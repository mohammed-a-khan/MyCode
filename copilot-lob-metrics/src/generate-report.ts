/**
 * Generate a Markdown report from collected Copilot metrics stores.
 *
 * Reads every per-scope store (data/*.json written by collect-metrics.ts),
 * aggregates the last N days, and emits: a side-by-side scope comparison
 * (org vs each LOB team), then a per-scope breakdown with acceptance rates
 * and top languages/editors.
 *
 * Usage:
 *   npx tsx src/generate-report.ts [--days N] [--data-dir DIR] [--out FILE]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CopilotDayMetrics, EditorMetrics, LanguageMetrics } from "./types.ts";

interface Totals {
  suggestions: number;
  acceptances: number;
  linesSuggested: number;
  linesAccepted: number;
}

interface ScopeSummary {
  scope: string;
  daysWithData: number;
  firstDate: string;
  lastDate: string;
  avgActiveUsers: number;
  avgEngagedUsers: number;
  totals: Totals;
  byLanguage: Map<string, Totals>;
  byEditor: Map<string, Totals>;
  ideChats: number;
  ideChatInsertions: number;
  ideChatCopies: number;
  dotcomChats: number;
  prSummaries: number;
}

const emptyTotals = (): Totals => ({ suggestions: 0, acceptances: 0, linesSuggested: 0, linesAccepted: 0 });

function addLanguage(totals: Totals, lang: LanguageMetrics): void {
  totals.suggestions += lang.total_code_suggestions ?? 0;
  totals.acceptances += lang.total_code_acceptances ?? 0;
  totals.linesSuggested += lang.total_code_lines_suggested ?? 0;
  totals.linesAccepted += lang.total_code_lines_accepted ?? 0;
}

function upsert(map: Map<string, Totals>, key: string): Totals {
  let entry = map.get(key);
  if (!entry) {
    entry = emptyTotals();
    map.set(key, entry);
  }
  return entry;
}

function summarize(scope: string, days: CopilotDayMetrics[]): ScopeSummary {
  const s: ScopeSummary = {
    scope,
    daysWithData: days.length,
    firstDate: days[0]?.date ?? "-",
    lastDate: days[days.length - 1]?.date ?? "-",
    avgActiveUsers: 0,
    avgEngagedUsers: 0,
    totals: emptyTotals(),
    byLanguage: new Map(),
    byEditor: new Map(),
    ideChats: 0,
    ideChatInsertions: 0,
    ideChatCopies: 0,
    dotcomChats: 0,
    prSummaries: 0,
  };

  let activeSum = 0;
  let engagedSum = 0;
  for (const day of days) {
    activeSum += day.total_active_users ?? 0;
    engagedSum += day.total_engaged_users ?? 0;

    for (const editor of day.copilot_ide_code_completions?.editors ?? []) {
      const editorTotals = upsert(s.byEditor, editor.name);
      for (const model of editor.models ?? []) {
        for (const lang of model.languages ?? []) {
          addLanguage(s.totals, lang);
          addLanguage(editorTotals, lang);
          addLanguage(upsert(s.byLanguage, lang.name), lang);
        }
      }
    }

    for (const editor of day.copilot_ide_chat?.editors ?? []) {
      for (const model of editor.models ?? []) {
        s.ideChats += model.total_chats ?? 0;
        s.ideChatInsertions += model.total_chat_insertion_events ?? 0;
        s.ideChatCopies += model.total_chat_copy_events ?? 0;
      }
    }

    for (const model of day.copilot_dotcom_chat?.models ?? []) {
      s.dotcomChats += model.total_chats ?? 0;
    }

    for (const repo of day.copilot_dotcom_pull_requests?.repositories ?? []) {
      for (const model of repo.models ?? []) {
        s.prSummaries += model.total_pr_summaries_created ?? 0;
      }
    }
  }

  if (days.length > 0) {
    s.avgActiveUsers = activeSum / days.length;
    s.avgEngagedUsers = engagedSum / days.length;
  }
  return s;
}

const pct = (num: number, den: number): string => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : "-");
const fmt = (n: number): string => n.toLocaleString("en-US");

function topEntries(map: Map<string, Totals>, limit: number): [string, Totals][] {
  return [...map.entries()].sort((a, b) => b[1].acceptances - a[1].acceptances).slice(0, limit);
}

function renderReport(summaries: ScopeSummary[], windowDays: number): string {
  const lines: string[] = [];
  lines.push(`# Copilot Usage Report`);
  lines.push("");
  lines.push(`Aggregated over the last **${windowDays} day(s)** of collected data.`);
  lines.push("");

  lines.push(`## Scope comparison`);
  lines.push("");
  lines.push(`| Scope | Days | Avg engaged users/day | Suggestions | Acceptance rate | AI lines accepted | Line acceptance rate | IDE chats |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of summaries) {
    lines.push(
      `| ${s.scope} | ${s.daysWithData} | ${s.avgEngagedUsers.toFixed(1)} | ${fmt(s.totals.suggestions)} | ` +
        `${pct(s.totals.acceptances, s.totals.suggestions)} | ${fmt(s.totals.linesAccepted)} | ` +
        `${pct(s.totals.linesAccepted, s.totals.linesSuggested)} | ${fmt(s.ideChats)} |`,
    );
  }
  lines.push("");

  for (const s of summaries) {
    lines.push(`## ${s.scope}`);
    lines.push("");
    if (s.daysWithData === 0) {
      lines.push(`_No data collected for this scope in the selected window._`);
      lines.push("");
      continue;
    }
    lines.push(`Window: ${s.firstDate} to ${s.lastDate} (${s.daysWithData} day(s) with data)`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---:|`);
    lines.push(`| Avg active users/day | ${s.avgActiveUsers.toFixed(1)} |`);
    lines.push(`| Avg engaged users/day | ${s.avgEngagedUsers.toFixed(1)} |`);
    lines.push(`| Code suggestions shown | ${fmt(s.totals.suggestions)} |`);
    lines.push(`| Code suggestions accepted | ${fmt(s.totals.acceptances)} |`);
    lines.push(`| Acceptance rate | ${pct(s.totals.acceptances, s.totals.suggestions)} |`);
    lines.push(`| Lines of code suggested | ${fmt(s.totals.linesSuggested)} |`);
    lines.push(`| Lines of code accepted | ${fmt(s.totals.linesAccepted)} |`);
    lines.push(`| Line acceptance rate | ${pct(s.totals.linesAccepted, s.totals.linesSuggested)} |`);
    lines.push(`| IDE chats | ${fmt(s.ideChats)} (insertions: ${fmt(s.ideChatInsertions)}, copies: ${fmt(s.ideChatCopies)}) |`);
    lines.push(`| github.com chats | ${fmt(s.dotcomChats)} |`);
    lines.push(`| PR summaries created | ${fmt(s.prSummaries)} |`);
    lines.push("");

    if (s.byLanguage.size > 0) {
      lines.push(`### Top languages (by accepted suggestions)`);
      lines.push("");
      lines.push(`| Language | Suggestions | Acceptances | Acceptance rate | Lines accepted |`);
      lines.push(`|---|---:|---:|---:|---:|`);
      for (const [name, t] of topEntries(s.byLanguage, 10)) {
        lines.push(`| ${name} | ${fmt(t.suggestions)} | ${fmt(t.acceptances)} | ${pct(t.acceptances, t.suggestions)} | ${fmt(t.linesAccepted)} |`);
      }
      lines.push("");
    }

    if (s.byEditor.size > 0) {
      lines.push(`### Editors`);
      lines.push("");
      lines.push(`| Editor | Suggestions | Acceptances | Acceptance rate |`);
      lines.push(`|---|---:|---:|---:|`);
      for (const [name, t] of topEntries(s.byEditor, 10)) {
        lines.push(`| ${name} | ${fmt(t.suggestions)} | ${fmt(t.acceptances)} | ${pct(t.acceptances, t.suggestions)} |`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push("");
  lines.push(
    `_Notes: acceptance rate = accepted / shown suggestions. These are usage/adoption metrics, ` +
      `not direct productivity outcomes - pair them with delivery metrics (cycle time, PR throughput) for a full picture. ` +
      `Team scopes require at least 5 Copilot-licensed members to return data._`,
  );
  lines.push("");
  return lines.join("\n");
}

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

  let files: string[];
  try {
    files = (await readdir(dataDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    console.error(`Data directory not found: ${dataDir}. Run collect-metrics first.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No stores found in ${dataDir}. Run collect-metrics first.`);
    process.exit(1);
  }

  const summaries: ScopeSummary[] = [];
  for (const file of files) {
    const allDays = JSON.parse(await readFile(join(dataDir, file), "utf8")) as CopilotDayMetrics[];
    const windowed = allDays.sort((a, b) => a.date.localeCompare(b.date)).slice(-windowDays);
    summaries.push(summarize(basename(file, ".json"), windowed));
  }

  const report = renderReport(summaries, windowDays);
  if (values.out) {
    await writeFile(values.out, report);
    console.log(`Report written to ${values.out}`);
  } else {
    console.log(report);
  }
}

await main();
