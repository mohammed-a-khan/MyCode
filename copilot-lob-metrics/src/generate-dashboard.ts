/**
 * Generate a self-contained HTML dashboard with team (LOB) level Copilot
 * metrics from the collected reports. No external assets - all CSS/JS is
 * inline, so the file can be opened locally, attached to email, or hosted
 * on any internal static server.
 *
 * Usage:
 *   npx tsx src/generate-dashboard.ts [--days N] [--data-dir DIR] [--out FILE]
 *
 * Optional env: GH_TEAM_SLUGS - comma-separated team slugs to include.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { aggregate, type TeamAggregate } from "./aggregate.ts";
import type { OrgAggregateRow } from "./types.ts";

const MAX_LINE_SERIES = 8; // categorical palette slots; beyond this, table only

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number): string => n.toLocaleString("en-US");
const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const pct = (num: number, den: number): string => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : "-");

function statTile(label: string, value: string, note: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-note">${esc(note)}</div></div>`;
}

function barRows(teams: TeamAggregate[]): string {
  const max = Math.max(1, ...teams.map((t) => t.locAdded));
  return teams
    .map((t) => {
      const w = Math.max(0.5, (100 * t.locAdded) / max);
      return `<div class="bar-row" data-tip="${esc(t.slug)}: ${fmt(t.locAdded)} LOC added, ${t.users.size} active user(s)">
  <div class="bar-label">${esc(t.slug)}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%"></div></div>
  <div class="bar-value">${compact(t.locAdded)}</div>
</div>`;
    })
    .join("\n");
}

interface LineChartModel {
  svg: string;
  legend: string;
  hoverData: { days: string[]; xs: number[]; series: { slug: string; values: (number | null)[] }[] };
}

function lineChart(days: string[], teams: TeamAggregate[]): LineChartModel {
  const W = 860;
  const H = 300;
  const PAD = { top: 16, right: 120, bottom: 28, left: 46 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const plotted = teams.slice(0, MAX_LINE_SERIES);
  const series = plotted.map((t) => ({
    slug: t.slug,
    values: days.map((d) => t.daily.get(d)?.locAdded ?? null),
  }));
  const maxY = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const xs = days.map((_, i) => PAD.left + (days.length === 1 ? plotW / 2 : (i * plotW) / (days.length - 1)));
  const y = (v: number) => PAD.top + plotH - (v / maxY) * plotH;

  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = (maxY * i) / ticks;
    const yy = y(v).toFixed(1);
    grid += `<line class="grid" x1="${PAD.left}" y1="${yy}" x2="${PAD.left + plotW}" y2="${yy}"/>`;
    grid += `<text class="axis" x="${PAD.left - 6}" y="${yy}" dy="0.32em" text-anchor="end">${compact(Math.round(v))}</text>`;
  }
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  let xLabels = "";
  days.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== days.length - 1) return;
    xLabels += `<text class="axis" x="${xs[i].toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>`;
  });

  let paths = "";
  series.forEach((s, si) => {
    const pts = s.values
      .map((v, i) => (v === null ? null : `${xs[i].toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
    if (!pts) return;
    paths += `<polyline class="line s${si + 1}" points="${pts}"/>`;
    // Direct label at line end for up to 4 series (text ink, not series color).
    if (series.length <= 4) {
      const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
      if (s.values[lastIdx] !== null && s.values[lastIdx] !== undefined) {
        paths += `<text class="endlabel" x="${(xs[lastIdx] + 8).toFixed(1)}" y="${y(s.values[lastIdx]!).toFixed(1)}" dy="0.32em">${esc(s.slug)}</text>`;
      }
    }
  });

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily lines of code added with Copilot, by team" id="trend-svg">
${grid}${xLabels}
<line class="baseline" x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}"/>
${paths}
<line id="crosshair" class="crosshair" y1="${PAD.top}" y2="${PAD.top + plotH}" visibility="hidden"/>
<g id="hoverdots"></g>
</svg>`;

  const legend = series
    .map((s, si) => `<span class="legend-item"><span class="swatch s${si + 1}"></span>${esc(s.slug)}</span>`)
    .join("");

  return { svg, legend, hoverData: { days, xs, series } };
}

function comparisonTable(teams: TeamAggregate[]): string {
  const rows = teams
    .map(
      (t) => `<tr><td>${esc(t.slug)}</td><td>${t.users.size}</td><td>${t.chatUsers.size}</td><td>${t.agentUsers.size}</td>` +
        `<td>${fmt(t.interactions)}</td><td>${fmt(t.generations)}</td><td>${fmt(t.acceptances)}</td>` +
        `<td>${pct(t.acceptances, t.generations)}</td><td>${fmt(t.locSuggested)}</td><td>${fmt(t.locAdded)}</td></tr>`,
    )
    .join("\n");
  return `<div class="table-wrap"><table>
<thead><tr><th>Team</th><th>Active users</th><th>Chat users</th><th>Agent users</th><th>Prompts</th><th>Generations</th><th>Acceptances</th><th>Accept. rate</th><th>LOC suggested</th><th>LOC added</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function languageCards(teams: TeamAggregate[]): string {
  const cards = teams
    .filter((t) => t.byLanguage.size > 0)
    .map((t) => {
      const top = [...t.byLanguage.entries()].sort((a, b) => b[1].locAdded - a[1].locAdded).slice(0, 5);
      const max = Math.max(1, ...top.map(([, l]) => l.locAdded));
      const rows = top
        .map(
          ([name, l]) => `<div class="mini-row" data-tip="${esc(name)}: ${fmt(l.locAdded)} LOC added, ${fmt(l.acceptances)} acceptance(s)">
  <div class="mini-label">${esc(name)}</div>
  <div class="mini-track"><div class="mini-fill" style="width:${Math.max(1, (100 * l.locAdded) / max).toFixed(1)}%"></div></div>
  <div class="mini-value">${compact(l.locAdded)}</div>
</div>`,
        )
        .join("\n");
      return `<div class="lang-card"><h3>${esc(t.slug)}</h3>${rows}</div>`;
    })
    .join("\n");
  return cards ? `<div class="lang-grid">${cards}</div>` : "";
}

function buildHtml(days: string[], teams: TeamAggregate[], orgRows: OrgAggregateRow[]): string {
  const orgTotal = (f: (r: OrgAggregateRow) => number | undefined) => orgRows.reduce((sum, r) => sum + (f(r) ?? 0), 0);
  const latest = orgRows[orgRows.length - 1];
  const orgGenerations = orgTotal((r) => r.code_generation_activity_count);
  const orgAcceptances = orgTotal((r) => r.code_acceptance_activity_count);

  const tiles = [
    statTile("Monthly active users", latest ? fmt(latest.monthly_active_users ?? 0) : "-", "org-wide, trailing 28 days"),
    statTile("Lines of code added with AI", fmt(orgTotal((r) => r.loc_added_sum)), "org-wide, this window"),
    statTile("Acceptance activity rate", pct(orgAcceptances, orgGenerations), "acceptances / generations, org-wide"),
    statTile("PRs created by Copilot agent", fmt(orgTotal((r) => r.pull_requests?.total_created_by_copilot)), "org-wide, this window"),
  ].join("\n");

  const trend = lineChart(days, teams);
  const trendNote =
    teams.length > MAX_LINE_SERIES
      ? `<p class="note">Showing the top ${MAX_LINE_SERIES} teams by LOC added; all ${teams.length} teams are in the tables below.</p>`
      : "";

  const empty = teams.length === 0;
  const windowLabel = days.length > 0 ? `${days[0]} to ${days[days.length - 1]} (${days.length} day(s))` : "no data";

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Copilot Usage Dashboard</title>
<style>
  .viz-root {
    color-scheme: light;
    --page: #f9f9f7; --surface-1: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --seq: #2a78d6;
    --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
    --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --page: #0d0d0d; --surface-1: #1a1a19;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --seq: #3987e5;
      --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
      --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface-1: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
    --seq: #3987e5;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
    --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767;
  }
  .viz-root { margin: 0; background: var(--page); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  h3 { font-size: 13px; margin: 0 0 8px; color: var(--ink-2); font-weight: 600; }
  .sub { color: var(--ink-2); margin: 0 0 20px; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px;
    padding: 18px 20px; margin: 0 0 16px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile-label { color: var(--ink-2); font-size: 12px; }
  .tile-value { font-size: 28px; font-weight: 650; margin: 2px 0; }
  .tile-note { color: var(--muted); font-size: 11px; }
  .bar-row { display: grid; grid-template-columns: 160px 1fr 56px; align-items: center; gap: 10px; margin: 0 0 2px; padding: 3px 0; }
  .bar-label { color: var(--ink-2); font-size: 12px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { height: 20px; }
  .bar-fill { height: 100%; min-width: 2px; background: var(--seq); border-radius: 0 4px 4px 0; }
  .bar-value, .mini-value { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  svg { display: block; width: 100%; height: auto; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--baseline); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 11px; }
  .endlabel { fill: var(--ink-2); font-size: 11px; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .crosshair { stroke: var(--baseline); stroke-width: 1; stroke-dasharray: 3 3; }
  .line.s1{stroke:var(--s1)} .line.s2{stroke:var(--s2)} .line.s3{stroke:var(--s3)} .line.s4{stroke:var(--s4)}
  .line.s5{stroke:var(--s5)} .line.s6{stroke:var(--s6)} .line.s7{stroke:var(--s7)} .line.s8{stroke:var(--s8)}
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
  .swatch.s1{background:var(--s1)} .swatch.s2{background:var(--s2)} .swatch.s3{background:var(--s3)} .swatch.s4{background:var(--s4)}
  .swatch.s5{background:var(--s5)} .swatch.s6{background:var(--s6)} .swatch.s7{background:var(--s7)} .swatch.s8{background:var(--s8)}
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 10px 0 0; color: var(--ink-2); font-size: 12px; }
  .legend-item { display: inline-flex; align-items: center; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: right; color: var(--ink-2); font-weight: 600; }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; font-variant-numeric: tabular-nums; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  .lang-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .lang-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .mini-row { display: grid; grid-template-columns: 110px 1fr 48px; align-items: center; gap: 8px; padding: 2px 0; }
  .mini-label { color: var(--ink-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini-track { height: 12px; }
  .mini-fill { height: 100%; min-width: 2px; background: var(--seq); border-radius: 0 3px 3px 0; }
  .note, .caveats { color: var(--muted); font-size: 12px; }
  .caveats { margin-top: 24px; }
  details summary { cursor: pointer; color: var(--ink-2); font-size: 12px; margin-top: 10px; }
  #tooltip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--ink);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.18); display: none; z-index: 10; max-width: 320px; }
  #tooltip .t-title { font-weight: 600; margin-bottom: 2px; }
  #tooltip .t-row { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .empty { color: var(--muted); padding: 30px 0; text-align: center; }
</style>
<div class="viz-root"><div class="wrap">
  <h1>Copilot Usage Dashboard</h1>
  <p class="sub">Team (LOB) level · window: ${esc(windowLabel)}</p>

  <div class="tiles">
${tiles}
  </div>

${empty ? `<div class="card"><div class="empty">No team data in this window. Teams need at least 5 Copilot-seated members, and the user-teams report must be collected. See the README.</div></div>` : `
  <div class="card">
    <h2>Lines of code added with AI, by team</h2>
${barRows(teams)}
  </div>

  <div class="card">
    <h2>Daily lines of code added, by team</h2>
${trend.svg}
    <div class="legend">${trend.legend}</div>
${trendNote}
    <details><summary>View as table</summary><div class="table-wrap" id="trend-table"></div></details>
  </div>

  <div class="card">
    <h2>Team comparison</h2>
${comparisonTable(teams)}
  </div>

  <div class="card">
    <h2>Top languages per team (by LOC added)</h2>
${languageCards(teams)}
  </div>
`}
  <p class="caveats">Active users = distinct users over the window (never summed across days). Acceptance activity rate = code acceptance activities / code generation activities; counters include completions, chat panel actions, and agent edits (LOC added). Teams with fewer than 5 Copilot-seated users are excluded from team data by GitHub; users on multiple teams count toward each team, so team rows do not sum to the org totals shown in the tiles. Usage metrics show adoption, not productivity - pair with delivery metrics.</p>
</div></div>
<div id="tooltip"></div>
<script>
(function () {
  var tooltip = document.getElementById("tooltip");
  function showTip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    var w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8);
    var top = y - h - 10 < 8 ? y + 16 : y - h - 10;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }
  function hideTip() { tooltip.style.display = "none"; }

  document.querySelectorAll("[data-tip]").forEach(function (el) {
    el.addEventListener("mousemove", function (e) { showTip(el.getAttribute("data-tip"), e.clientX, e.clientY); });
    el.addEventListener("mouseleave", hideTip);
  });

  var data = ${JSON.stringify(trend.hoverData)};
  var svg = document.getElementById("trend-svg");
  if (svg && data.days.length > 0) {
    var crosshair = document.getElementById("crosshair");
    var dots = document.getElementById("hoverdots");
    var seriesColors = ["--s1","--s2","--s3","--s4","--s5","--s6","--s7","--s8"];
    svg.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      var vx = ((e.clientX - rect.left) / rect.width) * 860;
      var best = 0;
      for (var i = 1; i < data.xs.length; i++) {
        if (Math.abs(data.xs[i] - vx) < Math.abs(data.xs[best] - vx)) best = i;
      }
      crosshair.setAttribute("x1", data.xs[best]);
      crosshair.setAttribute("x2", data.xs[best]);
      crosshair.setAttribute("visibility", "visible");
      var maxY = 1;
      data.series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null && v > maxY) maxY = v; }); });
      var html = '<div class="t-title">' + data.days[best] + "</div>";
      var dotSvg = "";
      var style = getComputedStyle(document.querySelector(".viz-root"));
      data.series.forEach(function (s, si) {
        var v = s.values[best];
        if (v === null) return;
        var color = style.getPropertyValue(seriesColors[si]).trim();
        var y = 16 + 256 - (v / maxY) * 256;
        dotSvg += '<circle cx="' + data.xs[best] + '" cy="' + y + '" r="4" fill="' + color + '" stroke="var(--surface-1)" stroke-width="2"/>';
        html += '<div class="t-row"><span class="swatch" style="background:' + color + '"></span>' + s.slug + ": " + v.toLocaleString() + " LOC</div>";
      });
      dots.innerHTML = dotSvg;
      showTip(html, e.clientX, e.clientY);
    });
    svg.addEventListener("mouseleave", function () {
      crosshair.setAttribute("visibility", "hidden");
      dots.innerHTML = "";
      hideTip();
    });

    var tableHost = document.getElementById("trend-table");
    if (tableHost) {
      var t = "<table><thead><tr><th>Day</th>";
      data.series.forEach(function (s) { t += "<th>" + s.slug + "</th>"; });
      t += "</tr></thead><tbody>";
      data.days.forEach(function (d, i) {
        t += "<tr><td>" + d + "</td>";
        data.series.forEach(function (s) {
          var v = s.values[i];
          t += "<td>" + (v === null ? "-" : v.toLocaleString()) + "</td>";
        });
        t += "</tr>";
      });
      tableHost.innerHTML = t + "</tbody></table>";
    }
  }
})();
</script>
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "28" },
      "data-dir": { type: "string" },
      out: { type: "string", default: "dashboard.html" },
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

  const html = "<!doctype html>\n<html lang=\"en\">\n" + buildHtml(days, teams, orgRows) + "\n</html>\n";
  await writeFile(values.out!, html);
  console.log(`Dashboard written to ${values.out}`);
}

await main();
