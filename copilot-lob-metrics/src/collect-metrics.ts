/**
 * Collect GitHub Copilot metrics at org and team (LOB) level.
 *
 * Fetches the last 28 days (the API's maximum retention) for the configured
 * organization and each configured team, and merges the results into
 * per-scope JSON stores keyed by date. Re-running is safe: days already
 * stored are overwritten with fresh values, so overlapping windows dedupe.
 *
 * Configuration (environment variables):
 *   GH_TOKEN        token with Copilot metrics read access (required)
 *   GH_ORG          organization slug (required)
 *   GH_TEAM_SLUGS   comma-separated team slugs, one per LOB (optional)
 *   GH_API_URL      API base URL, default https://api.github.com
 *
 * Usage:
 *   npx tsx src/collect-metrics.ts [--data-dir DIR]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CopilotDayMetrics } from "./types.ts";

const API_VERSION = "2022-11-28";
const PER_PAGE = 28; // API max; one page covers the full retention window

interface Scope {
  name: string;
  path: string;
}

async function apiGet(baseUrl: string, path: string, token: string): Promise<CopilotDayMetrics[]> {
  const results: CopilotDayMetrics[] = [];
  for (let page = 1; ; page++) {
    const url = `${baseUrl}${path}?per_page=${PER_PAGE}&page=${page}`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "copilot-lob-metrics-collector",
      },
    });
    if (!resp.ok) {
      throw new HttpError(resp.status, resp.statusText);
    }
    const batch = (await resp.json()) as CopilotDayMetrics[];
    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected response shape from ${path}`);
    }
    results.push(...batch);
    if (batch.length < PER_PAGE) return results;
  }
}

class HttpError extends Error {
  constructor(public status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
  }
}

function explainHttpError(err: HttpError, scope: string): string {
  switch (err.status) {
    case 403:
      return `[${scope}] 403 Forbidden - the token lacks Copilot metrics access, or the organization's 'Copilot metrics API access' policy is disabled. Ask an org admin to check both.`;
    case 404:
      return `[${scope}] 404 Not Found - wrong org/team slug, the token cannot see this team, or the team has fewer than 5 Copilot-licensed members (GitHub suppresses metrics for small teams).`;
    case 422:
      return `[${scope}] 422 - requested dates fall outside the 28-day retention window.`;
    default:
      return `[${scope}] ${err.message}`;
  }
}

/** Merge freshly fetched day objects into the JSON store keyed by date. */
async function mergeStore(storePath: string, days: CopilotDayMetrics[]): Promise<{ fetched: number; total: number }> {
  const byDate = new Map<string, CopilotDayMetrics>();
  if (existsSync(storePath)) {
    const existing = JSON.parse(await readFile(storePath, "utf8")) as CopilotDayMetrics[];
    for (const day of existing) byDate.set(day.date, day);
  }
  for (const day of days) byDate.set(day.date, day);
  const merged = [...byDate.keys()].sort().map((d) => byDate.get(d)!);
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(merged, null, 1));
  return { fetched: days.length, total: merged.length };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "data-dir": { type: "string" } },
  });
  const toolkitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const dataDir = values["data-dir"] ?? join(toolkitRoot, "data");

  const token = process.env.GH_TOKEN;
  const org = process.env.GH_ORG;
  if (!token || !org) {
    console.error("GH_TOKEN and GH_ORG environment variables are required.");
    process.exit(1);
  }
  const baseUrl = (process.env.GH_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const teamSlugs = (process.env.GH_TEAM_SLUGS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const scopes: Scope[] = [
    { name: "org", path: `/orgs/${org}/copilot/metrics` },
    ...teamSlugs.map((slug) => ({
      name: `team-${slug}`,
      path: `/orgs/${org}/team/${slug}/copilot/metrics`,
    })),
  ];

  let failures = 0;
  for (const scope of scopes) {
    try {
      const days = await apiGet(baseUrl, scope.path, token);
      const { fetched, total } = await mergeStore(join(dataDir, `${scope.name}.json`), days);
      console.log(`[${scope.name}] fetched ${fetched} day(s), store now holds ${total} day(s)`);
    } catch (err) {
      if (err instanceof HttpError) {
        console.error(explainHttpError(err, scope.name));
      } else {
        console.error(`[${scope.name}] ${(err as Error).message}`);
      }
      failures++;
    }
  }

  if (failures === scopes.length) {
    console.error("All scopes failed - nothing was collected.");
    process.exit(1);
  }
}

await main();
