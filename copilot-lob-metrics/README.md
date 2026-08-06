# Copilot LOB Metrics Toolkit

A small TypeScript (Node.js) toolkit to collect and report **GitHub Copilot
usage metrics at a line-of-business (LOB) level** — i.e. per GitHub Team —
instead of only at the organization level. No runtime dependencies; only dev
tooling (`typescript`, `tsx`) to run the scripts.

Everything is configured through environment variables. No organization,
team, user, or project names are hardcoded anywhere.

---

## How LOB-level metrics work on GitHub

GitHub's [Copilot Metrics API](https://docs.github.com/en/rest/copilot/copilot-metrics)
exposes usage data at four scopes:

| Scope | Endpoint |
|---|---|
| Organization | `GET /orgs/{org}/copilot/metrics` |
| **Team (→ your LOB)** | `GET /orgs/{org}/team/{team_slug}/copilot/metrics` |
| Enterprise | `GET /enterprises/{enterprise}/copilot/metrics` |
| Enterprise team | `GET /enterprises/{enterprise}/team/{team_slug}/copilot/metrics` |

The team-level endpoint is the mechanism for LOB reporting: **each LOB is
represented as a GitHub Team**, and you pull metrics per team.

### Hard requirements (things only an admin can do)

You do **not** need to be an org admin to run this toolkit, but an admin has
to set up three things once:

1. **Teams that mirror your LOB structure.** Ask the admin to create (or
   confirm) one GitHub Team per LOB, containing that LOB's developers.
   Nested teams work too — metrics for a parent team include child teams.
2. **A minimum of 5 Copilot-licensed members per team.** GitHub suppresses
   team-level metrics for smaller teams as a privacy measure. If a team is
   smaller, the API returns no data for it.
3. **API access for you.** One of:
   - The org's **"Copilot metrics API access" policy** enabled, which lets
     authorized members query the API, **or**
   - A **fine-grained personal access token** (created by an org owner or via
     a service account) with read access to Copilot metrics for the org, **or**
   - A **GitHub App** installed on the org with the Copilot read permission
     (best option for a long-lived scheduled job).

   For classic tokens, the relevant scopes are `manage_billing:copilot` or
   `read:org`.

> **Note on "subscription ID":** a Copilot subscription/agreement ID is a
> billing identifier. It cannot be used to call the API. What you need from
> your manager or admin is a *token* as described above — that is the ask to
> bring to them.

### What the API gives you (and what it doesn't)

Per day, per team, you get aggregates such as:

- Active and engaged user counts
- Code completions: suggestions shown, suggestions accepted, lines of code
  suggested, lines of code accepted — broken down by language, editor, and model
- Copilot Chat usage in IDEs (chats, insertions, copies) and on github.com
- Pull request summary usage

You do **not** get per-individual numbers from this API — data is aggregated
at the team/org level, which is usually exactly what an LOB head wants and
avoids individual surveillance concerns.

**Retention caveat:** the API only returns the **most recent 28 days**. To
build a long-term trend line you must snapshot regularly — that is what the
collector script here does. Run it at least weekly (daily is safer).

---

## Toolkit contents

| File | Purpose |
|---|---|
| `src/collect-metrics.ts` | Fetches org- and team-level metrics and merges them into per-scope JSON stores (`data/*.json`), keyed by date. Safe to re-run; overlapping days are deduplicated. |
| `src/generate-report.ts` | Reads the stores and produces a Markdown report: totals, acceptance rates, engaged users, language/editor breakdowns, and a side-by-side team (LOB) comparison. |
| `src/types.ts` | TypeScript types for the Copilot Metrics API response shape. |
| `workflow-example.yml` | A GitHub Actions workflow you can copy into `.github/workflows/` to automate collection + reporting on a schedule. |

Requires Node.js 18+ (uses the built-in `fetch`; developed on Node 22).

## Configuration

All via environment variables:

| Variable | Required | Description |
|---|---|---|
| `GH_TOKEN` | yes | Token with Copilot metrics read access (see above). |
| `GH_ORG` | yes | Organization login (slug). |
| `GH_TEAM_SLUGS` | no | Comma-separated team slugs, one per LOB (e.g. `lob-alpha,lob-beta`). If empty, only org-level metrics are collected. |
| `GH_API_URL` | no | API base URL. Defaults to `https://api.github.com`. Set for GitHub Enterprise Server (e.g. `https://HOST/api/v3`). |

## Usage

```bash
cd copilot-lob-metrics
npm install                   # one-time: installs typescript + tsx (dev only)

export GH_TOKEN=...           # from your admin — never commit this
export GH_ORG=your-org-slug
export GH_TEAM_SLUGS=lob-team-a,lob-team-b

# 1. Collect (run on a schedule; each run merges the last 28 days)
npm run collect

# 2. Report (over the last N days of collected history; default 28)
npm run report -- --days 28 --out report.md
```

The collector writes to `copilot-lob-metrics/data/` by default (override with
`--data-dir`). Commit that directory (or store it elsewhere) so history
accumulates beyond GitHub's 28-day window. To automate both steps, copy
`workflow-example.yml` into `.github/workflows/` and configure the secret and
variables described at the top of that file.

## Interpreting the numbers (talking to your LOB head)

- **Acceptance rate** (accepted / shown suggestions) is the most-quoted
  Copilot number; 20–35% is a commonly observed range. It measures *usage
  quality*, not productivity by itself.
- **Lines of AI-accepted code** is easy to communicate but easy to
  over-interpret — accepted lines are often edited afterwards.
- **Engaged users vs. licensed users** shows adoption: are the seats the LOB
  pays for actually used?
- For a genuine *productivity* story, pair these usage metrics with delivery
  metrics the LOB already tracks (cycle time, PR throughput, review time)
  and compare trends before/after Copilot rollout. Usage data alone shows
  adoption, not outcomes.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403` | Token lacks Copilot metrics permission, or the org's Copilot metrics API access policy is disabled. Ask the admin to check both. |
| `404` on a team | Team slug wrong, token can't see the team, or the team has fewer than 5 Copilot-licensed members. |
| `422` | Requested dates outside the 28-day retention window. |
| Empty days | No Copilot activity, or telemetry policy disabled for those users. |
