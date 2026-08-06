/**
 * Shared aggregation for report and dashboard generation.
 *
 * Implements the team-metrics join recipe from GitHub's documentation:
 * per day, inner-join the per-user usage report with the same day's
 * user-teams report on (user_id, day, organization_id); group by team;
 * SUM volume counters; COUNT(DISTINCT user_id) over the whole window.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgAggregateRow, UserTeamRow, UserUsageRow } from "./types.ts";

export interface LangTotals {
  acceptances: number;
  locAdded: number;
}

export interface DailyPoint {
  locAdded: number;
  acceptances: number;
  activeUsers: number;
}

export interface TeamAggregate {
  teamId: number;
  slug: string;
  daysPresent: Set<string>;
  users: Set<number>;
  chatUsers: Set<number>;
  agentUsers: Set<number>;
  interactions: number;
  generations: number;
  acceptances: number;
  locSuggested: number;
  locAdded: number;
  locDeleted: number;
  byLanguage: Map<string, LangTotals>;
  daily: Map<string, DailyPoint>;
}

export interface Aggregation {
  /** Joinable days (both reports present), oldest first, capped to the window. */
  days: string[];
  /** Teams sorted by LOC added, descending. */
  teams: TeamAggregate[];
  /** Org aggregate rows for the same days, oldest first. */
  orgRows: OrgAggregateRow[];
}

async function readNdjson<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

async function listDays(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(".ndjson", "")).sort();
  } catch {
    return [];
  }
}

export async function aggregate(dataDir: string, windowDays: number, teamFilter: Set<string>): Promise<Aggregation> {
  const usersDir = join(dataDir, "raw", "users");
  const teamsDir = join(dataDir, "raw", "user-teams");
  const orgDir = join(dataDir, "raw", "org");

  const userDays = await listDays(usersDir);
  const teamDays = new Set(await listDays(teamsDir));
  const days = userDays.filter((d) => teamDays.has(d)).slice(-windowDays);

  const teams = new Map<number, TeamAggregate>();
  for (const day of days) {
    const userRows = await readNdjson<UserUsageRow>(join(usersDir, `${day}.ndjson`));
    const teamRows = await readNdjson<UserTeamRow>(join(teamsDir, `${day}.ndjson`));
    const usersById = new Map(userRows.map((u) => [`${u.user_id}|${u.day}|${u.organization_id ?? ""}`, u]));

    for (const membership of teamRows) {
      if (teamFilter.size > 0 && !teamFilter.has(membership.slug)) continue;
      const user = usersById.get(`${membership.user_id}|${membership.day}|${membership.organization_id ?? ""}`);
      if (!user) continue; // inner join: membership without activity that day

      let team = teams.get(membership.team_id);
      if (!team) {
        team = {
          teamId: membership.team_id,
          slug: membership.slug,
          daysPresent: new Set(),
          users: new Set(),
          chatUsers: new Set(),
          agentUsers: new Set(),
          interactions: 0,
          generations: 0,
          acceptances: 0,
          locSuggested: 0,
          locAdded: 0,
          locDeleted: 0,
          byLanguage: new Map(),
          daily: new Map(),
        };
        teams.set(membership.team_id, team);
      }
      team.daysPresent.add(day);
      team.users.add(user.user_id);
      if (user.used_chat) team.chatUsers.add(user.user_id);
      if (user.used_agent) team.agentUsers.add(user.user_id);
      team.interactions += user.user_initiated_interaction_count ?? 0;
      team.generations += user.code_generation_activity_count ?? 0;
      team.acceptances += user.code_acceptance_activity_count ?? 0;
      team.locSuggested += user.loc_suggested_to_add_sum ?? 0;
      team.locAdded += user.loc_added_sum ?? 0;
      team.locDeleted += user.loc_deleted_sum ?? 0;

      let point = team.daily.get(day);
      if (!point) {
        point = { locAdded: 0, acceptances: 0, activeUsers: 0 };
        team.daily.set(day, point);
      }
      point.locAdded += user.loc_added_sum ?? 0;
      point.acceptances += user.code_acceptance_activity_count ?? 0;
      point.activeUsers += 1;

      for (const entry of user.totals_by_language_feature ?? []) {
        if (!entry.language) continue;
        let lang = team.byLanguage.get(entry.language);
        if (!lang) {
          lang = { acceptances: 0, locAdded: 0 };
          team.byLanguage.set(entry.language, lang);
        }
        lang.acceptances += entry.code_acceptance_activity_count ?? 0;
        lang.locAdded += entry.loc_added_sum ?? 0;
      }
    }
  }

  let orgRows: OrgAggregateRow[] = [];
  for (const day of (await listDays(orgDir)).filter((d) => days.includes(d))) {
    orgRows = orgRows.concat(await readNdjson<OrgAggregateRow>(join(orgDir, `${day}.ndjson`)));
  }

  return {
    days,
    teams: [...teams.values()].sort((a, b) => b.locAdded - a.locAdded),
    orgRows,
  };
}
