/**
 * Generate a Markdown report with team (LOB) level Copilot metrics.
 *
 * Implements the join recipe from GitHub's documentation
 * (https://docs.github.com/en/copilot/reference/copilot-usage-metrics/team-level-metrics):
 *
 *   1. For each day, inner-join the per-user usage report with the SAME
 *      day's user-teams report on (user_id, day, organization_id).
 *   2. Group the joined rows by team, summing volume counters across days.
 *   3. Distinct-user counts are COUNT(DISTINCT user_id) over the whole
 *      window's joined rows - never summed across days.
 *
 * Org-wide totals come from the aggregated organization report directly
 * (summing team rows would double-count users on multiple teams).
 *
 * Usage:
 *   npx tsx src/generate-report.ts [--days N] [--data-dir DIR] [--out FILE]
 *
 * Optional env: GH_TEAM_SLUGS - comma-separated team slugs to include
 * (one per LOB). If unset, every team present in the reports is included.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { OrgAggregateRow, UserTeamRow, UserUsageRow } from "./types.ts";

interface TeamAggregate {
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
  byLanguage: Map<string, { acceptances: number; locAdded: number }>;
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

const pct = (num: number, den: number): string => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : "-");
const fmt = (n: number): string => n.toLocaleString("en-US");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "28" },
      "data-dir": { type: "string" },
      out: { type: "string" },
    },
  });
  const windowDays = Number.parseInt(values.days!, 10);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error("--days must be a positive integer");
    process.exit(1);
  }
  const toolkitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const dataDir = values["data-dir"] ?? join(toolkitRoot, "data");
  const teamFilter = new Set(
    (process.env.GH_TEAM_SLUGS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  );

  const usersDir = join(dataDir, "raw", "users");
  const teamsDir = join(dataDir, "raw", "user-teams");
  const orgDir = join(dataDir, "raw", "org");

  const userDays = await listDays(usersDir);
  const teamDays = new Set(await listDays(teamsDir));
  // Only days with BOTH reports can be joined; take the last N of them.
  const joinableDays = userDays.filter((d) => teamDays.has(d)).slice(-windowDays);
  if (joinableDays.length === 0) {
    console.error(`No days with both a users and a user-teams report under ${dataDir}. Run collect-metrics first.`);
    process.exit(1);
  }

  const teams = new Map<number, TeamAggregate>();
  for (const day of joinableDays) {
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

  // Org-wide totals from the aggregated organization report (no join).
  const orgDays = (await listDays(orgDir)).filter((d) => joinableDays.includes(d));
  let orgRows: OrgAggregateRow[] = [];
  for (const day of orgDays) {
    orgRows = orgRows.concat(await readNdjson<OrgAggregateRow>(join(orgDir, `${day}.ndjson`)));
  }

  const lines: string[] = [];
  lines.push(`# Copilot Usage Report (team/LOB level)`);
  lines.push("");
  lines.push(`Window: ${joinableDays[0]} to ${joinableDays[joinableDays.length - 1]} (${joinableDays.length} day(s) with joinable data)`);
  lines.push("");

  lines.push(`## Team (LOB) comparison`);
  lines.push("");
  lines.push(`| Team | Active users | Chat users | Agent users | Prompts | Code generations | Acceptances | Acceptance activity rate | LOC suggested | LOC added |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  const sorted = [...teams.values()].sort((a, b) => b.locAdded - a.locAdded);
  for (const t of sorted) {
    lines.push(
      `| ${t.slug} | ${t.users.size} | ${t.chatUsers.size} | ${t.agentUsers.size} | ${fmt(t.interactions)} | ` +
        `${fmt(t.generations)} | ${fmt(t.acceptances)} | ${pct(t.acceptances, t.generations)} | ` +
        `${fmt(t.locSuggested)} | ${fmt(t.locAdded)} |`,
    );
  }
  if (sorted.length === 0) {
    lines.push(`| _no teams matched_ | | | | | | | | | |`);
  }
  lines.push("");

  if (orgRows.length > 0) {
    const latest = orgRows[orgRows.length - 1];
    const orgTotal = (f: (r: OrgAggregateRow) => number | undefined) => orgRows.reduce((sum, r) => sum + (f(r) ?? 0), 0);
    lines.push(`## Organization totals (for context)`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---:|`);
    lines.push(`| Monthly active users (latest day) | ${fmt(latest.monthly_active_users ?? 0)} |`);
    lines.push(`| Prompts | ${fmt(orgTotal((r) => r.user_initiated_interaction_count))} |`);
    lines.push(`| Code generations | ${fmt(orgTotal((r) => r.code_generation_activity_count))} |`);
    lines.push(`| Acceptances | ${fmt(orgTotal((r) => r.code_acceptance_activity_count))} |`);
    lines.push(`| LOC added | ${fmt(orgTotal((r) => r.loc_added_sum))} |`);
    lines.push(`| PRs created by Copilot cloud agent | ${fmt(orgTotal((r) => r.pull_requests?.total_created_by_copilot))} |`);
    lines.push("");
    lines.push(`_Team rows must not be summed to reproduce these totals: users on multiple teams count once per team, and teams under 5 seated users are absent from team data entirely._`);
    lines.push("");
  }

  for (const t of sorted) {
    if (t.byLanguage.size === 0) continue;
    lines.push(`### ${t.slug} - top languages (by LOC added)`);
    lines.push("");
    lines.push(`| Language | Acceptances | LOC added |`);
    lines.push(`|---|---:|---:|`);
    const top = [...t.byLanguage.entries()].sort((a, b) => b[1].locAdded - a[1].locAdded).slice(0, 10);
    for (const [name, l] of top) {
      lines.push(`| ${name} | ${fmt(l.acceptances)} | ${fmt(l.locAdded)} |`);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push("");
  lines.push(
    `_Notes: "Active users" is COUNT(DISTINCT user) over the window's joined rows, per GitHub's guidance - daily counts are never summed. ` +
      `Acceptance activity rate = code acceptance activities / code generation activities; counters span completions, chat panel actions, and (for LOC added) agent edits. ` +
      `Teams with fewer than 5 Copilot-seated users on a day are excluded from that day's team data by GitHub. ` +
      `These are usage/adoption metrics, not direct productivity outcomes - pair them with delivery metrics for a full picture._`,
  );
  lines.push("");

  const report = lines.join("\n");
  if (values.out) {
    await writeFile(values.out, report);
    console.log(`Report written to ${values.out}`);
  } else {
    console.log(report);
  }
}

await main();
