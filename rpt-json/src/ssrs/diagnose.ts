/**
 * A check of a finished .rdl, read back as it was written: what the designer or the report server would show wrong,
 * so that a converted folder can be judged from a few lines of text instead of opening every report.
 *
 * - custom code left in the report;
 * - items drawn over each other, or reaching past the box, cell or page that holds them;
 * - headings the designer shows as «Expr»;
 * - names left as the designer's defaults, and rows with nothing in them (template mode).
 */

import { child, childElements, descendants, parseXml, textOf, type XmlElement } from './xml.ts';

export interface Finding {
  kind: 'code' | 'overlap' | 'cut off' | 'page' | 'expression' | 'name' | 'empty row' | 'merge' | 'value';
  item: string;
  message: string;
}

const UNITS: Record<string, number> = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6 };
const len = (e: XmlElement | undefined, name: string): number => {
  const m = /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc)\s*$/.exec(textOf(e && child(e, name)));
  return m ? parseFloat(m[1]!) * UNITS[m[2]!]! : 0;
};
const ITEMS = new Set(['Textbox', 'Rectangle', 'Tablix', 'Line', 'Image', 'Subreport', 'Chart', 'GaugePanel', 'Map']);
const DEFAULT_NAME = /^(Textbox|Rectangle|Tablix|Line|Image|Chart|Subreport|Table|Matrix|List)\d+$/;
const EPS = 0.01;

const rowsOf = (t: XmlElement) => childElements(child(t, 'TablixBody/TablixRows') ?? t, 'TablixRow');
const cellsOf = (row: XmlElement) => childElements(child(row, 'TablixCells') ?? row, 'TablixCell');
const widthsOf = (t: XmlElement) => childElements(child(t, 'TablixBody/TablixColumns') ?? t, 'TablixColumn').map((c) => len(c, 'Width'));
const hideRule = (e: XmlElement) => textOf(child(e, 'Visibility/Hidden')).replace(/^\s*=\s*/, '').replace(/\s+/g, ' ').trim();
const unwrap = (s: string): string => {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let whole = true;
    for (let k = 0; k < t.length - 1; k++) {
      if (t[k] === '(') depth++;
      else if (t[k] === ')') depth--;
      if (depth === 0) { whole = false; break; }
    }
    if (!whole) break;
    t = t.slice(1, -1).trim();
  }
  return t;
};
const negated = (s: string): string | undefined => {
  const m = /^Not\b\s*(.*)$/i.exec(unwrap(s));
  return m ? unwrap(m[1]!) : undefined;
};
export const alternates = (a: XmlElement, b: XmlElement): boolean => {
  const x = hideRule(a);
  const y = hideRule(b);
  if (!x || !y) return false;
  const shown = (rule: string) => {
    const inner = negated(rule);
    const m = /^(.+?)\s*=\s*([^=<>]+)$/.exec(inner ?? unwrap(rule));
    return m ? { on: unwrap(m[1]!), value: unwrap(m[2]!), equal: inner !== undefined } : undefined;
  };
  const p = shown(x);
  const q = shown(y);
  if (p && q && p.on === q.on && p.value !== q.value && p.equal === q.equal) return true;
  const shape = (r: string) => r.replace(/<>\s*(-?\d+(?:\.\d+)?|"[^"]*")/g, '<> #');
  const first = (r: string) => /^\((.*)\) OrElse Not \((.*)\)$/.exec(r);
  const fx = first(x);
  const fy = first(y);
  if (fx && unwrap(fx[2]!) === unwrap(y) && shape(fx[1]!) === shape(y)) return true;
  if (fy && unwrap(fy[2]!) === unwrap(x) && shape(fy[1]!) === shape(x)) return true;
  if (fx && fy && unwrap(fx[2]!) === unwrap(fy[2]!) && shape(fx[1]!) === shape(fy[1]!)) return true;
  return negated(x) === unwrap(y) || negated(y) === unwrap(x) || (/^true$/i.test(unwrap(x)) !== /^true$/i.test(unwrap(y)) && /^(true|false)$/i.test(unwrap(x)) && /^(true|false)$/i.test(unwrap(y)));
};
const valueOf = (box: XmlElement) => descendants(box).filter((e) => e.name === 'Value' && !child(e, 'Value')).map(textOf).join('');

/** The checks of one .rdl; `template` adds the team template's own (names, empty rows, the merge's headings). */
export function diagnoseRdl(xml: string, template = false, standardParameters: string[] = []): Finding[] {
  const report = parseXml(xml);
  const out: Finding[] = [];

  // Custom code: none in a template; elsewhere listed, so what is left is plain.
  const code = textOf(child(report, 'Code'));
  if (code.trim()) out.push({ kind: 'code', item: 'Report', message: `custom code: ${(code.match(/^\s*(?:Public\s+|Private\s+)?(?:Shared\s+)?(?:Function|Sub)\s+\w+/gim) ?? []).length} function(s)` });
  for (const box of descendants(report).filter((e) => ITEMS.has(e.name) || e.name === 'Query')) {
    const own = descendants(box).filter((e) => !ITEMS.has(e.name) || e === box);
    const uses = new Set(own.flatMap((e) => (e.children.filter((c): c is string => typeof c === 'string').join('').match(/\bCode\.\w+/g) ?? [])));
    if (uses.size && box.name !== 'Rectangle' && box.name !== 'Tablix') out.push({ kind: 'code', item: box.attributes.Name ?? box.name, message: `calls ${[...uses].join(', ')}` });
  }

  // Items over each other, and past what holds them.
  const extent = (e: XmlElement) => ({ l: len(e, 'Left'), t: len(e, 'Top'), r: len(e, 'Left') + len(e, 'Width'), b: len(e, 'Top') + (e.name === 'Tablix' ? rowsOf(e).reduce((a, r) => a + len(r, 'Height'), 0) || len(e, 'Height') : len(e, 'Height')) });
  const cellSize = new Map<XmlElement, { w: number; h: number; where: string }>();
  for (const t of descendants(report).filter((e) => e.name === 'Tablix')) {
    const widths = widthsOf(t);
    const declared = len(t, 'Width');
    const total = widths.reduce((a, b) => a + b, 0);
    if (declared && total > declared + EPS) out.push({ kind: 'cut off', item: t.attributes.Name ?? 'Tablix', message: `its columns add up to ${total.toFixed(2)}in, more than its width ${declared.toFixed(2)}in` });
    for (const [r, row] of rowsOf(t).entries()) {
      let column = 0;
      for (const cell of cellsOf(row)) {
        const span = Number(textOf(child(cell, 'CellContents/ColSpan')) || 1);
        const item = childElements(child(cell, 'CellContents') ?? cell).find((e) => ITEMS.has(e.name));
        if (item) cellSize.set(item, { w: widths.slice(column, column + span).reduce((a, b) => a + b, 0), h: len(row, 'Height'), where: `${t.attributes.Name} row ${r + 1}` });
        column += 1;
      }
    }
  }
  for (const holder of descendants(report).filter((e) => e.name === 'ReportItems')) {
    const list = childElements(holder).filter((e) => ITEMS.has(e.name) && e.name !== 'Line' && child(e, 'Top'));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = extent(list[i]!);
        const o = extent(list[j]!);
        if (Math.min(a.r, o.r) - Math.max(a.l, o.l) > 0.001 && Math.min(a.b, o.b) - Math.max(a.t, o.t) > 0.001 && !alternates(list[i]!, list[j]!)) {
          out.push({ kind: 'overlap', item: `${list[i]!.attributes.Name} / ${list[j]!.attributes.Name}`, message: 'drawn over each other' });
        }
      }
    }
    const box = descendants(report).find((e) => e.name === 'Rectangle' && child(e, 'ReportItems') === holder);
    if (!box) continue;
    const size = cellSize.get(box) ?? { w: len(box, 'Width'), h: len(box, 'Height'), where: box.attributes.Name ?? 'Rectangle' };
    if (!size.w) continue;
    for (const item of childElements(holder).filter((e) => ITEMS.has(e.name) && child(e, 'Top'))) {
      const e = extent(item);
      if (e.r > size.w + EPS || (size.h && e.b > size.h + EPS)) out.push({ kind: 'cut off', item: item.attributes.Name ?? item.name, message: `reaches past ${cellSize.has(box) ? `its cell in ${size.where}` : `its box ${size.where}`}` });
    }
  }
  for (const section of descendants(report).filter((e) => e.name === 'ReportSection')) {
    const page = child(section, 'Page') ?? child(report, 'Page');
    const room = len(page, 'PageWidth') - len(page, 'LeftMargin') - len(page, 'RightMargin');
    if (len(page, 'PageWidth') && len(section, 'Width') > room + EPS) out.push({ kind: 'page', item: 'Body', message: `${len(section, 'Width').toFixed(2)}in wide, the page leaves ${room.toFixed(2)}in: a blank page follows each page` });
  }

  if (!template) return out;

  for (const t of descendants(report).filter((e) => e.name === 'Textbox' && /_(?:SubTotVal|TotVal)_[^_]+$/i.test(e.attributes.Name ?? ''))) {
    out.push({ kind: 'merge', item: t.attributes.Name!, message: 'read by the merge as the total of a column named after its last part, which no column has: the merge blanks it' });
  }
  for (const box of descendants(report).filter((e) => e.name === 'Rectangle')) {
    const heads = childElements(child(box, 'ReportItems') ?? box).filter((e) => e.name === 'Textbox' && /_ColTxt$/i.test(e.attributes.Name ?? ''));
    if (heads.length > 1) out.push({ kind: 'merge', item: box.attributes.Name ?? 'Rectangle', message: `holds ${heads.length} column headings (${heads.map((e) => e.attributes.Name).join(', ')}): the merge takes one heading per column` });
  }
  for (const q of descendants(report).filter((e) => e.name === 'QueryParameter')) {
    if (/^=\s*Nothing\s*$/i.test(textOf(child(q, 'Value')))) out.push({ kind: 'value', item: `${q.attributes.Name}`, message: 'passed as Nothing: set the value this schedule needs' });
  }
  if (standardParameters.length) {
    const standard = new Set(standardParameters.map((p) => p.toLowerCase()));
    const defined = descendants(report).filter((e) => e.name === 'ReportParameter').map((e) => e.attributes.Name ?? '');
    const read = new Set(descendants(report).flatMap((e) => e.children.filter((c): c is string => typeof c === 'string')).flatMap((t) => [...t.matchAll(/Parameters!(\w+)/g)].map((m) => m[1]!)));
    for (const name of new Set([...defined, ...read])) {
      if (standard.has(name.toLowerCase())) continue;
      out.push({ kind: 'merge', item: `Parameter ${name}`, message: read.has(name)
        ? 'not a parameter of the base report: the merge does not copy parameters, so the merged report will not publish while this is read'
        : 'not a parameter of the base report: dropped by the merge' });
    }
  }

  // Headings: the merge and the designer read them as text; an expression shows as «Expr».
  const shown = new Set(descendants(report).filter((e) => e.name === 'Textbox' && /_ColVal$/i.test(e.attributes.Name ?? ''))
    .flatMap((e) => [...valueOf(e).matchAll(/Fields!(\w+)\.Value/g)].map((m) => m[1]!.toLowerCase())));
  for (const box of descendants(report).filter((e) => e.name === 'Textbox' && /_ColTxt$/i.test(e.attributes.Name ?? ''))) {
    const v = valueOf(box).trim();
    const named = /^=Fields!(\w+)\.Value$/.exec(v)?.[1];
    if (named && !shown.has(named.toLowerCase())) continue;
    if (v.startsWith('=') && !/^="[^"]*"$/.test(v)) out.push({ kind: 'expression', item: box.attributes.Name!, message: `heading is an expression (the designer shows «Expr»): ${v.slice(0, 80)}` });
  }
  const scoped = descendants(report).filter((e) => ['DataSet', 'Tablix', 'Chart', 'GaugePanel', 'Map', 'Group', 'ChartMember'].includes(e.name) && e.attributes.Name && (e.name !== 'ChartMember' || !!child(e, 'Group')))
    .map((e) => e.attributes.Name!);
  for (const name of new Set(scoped.filter((n, i) => scoped.indexOf(n) !== i))) {
    out.push({ kind: 'name', item: name, message: 'used by more than one data set, data region or group: the report will not run' });
  }
  for (const item of descendants(report).filter((e) => ITEMS.has(e.name) && DEFAULT_NAME.test(e.attributes.Name ?? ''))) {
    out.push({ kind: 'name', item: item.attributes.Name!, message: 'keeps the designer\'s default name' });
  }
  for (const t of descendants(report).filter((e) => e.name === 'Tablix')) {
    for (const [r, row] of rowsOf(t).entries()) {
      const cells = cellsOf(row);
      const blank = cells.every((c) => {
        const inner = descendants(c).filter((e) => e.name === 'Textbox' || e.name === 'Image' || e.name === 'Subreport' || e.name === 'Chart' || e.name === 'Tablix');
        return inner.every((e) => e.name === 'Textbox' && !valueOf(e).trim()) && !descendants(c).some((e) => e.name === 'Line')
          && !descendants(c).some((e) => /^(Top|Bottom)Border$/.test(e.name) && !/^None$/i.test(textOf(child(e, 'Style')) || 'None'));
      });
      // (An empty row of a line or more is the space Crystal left there; a sliver is left over from a section.)
      const ruled = (other: XmlElement | undefined, side: string) => !!other && descendants(other).some((e) => (e.name === `${side}Border` || e.name === 'Border') && /solid|dashed|dotted|double/i.test(textOf(child(e, 'Style'))));
      const spacing = ruled(rowsOf(t)[r - 1], 'Bottom') || ruled(rowsOf(t)[r + 1], 'Top');
      if (cells.length && blank && !spacing && len(row, 'Height') < 0.1) out.push({ kind: 'empty row', item: `${t.attributes.Name} row ${r + 1}`, message: `a sliver ${len(row, 'Height').toFixed(3)}in high with nothing in it, hard to find in the designer` });
    }
  }
  // The merge hides and moves the columns of the first table by its headings: headings only in a later table are not
  // found there.
  const tables = descendants(child(report, 'ReportSections') ?? report).filter((e) => e.name === 'Tablix');
  const headed = (t: XmlElement) => descendants(t).some((e) => e.name === 'Textbox' && /_ColTxt$/i.test(e.attributes.Name ?? ''));
  const later = tables.slice(1).find(headed);
  if (tables[0] && !headed(tables[0]) && later) out.push({ kind: 'merge', item: tables[0].attributes.Name ?? 'Tablix', message: `the first table has no _ColTxt heading, ${later.attributes.Name} has: the merge looks for the headings in the first` });
  return out;
}

/** One line: the counts by kind, or "clean". */
export function diagnosisLine(findings: Finding[]): string {
  if (!findings.length) return 'clean';
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

/** The findings of one file, a heading and one line each, to read or paste as they are. */
export function diagnosisText(file: string, findings: Finding[]): string {
  return [`${file}: ${diagnosisLine(findings)}`, ...findings.map((f) => `  - [${f.kind}] ${f.item}: ${f.message}`)].join('\n');
}
