/**
 * Generate a Markdown report with team (LOB) level Copilot metrics.
 *
 * Uses the shared aggregation in aggregate.ts, which implements the join
 * recipe from GitHub's documentation
 * (https://docs.github.com/en/copilot/reference/copilot-usage-metrics/team-level-metrics).
 * Org-wide totals come from the aggregated organization report directly
 * (summing team rows would double-count users on multiple teams).
 *
 * Usage:
 *   npx tsx src/generate-report.ts [--days N] [--data-dir DIR] [--out FILE]
 *
 * Optional env: GH_TEAM_SLUGS - comma-separated team slugs to include
 * (one per LOB). If unset, every team present in the reports is included.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { aggregate } from "./aggregate.ts";
import type { OrgAggregateRow } from "./types.ts";

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

  const { days, teams, orgRows } = await aggregate(dataDir, windowDays, teamFilter);
  if (days.length === 0) {
    console.error(`No days with both a users and a user-teams report under ${dataDir}. Run collect-metrics first.`);
    process.exit(1);
  }

  const lines: string[] = [];
  lines.push(`# Copilot Usage Report (team/LOB level)`);
  lines.push("");
  lines.push(`Window: ${days[0]} to ${days[days.length - 1]} (${days.length} day(s) with joinable data)`);
  lines.push("");

  lines.push(`## Team (LOB) comparison`);
  lines.push("");
  lines.push(`| Team | Active users | Chat users | Agent users | Prompts | Code generations | Acceptances | Acceptance activity rate | LOC suggested | LOC added |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const t of teams) {
    lines.push(
      `| ${t.slug} | ${t.users.size} | ${t.chatUsers.size} | ${t.agentUsers.size} | ${fmt(t.interactions)} | ` +
        `${fmt(t.generations)} | ${fmt(t.acceptances)} | ${pct(t.acceptances, t.generations)} | ` +
        `${fmt(t.locSuggested)} | ${fmt(t.locAdded)} |`,
    );
  }
  if (teams.length === 0) {
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

  for (const t of teams) {
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
