import { pageLines, readPdf, type PdfPage, type TextLine } from './read.ts';

export interface ValueToken {
  raw: string;
  kind: 'amount' | 'percent' | 'date';
  value: string;
  page: number;
  y: number;
  label: string;
}

export interface Difference {
  kind: 'differs' | 'only-original' | 'only-converted' | 'format' | 'picture';
  label: string;
  original?: ValueToken;
  converted?: ValueToken;
  delta?: string;
}

export interface PartResult {
  name: string;
  found: boolean;
  originalPages: number[];
  convertedPages: number;
  values: number;
  identical: number;
  differences: Difference[];
  totals: { original: string; converted: string; delta: string };
  note?: string;
}

const NUMBER = /(?<![\w.,/])(?:\(\s*)?-?\s*[$€£]?\s*-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*%?\s*\)?(?![\w/])|(?<![\w.,/])(?:\(\s*)?-?\s*[$€£]?\s*-?\d+(?:\.\d+)?\s*%?\s*\)?(?![\w/,]\d)(?![\w/])/g;
const DATE = /(?<![\w/])(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?![\w/])|(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;

function decimal(text: string): string {
  const negative = /^\(.*\)$/.test(text.trim()) || /-/.test(text);
  let digits = text.replace(/[^0-9.]/g, '');
  if (!digits) return '0';
  if (digits.includes('.')) digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  digits = digits.replace(/^0+(?=\d)/, '');
  if (digits === '' || digits === '.') digits = '0';
  return negative && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

function subtract(a: string, b: string): string {
  const scale = (s: string) => (s.split('.')[1] ?? '').length;
  const places = Math.max(scale(a), scale(b));
  const big = (s: string) => {
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const v = BigInt((i || '0') + f.padEnd(places, '0'));
    return neg ? -v : v;
  };
  const d = big(a) - big(b);
  const neg = d < 0n;
  let s = (neg ? -d : d).toString().padStart(places + 1, '0');
  if (places) s = `${s.slice(0, -places)}.${s.slice(-places)}`;
  return `${neg ? '-' : ''}${s}`;
}

function add(a: string, b: string): string {
  return subtract(a, b.startsWith('-') ? b.slice(1) : `-${b}`);
}

export function valuesOf(line: TextLine): ValueToken[] {
  const out: ValueToken[] = [];
  const text = line.text;
  const taken: [number, number][] = [];
  for (const m of text.matchAll(DATE)) {
    const [d, mo, y] = m[4] ? [m[6]!, m[5]!, m[4]] : [m[2]!, m[1]!, m[3]!];
    const year = y.length === 2 ? `20${y}` : y;
    out.push({ raw: m[0], kind: 'date', value: `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, page: line.page, y: line.y, label: '' });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index!;
    if (taken.some(([a, b]) => start < b && start + m[0].length > a)) continue;
    const raw = m[0].trim();
    out.push({ raw, kind: raw.includes('%') ? 'percent' : 'amount', value: decimal(raw), page: line.page, y: line.y, label: '' });
    taken.push([start, start + m[0].length]);
  }
  const order = new Map(out.map((v) => [v, text.indexOf(v.raw)]));
  out.sort((a, b) => order.get(a)! - order.get(b)!);
  const first = line.cells.find((c) => /[A-Za-z]{2}/.test(c.text))?.text ?? '';
  const label = first.replace(/\s+/g, ' ').trim().slice(0, 80);
  for (const v of out) v.label = label;
  return out;
}

const signature = (text: string) => text.replace(/\d/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

function contentLines(pages: PdfPage[]): TextLine[] {
  const perPage = pages.map((p) => ({ page: p, lines: pageLines(p) }));
  const furniture = new Set<string>();
  if (pages.length >= 3) {
    const count = new Map<string, number>();
    for (const { page, lines } of perPage) {
      const seen = new Set<string>();
      for (const l of lines) {
        const key = `${signature(l.text)}@${Math.round(l.y / 6)}`;
        const band = l.y > page.height * 0.8 || l.y < page.height * 0.2;
        if (band && !seen.has(key)) { seen.add(key); count.set(key, (count.get(key) ?? 0) + 1); }
      }
    }
    for (const [key, n] of count) if (n >= Math.max(3, pages.length * 0.5)) furniture.add(key);
  }
  const out: TextLine[] = [];
  for (const { lines } of perPage) {
    for (const l of lines) {
      if (furniture.has(`${signature(l.text)}@${Math.round(l.y / 6)}`)) continue;
      if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(l.text.trim()) || /^\d+\s+of\s+\d+$/.test(l.text.trim())) continue;
      out.push(l);
    }
  }
  return out;
}

function dropRepeatedHeads(lines: TextLine[]): TextLine[] {
  const out: TextLine[] = [];
  const seen = new Set<string>();
  let page = -1;
  let head = 0;
  for (const l of lines) {
    if (l.page !== page) { page = l.page; head = 0; }
    const key = signature(l.text);
    if (head < 4 && out.length && seen.has(key) && !valuesOf(l).some((v) => v.kind !== 'date')) { head++; continue; }
    head = 99;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function lineKey(l: TextLine): { text: string; values: string; words: Set<string> } {
  return {
    text: l.text.replace(/\s+/g, ' ').trim().toLowerCase(),
    values: valuesOf(l).map((v) => `${v.kind}:${v.value}`).join('|'),
    words: new Set(l.text.toLowerCase().match(/[a-z]{3,}/g) ?? []),
  };
}

function locate(part: TextLine[], original: TextLine[]): { start: number; end: number; score: number } {
  const pk = part.map(lineKey);
  const ok = original.map(lineKey);
  const sim = (a: ReturnType<typeof lineKey>, b: ReturnType<typeof lineKey>) => {
    if (a.text === b.text) return 3;
    if (a.values && a.values === b.values) return 2;
    if (a.words.size && b.words.size) {
      let common = 0;
      for (const w of a.words) if (b.words.has(w)) common++;
      if (common / Math.max(a.words.size, b.words.size) >= 0.5) return 1;
    }
    return -1;
  };
  const n = pk.length;
  let prevScore = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  let best = { start: 0, end: -1, score: 0 };
  for (let j = 1; j <= ok.length; j++) {
    const score = new Int32Array(n + 1);
    const start = new Int32Array(n + 1);
    start[0] = j;
    for (let i = 1; i <= n; i++) {
      const diag = prevScore[i - 1]! + sim(pk[i - 1]!, ok[j - 1]!);
      const up = score[i - 1]! - 1;
      const left = prevScore[i]! - 1;
      let s = 0;
      let from = j;
      if (diag > s) { s = diag; from = prevScore[i - 1]! > 0 ? prevStart[i - 1]! : j - 1; }
      if (up > s) { s = up; from = start[i - 1]!; }
      if (left > s) { s = left; from = prevStart[i]!; }
      score[i] = s;
      start[i] = from;
      if (s > best.score) best = { start: from, end: j - 1, score: s };
    }
    prevScore = score;
    prevStart = start;
  }
  return best;
}

function align<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n * m > 40_000_000) {
    const pairs: [number, number][] = [];
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      for (let k = j; k < Math.min(m, j + 50); k++) if (same(a[i]!, b[k]!)) { pairs.push([i, k]); j = k + 1; break; }
    }
    return pairs;
  }
  const dir = new Uint8Array((n + 1) * (m + 1));
  let prev = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const row = new Uint32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      if (same(a[i - 1]!, b[j - 1]!)) { row[j] = prev[j - 1]! + 1; dir[i * (m + 1) + j] = 1; }
      else if (prev[j]! >= row[j - 1]!) { row[j] = prev[j]!; dir[i * (m + 1) + j] = 2; }
      else { row[j] = row[j - 1]!; dir[i * (m + 1) + j] = 3; }
    }
    prev = row;
  }
  const pairs: [number, number][] = [];
  for (let i = n, j = m; i > 0 && j > 0;) {
    const d = dir[i * (m + 1) + j];
    if (d === 1) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

export function comparePart(name: string, originalPages: PdfPage[], convertedPages: PdfPage[], originalLines = contentLines(originalPages)): PartResult {
  const part = dropRepeatedHeads(contentLines(convertedPages));
  const result: PartResult = { name, found: false, originalPages: [], convertedPages: convertedPages.length, values: 0, identical: 0, differences: [], totals: { original: '0', converted: '0', delta: '0' } };
  if (!part.length) {
    result.note = 'no text could be read from this PDF (it may be scanned or drawn as pictures)';
    return result;
  }
  const where = locate(part, originalLines);
  if (where.end < 0 || where.score < Math.max(3, part.length * 0.3)) {
    result.note = 'its content was not found in the original PDF';
    return result;
  }
  result.found = true;
  const region = dropRepeatedHeads(originalLines.slice(where.start, where.end + 1));
  result.originalPages = [...new Set(region.map((l) => l.page))];
  const ov = region.flatMap(valuesOf);
  const cv = part.flatMap(valuesOf);
  result.values = Math.max(ov.length, cv.length);
  const key = (v: ValueToken) => `${v.kind}:${v.value}`;
  const pairs = align(ov, cv, (x, y) => key(x) === key(y));
  const pictures = convertedPages.flatMap((p) => p.images.filter((im) => im.width > 40 && im.height > 40).map((im) => ({ page: p.number, ...im })));
  const inPicture = (before?: ValueToken, after?: ValueToken) => pictures.some((im) =>
    (before ? im.page >= before.page : true) && (after ? im.page <= after.page : true)
    && (!before || im.page !== before.page || im.y + im.height <= before.y + 2)
    && (!after || im.page !== after.page || im.y >= after.y - 2));
  let i = 0;
  let j = 0;
  const flush = (oi: number, cj: number) => {
    const a = ov.slice(i, oi);
    const b = cv.slice(j, cj);
    const before = j > 0 ? cv[j - 1] : undefined;
    const after = cv[cj];
    const both = Math.min(a.length, b.length);
    for (let k = 0; k < both; k++) {
      const x = a[k]!;
      const y = b[k]!;
      const numeric = x.kind === y.kind && x.kind !== 'date';
      result.differences.push({ kind: 'differs', label: y.label || x.label, original: x, converted: y, delta: numeric ? subtract(y.value, x.value) : undefined });
    }
    const pictured = !b.length && a.length > 0 && inPicture(before, after);
    for (const x of a.slice(both)) result.differences.push({ kind: pictured ? 'picture' : 'only-original', label: x.label, original: x });
    for (const y of b.slice(both)) result.differences.push({ kind: 'only-converted', label: y.label, converted: y });
    i = oi;
    j = cj;
  };
  for (const [oi, cj] of pairs) {
    flush(oi, cj);
    const x = ov[oi]!;
    const y = cv[cj]!;
    result.identical++;
    if (x.raw.replace(/\s+/g, '') !== y.raw.replace(/\s+/g, '')) result.differences.push({ kind: 'format', label: y.label || x.label, original: x, converted: y });
    i = oi + 1;
    j = cj + 1;
  }
  flush(ov.length, cv.length);
  const rank: Record<Difference['kind'], number> = { differs: 0, 'only-original': 1, 'only-converted': 2, picture: 3, format: 4 };
  result.differences.sort((x, y) => rank[x.kind] - rank[y.kind]);
  const sum = (list: ValueToken[]) => list.filter((v) => v.kind === 'amount').reduce((s, v) => add(s, v.value), '0');
  const so = sum(ov);
  const sc = sum(cv);
  result.totals = { original: so, converted: sc, delta: subtract(sc, so) };
  return result;
}

export function compareReports(original: Uint8Array, parts: { name: string; data: Uint8Array }[]): { results: PartResult[]; originalPages: number } {
  const originalPages = readPdf(original);
  const lines = contentLines(originalPages);
  if (!lines.length) throw new Error('no text could be read from the original PDF (it may be scanned or drawn as pictures)');
  const results = parts.map((p) => {
    try {
      return comparePart(p.name, originalPages, readPdf(p.data), lines);
    } catch (err) {
      return { name: p.name, found: false, originalPages: [], convertedPages: 0, values: 0, identical: 0, differences: [], totals: { original: '0', converted: '0', delta: '0' }, note: (err as Error).message } as PartResult;
    }
  });
  return { results, originalPages: originalPages.length };
}

const KIND: Record<Difference['kind'], string> = {
  differs: 'Different value',
  'only-original': 'Only in the original',
  'only-converted': 'Only in the converted report',
  format: 'Same value, shown differently',
  picture: 'In a chart (the converted report draws it as a picture; not compared)',
};

const real = (d: Difference) => d.kind === 'differs' || d.kind === 'only-original' || d.kind === 'only-converted';

export function grouped(value: string): string {
  const [whole, fraction] = value.replace('-', '').split('.');
  const digits = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value.startsWith('-') ? '-' : ''}${digits}${fraction !== undefined ? `.${fraction}` : ''}`;
}

export function verdict(r: PartResult): string {
  if (!r.found) return 'NOT CHECKED';
  return r.differences.some(real) ? 'DIFFERENCES' : 'MATCH';
}

export function summaryText(results: PartResult[], originalName: string, originalPages: number): string {
  const lines = [`Data check against ${originalName} (${originalPages} page(s))`, ''];
  for (const r of results) {
    const counts = (k: Difference['kind']) => r.differences.filter((d) => d.kind === k).length;
    lines.push(`${verdict(r).padEnd(12)} ${r.name}`);
    if (!r.found) { lines.push(`             ${r.note ?? ''}`, ''); continue; }
    lines.push(`             original pages ${r.originalPages[0]}-${r.originalPages[r.originalPages.length - 1]}; ${r.values} value(s) compared, ${r.identical} identical`);
    lines.push(`             sum of amounts: original ${grouped(r.totals.original)}, converted ${grouped(r.totals.converted)}, difference ${grouped(r.totals.delta)}`);
    for (const k of ['differs', 'only-original', 'only-converted', 'format', 'picture'] as const) if (counts(k)) lines.push(`             ${KIND[k]}: ${counts(k)}`);
    for (const d of r.differences.filter(real).slice(0, 200)) {
      lines.push(`               - ${d.label || '(no label)'}: original ${d.original ? `${d.original.raw} (page ${d.original.page})` : '-'}, converted ${d.converted ? `${d.converted.raw} (page ${d.converted.page})` : '-'}${d.delta ? `, difference ${grouped(d.delta)}` : ''}`);
    }
    lines.push('');
  }
  const bad = results.filter((r) => verdict(r) !== 'MATCH').length;
  lines.push(bad ? `${bad} of ${results.length} report(s) need a look.` : `All ${results.length} report(s) match the original, value for value.`);
  return `${lines.join('\n')}\n`;
}

const csvCell = (s: string | undefined) => (s === undefined ? '' : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function differencesCsv(results: PartResult[]): string {
  const rows = [['Report', 'Result', 'Kind', 'Label', 'Original value', 'Original page', 'Converted value', 'Converted page', 'Difference']];
  for (const r of results) {
    if (!r.differences.length) rows.push([r.name, verdict(r), '', r.note ?? '', '', '', '', '', '']);
    for (const d of r.differences) rows.push([r.name, verdict(r), KIND[d.kind], d.label, d.original?.raw ?? '', d.original ? String(d.original.page) : '', d.converted?.raw ?? '', d.converted ? String(d.converted.page) : '', d.delta ? grouped(d.delta) : '']);
  }
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function summaryHtml(results: PartResult[], originalName: string, originalPages: number): string {
  const bad = results.filter((r) => verdict(r) !== 'MATCH').length;
  const parts = results.map((r) => {
    const v = verdict(r);
    const rows = r.differences.filter((d) => d.kind !== 'picture').map((d) => `<tr class="${d.kind}"><td>${esc(KIND[d.kind])}</td><td>${esc(d.label)}</td><td class="n">${esc(d.original?.raw ?? '')}</td><td>${d.original ? d.original.page : ''}</td><td class="n">${esc(d.converted?.raw ?? '')}</td><td>${d.converted ? d.converted.page : ''}</td><td class="n">${esc(d.delta ? grouped(d.delta) : '')}</td></tr>`).join('');
    const pictured = r.differences.filter((d) => d.kind === 'picture').length;
    return `<section><h2><span class="v ${v.toLowerCase().replace(' ', '-')}">${v}</span> ${esc(r.name)}</h2>${r.found
      ? `<p>Original pages ${r.originalPages[0]}&ndash;${r.originalPages[r.originalPages.length - 1]} &middot; ${r.values} value(s) compared &middot; ${r.identical} identical &middot; sum of amounts: original <b>${esc(grouped(r.totals.original))}</b>, converted <b>${esc(grouped(r.totals.converted))}</b>, difference <b>${esc(grouped(r.totals.delta))}</b>${pictured ? ` &middot; ${pictured} chart value(s) not compared (drawn as a picture in the converted report)` : ''}</p>${rows ? `<table><tr><th>Kind</th><th>Label</th><th>Original</th><th>Page</th><th>Converted</th><th>Page</th><th>Difference</th></tr>${rows}</table>` : '<p class="ok">Every value is identical.</p>'}`
      : `<p>${esc(r.note ?? '')}</p>`}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Data check</title><style>
body{font:14px/1.45 "Segoe UI",system-ui,Arial,sans-serif;margin:24px;color:#1d2433;background:#f4f6f9}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 6px}
section{background:#fff;border:1px solid #dde3ea;border-radius:10px;padding:14px 16px;margin:14px 0}
.v{display:inline-block;padding:2px 8px;border-radius:5px;font-size:12px;color:#fff;margin-right:6px}
.match{background:#1a7f37}.differences{background:#c62828}.not-checked{background:#9a6700}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-top:1px solid #e3e8ee;padding:4px 6px;text-align:left}td.n{font-family:Consolas,monospace;text-align:right}
tr.format td{color:#6b5200}.ok{color:#1a7f37;font-weight:600}.head{color:#5d6879}
</style></head><body><h1>Data check</h1><p class="head">Original: ${esc(originalName)} (${originalPages} page(s)) &middot; ${results.length} converted report(s) &middot; ${bad ? `<b>${bad} need a look</b>` : '<b>all match, value for value</b>'}</p>${parts}</body></html>\n`;
}
