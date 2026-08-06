/**
 * Collect GitHub Copilot usage metrics reports (current 2026 API).
 *
 * For each day in the collection window this script calls the Copilot usage
 * metrics report endpoints, follows the signed download links they return,
 * and stores the raw NDJSON rows on disk:
 *
 *   GET /orgs/{org}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD
 *       -> data/raw/users/YYYY-MM-DD.ndjson       (per-user activity)
 *   GET /orgs/{org}/copilot/metrics/reports/user-teams-1-day?day=YYYY-MM-DD
 *       -> data/raw/user-teams/YYYY-MM-DD.ndjson  (user -> team membership)
 *   GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=YYYY-MM-DD
 *       -> data/raw/org/YYYY-MM-DD.ndjson         (org-wide aggregate)
 *
 * Team (LOB) metrics are produced later by generate-report.ts, which joins
 * the per-user and user-teams reports day by day, as GitHub's documentation
 * prescribes.
 *
 * Days already on disk are skipped, so running this daily (or weekly) builds
 * an ever-growing local history. Data for a day is published within two full
 * UTC days after the day closes, so collection starts at today-2.
 *
 * Configuration (environment variables):
 *   GH_TOKEN    token with Copilot metrics read access (required):
 *               fine-grained PAT with "Organization Copilot metrics: read",
 *               or a classic PAT with the read:org scope
 *   GH_ORG      organization slug (required)
 *   GH_API_URL  API base URL, default https://api.github.com
 *
 * Usage:
 *   npx tsx src/collect-metrics.ts [--days N] [--data-dir DIR]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ReportEnvelope } from "./types.ts";

const API_VERSION = "2022-11-28";
const PUBLISH_LAG_DAYS = 2; // data for a day appears within two full UTC days

const REPORTS = [
  { name: "users", endpoint: "users-1-day" },
  { name: "user-teams", endpoint: "user-teams-1-day" },
  { name: "org", endpoint: "organization-1-day" },
] as const;

class HttpError extends Error {
  constructor(public status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
  }
}

function explainHttpError(err: HttpError, scope: string): string {
  switch (err.status) {
    case 403:
      return `[${scope}] 403 Forbidden - the token lacks the "Organization Copilot metrics: read" permission (classic PATs need read:org), the caller has not been granted Copilot metrics access, or the "Copilot usage metrics" policy is not enabled for the organization/enterprise. Ask an org admin to check these.`;
    case 404:
      return `[${scope}] 404 Not Found - wrong org slug, no access, or the report for this day is not (yet) available. Reports appear within two full UTC days after the day closes.`;
    case 422:
      return `[${scope}] 422 - the requested day is invalid or outside the available range.`;
    default:
      return `[${scope}] ${err.message}`;
  }
}

async function fetchEnvelope(baseUrl: string, org: string, endpoint: string, day: string, token: string): Promise<ReportEnvelope> {
  const url = `${baseUrl}/orgs/${org}/copilot/metrics/reports/${endpoint}?day=${day}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "copilot-lob-metrics-collector",
    },
  });
  if (!resp.ok) throw new HttpError(resp.status, resp.statusText);
  return (await resp.json()) as ReportEnvelope;
}

/** Download every signed link of an envelope and concatenate the NDJSON. */
async function downloadReport(envelope: ReportEnvelope): Promise<string> {
  const parts: string[] = [];
  for (const link of envelope.download_links) {
    // Signed URLs carry their own auth; do not forward the API token.
    const resp = await fetch(link);
    if (!resp.ok) throw new HttpError(resp.status, `downloading report file`);
    parts.push((await resp.text()).trim());
  }
  return parts.filter(Boolean).join("\n");
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "10" },
      "data-dir": { type: "string" },
    },
  });
  const windowDays = Number.parseInt(values.days!, 10);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error("--days must be a positive integer");
    process.exit(1);
  }
  const toolkitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const dataDir = values["data-dir"] ?? join(toolkitRoot, "data");

  const token = process.env.GH_TOKEN;
  const org = process.env.GH_ORG;
  if (!token || !org) {
    console.error("GH_TOKEN and GH_ORG environment variables are required.");
    process.exit(1);
  }
  const baseUrl = (process.env.GH_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

  const newest = new Date();
  newest.setUTCDate(newest.getUTCDate() - PUBLISH_LAG_DAYS);

  let fetched = 0;
  let skipped = 0;
  let failures = 0;
  for (let i = 0; i < windowDays; i++) {
    const date = new Date(newest);
    date.setUTCDate(date.getUTCDate() - i);
    const day = isoDay(date);

    for (const report of REPORTS) {
      const outPath = join(dataDir, "raw", report.name, `${day}.ndjson`);
      if (existsSync(outPath)) {
        skipped++;
        continue;
      }
      const scope = `${report.name} ${day}`;
      try {
        const envelope = await fetchEnvelope(baseUrl, org, report.endpoint, day, token);
        const ndjson = await downloadReport(envelope);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, ndjson + "\n");
        console.log(`[${scope}] saved ${ndjson ? ndjson.split("\n").length : 0} row(s)`);
        fetched++;
      } catch (err) {
        failures++;
        if (err instanceof HttpError) {
          console.error(explainHttpError(err, scope));
        } else {
          console.error(`[${scope}] ${(err as Error).message}`);
        }
      }
    }
  }

  console.log(`Done: ${fetched} report file(s) fetched, ${skipped} already present, ${failures} failed.`);
  if (fetched === 0 && skipped === 0 && failures > 0) {
    process.exit(1);
  }
}

await main();
