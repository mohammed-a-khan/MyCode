# Copilot LOB Metrics Toolkit

A small TypeScript (Node.js) toolkit to collect and report **GitHub Copilot
usage metrics at a line-of-business (LOB) level** — i.e. per GitHub Team.
No runtime dependencies; only dev tooling (`typescript`, `tsx`) to run the
scripts. Everything is configured through environment variables; no
organization, team, user, or project names are hardcoded anywhere.

Built against the **current (2026) Copilot usage metrics API**. The older
`/orgs/{org}/copilot/metrics` and `/orgs/{org}/team/{team_slug}/copilot/metrics`
endpoints were closed down by GitHub on April 2, 2026 and no longer work.

---

## How LOB-level metrics work on GitHub (verified against official docs)

The [Copilot usage metrics API](https://docs.github.com/en/rest/copilot/copilot-usage-metrics)
does **not** publish a pre-aggregated team report. Instead, each REST endpoint
returns time-limited **signed download links** to newline-delimited JSON
(NDJSON) report files, and team-level metrics are constructed by **joining two
daily reports**, exactly as described in
[Team-level Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/team-level-metrics):

| Report | Endpoint | Contents |
|---|---|---|
| Per-user usage | `GET /orgs/{org}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD` | One row per user per day: prompts, code generations, acceptances, lines of code, chat/agent/CLI usage flags, language/IDE/model breakdowns, AI adoption phase. |
| User-teams | `GET /orgs/{org}/copilot/metrics/reports/user-teams-1-day?day=YYYY-MM-DD` | One row per (user, team) pair per day: which teams each user belonged to that day. |
| Org aggregate | `GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=YYYY-MM-DD` | One pre-aggregated row for the whole organization (active-user counts, totals, PR activity). |

The join recipe (from GitHub's docs, implemented by `generate-report.ts`):
inner-join per-user rows with the **same day's** user-teams rows on
`(user_id, day, organization_id)`, group by team, `SUM(...)` the volume
counters and `COUNT(DISTINCT user_id)` over the whole window for user counts.
Never join a 28-day per-user report against a single day's team membership —
that mis-attributes activity when membership changes.

Enterprise-scope variants of all endpoints exist under
`/enterprises/{enterprise}/copilot/metrics/reports/...`, plus `repos-1-day`
and `*-28-day/latest` reports.

> **UI alternative:** if the LOB head only needs adoption cohorts per team in
> a browser, the **impact dashboard** (org **Insights** tab) surfaces
> team-level adoption natively without any of this — same permissions as the
> API. The API path is for raw numbers, custom BI, and history.

### Access — the exact ask for your admin

Verified requirements
([permissions](https://docs.github.com/en/copilot/reference/copilot-usage-metrics),
[policy](https://docs.github.com/en/rest/copilot/copilot-usage-metrics)):

1. **Policy:** the **"Copilot usage metrics"** policy must be enabled — at the
   enterprise level ("Enabled everywhere") or in the organization's Copilot
   policy settings for standalone orgs.
2. **Who can call the API:** organization owners, billing managers,
   enterprise owners — **or a regular member granted access**. Two ways for a
   non-admin:
   - An org owner creates a **custom organization role** containing the
     **"View organization Copilot metrics"** permission and assigns it to you
     (at enterprise level the analogous permission is "View Enterprise
     Copilot Metrics"). You can then use your own token and the dashboards.
   - Or an admin provides a service-account token / GitHub App installation
     with the permission below.
3. **Token:** a **fine-grained PAT with the "Organization Copilot metrics"
   permission (read)** — or a classic PAT with the `read:org` scope.

> **Note on "subscription ID":** a Copilot subscription/agreement ID is a
> billing identifier and cannot authenticate API calls. The ask that works is
> the custom role + token above.

### Facts that shape the data (all from official docs)

- **Teams with fewer than 5 Copilot-seated users are excluded** from the
  user-teams report for that day. Their members' activity still exists in the
  per-user report, but no team row exists, so sub-threshold LOB teams show no
  team-level data.
- **Users on multiple teams count toward each team.** Summing team rows
  double-counts them — org totals must come from the org aggregate report.
- **Data lands within two full UTC days** after a day closes; the collector
  therefore starts at `today - 2`.
- Reports are **daily files**; the docs do not promise indefinite
  availability of past days, so this toolkit snapshots them locally — run the
  collector on a schedule to build history.
- The counters cover **more than inline completions**: chat panel actions and
  agent-mode edits are included (e.g. `loc_added_sum` counts agent edits).
  Numbers are not comparable to the pre-2026 metrics API — re-baseline.

## Toolkit contents

| File | Purpose |
|---|---|
| `src/collect-metrics.ts` | For each day in the window, fetches the three report envelopes, downloads the signed NDJSON links, and stores raw rows under `data/raw/{users,user-teams,org}/YYYY-MM-DD.ndjson`. Idempotent — existing days are skipped. |
| `src/generate-report.ts` | Emits a Markdown report: LOB comparison table, org context totals, per-team language breakdowns. |
| `src/generate-dashboard.ts` | Emits a **self-contained HTML dashboard** (no external assets/CDNs — works offline and behind restrictive proxies): stat tiles, LOC-added-by-team bars, daily trend lines with hover tooltips and a table view, comparison table, per-team language breakdowns. Light and dark theme follow the viewer's OS setting. |
| `src/aggregate.ts` | Shared join/aggregation logic used by both generators. |
| `src/types.ts` | TypeScript types for the report envelope and NDJSON row shapes. |
| `workflow-example.yml` | GitHub Actions workflow to automate collection + reporting (copy into `.github/workflows/` to activate). |

Requires Node.js 18+ (uses built-in `fetch`; developed on Node 22).

## Usage

```bash
cd copilot-lob-metrics
npm install                   # one-time: installs typescript + tsx (dev only)

export GH_TOKEN=...           # fine-grained PAT, "Organization Copilot metrics: read"
export GH_ORG=your-org-slug
export GH_TEAM_SLUGS=lob-team-a,lob-team-b   # optional filter for the report

# 1. Collect raw daily reports (default: last 10 available days; skips existing)
npm run collect               # add -- --days 30 to backfill further

# 2. Report over the collected history (default window: last 28 joinable days)
npm run report -- --days 28 --out report.md

# 3. HTML dashboard for the LOB head (self-contained, share the file directly)
npm run dashboard -- --days 28 --out dashboard.html
```

**Privacy note:** the raw per-user NDJSON files contain individual user IDs
and logins. The generated report only aggregates to team level, but the
`data/` directory itself is sensitive — keep the repository private, or point
`--data-dir` somewhere access-controlled.

## Interpreting the numbers (talking to your LOB head)

- **Acceptance activity rate** (`code_acceptance_activity_count` /
  `code_generation_activity_count`) measures how often suggested output is
  taken. It spans completions and chat, so don't compare it to older
  completions-only acceptance rates.
- **LOC added** (`loc_added_sum`) is lines actually added in the editor via
  Copilot — completions, applied chat blocks, and agent edits.
- **Active users vs. seats** shows whether the LOB's licenses are used.
- GitHub's own **AI adoption phases** (per-user field, and cohorts in the
  impact dashboard) are a ready-made adoption narrative for leadership.
- For a genuine *productivity* story, pair usage with delivery metrics the
  LOB already tracks (cycle time, PR throughput) — the org report's
  `pull_requests` block (including Copilot-authored/reviewed PR counts and
  median-minutes-to-merge) helps here.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403` | Token lacks "Organization Copilot metrics: read" (classic: `read:org`), you haven't been granted metrics access, or the "Copilot usage metrics" policy is disabled. |
| `404` | Wrong org slug, no access, or the day's report isn't published yet (allow two full UTC days). |
| A team never appears | Fewer than 5 Copilot-seated members that day, wrong slug in `GH_TEAM_SLUGS`, or no member had activity (inner join). |
| Team sums ≠ org totals | Expected: multi-team users count per team, and sub-threshold teams are missing from team data. Use the org report for totals. |
