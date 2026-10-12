/**
 * A converted report reshaped as a team's own report template: their names for every item, one rectangle holding
 * the report's table(s), the title as the table's first row, a row shown when there is no data, the totals printed
 * under the table as the table's last row, their shared data source, their report parameters, and their looks read
 * at run time from a style dataset (=First(Fields!<role>_<property>.Value, "<style dataset>")).
 *
 * Positions, sizes, text, formats, groups, sorts and show/hide rules stay as converted from Crystal; only names,
 * where things sit (title, totals) and looks change.
 *
 * Everything team-specific comes from a conventions file (JSON); what it leaves out keeps a plain default:
 *
 *   {
 *     "names": { "rect": "{S}_Box{n}", "table": "{S}_Table{n}", "title": "{S}_Title", "heading": "{T}_{col}_Heading",
 *                "value": "{T}_{col}", "groupText": "{T}_{col}_Group", "subtotalText": "{T}_{col}_SubtotalLabel",
 *                "subtotal": "{T}_{col}_Subtotal", "totalText": "{T}_TotalLabel", "total": "{T}_{col}_Total",
 *                "blank": "{T}_Blank{n}", "noData": "{T}_NoData", "footer": "{S}_Footnote", "text": "{S}_Text{n}",
 *                "cellRect": "{T}_{col}_Box", "cellLine": "{T}_{col}_Line{n}",
 *                "line": "{S}_Line{n}", "image": "{S}_Image{n}", "chart": "{S}_Chart{n}", "group": "{S}_Group{n}",
 *                "details": "{S}_Details" },
 *     "prefixes": { "Long_Report_File_Name": "Short" },
 *     "dataset": "{S}_Data",
 *     "dataSource": { "name": "Shared", "reference": "Shared" },
 *       (or, to preview on a machine not connected to the report server, a connection of its own:
 *        { "name": "Shared", "connectString": "Data Source=server;Initial Catalog=database" })
 *     "parameters": [ { "name": "as_of", "match": "date", "prompt": "as of", "dataType": "DateTime" } ],
 *     "page": { "width": "11in", "height": "8.5in", "margin": "0.25in", "font": "Georgia" },
 *     "pageBands": "drop",
 *     "noData": "No {title} data for this period",
 *     "documentMap": true,
 *     "style": { "dataset": "Theme", "commandType": "StoredProcedure", "command": "dbo.theme_get",
 *                "field": "{role}_{prop}",
 *                "props": { "FontFamily": "font_family", "FontSize": "font_size", "FontWeight": "font_weight",
 *                           "Color": "color", "BackgroundColor": "background", "VerticalAlign": "vertical_align" },
 *                "roles": { "title": "Title", "heading": "Head", "headingFirst": "Head_First", "body": "Body",
 *                           "bodyFirst": "Body_First", "number": "Number", "group": "Group", "totalLabel": "Total_Label",
 *                           "totalValue": "Total_Value", "footer": "Footnote", "text": "Text" },
 *                "rowBands": { "odd": "Row_Odd", "even": "Row_Even" },
 *                "border": "Border_{side}" }
 *   }
 *
 * Name patterns: {S} the report's name, {T} its table's, {col} the column (the field a cell shows, else the field
 * its column shows, else its heading), {n} a number counting from 1. Names are made unique by adding _2, _3, ...
 */

import { child, childElements, descendants, el, parseXml, textOf, toXml, type XmlElement } from './xml.ts';
import { parametersLayout, type ReviewNote } from './rdl.ts';

const NAME_KEYS = ['rect', 'table', 'title', 'heading', 'value', 'groupText', 'subtotalText', 'subtotal', 'totalText', 'total',
  'blank', 'noData', 'footer', 'text', 'cellRect', 'cellLine', 'line', 'image', 'chart', 'group', 'details'] as const;
type NameKey = typeof NAME_KEYS[number];

const ROLE_KEYS = ['title', 'heading', 'headingFirst', 'body', 'bodyFirst', 'number', 'group', 'totalLabel', 'totalValue', 'footer', 'text'] as const;
type RoleKey = typeof ROLE_KEYS[number];

const STYLE_PROPS = ['FontFamily', 'FontSize', 'FontWeight', 'Color', 'BackgroundColor', 'TextAlign', 'VerticalAlign'] as const;

export interface Conventions {
  names: Record<NameKey, string>;
  /** Short names for reports ({S}), by report (file) name; others use their file name. */
  prefixes: Record<string, string>;
  dataset?: string;
  dataSource?: { name: string; reference?: string; connectString?: string };
  parameters: { name: string; match: RegExp; prompt?: string; dataType?: string }[];
  page?: { width?: string; height?: string; margin?: string; font?: string };
  pageBands: 'drop' | 'keep';
  noData: string;
  documentMap: boolean;
  style?: {
    dataset: string;
    commandType?: string;
    command: string;
    field: string;
    props: Partial<Record<typeof STYLE_PROPS[number], string>>;
    roles: Partial<Record<RoleKey, string>>;
    rowBands?: { odd: string; even: string };
    border?: string;
  };
}

const DEFAULT_NAMES: Record<NameKey, string> = {
  rect: '{S}_Box{n}', table: '{S}_Table{n}', title: '{S}_Title', heading: '{T}_{col}_Heading', value: '{T}_{col}',
  groupText: '{T}_{col}_Group', subtotalText: '{T}_{col}_SubtotalLabel', subtotal: '{T}_{col}_Subtotal',
  totalText: '{T}_TotalLabel', total: '{T}_{col}_Total', blank: '{T}_Blank{n}', noData: '{T}_NoData', footer: '{S}_Footnote',
  text: '{S}_Text{n}', cellRect: '{T}_{col}_Box', cellLine: '{T}_{col}_Line{n}', line: '{S}_Line{n}', image: '{S}_Image{n}', chart: '{S}_Chart{n}', group: '{S}_Group{n}', details: '{S}_Details',
};

/** Reads and checks a conventions file. */
export function readConventions(json: string): Conventions {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`not valid JSON: ${(err as Error).message}`);
  }
  const object = (key: string, value: unknown, allowed?: readonly string[]): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key ? `"${key}"` : 'the file'} must be a JSON object`);
    const o = value as Record<string, unknown>;
    const extra = allowed ? Object.keys(o).filter((k) => !allowed.includes(k)) : [];
    if (extra.length) throw new Error(`${key ? `"${key}" has u` : 'u'}nknown entr${extra.length > 1 ? 'ies' : 'y'} ${extra.map((k) => `"${k}"`).join(', ')} (expected ${allowed!.join(', ')})`);
    return o;
  };
  const text = (key: string, value: unknown, required = false): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty text`);
    return value.trim();
  };
  const o = object('', raw, ['names', 'prefixes', 'dataset', 'dataSource', 'parameters', 'page', 'pageBands', 'noData', 'documentMap', 'style'])!;
  const pre = object('prefixes', o.prefixes) ?? {};
  const prefixes = Object.fromEntries(Object.entries(pre).map(([k, v]) => [k.toLowerCase(), text(`prefixes.${k}`, v)!]));
  const names = { ...DEFAULT_NAMES };
  const n = object('names', o.names, NAME_KEYS);
  for (const k of NAME_KEYS) if (n?.[k] !== undefined) names[k] = text(`names.${k}`, n[k])!;
  const ds = object('dataSource', o.dataSource, ['name', 'reference', 'connectString']);
  if (ds && ds.reference !== undefined && ds.connectString !== undefined) throw new Error('"dataSource" takes a "reference" or a "connectString", not both');
  const page = object('page', o.page, ['width', 'height', 'margin', 'font']);
  if (o.parameters !== undefined && !Array.isArray(o.parameters)) throw new Error('"parameters" must be a list');
  const parameters = ((o.parameters ?? []) as unknown[]).map((p, i) => {
    const q = object(`parameters[${i}]`, p, ['name', 'match', 'prompt', 'dataType'])!;
    const match = text(`parameters[${i}].match`, q.match, true)!;
    let re: RegExp;
    try {
      re = new RegExp(match, 'i');
    } catch {
      throw new Error(`"parameters[${i}].match" is not a valid pattern: ${match}`);
    }
    return { name: text(`parameters[${i}].name`, q.name, true)!, match: re, prompt: text(`parameters[${i}].prompt`, q.prompt), dataType: text(`parameters[${i}].dataType`, q.dataType) };
  });
  if (o.pageBands !== undefined && o.pageBands !== 'drop' && o.pageBands !== 'keep') throw new Error('"pageBands" must be "drop" or "keep"');
  if (o.documentMap !== undefined && typeof o.documentMap !== 'boolean') throw new Error('"documentMap" must be true or false');
  const s = object('style', o.style, ['dataset', 'commandType', 'command', 'field', 'props', 'roles', 'rowBands', 'border']);
  let style: Conventions['style'];
  if (s) {
    const props = object('style.props', s.props, STYLE_PROPS) ?? {};
    const roles = object('style.roles', s.roles, ROLE_KEYS) ?? {};
    const bands = object('style.rowBands', s.rowBands, ['odd', 'even']);
    style = {
      dataset: text('style.dataset', s.dataset, true)!,
      commandType: text('style.commandType', s.commandType),
      command: text('style.command', s.command, true)!,
      field: text('style.field', s.field) ?? '{role}_{prop}',
      props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, text(`style.props.${k}`, v)!])),
      roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, text(`style.roles.${k}`, v)!])),
      rowBands: bands ? { odd: text('style.rowBands.odd', bands.odd, true)!, even: text('style.rowBands.even', bands.even, true)! } : undefined,
      border: text('style.border', s.border),
    };
  }
  return {
    names,
    prefixes,
    dataset: text('dataset', o.dataset),
    dataSource: ds ? {
      name: text('dataSource.name', ds.name, true)!,
      connectString: text('dataSource.connectString', ds.connectString),
      reference: ds.connectString === undefined ? text('dataSource.reference', ds.reference) ?? text('dataSource.name', ds.name)! : undefined,
    } : undefined,
    parameters,
    page: page ? { width: text('page.width', page.width), height: text('page.height', page.height), margin: text('page.margin', page.margin), font: text('page.font', page.font) } : undefined,
    pageBands: (o.pageBands as 'drop' | 'keep' | undefined) ?? 'drop',
    noData: text('noData', o.noData) ?? 'No {title} data',
    documentMap: (o.documentMap as boolean | undefined) ?? false,
    style,
  };
}

// ---------------------------------------------------------------------------------------------------------------

const ITEMS = new Set(['Textbox', 'Rectangle', 'Tablix', 'Chart', 'Line', 'Image', 'Subreport', 'GaugePanel', 'Map', 'CustomReportItem']);
const TOTALLED = /\b(Sum|Count|CountDistinct|Avg|Min|Max|RunningValue|StDev|StDevP|Var|VarP|First|Last)\s*\(/i;
const NUMERIC = /^System\.(Decimal|Double|Single|Int16|Int32|Int64|Byte|SByte|UInt16|UInt32|UInt64)$/;

const inches = (value: string): number | undefined => {
  const m = /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc)?\s*$/i.exec(value);
  if (!m) return undefined;
  const v = Number(m[1]);
  return { in: v, cm: v / 2.54, mm: v / 25.4, pt: v / 72, pc: v / 6 }[(m[2] ?? 'in').toLowerCase() as 'in'];
};
const inch = (v: number) => `${Math.round(v * 100000) / 100000}in`;
/** Rounded up: what moves below another item never ends up a hair inside it (SSRS then would not push it). */
const inchUp = (v: number) => `${Math.ceil(v * 100000 - 1e-6) / 100000}in`;
const pt = (v: number) => `${Math.round(v * 72 * 10) / 10}pt`;
const len = (e: XmlElement, name: string) => inches(textOf(child(e, name))) ?? 0;

function setChild(parent: XmlElement, name: string, value: string): void {
  const existing = childElements(parent, name)[0];
  if (existing) existing.children = [value];
  else parent.children.push(el(name, value));
}
function removeChildren(parent: XmlElement, names: string[]): void {
  parent.children = parent.children.filter((c) => typeof c !== 'object' || !c || !names.includes((c as XmlElement).name));
}
function ownStyle(item: XmlElement): XmlElement {
  let style = childElements(item, 'Style')[0];
  if (!style) {
    style = el('Style');
    item.children.push(style);
  }
  return style;
}
function runStyles(textbox: XmlElement): XmlElement[] {
  return descendants(textbox).filter((e) => e.name === 'TextRun').map((run) => {
    let style = child(run, 'Style');
    if (!style) {
      style = el('Style');
      run.children.push(style);
    }
    return style;
  });
}
const valuesOf = (textbox: XmlElement) => descendants(textbox).filter((e) => e.name === 'Value').map(textOf);
const valueOf = (textbox: XmlElement) => valuesOf(textbox).join('');
const isBlank = (textbox: XmlElement) => valuesOf(textbox).every((v) => !v.trim() || /^=\s*""\s*$/.test(v));
/** The text a fixed text box shows (undefined for one worked out by an expression). */
function headingText(textbox: XmlElement): string | undefined {
  const fixed = fixedText(textbox);
  if (fixed !== undefined) return fixed;
  const v = valueOf(textbox).trim();
  if (!/^=\s*"(?:[^"]|"")*"(?:\s*&\s*(?:vbCrLf|vbLf|Chr\(10\)|"(?:[^"]|"")*"))*\s*$/i.test(v)) return undefined;
  return [...v.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')).join(' ').trim() || undefined;
}

function fixedText(textbox: XmlElement): string | undefined {
  const parts = valuesOf(textbox);
  if (parts.some((v) => v.startsWith('=') && !/^=\s*"([^"]|"")*"\s*$/.test(v))) return undefined;
  const t = parts.map((v) => (v.startsWith('=') ? v.replace(/^=\s*"|"\s*$/g, '').replace(/""/g, '"') : v)).join('').trim();
  return t || undefined;
}
const cellItem = (cell: XmlElement) => childElements(child(cell, 'CellContents') ?? el('CellContents')).find((e) => ITEMS.has(e.name));
const snake = (text: string) => text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1');

/**
 * The column a text box shows: its field, alone or summed up (Fields!X.Value, Sum(Fields!X.Value), ...), without
 * the prefix a field worked out from a Crystal formula has (F_).
 */
const sourceOf = new Map<string, string>();

function fieldOf(textbox: XmlElement): string | undefined {
  const v = valueOf(textbox).trim();
  const m = /^=\s*(?:\w+\(\s*)?Fields!(\w+)\.Value(?:\s*(?:,\s*"[^"]*"\s*)?\))?\s*$/i.exec(v)
    // (A field shown in one of the places it can stand: "IIf(<its place> = k, Fields!X.Value, Nothing)".)
    ?? /^=\s*IIf\([\s\S]*,\s*Fields!(\w+)\.Value\s*,\s*(?:Nothing|\(?"[^"]*"\)?)\s*\)\s*$/i.exec(v);
  return m?.[1] ? sourceOf.get(m[1]) ?? m[1].replace(/^F_(?=\w)/, '') : undefined;
}
/** A name worked from an item's Crystal name (its number dropped). */
const ownWord = (item: XmlElement) => snake((item.attributes.Name ?? '').replace(/_?\d+$/, '')) || undefined;

class Names {
  private readonly used = new Set<string>();
  make(base: string): string {
    const clean = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z])/, 'R$1');
    const typed = /^(.*)(_(?:SubTotVal|TotVal|SubTotTxt|TotTxt|ColTxt|ColVal|HdrTxt|HdrVal))$/i.exec(clean);
    let name = clean;
    for (let k = 2; this.used.has(name.toLowerCase()); k++) name = typed ? `${typed[1]}_${k}${typed[2]}` : `${clean}_${k}`;
    this.used.add(name.toLowerCase());
    return name;
  }
}

type RowKind = 'heading' | 'noData' | 'groupHeading' | 'detail' | 'subtotal' | 'total';

interface Leaf {
  member: XmlElement;
  kind: RowKind;
}

function restack(tablix: XmlElement, whole = false): void {
  const widths = widthsOf(tablix);
  const spanOf = (cell: XmlElement) => Number(textOf(child(child(cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1);
  const inner = (item: XmlElement | undefined) => (item?.name === 'Rectangle' ? childElements(child(item, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name)) : []);
  const startsOf = (c: number, span: number) => widths.slice(c, c + span).map((_, k) => widths.slice(c, c + k).reduce((a, b) => a + b, 0));
  const columnAt = (starts: number[], x: number) => { let k = 0; while (k + 1 < starts.length && starts[k + 1]! <= x + 0.01) k++; return k; };
  for (const row of rowsOf(tablix)) {
    const cells = cellsOf(row);
    for (let i = 0, c = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (!child(cell, 'CellContents')) continue;
      const span = spanOf(cell);
      const item = cellItem(cell);
      const parts = inner(item);
      const starts = startsOf(c, span);
      const texts = parts.filter((e) => e.name === 'Textbox');
      if (span >= 2 && !groupLabels.has(item!) && texts.length >= 2 && parts.every((e) => e.name === 'Textbox') && cells.slice(i + 1, i + span).every((x) => !child(x, 'CellContents'))) {
        const hidden = (e: XmlElement) => !!child(e, 'Visibility');
        const shown = texts.filter((e) => !hidden(e));
        const home = (e: XmlElement) => columnAt(starts, hidden(e) ? len(e, 'Left') : len(e, 'Left') + len(e, 'Width') / 2);
        const fits = shown.every((e) => len(e, 'Left') + len(e, 'Width') <= starts[home(e)]! + widths[c + home(e)]! + 0.06);
        const homes = new Set(texts.map(home));
        if (fits && homes.size >= 2 && new Set(shown.map(home)).size === shown.length) {
          for (let k = 0; k < span; k++) {
            const mine = texts.filter((e) => home(e) === k);
            for (const e of mine) {
              const left = Math.max(0, len(e, 'Left') - starts[k]!);
              setChild(e, 'Left', inch(left));
              setChild(e, 'Width', inch(Math.max(0.01, Math.min(len(e, 'Width'), widths[c + k]! - left))));
            }
            const content = mine.length
              ? el('Rectangle', { Name: `${item!.attributes.Name ?? 'Rect'}_${k + 1}` }, el('ReportItems', ...mine), ...childElements(item!).filter((e) => e.name === 'Style').map((e) => structuredClone(e)))
              : newTextbox(`__split_${k}`, '', '0pt');
            const target = cells[i + k]!;
            removeChildren(target, ['CellContents']);
            target.children.push(el('CellContents', content));
          }
        }
      }
      c += span;
    }
  }
  const leavesNow = rowLeaves(tablix);
  for (const [r, row] of rowsOf(tablix).entries()) {
    const cells = cellsOf(row);
    if (leavesNow[r]?.kind !== 'heading' && leavesNow[r]?.kind !== 'groupHeading') continue;
    for (let i = 0, c = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (!child(cell, 'CellContents')) continue;
      const span = spanOf(cell);
      const item = cellItem(cell);
      const parts = inner(item);
      const texts = parts.filter((e) => e.name === 'Textbox' && fixedText(e) !== undefined);
      const starts = startsOf(c, span);
      const lowest = texts.length ? Math.max(...texts.map((e) => len(e, 'Top'))) : 0;
      const bottom = texts.filter((e) => len(e, 'Top') >= lowest - 0.05);
      const above = texts.filter((e) => !bottom.includes(e));
      const spansColumns = (e: XmlElement) => new Set(bottom.filter((x) => len(x, 'Left') + len(x, 'Width') / 2 > len(e, 'Left') && len(x, 'Left') + len(x, 'Width') / 2 < len(e, 'Left') + len(e, 'Width')).map((x) => len(x, 'Left'))).size >= 2;
      const home = (e: XmlElement) => columnAt(starts, len(e, 'Left') + len(e, 'Width') / 2);
      if (span >= 2 && !groupLabels.has(item!) && bottom.length >= 2 && above.length >= 1 && above.some(spansColumns) && new Set(bottom.map(home)).size === bottom.length && parts.every((e) => e.name === 'Textbox' || e.name === 'Line')) {
        const cut = Math.min(...bottom.map((e) => len(e, 'Top')));
        const edge = (x: number) => [...starts, starts[span - 1]! + widths[c + span - 1]!].findIndex((v) => Math.abs(v - x) < 0.06);
        const groupEdges = new Set<number>();
        const subEdges = new Set<number>();
        const overRange: [number, number][] = [];
        let ruleStyle: XmlElement | undefined;
        for (const line of parts.filter((e) => e.name === 'Line')) {
          const top = len(line, 'Top');
          const h = len(line, 'Height');
          ruleStyle ??= childElements(line, 'Style')[0];
          if (h > 0.01) {
            const k = edge(len(line, 'Left'));
            if (k < 0) continue;
            if (top <= 0.06 && top + h >= cut - 0.02) groupEdges.add(k);
            else if (top + h > cut - 0.02) subEdges.add(k);
          } else if (top < cut + 0.02) {
            const a = edge(len(line, 'Left'));
            const b = edge(len(line, 'Left') + len(line, 'Width'));
            overRange.push([a < 0 ? 0 : a, b < 0 ? span : b]);
          }
        }
        const rules = child(item!, 'ReportItems')!;
        rules.children = rules.children.filter((x) => typeof x !== 'object' || (x as XmlElement).name !== 'Line');
        const border = (side: string) => {
          const from = child(ruleStyle ?? el('Style'), 'Border') ?? ruleStyle ?? el('Style');
          const b = el(side, { inked: '1' }, el('Style', 'Solid'), el('Width', textOf(child(from, 'Width')) || '1pt'), el('Color', textOf(child(from, 'Color')) || 'Black'));
          return b;
        };
        const addBorder = (target: XmlElement, side: string) => {
          const st = ownStyle(target);
          removeChildren(st, [side]);
          st.children.push(border(side));
        };
        const coverOf = (k: number) => {
          for (let jj = 0, cc = 0; jj < cells.length; jj++) {
            if (!child(cells[jj]!, 'CellContents')) continue;
            const sp = spanOf(cells[jj]!);
            if (k >= cc && k < cc + sp) return cellItem(cells[jj]!);
            cc += sp;
          }
          return undefined;
        };
        const lowerCells: XmlElement[] = [];
        let lifted = 0;
        for (let k = 0; k < widths.length; k++) {
          const within = k - c;
          const tb = within >= 0 && within < span ? bottom.find((e) => home(e) === within) : undefined;
          let content: XmlElement;
          const above = coverOf(k);
          const single = above?.name === 'Textbox' ? above : inner(above).length === 1 && inner(above)[0]!.name === 'Textbox' ? inner(above)[0] : undefined;
          const alone = (within < 0 || within >= span) && single && !isBlank(single) && !/Fields!|Parameters!|\b(Sum|Count|First)\(/i.test(valueOf(single)) ? single : undefined;
          if (tb) {
            rules.children = rules.children.filter((x) => x !== tb);
            unplace(tb);
            content = tb;
          } else if (alone) {
            const holder = cells.find((x) => cellItem(x) === above)!;
            const contents = child(holder, 'CellContents')!;
            const blank = newTextbox(`__lift_${k}`, '', '0pt');
            leftBlank.add(blank);
            const st = child(ownStyle(above!), 'BottomBorder');
            if (st) ownStyle(blank).children.push(structuredClone(st));
            contents.children = contents.children.map((x) => (x === above ? blank : x));
            unplace(alone);
            const lineCount = Math.max(descendants(alone).filter((x) => x.name === 'Paragraph').length, 1 + (valueOf(alone).match(/vbCrLf|vbLf|Chr\(10\)/gi) ?? []).length, (fixedText(alone) ?? '').split(/\r?\n/).length);
            lifted = Math.max(lifted, textHeight(alone, true, widths[k]!) ?? 0.2, lineCount * drawnFont(alone, true).size * DESIGN_LEADING / 72 + 0.04);
            content = alone;
          } else content = newTextbox(`__band_${k}`, '', '0pt');
          const under = above && child(ownStyle(above), 'BottomBorder');
          if (under && /solid|dashed|dotted|double/i.test(textOf(child(under, 'Style')))) {
            removeChildren(ownStyle(content), ['BottomBorder']);
            ownStyle(content).children.push(structuredClone(under));
          }
          const edgeLines = above && above.name === 'Rectangle' && (within < 0 || within >= span) ? inner(above) : [];
          if (edgeLines.length && edgeLines.every((e) => e.name === 'Line' && len(e, 'Height') > 0.01 && len(e, 'Left') < 0.06)) {
            ruleStyle ??= childElements(edgeLines[0]!, 'Style')[0];
            const holder = child(above!, 'ReportItems')!;
            holder.children = holder.children.filter((x) => !edgeLines.includes(x as XmlElement));
            addBorder(above!, 'LeftBorder');
            addBorder(content, 'LeftBorder');
          }
          if (within >= 0 && within < span) {
            if (groupEdges.has(within) || subEdges.has(within)) addBorder(content, 'LeftBorder');
            if (within === span - 1 && groupEdges.has(span)) addBorder(content, 'RightBorder');
            if (overRange.some(([a, b]) => within >= a && within < b)) addBorder(content, 'TopBorder');
          }
          lowerCells.push(el('TablixCell', el('CellContents', content)));
        }
        for (const [jj, x] of cells.entries()) {
          const it = cellItem(x);
          if (it) removeChildren(ownStyle(it), ['BottomBorder']);
          void jj;
        }
        const cutsAt = [...groupEdges].filter((k) => k > 0 && k < span).sort((a, b) => a - b);
        const segments = [0, ...cutsAt, span].slice(0, -1).map((a, n) => [a, [...cutsAt, span][n]!] as [number, number]);
        const rest = childElements(rules).filter((e) => ITEMS.has(e.name));
        for (const [a, b] of segments) {
          const mine = rest.filter((e) => { const mid = len(e, 'Left') + len(e, 'Width') / 2; return mid >= starts[a]! - 0.01 && (b >= span || mid < starts[b]!); });
          for (const e of mine) setChild(e, 'Left', inch(Math.max(0, len(e, 'Left') - starts[a]!)));
          const box = el('Rectangle', { Name: `${item!.attributes.Name ?? 'Rect'}_${a + 1}` }, el('ReportItems', ...mine), el('KeepTogether', 'true'), el('Style', el('Border', el('Style', 'None'))));
          if (groupEdges.has(a)) addBorder(box, 'LeftBorder');
          if (groupEdges.has(b)) addBorder(box, 'RightBorder');
          const target = cells[i + a]!;
          removeChildren(target, ['CellContents']);
          target.children.push(el('CellContents', box, b - a > 1 ? el('ColSpan', String(b - a)) : null));
          groupLabels.add(box);
          for (const e of mine) groupLabels.add(e);
        }
        if (whole) {
          const upper = cellsOf(row);
          const boxes: { box: XmlElement; left: number; width: number }[] = [];
          let plain = true;
          for (let q = 0, cc = 0; q < upper.length; q++) {
            const contents = child(upper[q]!, 'CellContents');
            if (!contents) continue;
            const sp = spanOf(upper[q]!);
            const it = cellItem(upper[q]!);
            if (it && groupLabels.has(it)) boxes.push({ box: it, left: widths.slice(0, cc).reduce((x, y) => x + y, 0), width: widths.slice(cc, cc + sp).reduce((x, y) => x + y, 0) });
            else if (it && !(it.name === 'Textbox' && isBlank(it)) && !(it.name === 'Rectangle' && !inner(it).length)) plain = false;
            cc += sp;
          }
          if (plain && boxes.length) {
            for (const g of boxes) {
              removeChildren(g.box, ['Top', 'Left', 'Height', 'Width']);
              g.box.children.splice(1, 0, el('Top', '0in'), el('Left', inch(g.left)), el('Height', inch(cut)), el('Width', inch(g.width)));
            }
            const band = el('Rectangle', { Name: `${item!.attributes.Name ?? 'Rect'}_band` }, el('ReportItems', ...boxes.map((g) => g.box)), el('KeepTogether', 'true'), el('Style', el('Border', el('Style', 'None'))));
            groupLabels.add(band);
            const all = widths.length;
            child(row, 'TablixCells')!.children = [el('TablixCell', el('CellContents', band, all > 1 ? el('ColSpan', String(all)) : null)), ...Array.from({ length: all - 1 }, () => el('TablixCell'))];
          }
        }
        const height = len(row, 'Height');
        const band = Math.max(lifted, ...bottom.map((e) => len(e, 'Height'))) + 0.03;
        setChild(row, 'Height', inch(cut));
        void height;
        const lower = el('TablixRow', el('Height', inch(band)), el('TablixCells', ...lowerCells));
        const rowsEl = child(tablix, 'TablixBody/TablixRows')!;
        rowsEl.children.splice(rowsEl.children.indexOf(row) + 1, 0, lower);
        const leaf = leavesNow[r]!.member;
        const parent = parentOf(tablix, leaf);
        parent.children.splice(parent.children.indexOf(leaf) + 1, 0, structuredClone(leaf));
        groupLabels.add(item!);
        return restack(tablix, whole);
      }
      c += span;
    }
  }
  for (const row of rowsOf(tablix)) {
    const cells = cellsOf(row);
    const texts = cells.flatMap((cell) => { const item = cellItem(cell); return item?.name === 'Rectangle' ? inner(item) : item ? [item] : []; })
      .filter((e) => e.name === 'Textbox' && !isBlank(e));
    if (texts.filter((e) => fixedText(e) !== undefined).length < 2 || texts.some((e) => /Fields!|\b(Sum|Count|Avg)\(/i.test(valueOf(e)))) continue;
    const mids = texts.map((e) => len(e, 'Top') + len(e, 'Height') / 2);
    const alone = cells.every((cell) => inner(cellItem(cell)).filter((e) => e.name === 'Textbox' && !isBlank(e)).length <= 1);
    if (alone && texts.every((e) => child(e, 'Top')) && Math.max(...mids) - Math.min(...mids) < 0.25) {
      for (const e of texts) {
        setChild(e, 'Top', '0in');
        setChild(ownStyle(e), 'VerticalAlign', 'Middle');
      }
    }
    for (let i = 0, c = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (!child(cell, 'CellContents')) continue;
      const span = spanOf(cell);
      const item = cellItem(cell);
      const parts = inner(item);
      const starts = widths.slice(c, c + span).map((_, k) => widths.slice(c, c + k).reduce((a, b) => a + b, 0));
      const columnOf = (e: XmlElement) => { const mid = len(e, 'Left') + len(e, 'Width') / 2; let k = 0; while (k + 1 < span && starts[k + 1]! <= mid) k++; return k; };
      const placed = parts.map(columnOf);
      if (span >= 2 && !groupLabels.has(item!) && parts.length >= 2 && parts.every((e) => e.name === 'Textbox') && new Set(placed).size === parts.length
        && cells.slice(i + 1, i + span).every((x) => !child(x, 'CellContents'))) {
        for (let k = 0; k < span; k++) {
          const tb = parts[placed.indexOf(k)];
          let content: XmlElement;
          if (tb) {
            const box = el('Rectangle', { Name: `${item!.attributes.Name ?? 'Rect'}_${k + 1}` }, el('ReportItems', tb), ...childElements(item!).filter((e) => e.name === 'Style').map((e) => structuredClone(e)));
            const left = Math.max(0, len(tb, 'Left') - starts[k]!);
            setChild(tb, 'Left', inch(left));
            setChild(tb, 'Width', inch(Math.max(0.01, Math.min(len(tb, 'Width'), widths[c + k]! - left))));
            content = box;
          } else content = newTextbox(`__split_${k}`, '', '0pt');
          const target = cells[i + k]!;
          removeChildren(target, ['CellContents']);
          target.children.push(el('CellContents', content));
        }
      }
      c += span;
    }
    for (let i = 0, c = 0, now = cellsOf(row); i < now.length; i++) {
      if (!child(now[i]!, 'CellContents')) continue;
      const span = spanOf(now[i]!);
      const room = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
      const parts = inner(cellItem(now[i]!));
      const only = parts.length === 1 && parts[0]!.name === 'Textbox' ? parts[0]! : undefined;
      if (only && fixedText(only) !== undefined && descendants(only).some((e) => e.name === 'TextAlign' && /^center$/i.test(textOf(e)))) {
        setChild(only, 'Left', '0in');
        setChild(only, 'Width', inch(room));
      }
      c += span;
    }
  }
  const headNeed = widths.map(() => 0);
  const dataNeed = widths.map(() => 0);
  for (const row of rowsOf(tablix)) {
    const cells = cellsOf(row);
    const headed = cells.flatMap((cell) => { const item = cellItem(cell); return item?.name === 'Rectangle' ? inner(item) : item ? [item] : []; })
      .filter((e) => e.name === 'Textbox' && !isBlank(e));
    const headingRow = headed.length >= 2 && headed.every((e) => headingText(e) !== undefined);
    for (let i = 0, c = 0; i < cells.length; i++) {
      if (!child(cells[i]!, 'CellContents')) continue;
      const span = spanOf(cells[i]!);
      const item = cellItem(cells[i]!);
      if (span === 1) {
        for (const e of item?.name === 'Rectangle' ? inner(item) : item ? [item] : []) {
          if (e.name !== 'Textbox' || isBlank(e)) continue;
          if (headingRow) {
            const { size, bold } = drawnFont(e, true);
            headNeed[c] = Math.max(headNeed[c]!, Math.max(...headingText(e)!.split(/\s+/).map((w) => arialWidth(w, size, bold) * 1.05)) + 0.06);
          } else if (descendants(e).some((x) => x.name === 'Format') && child(e, 'Width')) dataNeed[c] = Math.max(dataNeed[c]!, len(e, 'Left') + len(e, 'Width'));
        }
      }
      c += span;
    }
  }
  if (!widened.has(tablix)) {
    widened.add(tablix);
    const columnEls = childElements(child(tablix, 'TablixBody/TablixColumns')!, 'TablixColumn');
    const widest = widths.indexOf(Math.max(...widths));
    const floorWidest = widths[widest]!;
    const pass = (need: number[], widestShare: number) => {
      const now = widthsOf(tablix);
      const short = need.map((n, k) => Math.max(0, n - now[k]!));
      const wanted = short.reduce((a, b) => a + b, 0);
      if (wanted <= 0.005) return;
      const keep = (k: number) => Math.max(headNeed[k]!, dataNeed[k]!) + 0.05;
      const others = now.map((w, k) => (short[k]! > 0 || k === widest ? 0 : Math.max(0, w - Math.max(keep(k), widths[k]! * 0.85))));
      const fromOthers = others.reduce((a, b) => a + b, 0);
      const fromWidest = short[widest]! > 0 ? 0 : Math.max(0, Math.min(wanted - Math.min(wanted, fromOthers), now[widest]! - Math.max(keep(widest), floorWidest * widestShare)));
      const spare = others.map((v, k) => (k === widest ? fromWidest : v));
      const room = spare.reduce((a, b) => a + b, 0);
      const give = Math.min(wanted, room);
      if (give <= 0.005) return;
      columnEls.forEach((col, k) => {
        if (spare[k]! > 0) setChild(col, 'Width', inch(now[k]! - spare[k]! * give / room));
        else if (short[k]! > 0) setChild(col, 'Width', inch(now[k]! + short[k]! * give / wanted));
      });
    };
    pass(dataNeed, 0.7);
    pass(headNeed, 0.85);
  }
  {
    const now = widthsOf(tablix);
    {
      for (const row of rowsOf(tablix)) {
        for (let i = 0, c = 0, cells = cellsOf(row); i < cells.length; i++) {
          if (!child(cells[i]!, 'CellContents')) continue;
          const span = spanOf(cells[i]!);
          const room = now.slice(c, c + span).reduce((x, y) => x + y, 0);
          const was = widths.slice(c, c + span).reduce((x, y) => x + y, 0);
          const oldEdges = [0, ...widths.slice(c, c + span).map((_, k) => widths.slice(c, c + k + 1).reduce((x, y) => x + y, 0))];
          const newEdges = [0, ...now.slice(c, c + span).map((_, k) => now.slice(c, c + k + 1).reduce((x, y) => x + y, 0))];
          const moved = (x: number) => {
            for (let k = 0; k < span; k++) {
              if (x <= oldEdges[k + 1]! + 0.0005 || k === span - 1) {
                const part = oldEdges[k + 1]! - oldEdges[k]!;
                return newEdges[k]! + (part > 0 ? (Math.min(x, oldEdges[k + 1]!) - oldEdges[k]!) / part : 0) * (newEdges[k + 1]! - newEdges[k]!);
              }
            }
            return x;
          };
          for (const e of inner(cellItem(cells[i]!))) {
            if (!child(e, 'Width')) continue;
            if (span > 1 && Math.abs(room - was) > 0.001) {
              const l = moved(len(e, 'Left'));
              const r = moved(len(e, 'Left') + len(e, 'Width'));
              setChild(e, 'Left', inch(l));
              setChild(e, 'Width', inch(e.name === 'Line' && len(e, 'Width') < 0.02 ? len(e, 'Width') : Math.max(0.01, r - l)));
            } else if (len(e, 'Left') + len(e, 'Width') > room + 0.0005 || (room > was + 0.001 && Math.abs(len(e, 'Left') + len(e, 'Width') - was) < 0.01)) setChild(e, 'Width', inch(Math.max(0.01, room - len(e, 'Left'))));
          }
          const box = cellItem(cells[i]!);
          if (box?.name === 'Rectangle' && child(box, 'Width')) setChild(box, 'Width', inch(room));
          c += span;
        }
      }
    }
  }
  {
    const final = widthsOf(tablix);
    for (const row of rowsOf(tablix)) {
      const cells = cellsOf(row);
      const own = (cell: XmlElement) => { const it = cellItem(cell); const ins = inner(it); return it?.name === 'Textbox' ? it : ins.length === 1 && ins[0]!.name === 'Textbox' ? ins[0] : undefined; };
      const headed = cells.map(own).filter((e): e is XmlElement => !!e && !isBlank(e));
      if (headed.length < 2 || !headed.every((e) => headingText(e) !== undefined)) continue;
      for (let i = 0, c = 0; i < cells.length; i++) {
        if (!child(cells[i]!, 'CellContents')) continue;
        const span = spanOf(cells[i]!);
        const e = own(cells[i]!);
        if (span === 1 && e && headingText(e)) {
          const { size, bold } = drawnFont(e, true);
          const word = Math.max(...headingText(e)!.split(/\s+/).map((w) => arialWidth(w, size, bold) * 1.2));
          const room = final[c]! - 0.06;
          if (word > room) e.attributes.capsize = String(Math.max(6.5, Math.floor(size * room / word * 2) / 2));
        }
        c += span;
      }
      const caps = headed.map((e) => Number(e.attributes.capsize)).filter((n) => n > 0);
      if (caps.length) for (const e of headed) e.attributes.capsize = String(Math.min(...caps));
    }
  }
  const members = rowLeaves(tablix);
  for (const [r, row] of rowsOf(tablix).entries()) {
    const cells = cellsOf(row);
    const placedIn = cells.map((cell) => { const item = cellItem(cell); return item?.name === 'Rectangle' ? inner(item) : []; });
    const ruled = placedIn.flat().filter((e) => e.name === 'Textbox' && ruledAbove(e));
    const skip = ruled.length ? Math.max(0, Math.min(...ruled.map((e) => len(e, 'Top'))) - 0.028) : 0;
    if (skip > 0.01) for (const e of placedIn.flat()) if (child(e, 'Top')) setChild(e, 'Top', inch(Math.max(0, len(e, 'Top') - skip)));
    const leaf = members[r]?.member;
    if (!leaf || child(leaf, 'Group') || members[r]!.kind === 'detail' || members[r]!.kind === 'noData') continue;
    if (cells.some((cell) => { const item = cellItem(cell); return item && item.name !== 'Rectangle' && !(item.name === 'Textbox' && isBlank(item)); })) continue;
    const all = placedIn.flat().filter((e) => child(e, 'Top'));
    const mixable = members[r]!.kind === 'total' || members[r]!.kind === 'subtotal';
    const height = len(row, 'Height');
    const cut = [...new Set(all.map((e) => len(e, 'Top')))].sort((a, b) => a - b)
      .find((t) => t > 0.01 && all.every((e) => len(e, 'Top') >= t || len(e, 'Top') + len(e, 'Height') <= t + 0.01) && all.some((e) => len(e, 'Top') < t) && all.some((e) => len(e, 'Top') >= t)
        && (mixable || placedIn.every((items) => items.every((e) => len(e, 'Top') >= t) || items.every((e) => len(e, 'Top') < t))));
    if (cut === undefined) continue;
    for (const e of all.filter((x) => len(x, 'Top') >= cut && x.name === 'Textbox' && headingText(x) !== undefined)) {
      const v = valueOf(e);
      const lines = Math.max(descendants(e).filter((x) => x.name === 'Paragraph').length, 1 + (v.match(/vbCrLf|vbLf|Chr\(10\)/gi) ?? []).length, (fixedText(e) ?? '').split(/\r?\n/).length);
      const own = descendants(e).filter((x) => x.name === 'FontSize' && !textOf(x).startsWith('=')).map((x) => (inches(textOf(x)) ?? 0) * 72).filter((x) => x > 0);
      const size = own.length ? Math.max(...own) : DESIGN_FONT;
      const need = lines * size * 1.25 / 72 + paddingOf(e, ['PaddingTop', 'PaddingBottom']) + 0.05;
      if (need > len(e, 'Height')) setChild(e, 'Height', inch(need));
    }
    const lowerBottom = Math.max(...all.filter((e) => len(e, 'Top') >= cut).map((e) => len(e, 'Top') + len(e, 'Height')));
    const lowerCells: XmlElement[] = [];
    const blank = (k: number) => el('CellContents', newTextbox(`__split_${k}`, '', '0pt'));
    let lowerCovered = 0;
    let upperFill = 0;
    for (let k = 0, c = 0; k < cells.length; k++) {
      const cell = cells[k]!;
      const contents = child(cell, 'CellContents');
      if (!contents) {
        if (upperFill > 0) { upperFill--; cell.children.push(blank(k)); }
        if (lowerCovered > 0) { lowerCovered--; lowerCells.push(el('TablixCell')); } else lowerCells.push(el('TablixCell', blank(k)));
        c++;
        continue;
      }
      const span = spanOf(cell);
      const items = placedIn[k]!;
      const below = items.filter((e) => len(e, 'Top') >= cut);
      const above = items.filter((e) => len(e, 'Top') < cut);
      for (const e of below) setChild(e, 'Top', inch(len(e, 'Top') - cut));
      if (below.length && !above.length) {
        lowerCells.push(el('TablixCell', contents));
        cell.children = cell.children.filter((x) => x !== contents);
        cell.children.push(blank(k));
        lowerCovered = span - 1;
        upperFill = span - 1;
      } else if (below.length) {
        const holder = child(cellItem(cell)!, 'ReportItems')!;
        holder.children = holder.children.filter((x) => !below.includes(x as XmlElement));
        lowerCells.push(el('TablixCell', el('CellContents', el('Rectangle', { Name: `${cellItem(cell)!.attributes.Name ?? 'Rect'}_low` }, el('ReportItems', ...below), el('KeepTogether', 'true'), el('Style', el('Border', el('Style', 'None')))), span > 1 ? el('ColSpan', String(span)) : null)));
        lowerCovered = span - 1;
        const fits = above.every((e) => len(e, 'Left') + len(e, 'Width') <= widths[c]! + 0.15);
        if (span > 1 && fits) {
          removeChildren(contents, ['ColSpan']);
          upperFill = span - 1;
        } else upperFill = 0;
      } else {
        lowerCells.push(el('TablixCell', blank(k)));
        if (span > 1) lowerCells[lowerCells.length - 1]!.children[0] = el('CellContents', newTextbox(`__split_${k}`, '', '0pt'), el('ColSpan', String(span)));
        lowerCovered = span - 1;
        upperFill = 0;
      }
      c += span;
    }
    setChild(row, 'Height', inch(cut));
    const lower = el('TablixRow', el('Height', inch(Math.max(height - cut, lowerBottom - cut + 0.02))), el('TablixCells', ...lowerCells));
    stackedRows.add(lower);
    const filledLow = childElements(child(lower, 'TablixCells')!, 'TablixCell').filter((x) => { const it = cellItem(x); return it && !(it.name === 'Textbox' && isBlank(it)); });
    if (whole && filledLow.length === 1 && cellItem(filledLow[0]!)!.name === 'Rectangle') {
      const lowCells = childElements(child(lower, 'TablixCells')!, 'TablixCell');
      let start = 0;
      for (let i = 0, c = 0; i < lowCells.length; i++) {
        if (lowCells[i] === filledLow[0]) { start = c; break; }
        if (child(lowCells[i]!, 'CellContents')) c += spanOf(lowCells[i]!);
        else c += 0;
      }
      const offset = widths.slice(0, start).reduce((a, b) => a + b, 0);
      const box = cellItem(filledLow[0]!)!;
      for (const e of childElements(child(box, 'ReportItems') ?? el('x')).filter((x) => child(x, 'Left'))) setChild(e, 'Left', inch(len(e, 'Left') + offset));
      const all = widths.length;
      child(lower, 'TablixCells')!.children = [el('TablixCell', el('CellContents', box, all > 1 ? el('ColSpan', String(all)) : null)), ...Array.from({ length: all - 1 }, () => el('TablixCell'))];
    }
    const gap = el('TablixRow', el('Height', '0.15in'), el('TablixCells', ...cells.map((_, k) => el('TablixCell', el('CellContents', newTextbox(`__gap_${k}`, '', '0pt'))))));
    const rowsEl = child(tablix, 'TablixBody/TablixRows')!;
    rowsEl.children.splice(rowsEl.children.indexOf(row) + 1, 0, lower, gap);
    const parent = parentOf(tablix, leaf);
    parent.children.splice(parent.children.indexOf(leaf) + 1, 0, structuredClone(leaf), structuredClone(leaf));
    return restack(tablix, whole);
  }
}

const stackedRows = new WeakSet<XmlElement>();
const widened = new WeakSet<XmlElement>();
const leftBlank = new WeakSet<XmlElement>();
const groupLabels = new WeakSet<XmlElement>();

function parentOf(root: XmlElement, target: XmlElement): XmlElement {
  return [root, ...descendants(root)].find((e) => e.children.includes(target))!;
}

/** Each row's leaf member of the row hierarchy and what the row is. */
function rowLeaves(tablix: XmlElement): Leaf[] {
  const out: Leaf[] = [];
  const hasGroup = (m: XmlElement) => descendants(m).some((e) => e.name === 'Group');
  const walk = (members: XmlElement | undefined, level: number, details: boolean) => {
    const list = childElements(members ?? el('TablixMembers'), 'TablixMember');
    const firstDynamic = list.findIndex(hasGroup);
    list.forEach((m, i) => {
      const group = child(m, 'Group');
      const isDetails = details || (!!group && !child(group, 'GroupExpressions'));
      const nested = child(m, 'TablixMembers');
      if (nested) return walk(nested, group ? level + 1 : level, isDetails);
      if (/CountRows\(\)\s*(>|&gt;)/.test(textOf(child(m, 'Visibility/Hidden')))) return out.push({ member: m, kind: 'noData' });
      if (isDetails || group) return out.push({ member: m, kind: 'detail' });
      const after = firstDynamic >= 0 && i > firstDynamic;
      out.push({ member: m, kind: level === 0 ? (after || out.some((l) => l.kind === 'detail') ? 'total' : 'heading') : after ? 'subtotal' : 'groupHeading' });
    });
  };
  walk(child(tablix, 'TablixRowHierarchy/TablixMembers'), 0, false);
  return out;
}

const rowsOf = (tablix: XmlElement) => childElements(child(tablix, 'TablixBody/TablixRows') ?? el('TablixRows'), 'TablixRow');
const cellsOf = (row: XmlElement) => childElements(child(row, 'TablixCells') ?? el('TablixCells'), 'TablixCell');
const widthsOf = (tablix: XmlElement) => childElements(child(tablix, 'TablixBody/TablixColumns') ?? el('TablixColumns'), 'TablixColumn').map((c) => len(c, 'Width'));

function newTextbox(name: string, value: string, padding = '2pt'): XmlElement {
  return el('Textbox', { Name: name },
    el('CanGrow', 'true'), el('KeepTogether', 'true'),
    el('Paragraphs', el('Paragraph', el('TextRuns', el('TextRun', el('Value', value), el('Style'))), el('Style'))),
    el('Style', el('Border', el('Style', 'None')), el('PaddingLeft', padding), el('PaddingRight', padding), el('PaddingTop', padding), el('PaddingBottom', padding)));
}

/** A new row of the table: one cell holding an item across every column. */
function spanningRow(height: number, item: XmlElement, columns: number): XmlElement {
  const cells: XmlElement[] = [el('TablixCell', el('CellContents', item, columns > 1 ? el('ColSpan', String(columns)) : null))];
  for (let i = 1; i < columns; i++) cells.push(el('TablixCell'));
  return el('TablixRow', el('Height', inch(height)), el('TablixCells', ...cells));
}

/** Adds to a text box's padding on each side (in inches). */
function pad(textbox: XmlElement, add: { left?: number; right?: number; top?: number; bottom?: number }): void {
  const style = ownStyle(textbox);
  for (const [side, amount] of Object.entries(add) as [string, number | undefined][]) {
    if (!amount || amount <= 0) continue;
    const key = `Padding${side[0]!.toUpperCase()}${side.slice(1)}`;
    const current = textOf(child(style, key));
    if (current.startsWith('=')) continue;
    setChild(style, key, pt((inches(current || '0pt') ?? 0) + amount));
  }
}
/** A report item moved into a table cell: the cell places it. */
const unplace = (item: XmlElement) => removeChildren(item, ['Top', 'Left', 'Height', 'Width', 'ZIndex']);

// ---------------------------------------------------------------------------------------------------------------

/** Reshapes a converted report as a template following the conventions. */
export function applyConventions(rdl: string, reportName: string, conv: Conventions, prefix?: string, extra: { sqlFunctions?: string[]; parameterValues?: Record<string, string> } = {}): { rdl: string; review: ReviewNote[]; settled: string[]; files?: Record<string, string> } {
  const review: ReviewNote[] = [];
  const root = parseXml(rdl);
  const report = root.name === 'Report' ? root : descendants(root).find((e) => e.name === 'Report')!;
  const S = snake(prefix ?? conv.prefixes[reportName.toLowerCase()] ?? reportName) || 'Report';
  designText = !!conv.style;
  sourceOf.clear();
  for (const f of descendants(report).filter((e) => e.name === 'Field' && child(e, 'Value'))) {
    const read = [...new Set([...textOf(child(f, 'Value')).matchAll(/Fields!(\w+)\.Value/g)].map((x) => x[1]!))];
    if (read.length === 1 && f.attributes.Name) sourceOf.set(f.attributes.Name, read[0]!);
  }
  const names = new Names();
  const itemRenames = new Map<string, string>();
  const scopeRenames = new Map<string, string>();
  const paramRenames = new Map<string, string>();
  const counters = new Map<string, number>();
  const fill = (key: NameKey, vars: { T?: string; col?: string }) => {
    let pattern = conv.names[key];
    if (pattern.includes('{n}')) {
      // One count per pattern (groups and details groups named alike count together).
      const id = `${pattern}|${pattern.includes('{T}') ? vars.T ?? '' : ''}|${pattern.includes('{col}') ? vars.col ?? '' : ''}`;
      const n = (counters.get(id) ?? 0) + 1;
      counters.set(id, n);
      pattern = pattern.replace(/\{n\}/g, String(n));
    }
    return pattern.replace(/\{S\}/g, S).replace(/\{T\}/g, vars.T ?? S).replace(/\{col\}/g, vars.col ?? 'col');
  };
  const rename = (item: XmlElement, key: NameKey, vars: { T?: string; col?: string } = {}) => {
    const old = item.attributes.Name;
    const name = names.make(fill(key, vars));
    if (old && old !== name) {
      itemRenames.set(old, name);
      scopeRenames.set(old, name);
    }
    item.attributes.Name = name;
    named.add(item);
    if (key === 'heading') headings.add(item);
    return name;
  };
  const headings = new Set<XmlElement>();

  const named = new Set<XmlElement>();

  // ----- Data: data source, datasets, parameters.
  const dataSources = descendants(report).filter((e) => e.name === 'DataSource');
  if (conv.dataSource && dataSources[0]) {
    const ds = dataSources[0];
    const old = ds.attributes.Name ?? '';
    const id = child(ds, 'rd:DataSourceID');
    ds.attributes.Name = conv.dataSource.name;
    ds.children = conv.dataSource.connectString
      ? [el('ConnectionProperties', el('DataProvider', 'SQL'), el('ConnectString', conv.dataSource.connectString), el('IntegratedSecurity', 'true')), el('rd:SecurityType', 'Integrated'), id ?? null]
      : [el('DataSourceReference', conv.dataSource.reference!), el('rd:SecurityType', 'None'), id ?? null];
    for (const e of descendants(report)) if (e.name === 'DataSourceName' && textOf(e) === old) e.children = [conv.dataSource.name];
  }
  const dataSets = descendants(report).filter((e) => e.name === 'DataSet');
  const firstTablix = descendants(report).find((e) => e.name === 'Tablix' && textOf(child(e, 'DataSetName')));
  const mainName = textOf(child(firstTablix, 'DataSetName')) || dataSets[0]?.attributes.Name || '';
  const main = dataSets.find((d) => d.attributes.Name === mainName);
  if (conv.dataset && main) {
    const name = conv.dataset.replace(/\{S\}/g, S);
    scopeRenames.set(mainName, name);
    main.attributes.Name = name;
    // The other tables' and charts' datasets: the same pattern, numbered after the report's name (2, 3, ...).
    let n = 1;
    const taken = new Set(dataSets.map((d) => (d.attributes.Name ?? '').toLowerCase()));
    // (Then any other dataset, read by name in an expression: reports combined into one keep only the first dataset
    // of each name, so each report's own are named after it.)
    const regionSets = descendants(report).filter((e) => (e.name === 'Tablix' || e.name === 'Chart') && child(e, 'DataSetName'))
      .map((region) => dataSets.find((d) => d.attributes.Name === textOf(child(region, 'DataSetName'))));
    const done = new Set<XmlElement>([main]);
    // (One nothing reads is left out further on: it takes no number.)
    const read = (name: string) => descendants(report).some((e) => (e.name === 'DataSetName' && textOf(e) === name) || (textOf(e).startsWith('=') && textOf(e).includes(`"${name}"`)));
    for (const ds of [...regionSets, ...dataSets]) {
      const old = ds?.attributes.Name ?? '';
      if (!ds || done.has(ds) || old === conv.style?.dataset || !read(old)) continue;
      done.add(ds);
      let other: string;
      do other = conv.dataset.includes('{S}') ? conv.dataset.replace(/\{S\}/g, `${S}_${++n}`) : `${name}_${++n}`;
      while (taken.has(other.toLowerCase()));
      taken.add(other.toLowerCase());
      scopeRenames.set(old, other);
      ds.attributes.Name = other;
    }
  }
  const fieldTypes = new Map<string, string>();
  for (const f of descendants(main ?? el('x')).filter((e) => e.name === 'Field')) fieldTypes.set(f.attributes.Name ?? '', textOf(child(f, 'rd:TypeName')));

  const parameters = child(report, 'ReportParameters');
  if (conv.parameters.length) {
    const taken = new Set<string>();
    const existing = childElements(parameters ?? el('x'), 'ReportParameter');
    for (const p of existing) {
      const old = p.attributes.Name ?? '';
      // (A date parameter becomes only a date one, and a date one only a date parameter.)
      const type = textOf(child(p, 'DataType'));
      const fits = (s: { dataType?: string }) => !s.dataType || (s.dataType === 'DateTime') === (type === 'DateTime');
      const std = conv.parameters.find((s) => !taken.has(s.name) && fits(s) && (s.name.toLowerCase() === old.toLowerCase() || s.match.test(old)));
      if (!std) continue;
      if (existing.some((q) => q !== p && q.attributes.Name?.toLowerCase() === std.name.toLowerCase())) continue;
      taken.add(std.name);
      if (old !== std.name) {
        paramRenames.set(old, std.name);
        review.push({ item: `Parameter ${std.name}`, message: `was Crystal's ${old}` });
      }
      p.attributes.Name = std.name;
      if (std.prompt) setChild(p, 'Prompt', std.prompt);
    }
    const missing = conv.parameters.filter((s) => !taken.has(s.name) && !existing.some((q) => q.attributes.Name?.toLowerCase() === s.name.toLowerCase()));
    if (missing.length) {
      const list = parameters ?? el('ReportParameters');
      if (!parameters) insertBefore(report, list, ['ReportParametersLayout', 'Code', 'EmbeddedImages', 'Language', 'ConsumeContainerWhitespace', 'rd:ReportUnitType', 'rd:ReportID']);
      for (const s of missing) list.children.push(el('ReportParameter', { Name: s.name }, el('DataType', s.dataType ?? 'String'), el('Prompt', s.prompt ?? s.name)));
      // The parameters pane lays out every parameter (Report Builder fails on one missing from it).
      const layout = parametersLayout(childElements(list, 'ReportParameter').map((p) => p.attributes.Name ?? ''));
      removeChildren(report, ['ReportParametersLayout']);
      if (layout) report.children.splice(report.children.indexOf(list) + 1, 0, layout);
    }
  }

  // ----- Page: the team's page, where the report fits it; page header and footer.
  const section = descendants(report).find((e) => e.name === 'ReportSection');
  const body = child(section, 'Body');
  const page = child(section, 'Page');
  let reportWidth = len(section ?? el('x'), 'Width');
  if (conv.page && page) {
    const width = inches(conv.page.width ?? '') ?? len(page, 'PageWidth');
    const margin = conv.page.margin ? inches(conv.page.margin) : undefined;
    const usable = width - (margin ?? len(page, 'LeftMargin')) * 2;
    // What the body holds decides (the report may be drawn wider than what is in it).
    const content = Math.max(0, ...childElements(child(body, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name)).map((e) => len(e, 'Left') + len(e, 'Width')));
    if (content <= usable + 0.01) {
      reportWidth = Math.floor(usable * 100000) / 100000;
      setChild(section!, 'Width', inch(reportWidth));
      if (conv.page.width) setChild(page, 'PageWidth', conv.page.width);
      if (conv.page.height) setChild(page, 'PageHeight', conv.page.height);
      if (conv.page.margin) for (const m of ['LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin']) setChild(page, m, conv.page.margin);
    } else {
      review.push({ item: 'Page', message: `the report is ${inch(content)} wide, wider than the standard page leaves room for; Crystal's page size is kept` });
    }
  }
  if (conv.page?.font) for (const e of descendants(report).filter((x) => x.name === 'df:DefaultFontFamily')) e.children = [conv.page.font];
  // The report's title, where Crystal printed it in the page header: the fixed text in the largest letters (not a
  // label such as "As of:" or "Page"). It is kept, as the table's title.
  let headerTitle: XmlElement | undefined;
  if (page && conv.pageBands === 'drop') {
    const size = (tb: XmlElement) => Math.max(0, ...descendants(tb).filter((e) => e.name === 'FontSize').map((e) => inches(textOf(e)) ?? 0));
    const candidates = descendants(child(page, 'PageHeader') ?? el('x')).filter((e) => e.name === 'Textbox' && !child(e, 'Visibility')).filter((tb) => {
      const t = fixedText(tb);
      return !!t && t.length > 3 && !/:\s*$/.test(t) && !/^(as of|page|date|run date|printed)\b/i.test(t) && !/Globals!|Parameters!/.test(valueOf(tb));
    });
    headerTitle = candidates.sort((a, b) => size(b) - size(a))[0];
    if (headerTitle) {
      const parent = descendants(page).find((e) => childElements(e).includes(headerTitle!));
      if (parent) parent.children = parent.children.filter((c) => c !== headerTitle);
    }
    for (const band of ['PageHeader', 'PageFooter']) {
      const b = child(page, band);
      if (!b) continue;
      const shown = descendants(b).filter((e) => e.name === 'Textbox').map((t) => fixedText(t) ?? valueOf(t)).filter((v) => v.trim());
      review.push({ item: band === 'PageHeader' ? 'Page header' : 'Page footer', message: `left out (a template has none; the combined report prints its own)${shown.length ? `: ${shown.join(' | ')}` : ''}` });
      removeChildren(page, [band]);
    }
  }

  // ----- Roles each text box takes its looks from.
  const roles = new Map<XmlElement, RoleKey>();
  const unbanded = new Set<XmlElement>();
  const tableCells = new Set<XmlElement>();
  const bandRows: XmlElement[] = [];

  // ----- Tables.
  const tablixes = body ? descendants(body).filter((e) => e.name === 'Tablix') : [];
  const groups = descendants(report).filter((e) => e.name === 'Group');
  let titleText: string | undefined;
  const parents = new Map<XmlElement, XmlElement>();
  for (const e of descendants(report)) for (const c of childElements(e)) parents.set(c, e);

  for (const tablix of tablixes) {
    const T = rename(tablix, 'table');
    const container = parents.get(tablix);
    foldMargins(tablix);
    restack(tablix, tablix === tablixes[0]);
    const widths = widthsOf(tablix);
    const columns = widths.length;
    const isNumber = (tb: XmlElement) => {
      const f = fieldOf(tb);
      if (f && NUMERIC.test(fieldTypes.get(f) ?? '')) return true;
      const format = descendants(tb).find((e) => e.name === 'Format');
      return (!!format && /[#0]/.test(textOf(format)) && !/[dMyHhms]/.test(textOf(format))) || /^=\s*(Sum|Count|Avg|CountDistinct)\(/i.test(valueOf(tb));
    };

    // The title: fixed text just above the table, within its width, becomes its first row.
    const tTop = len(tablix, 'Top');
    const tLeft = len(tablix, 'Left');
    const tWidth = widths.reduce((a, b) => a + b, 0) || len(tablix, 'Width');
    const siblings = container ? childElements(container).filter((e) => ITEMS.has(e.name) && e !== tablix) : [];
    const above = siblings.filter((e) => e.name === 'Textbox' && fixedText(e) && len(e, 'Top') + len(e, 'Height') <= tTop + 0.01
      && len(e, 'Left') >= tLeft - 0.1 && len(e, 'Left') + len(e, 'Width') <= tLeft + tWidth + 0.1)
      .sort((a, b) => len(b, 'Top') - len(a, 'Top'));
    const nearest = above[0];
    // Nothing else between the title and the table, nor beside the title over the table's width (a logo, a label):
    // the title is a line of its own.
    const between = nearest && siblings.some((e) => e !== nearest && len(e, 'Top') < tTop && len(e, 'Top') + len(e, 'Height') > len(nearest, 'Top') + 0.01
      && len(e, 'Left') < tLeft + tWidth && len(e, 'Left') + len(e, 'Width') > tLeft);
    const leaves0 = rowLeaves(tablix);
    if (nearest && !between && tTop - (len(nearest, 'Top') + len(nearest, 'Height')) <= 0.5 && tablix === tablixes[0]) {
      const top = len(nearest, 'Top');
      const height = tTop - top;
      titleText = fixedText(nearest);
      // A frame drawn round the title (an empty box of the same middle over it): the title cell's border.
      const nl = len(nearest, 'Left');
      const nr = nl + len(nearest, 'Width');
      const frame = siblings.find((e) => e.name === 'Rectangle' && !child(e, 'ReportItems') && drawnAs(e) && !child(e, 'Visibility')
        && Math.abs(len(e, 'Left') + len(e, 'Width') / 2 - (nl + nr) / 2) < 0.1
        && len(e, 'Top') < top + len(nearest, 'Height') && len(e, 'Top') + len(e, 'Height') > top);
      if (frame) {
        const own = ownStyle(nearest);
        for (const side of ['Border', ...BORDER_SIDES]) {
          const border = child(childElements(frame, 'Style')[0], side);
          if (border) {
            removeChildren(own, [side]);
            own.children.unshift(border);
          }
        }
        container!.children = container!.children.filter((c) => c !== frame);
      }
      container!.children = container!.children.filter((c) => c !== nearest);
      pad(nearest, { left: Math.max(0, len(nearest, 'Left') - tLeft), right: Math.max(0, tLeft + tWidth - len(nearest, 'Left') - len(nearest, 'Width')) });
      unplace(nearest);
      rename(nearest, 'title');
      roles.set(nearest, 'title');
      tableCells.add(nearest);
      const rowsEl = child(tablix, 'TablixBody/TablixRows')!;
      const row = spanningRow(height, nearest, columns);
      rowsEl.children.unshift(row);
      bandRows.push(row);
      const repeat = leaves0[0]?.kind === 'heading' && textOf(child(leaves0[0].member, 'RepeatOnNewPage')) === 'true';
      const member = el('TablixMember', el('KeepWithGroup', 'After'), repeat ? el('RepeatOnNewPage', 'true') : null);
      child(tablix, 'TablixRowHierarchy/TablixMembers')!.children.unshift(member);
      setChild(tablix, 'Top', inch(top));
      setChild(tablix, 'Height', inch(len(tablix, 'Height') + height));
    } else if (headerTitle && tablix === tablixes[0]) {
      // The title from the page header: over the table, as its first row.
      const height = Math.max(len(headerTitle, 'Height'), 0.2);
      titleText = fixedText(headerTitle);
      unplace(headerTitle);
      rename(headerTitle, 'title');
      roles.set(headerTitle, 'title');
      tableCells.add(headerTitle);
      const row = spanningRow(height, headerTitle, columns);
      child(tablix, 'TablixBody/TablixRows')!.children.unshift(row);
      bandRows.push(row);
      const repeat = leaves0[0]?.kind === 'heading' && textOf(child(leaves0[0].member, 'RepeatOnNewPage')) === 'true';
      child(tablix, 'TablixRowHierarchy/TablixMembers')!.children.unshift(el('TablixMember', el('KeepWithGroup', 'After'), repeat ? el('RepeatOnNewPage', 'true') : null));
      const oldBottom = len(tablix, 'Top') + len(tablix, 'Height');
      setChild(tablix, 'Height', inch(len(tablix, 'Height') + height));
      // What lies under the table (a rule, the next table) moves down as far.
      if (container) moveBelow(container, tablix, oldBottom, height, tLeft, tLeft + tWidth);
      headerTitle = undefined;
    }

    // Totals printed just under the table, each under a column: the table's last row(s).
    if (container) {
      for (;;) {
        const bottom = len(tablix, 'Top') + len(tablix, 'Height');
        const below = childElements(container).filter((e) => ITEMS.has(e.name) && e !== tablix && len(e, 'Top') >= bottom - 0.01);
        if (!below.length) break;
        const firstTop = Math.min(...below.map((e) => len(e, 'Top')));
        const line = below.filter((e) => len(e, 'Top') < firstTop + 0.05);
        if (firstTop - bottom > 0.5 || line.some((e) => e.name !== 'Textbox')) break;
        const edges = [tLeft];
        for (const w of widths) edges.push(edges[edges.length - 1]! + w);
        const colAt = (x: number) => edges.findIndex((e, i) => i < columns && x >= e - 0.001 && x < edges[i + 1]! - 0.001);
        const placed = line.map((e) => {
          const l = len(e, 'Left');
          const r = l + len(e, 'Width');
          const start = colAt(l + 0.02);
          let end = colAt(r - 0.02);
          if (end < 0 && r <= edges[columns]! + 0.1) end = columns - 1;
          return { e, l, r, start, end };
        });
        // Only where every item sits under columns of its own (none starting left of the table or past its end).
        const used = new Set<number>();
        const fits = placed.every((p) => p.start >= 0 && p.end >= p.start && [...Array(p.end - p.start + 1).keys()].every((k) => !used.has(p.start + k) && (used.add(p.start + k), true)));
        if (!fits || !placed.some((p) => !isBlank(p.e))) break;
        const height = Math.max(...line.map((e) => len(e, 'Top') + len(e, 'Height'))) - bottom;
        const cells: XmlElement[] = [];
        for (let c = 0; c < columns;) {
          const p = placed.find((x) => x.start === c);
          if (!p) {
            cells.push(el('TablixCell', el('CellContents', newTextbox(`__blank_${c}`, '', '0pt'))));
            c++;
            continue;
          }
          const span = p.end - p.start + 1;
          pad(p.e, { left: p.l - edges[p.start]!, right: edges[p.end + 1]! - Math.min(p.r, edges[p.end + 1]!), top: len(p.e, 'Top') - bottom });
          unplace(p.e);
          cells.push(el('TablixCell', el('CellContents', p.e, span > 1 ? el('ColSpan', String(span)) : null)));
          for (let k = 1; k < span; k++) cells.push(el('TablixCell'));
          c += span;
        }
        container.children = container.children.filter((x) => !line.includes(x as XmlElement));
        child(tablix, 'TablixBody/TablixRows')!.children.push(el('TablixRow', el('Height', inch(Math.max(height, 0.01))), el('TablixCells', ...cells)));
        child(tablix, 'TablixRowHierarchy/TablixMembers')!.children.push(el('TablixMember', el('KeepWithGroup', 'Before')));
        setChild(tablix, 'Height', inch(len(tablix, 'Height') + height));
      }
    }

    // Crystal's blank band where there is no data (copies of the data rows, shown only then): the team's message row
    // takes its place, as in their templates (the copies would read as doubled rows in the designer).
    {
      const blank = rowLeaves(tablix).map((l, i) => ({ ...l, i })).filter((l) => l.kind === 'noData');
      if (blank.length) {
        const rowsEl = child(tablix, 'TablixBody/TablixRows')!;
        const all = rowsOf(tablix);
        let dropped = 0;
        for (const l of blank) {
          const holder = descendants(child(tablix, 'TablixRowHierarchy')!).find((e) => e.name === 'TablixMembers' && e.children.includes(l.member));
          // (Only where the row's member is not the last of its list: a list may not be left empty.)
          if (!holder || childElements(holder, 'TablixMember').length < 2) continue;
          holder.children = holder.children.filter((c) => c !== l.member);
          dropped += len(all[l.i]!, 'Height');
          rowsEl.children = rowsEl.children.filter((c) => c !== all[l.i]);
        }
        // (Those rows were never counted in the table's height, which shows the table with data: it is its rows'.)
        if (dropped) setChild(tablix, 'Height', inch(Math.max(0.01, rowsOf(tablix).reduce((sum, row) => sum + len(row, 'Height'), 0))));
      }
    }

    // A sliver of a row with nothing in it (a section Crystal kept a few points high, empty): the designer can hardly
    // find or select it, and it prints only that space, so it goes.
    {
      const all = rowsOf(tablix);
      const rowsEl = child(tablix, 'TablixBody/TablixRows')!;
      rowLeaves(tablix).forEach((l, i) => {
        const row = all[i];
        if (!row || len(row, 'Height') >= 0.1 || child(l.member, 'Group') || !emptyRow(row)) return;
        if ((all[i - 1] && ruledRow(all[i - 1]!, 'Bottom')) || (all[i + 1] && ruledRow(all[i + 1]!, 'Top'))) return;
        const holder = descendants(child(tablix, 'TablixRowHierarchy')!).find((e) => e.name === 'TablixMembers' && e.children.includes(l.member));
        if (!holder || childElements(holder, 'TablixMember').length < 2 || rowsOf(tablix).length < 2) return;
        holder.children = holder.children.filter((c) => c !== l.member);
        rowsEl.children = rowsEl.children.filter((c) => c !== row);
        setChild(tablix, 'Height', inch(Math.max(0.01, rowsOf(tablix).reduce((sum, r) => sum + len(r, 'Height'), 0))));
      });
    }

    // A title Crystal printed in the table's own header (as in a group over the whole report): the first row, one
    // fixed text across the table, over its headings. It is the table's title, with the rule of the box round it.
    if (tablix === tablixes[0] ? !titleText : !!rowLeaves(tablix)[0]) {
      const first = rowsOf(tablix)[0];
      const kind = rowLeaves(tablix)[0]?.kind;
      const shown = (e: XmlElement) => [e, ...descendants(e)].some((x) => x.name === 'Textbox' && !isBlank(x));
      const filled = first && (kind === 'heading' || kind === 'groupHeading') && rowsOf(tablix).length > 1
        ? cellsOf(first).map((cell, c) => ({ cell, c, item: cellItem(cell) })).filter((x) => x.item && shown(x.item)) : [];
      const only = filled.length === 1 ? filled[0]! : undefined;
      const item = only?.item;
      const inner = item?.name === 'Rectangle' ? childElements(child(item, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name)) : item ? [item] : [];
      const tb = inner.length === 1 && inner[0]!.name === 'Textbox' ? inner[0]! : undefined;
      const span = only ? Number(textOf(child(child(only.cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1) : 0;
      const spanWidth = only ? widths.slice(only.c, only.c + span).reduce((a, b) => a + b, 0) : 0;
      const words = tb ? fixedText(tb) : undefined;
      // (Over headings of its own: the next row is two or more fixed texts.)
      const next = rowsOf(tablix).slice(1).find((r) => !emptyRow(r));
      const under = next ? descendants(next).filter((e) => e.name === 'Textbox' && !isBlank(e)) : [];
      const headingsUnder = under.filter((e) => fixedText(e) !== undefined).length >= 2
        || (under.length >= 3 && under.some((e) => fixedText(e) !== undefined) && under.every((e) => !/\b(Sum|Count|Avg|RunningValue)\s*\(/i.test(valueOf(e))));
      if (only && item && tb && words && words.trim().length > 3 && !/:\s*$/.test(words) && span >= 2 && headingsUnder
        && spanWidth >= 0.8 * tWidth && !child(item, 'Visibility')) {
        if (item !== tb) {
          const own = ownStyle(tb);
          const from = childElements(item, 'Style')[0];
          for (const side of [...BORDER_SIDES].reverse()) {
            const border = child(from, side);
            if (border && !/^none$/i.test(textOf(child(border, 'Style')))) {
              removeChildren(own, [side]);
              own.children.unshift(structuredClone(border));
            }
          }
          pad(tb, { left: len(tb, 'Left'), top: ruledAbove(tb) ? 0 : len(tb, 'Top'), right: Math.max(0, spanWidth - len(tb, 'Left') - len(tb, 'Width')) });
          unplace(tb);
          const contents = child(only.cell, 'CellContents')!;
          contents.children = contents.children.map((x) => (x === item ? tb : x));
        }
        if (tablix === tablixes[0]) {
          titleText = words.trim();
          rename(tb, 'title');
        } else {
          rename(tb, 'text', { T });
        }
        roles.set(tb, 'title');
        tableCells.add(tb);
      }
    }

    // A row shown only when there is no data, under the headings: where the table has headings of its own (a table
    // of lines with none, as a statement under another, prints nothing then, as in Crystal).
    const leaves = rowLeaves(tablix);
    const memberList = child(tablix, 'TablixRowHierarchy/TablixMembers')!;
    const top = childElements(memberList, 'TablixMember');
    // The leading rows that are headings (each its own top-level member).
    let at = 0;
    while (at < top.length && leaves[at]?.member === top[at] && leaves[at]!.kind === 'heading') at++;
    const headed = rowsOf(tablix).slice(0, at).some((row) => descendants(row).some((e) => e.name === 'Textbox' && !isBlank(e)));
    if (textOf(child(tablix, 'DataSetName')) && headed && !leaves.some((l) => l.kind === 'noData')) {
      const ownTitle = descendants(tablix).find((e) => e.name === 'Textbox' && roles.get(e) === 'title');
      const what = ((ownTitle && fixedText(ownTitle)) ?? titleText ?? reportName.replace(/_/g, ' ')).trim();
      const message = conv.noData.replace(/\{TITLE\}/g, what.toUpperCase()).replace(/\{title\}/g, what);
      const row = spanningRow(0.2, newTextbox('__nodata', message), columns);
      child(tablix, 'TablixBody/TablixRows')!.children.splice(at, 0, row);
      const repeat = at > 0 && textOf(child(top[at - 1]!, 'RepeatOnNewPage')) === 'true';
      const member = el('TablixMember', el('KeepWithGroup', 'After'), repeat ? el('RepeatOnNewPage', 'true') : null, el('Visibility', el('Hidden', '=CountRows() > 0')));
      if (at < top.length) memberList.children.splice(memberList.children.indexOf(top[at]!), 0, member);
      else memberList.children.push(member);
      const oldBottom = len(tablix, 'Top') + len(tablix, 'Height');
      setChild(tablix, 'Height', inch(len(tablix, 'Height') + 0.2));
      // What lies under the table moves down as far (the row is hidden when there is data; then all moves back up).
      if (container) moveBelow(container, tablix, oldBottom, 0.2, tLeft, tLeft + tWidth);
    }

    // Column names: the field each column shows in its data row, else its heading.
    const rows = rowsOf(tablix);
    const kinds = rowLeaves(tablix).map((l) => l.kind);
    // Rows of column headings (Crystal's, or fixed text only in a group's header).
    const headingRow = (row: XmlElement, i: number) => {
      const texts = descendants(row).filter((e) => e.name === 'Textbox' && !isBlank(e));
      return (kinds[i] === 'heading' && !texts.some((e) => roles.get(e) === 'title'))
        || (kinds[i] === 'groupHeading' && texts.length > 1 && texts.every((e) => fixedText(e) !== undefined));
    };
    // A heading across columns: in its first column, the others given empty headings drawn alike. Where reports are
    // combined, columns are found by their headings, one each, and a row with cells across columns is left out when the
    // columns are put in order (so headings and values would part).
    rows.forEach((row, i) => {
      if (!headingRow(row, i)) return;
      const cells = cellsOf(row);
      for (let c = 0; c < cells.length; c++) {
        const contents = child(cells[c]!, 'CellContents');
        const span = Number(textOf(child(contents ?? el('x'), 'ColSpan')) || 1);
        let tb = cellItem(cells[c]!);
        // (A plain box holding just the heading: the heading itself, placed by its padding.)
        if (tb?.name === 'Rectangle' && span > 1 && !child(tb, 'Visibility') && !drawnAs(tb)) {
          const inner = childElements(child(tb, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name));
          if (inner.length === 1 && inner[0]!.name === 'Textbox') {
            const text = inner[0]!;
            const spanWidth = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
            pad(text, { left: len(text, 'Left'), top: ruledAbove(text) ? 0 : len(text, 'Top'), right: Math.max(0, spanWidth - len(text, 'Left') - len(text, 'Width')) });
            unplace(text);
            contents!.children = contents!.children.map((x) => (x === tb ? text : x));
            tb = text;
          }
        }
        if (span < 2 || span >= columns || !tb || tb.name !== 'Textbox' || fixedText(tb) === undefined) continue;
        // (Too long for its first column: on more lines, where the row has room for them.)
        const lines = Math.ceil(textWidth(tb, true) / Math.max(0.01, widths[c]!) - 0.01);
        const sizes = descendants(tb).filter((e) => e.name === 'FontSize' && !textOf(e).startsWith('=')).map((e) => (inches(textOf(e)) ?? 0) * 72);
        const lineHeight = (Math.max(DESIGN_FONT, ...sizes) * DESIGN_LEADING) / 72;
        if (lines > 1 && lines * lineHeight > len(row, 'Height') + 0.01) {
          review.push({ item: `Table ${T}`, message: `the heading "${fixedText(tb)}" is over columns ${c + 1} to ${c + span} and too long for one: where reports are combined, those columns cannot be chosen apart` });
          continue;
        }
        if (textAlignOf(tb) !== 'Left' || lines > 1) review.push({ item: `Table ${T}`, message: `the heading "${fixedText(tb)}" was over columns ${c + 1} to ${c + span}; it is over column ${c + 1} only${lines > 1 ? `, on ${lines} lines` : ''} (reports combined need a heading for each column)` });
        removeChildren(contents!, ['ColSpan']);
        const st = childElements(tb, 'Style')[0];
        const right = st ? childElements(st, 'RightBorder')[0] : undefined;
        if (st) removeChildren(st, ['RightBorder']);
        for (let k = 1; k < span; k++) {
          const blank = newTextbox(`__heading_${c + k}`, '', '0pt');
          if (st) {
            const copy = structuredClone(st);
            removeChildren(copy, ['LeftBorder', 'RightBorder']);
            if (k === span - 1 && right) copy.children.push(structuredClone(right));
            blank.children = blank.children.filter((x) => typeof x !== 'object' || (x as XmlElement).name !== 'Style');
            blank.children.push(copy);
          }
          cells[c + k]!.children = [el('CellContents', blank)];
        }
      }
    });
    rows.forEach((row, i) => {
      if (kinds[i] !== 'total' && kinds[i] !== 'subtotal') return;
      const cells = cellsOf(row);
      for (let c = 0; c < cells.length; c++) {
        const contents = child(cells[c]!, 'CellContents');
        const span = Number(textOf(child(contents ?? el('x'), 'ColSpan')) || 1);
        const item = cellItem(cells[c]!);
        const inner = item?.name === 'Rectangle' ? childElements(child(item, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name)) : item ? [item] : [];
        const label = inner.length === 1 && inner[0]!.name === 'Textbox' ? inner[0]! : undefined;
        if (span < 2 || span >= columns - 1 || !item || !label || fixedText(label) === undefined) continue;
        const offset = item === label ? 0 : len(label, 'Left');
        const over = offset + textWidth(label, true) - (widths[c]! - 0.02);
        if (over > 0) {
          const st = childElements(label, 'Style')[0];
          const padLeft = inches(textOf(child(st, 'PaddingLeft'))) ?? 0;
          if (item === label && st && padLeft >= over) setChild(st, 'PaddingLeft', `${Math.round((padLeft - over) * 720) / 10}pt`);
          else if (item !== label && offset >= over) setChild(label, 'Left', inch(offset - over));
          else continue;
        }
        if (item !== label && len(label, 'Left') + len(label, 'Width') > widths[c]!) setChild(label, 'Width', inch(widths[c]! - len(label, 'Left')));
        const tb = item;
        removeChildren(contents!, ['ColSpan']);
        const st = childElements(tb, 'Style')[0];
        const right = st ? childElements(st, 'RightBorder')[0] : undefined;
        if (st) removeChildren(st, ['RightBorder']);
        for (let k = 1; k < span; k++) {
          const blank = newTextbox(`__total_${c + k}`, '', '0pt');
          if (st) {
            const copy = structuredClone(st);
            removeChildren(copy, ['LeftBorder', 'RightBorder']);
            if (k === span - 1 && right) copy.children.push(structuredClone(right));
            blank.children = blank.children.filter((x) => typeof x !== 'object' || (x as XmlElement).name !== 'Style');
            blank.children.push(copy);
          }
          cells[c + k]!.children = [el('CellContents', blank)];
        }
      }
    });
    // A table without column headings, or placing its lines by formula (a statement's indented labels), is lines of
    // text, not rows of data: its rows are not banded.
    const statement = !rows.some((row, i) => kinds[i] === 'heading' && !descendants(row).some((e) => roles.get(e) === 'title')) || rows.some((row, i) => kinds[i] === 'detail'
      && descendants(row).some((e) => e.name === 'Textbox' && textOf(child(childElements(e, 'Style')[0] ?? el('x'), 'PaddingLeft')).startsWith('=')));
    const colNames: (string | undefined)[] = [];
    const fromField: boolean[] = [];
    const textboxIn = (cell: XmlElement | undefined) => {
      const item = cell ? cellItem(cell) : undefined;
      if (!item) return undefined;
      return item.name === 'Textbox' ? item : descendants(item).find((e) => e.name === 'Textbox' && !isBlank(e));
    };
    for (let c = 0; c < columns; c++) {
      let name: string | undefined;
      for (const [i, row] of rows.entries()) {
        if (kinds[i] !== 'detail') continue;
        const tb = textboxIn(cellsOf(row)[c]);
        if (!tb || isBlank(tb)) continue;
        name = fieldOf(tb) ?? ownWord(tb);
        if (fieldOf(tb)) fromField[c] = true;
        if (name) break;
      }
      if (!name) {
        for (const [i, row] of rows.entries()) {
          if (kinds[i] !== 'heading') continue;
          const tb = textboxIn(cellsOf(row)[c]);
          if (tb && roles.get(tb) === 'title') continue;
          const t = tb && fixedText(tb);
          if (t) {
            name = snake(t).toLowerCase();
            break;
          }
        }
      }
      colNames.push(name);
    }
    if (tablix === tablixes[0]) {
      const total = widthsOf(tablix).length;
      for (const row of rowsOf(tablix)) {
        const cells = cellsOf(row);
        const filled = cells.filter((x) => child(x, 'CellContents'));
        const first = filled[0];
        const span = first ? Number(textOf(child(child(first, 'CellContents')!, 'ColSpan')) || 1) : 0;
        if (!first || span < 2 || span >= total || cells.indexOf(first) !== 0) continue;
        const tail = cells.slice(span);
        const emptyTail = tail.every((x) => { const it = cellItem(x); return !child(x, 'CellContents') || (it?.name === 'Textbox' && isBlank(it)) || (it?.name === 'Rectangle' && !child(it, 'ReportItems')?.children.length); });
        if (!emptyTail || span + tail.length !== total) continue;
        const contents = child(first, 'CellContents')!;
        removeChildren(contents, ['ColSpan']);
        contents.children.push(el('ColSpan', String(total)));
        child(row, 'TablixCells')!.children = [first, ...Array.from({ length: total - 1 }, () => el('TablixCell'))];
      }
    }
    // Each text in its row: named after its column, given its looks.
    const headingCols = new Set<string>();
    let footerInTable = false;
    rows.forEach((row, i) => {
      const kind = kinds[i]!;
      let labelled = false;
      // Column headings Crystal printed in a group's header (fixed text only, over two columns or more): named as
      // headings, which is how reports are combined finds and relabels columns.
      const rowTexts = descendants(row).filter((e) => e.name === 'Textbox' && !isBlank(e));
      const headingsHere = kind === 'groupHeading' && rowTexts.length > 1 && rowTexts.every((e) => fixedText(e) !== undefined);
      const headingsRow = headingRow(row, i);
      // (Columns whose heading has text: an empty one is not named after them too.)
      for (const [c, cell] of cellsOf(row).entries()) {
        const tb = textboxIn(cell);
        if (headingsRow && tb && !isBlank(tb) && colNames[c]) headingCols.add(colNames[c]!);
      }
      const shortInRow = cellsOf(row).some((cell, c) => {
        const box = cellItem(cell);
        if (box?.name !== 'Rectangle') return false;
        const inside = childElements(child(box, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name));
        const t = inside.length === 1 && inside[0]!.name === 'Textbox' ? inside[0]! : undefined;
        if (!t || !ruledAbove(t)) return false;
        const room = widths.slice(c, c + Number(textOf(child(child(cell, 'CellContents'), 'ColSpan')) || 1)).reduce((x, y) => x + y, 0);
        return len(t, 'Left') > 0.02 || room - len(t, 'Left') - len(t, 'Width') > 0.02;
      });
      cellsOf(row).forEach((cell, c) => {
        let item = cellItem(cell);
        if (!item) return;
        if (item.name === 'Rectangle' && !childElements(child(item, 'ReportItems') ?? el('x')).some((e) => ITEMS.has(e.name)) && !child(item, 'Visibility')) {
          const blank = newTextbox(`__blank_${c}`, '', '0pt');
          const st = childElements(item, 'Style')[0];
          if (st) blank.children = [...blank.children.filter((x) => typeof x !== 'object' || (x as XmlElement).name !== 'Style'), structuredClone(st)];
          const contents = child(cell, 'CellContents')!;
          contents.children = contents.children.map((x) => (x === item ? blank : x));
          item = blank;
        }
        // A box in a cell holding just one text: the text itself, placed by its padding.
        if (item.name === 'Rectangle') {
          let inner = childElements(child(item, 'ReportItems') ?? el('x')).filter((e) => ITEMS.has(e.name));
          // A text with a line drawn just under it (Crystal's underlined heading): the text underlined.
          const texts = inner.filter((e) => e.name === 'Textbox');
          const lines = inner.filter((e) => e.name === 'Line');
          if (texts.length === 1 && lines.length && lines.length + 1 === inner.length) {
            const tb = texts[0]!;
            const top = len(tb, 'Top');
            const bottom = top + len(tb, 'Height');
            const under = lines.every((l) => len(l, 'Height') === 0 && len(l, 'Top') >= top + (bottom - top) / 2 && len(l, 'Top') <= bottom + 0.1
              && len(l, 'Left') < len(tb, 'Left') + len(tb, 'Width') && len(l, 'Left') + len(l, 'Width') > len(tb, 'Left')
              && /^(solid|dashed|dotted|double)$/i.test(textOf(child(l, 'Style/Border/Style'))));
            const decorated = descendants(tb).some((e) => e.name === 'TextDecoration' && textOf(e).startsWith('='));
            if (under && !decorated) {
              for (const run of runStyles(tb)) setChild(run, 'TextDecoration', 'Underline');
              const holder = child(item, 'ReportItems')!;
              holder.children = holder.children.filter((x) => !lines.includes(x as XmlElement));
              inner = [tb];
            }
          }
          if (inner.length === 2 && inner.every((e) => e.name === 'Textbox')) {
            const hiddenBy = (t: XmlElement) => textOf(child(t, 'Visibility/Hidden'));
            const [a, b] = inner as [XmlElement, XmlElement];
            const both = hiddenBy(a).startsWith('=') && hiddenBy(b).startsWith('=');
            const hidden = both ? (/Count|Sum|CountRows/i.test(hiddenBy(a)) ? a : b) : hiddenBy(a).startsWith('=') && !child(b, 'Visibility') ? a : hiddenBy(b).startsWith('=') && !child(a, 'Visibility') ? b : undefined;
            const shown = hidden === a ? b : a;
            const shownHidden = both ? hiddenBy(shown).slice(1) : '';
            const runs = (t: XmlElement) => descendants(t).filter((e) => e.name === 'TextRun');
            const left = Math.max(len(a, 'Left'), len(b, 'Left'));
            const right = Math.min(len(a, 'Left') + len(a, 'Width'), len(b, 'Left') + len(b, 'Width'));
            if (hidden && runs(hidden).length === 1 && runs(shown).length === 1 && right - left > 0.5 * Math.min(len(a, 'Width'), len(b, 'Width'))) {
              const vb = (t: XmlElement) => {
                const v = textOf(child(runs(t)[0]!, 'Value'));
                return v.startsWith('=') ? v.slice(1) : `"${v.replace(/"/g, '""')}"`;
              };
              const hiddenRule = hiddenBy(hidden).slice(1);
              child(runs(shown)[0]!, 'Value')!.children = [shownHidden
                ? `=IIf(${hiddenRule}, IIf(${shownHidden}, Nothing, ${vb(shown)}), ${vb(hidden)})`
                : `=IIf(${hiddenRule}, ${vb(shown)}, ${vb(hidden)})`];
              if (shownHidden) setChild(child(shown, 'Visibility')!, 'Hidden', `=(${hiddenRule}) AndAlso (${shownHidden})`);
              const from = Math.min(len(a, 'Left'), len(b, 'Left'));
              const to = Math.max(len(a, 'Left') + len(a, 'Width'), len(b, 'Left') + len(b, 'Width'));
              setChild(shown, 'Left', inch(from));
              setChild(shown, 'Width', inch(to - from));
              const holder = child(item, 'ReportItems')!;
              holder.children = holder.children.filter((x) => x !== hidden);
              inner = [shown];
            }
          }
          {
            const texts = inner.filter((e) => e.name === 'Textbox');
            const frames = inner.filter((e) => e.name === 'Rectangle' && !childElements(child(e, 'ReportItems') ?? el('x')).some((x) => ITEMS.has(x.name)) && drawnAs(e));
            const across = Number(textOf(child(child(cell, 'CellContents'), 'ColSpan')) || 1);
            const room = widths.slice(c, c + across).reduce((a, b) => a + b, 0);
            if (texts.length === 1 && frames.length === 1 && inner.length === 2) {
              const t = texts[0]!;
              const f = frames[0]!;
              const fl = len(f, 'Left');
              const fr = fl + len(f, 'Width');
              const inside = len(t, 'Left') >= fl - 0.1 && len(t, 'Left') + len(t, 'Width') <= fr + 0.1 && len(t, 'Top') >= len(f, 'Top') - 0.1 && len(t, 'Top') + len(t, 'Height') <= len(f, 'Top') + len(f, 'Height') + 0.1;
              if (inside && fl <= 0.1 && room - fr <= 0.1 && !child(f, 'Visibility')) {
                const own = ownStyle(t);
                const fs = childElements(f, 'Style')[0];
                for (const side of ['Border', ...BORDER_SIDES].reverse()) {
                  const border = child(fs, side);
                  if (border) {
                    removeChildren(own, [side]);
                    own.children.unshift(structuredClone(border));
                  }
                }
                const holder = child(item, 'ReportItems')!;
                holder.children = holder.children.filter((x) => x !== f);
                inner = [t];
              }
            }
          }
          const rs = ownStyle(item);
          const plain = !/^(solid|dashed|dotted|double)/i.test(textOf(child(rs, 'Border/Style'))) && !BORDER_SIDES.some((s) => /^(solid|dashed|dotted|double)/i.test(textOf(child(rs, `${s}/Style`))))
            && (!textOf(child(rs, 'BackgroundColor')) || /^(transparent|#00ffffff)$/i.test(textOf(child(rs, 'BackgroundColor'))));
          const only = inner.length === 1 && inner[0]!.name === 'Textbox' ? inner[0]! : undefined;
          const across = Number(textOf(child(child(cell, 'CellContents'), 'ColSpan')) || 1);
          const room = widths.slice(c, c + across).reduce((a, b) => a + b, 0);
          const shortRule = !!only && ruledAbove(only) && (shortInRow || len(only, 'Left') > 0.02 || room - len(only, 'Left') - len(only, 'Width') > 0.02);
          const drawn = (st: XmlElement | undefined, side: string) => /solid|dashed|dotted|double/i.test(textOf(child(st, `${side}/Style`)));
          const filled = (st: XmlElement | undefined) => { const v = textOf(child(st, 'BackgroundColor')); return !!v && !/^(transparent|#00ffffff)$/i.test(v); };
          const ts = only ? ownStyle(only) : undefined;
          const movable = !plain && !!only && !shortRule
            && !['Border', ...BORDER_SIDES].some((side) => drawn(rs, side) && (drawn(ts, side) || drawn(ts, 'Border') || (side === 'Border' && BORDER_SIDES.some((x) => drawn(ts, x)))))
            && !(filled(rs) && filled(ts) && textOf(child(rs, 'BackgroundColor')) !== textOf(child(ts, 'BackgroundColor')));
          if (movable && ts) {
            for (const side of [...BORDER_SIDES].reverse()) {
              const border = child(rs, side);
              if (border && drawn(rs, side)) {
                removeChildren(ts, [side]);
                ts.children.unshift(structuredClone(border));
              }
            }
            if (drawn(rs, 'Border')) {
              removeChildren(ts, ['Border']);
              ts.children.unshift(structuredClone(child(rs, 'Border')!));
            }
            if (filled(rs) && !filled(ts)) setChild(ts, 'BackgroundColor', textOf(child(rs, 'BackgroundColor')));
          }
          if (only && (plain || movable) && !shortRule && !child(item, 'Visibility')) {
            const tb = only;
            const span = across;
            const cellWidth = room;
            pad(tb, { left: len(tb, 'Left'), top: ruledAbove(tb) ? 0 : len(tb, 'Top'), right: Math.max(0, cellWidth - len(tb, 'Left') - len(tb, 'Width')) });
            unplace(tb);
            const contents = child(cell, 'CellContents')!;
            contents.children = contents.children.map((x) => (x === item ? tb : x));
            itemRenames.set(item.attributes.Name ?? '', tb.attributes.Name ?? '');
            item = tb;
          }
        }
        const textboxes = item.name === 'Textbox' ? [item] : descendants(item).filter((e) => e.name === 'Textbox');
        const cellName = (tb: XmlElement) => {
          if (named.has(tb)) return tb.attributes.Name;
          if ((item.name === 'Rectangle' && groupLabels.has(item)) || groupLabels.has(tb)) return rename(tb, 'text', { T });
          if (leftBlank.has(tb)) return rename(tb, 'blank', { T, col: colNames[c] ?? `col${c + 1}` });
          const col = fieldOf(tb) ?? colNames[c] ?? ownWord(tb) ?? `col${c + 1}`;
          if (kind === 'noData') return rename(tb, 'noData', { T });
          const across = Number(textOf(child(child(cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1);
          if (kind === 'total' && !footerInTable && !isBlank(tb) && across >= Math.max(2, columns - 1) && !/\b(Sum|Count|CountDistinct|Avg|RunningValue)\s*\(/i.test(valueOf(tb))) {
            footerInTable = true;
            roles.set(tb, 'footer');
            return rename(tb, 'footer');
          }
          // (An empty heading over a column of a field's values: the heading of that column, to be given a label.)
          if (isBlank(tb) && headingsRow && fromField[c] && !headingCols.has(colNames[c]!)) {
            headingCols.add(colNames[c]!);
            return rename(tb, 'heading', { T, col: colNames[c]! });
          }
          if (isBlank(tb)) return rename(tb, 'blank', { T, col });
          const totalled = TOTALLED.test(valueOf(tb));
          if ((kind === 'subtotal' || kind === 'total') && stackedRows.has(row) && !/Fields!/.test(valueOf(tb)) && !rowTexts.some((e) => fieldOf(e)) && !rowTexts.some((e) => TOTALLED.test(valueOf(e)))) return rename(tb, 'text', { T });
          switch (kind) {
            case 'heading': return rename(tb, 'heading', { T, col: colNames[c] ?? col });
            case 'detail': return !/Fields!/.test(valueOf(tb)) && !rowTexts.some((e) => fieldOf(e) || /Fields!/.test(valueOf(e))) ? rename(tb, 'text', { T }) : rename(tb, 'value', { T, col });
            case 'groupHeading': return headingsHere ? rename(tb, 'heading', { T, col: colNames[c] ?? col }) : rename(tb, 'groupText', { T, col });
            case 'subtotal': return rename(tb, totalled ? 'subtotal' : 'subtotalText', { T, col });
            default:
              if (totalled) return rename(tb, 'total', { T, col });
              if (!labelled) {
                labelled = true;
                return rename(tb, 'totalText', { T, col });
              }
              return rename(tb, 'subtotalText', { T, col });
          }
        };
        if (item.name === 'Rectangle') {
          const col = colNames[c] ?? ownWord(item) ?? `col${c + 1}`;
          rename(item, 'cellRect', { T, col });
          for (const d of descendants(item)) {
            if (d === item || named.has(d) || inTable(d, item)) continue;
            if (d.name === 'Textbox') cellName(d);
            else if (d.name === 'Rectangle') rename(d, 'cellRect', { T, col });
            else if (d.name === 'Line') rename(d, 'cellLine', { T, col });
            else if (d.name === 'Image') rename(d, 'image', { T });
          }
        } else if (item.name === 'Textbox') cellName(item);
        else if (item.name === 'Tablix' || item.name === 'Chart') { /* named where met */ } else rename(item, item.name === 'Line' ? 'line' : item.name === 'Image' ? 'image' : 'text', { T });
        for (const tb of textboxes) {
          tableCells.add(tb);
          if ((statement && kind === 'detail') || kind === 'noData') unbanded.add(tb);
          if (roles.has(tb) || isBlank(tb)) continue;
          const numeric = isNumber(tb);
          const totalled = TOTALLED.test(valueOf(tb));
          roles.set(tb, kind === 'heading' ? (c === 0 ? 'headingFirst' : 'heading')
            : kind === 'detail' ? (numeric ? 'number' : c === 0 ? 'bodyFirst' : 'body')
              : kind === 'groupHeading' ? 'group'
                : kind === 'noData' ? 'body'
                  : totalled || numeric ? 'totalValue' : 'totalLabel');
        }
        if (kind !== 'detail' && kind !== 'noData' && !isBlank(textboxes[0] ?? el('x'))) bandRows.push(row);
      });
      if (kind === 'detail' && !statement) bandRows.push(row);
    });
    // A cross-tab's row and column headers.
    for (const hierarchy of ['TablixRowHierarchy', 'TablixColumnHierarchy']) {
      for (const header of descendants(child(tablix, hierarchy) ?? el('x')).filter((e) => e.name === 'TablixHeader')) {
        for (const tb of descendants(header).filter((e) => e.name === 'Textbox' && !named.has(e))) {
          const col = fieldOf(tb) ?? ownWord(tb) ?? 'header';
          rename(tb, isBlank(tb) ? 'blank' : 'groupText', { T, col });
          tableCells.add(tb);
          if (!isBlank(tb)) roles.set(tb, hierarchy === 'TablixColumnHierarchy' ? 'heading' : TOTALLED.test(valueOf(tb)) ? 'totalValue' : 'group');
        }
      }
      for (const corner of descendants(tablix).filter((e) => e.name === 'TablixCornerCell')) {
        for (const tb of descendants(corner).filter((e) => e.name === 'Textbox' && !named.has(e))) {
          rename(tb, isBlank(tb) ? 'blank' : 'heading', { T, col: ownWord(tb) ?? 'corner' });
          tableCells.add(tb);
          if (!isBlank(tb)) roles.set(tb, 'headingFirst');
        }
      }
    }

    // For setting up which columns show where reports are combined: each column's number and the name its heading
    // goes by; rows with cells across some of the columns are not put in order with them.
    if (headingCols.size) {
      const list = colNames.map((n, c) => `${c + 1} ${headingCols.has(n ?? '') ? n : '(no heading)'}`).join(', ');
      review.push({ item: `Table ${T}`, message: `columns, by number: ${list}` });
      const across = rows.map((row, i) => ({ i, spans: cellsOf(row).map((cell) => Number(textOf(child(child(cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1)) }))
        .filter((r) => r.spans.some((n) => n > 1 && n < columns));
      if (across.length) {
        review.push({ item: `Table ${T}`, message: `row(s) ${across.map((r) => r.i + 1).join(', ')} have cells across some columns: where reports are combined they keep their order when columns are put in another order, and lose their last cells when columns are hidden; keep those columns in place` });
      }
    }
  }

  // Groups: the team's names (details groups apart).
  for (const g of groups) {
    const details = !child(g, 'GroupExpressions');
    const old = g.attributes.Name ?? '';
    const name = names.make(fill(details ? 'details' : 'group', {}));
    g.attributes.Name = name;
    named.add(g);
    if (old && old !== name) scopeRenames.set(old, name);
  }

  // ----- Sizes as the report prints: what Crystal's layout leaves to grow when the report runs (a box holding a
  // table, a row holding a box, a row of text drawn shorter than its text) is drawn at its full size, and what lies
  // under it moves down as far, so nothing overlaps in the designer and the printed report stays the same.
  if (body) {
    designText = !!conv.style;
    for (const holder of descendants(body).filter((e) => e.name === 'ReportItems')) separate(holder, review);
    // (Each subreport's frame stays: when the report runs, a frame growing with its table pushes the next frame down,
    // which items side by side in one box, touching, would not do.)
    fitItems(child(body, 'ReportItems'));
    // Crystal's sections keep apart what lies side by side across the page (a logo beside a title, a subreport beside
    // a heading); laid out in one container, a part of them growing would push only what lies under it. Each strip
    // of items is a band of its own, moving as one, as Crystal's section does.
    widenCells(body);
    const holders = descendants(body).filter((e) => e.name === 'ReportItems' && !descendants(body).some((t) => t.name === 'Tablix' && descendants(t).includes(e)));
    for (const holder of holders.reverse()) band(holder);
    // A box inside the report's box (a subreport's frame, a band) runs on to the next page as Crystal's subreport
    // does, rather than moving whole to the next page and leaving the rest of this one blank.
    for (const box of descendants(child(body, 'ReportItems') ?? el('x')).filter((e) => e.name === 'Rectangle' && child(e, 'Top')
      && descendants(e).some((d) => d.name === 'Tablix'))) removeChildren(box, ['KeepTogether']);
    // (Then nothing is left over anything else at its full size: what lies lower moves below.)
    const bottom = unpile(child(body, 'ReportItems'));
    if (bottom > len(body, 'Height')) setChild(body, 'Height', inch(bottom));
  }

  // ----- What else lies in the body: one rectangle around it all.
  if (body) {
    const items = child(body, 'ReportItems');
    const top = items ? childElements(items).filter((e) => ITEMS.has(e.name)) : [];
    const tablixBottom = Math.max(0, ...top.filter((e) => e.name === 'Tablix').map((e) => len(e, 'Top') + len(e, 'Height')));
    let footerDone = false;
    const inTables = new Set(tablixes.flatMap((t) => descendants(t)));
    const nameFree = (e: XmlElement) => {
      for (const d of descendants(e).filter((x) => ITEMS.has(x.name) && !inTables.has(x))) {
        if (d.name === 'Textbox') {
          const below = tablixes.length > 0 && len(d, 'Top') >= tablixBottom - 0.01 && !!items && childElements(items).includes(d);
          if (below && !footerDone && !isBlank(d)) {
            footerDone = true;
            rename(d, 'footer');
            roles.set(d, 'footer');
          } else {
            rename(d, 'text');
            if (!isBlank(d)) roles.set(d, 'text');
          }
        } else if (d.name === 'Rectangle') rename(d, 'rect');
        else if (d.name === 'Line') rename(d, 'line');
        else if (d.name === 'Image') rename(d, 'image');
        else if (d.name === 'Chart') rename(d, 'chart');
      }
    };
    // The wrapper takes the first rectangle name.
    const wrapperName = names.make(fill('rect', {}));
    for (const e of top) nameFree(e);
    if (items && top.length) {
      const height = len(body, 'Height');
      const wrapper = el('Rectangle', { Name: wrapperName },
        el('ReportItems', ...top),
        el('KeepTogether', 'true'),
        conv.documentMap && titleText ? el('DocumentMapLabel', titleText) : null,
        conv.documentMap && titleText ? el('Bookmark', titleText) : null,
        el('Top', '0in'), el('Left', '0in'), el('Height', inch(height)), el('Width', inch(Math.max(reportWidth, ...top.map((e) => len(e, 'Left') + len(e, 'Width'))))),
        el('Style', el('Border', el('Style', 'None'))));
      items.children = [wrapper];
    }
    plainLines(report);
    checkLayout(report, body, review);
  }
  // Where reports are combined, hiding columns takes the last columns off every table in the box, not only the first
  // (whose columns are the ones chosen): each other table gets as many thin empty columns at its end as could be taken,
  // and keeps its own.
  const boxTables = body ? descendants(body).filter((e) => e.name === 'Tablix') : [];
  const chosen = boxTables[0];
  const spare = chosen && descendants(chosen).some((e) => headings.has(e)) ? widthsOf(chosen).length - 1 : 0;
  for (const t of spare > 0 ? boxTables.slice(1) : []) {
    const columns = childElements(child(t, 'TablixBody/TablixColumns')!, 'TablixColumn');
    const members = child(t, 'TablixColumnHierarchy/TablixMembers');
    const last = columns[columns.length - 1];
    // (Columns in groups of their own: the number taken cannot be known.)
    if (!last || !members || descendants(members).some((e) => e.name === 'Group') || len(last, 'Width') <= spare * SPARE_WIDTH + 0.05) continue;
    // A last column left empty in every row (Crystal's space at the table's right) is shared out with the spare
    // columns, so that each is wide enough to be seen and picked in the designer; otherwise they are thin slivers.
    const at = columns.length - 1;
    const ownWidths = widthsOf(t);
    for (const row of rowsOf(t)) {
      const cells = cellsOf(row);
      for (let i = 0, c = 0; i < cells.length; i++) {
        const contents = child(cells[i]!, 'CellContents');
        if (!contents) continue;
        const span = Number(textOf(child(contents, 'ColSpan')) || 1);
        if (span === spare + 1 && span > 1 && cells[i + span - 1] && !child(cells[i + span - 1]!, 'CellContents')) {
          const item = cellItem(cells[i]!);
          const tail = newTextbox('__spare', '', '0pt');
          tail.attributes.Name = names.make(fill('blank', { T: t.attributes.Name ?? '' }));
          named.add(tail);
          const from = item ? ownStyle(item) : undefined;
          const to = ownStyle(tail);
          for (const side of ['Border', 'TopBorder', 'BottomBorder', 'BackgroundColor']) {
            const value = child(from, side);
            if (value) {
              removeChildren(to, [side]);
              to.children.push(structuredClone(value));
            }
          }
          if (roles.has(item!)) roles.set(tail, roles.get(item!)!);
          if (tableCells.has(item!)) tableCells.add(tail);
          cells[i + span - 1]!.children.push(el('CellContents', tail));
          removeChildren(contents, ['ColSpan']);
          if (span - 1 > 1) contents.children.push(el('ColSpan', String(span - 1)));
          const centred = item?.name === 'Textbox' && descendants(item).some((e) => e.name === 'TextAlign' && /^center$/i.test(textOf(e)));
          if (centred) pad(item!, { left: Math.min(1, ownWidths[c + span - 1] ?? 0) });
        }
        c += span;
      }
    }
    const each = SPARE_WIDTH;
    const widest = columns.reduce<XmlElement | undefined>((w, c) => (!w || len(c, 'Width') > len(w, 'Width') ? c : w), undefined)!;
    const from = len(widest, 'Width') - spare * each >= 1 ? widest : last;
    setChild(from, 'Width', inch(len(from, 'Width') - spare * each));
    const T = t.attributes.Name ?? '';
    for (let k = 0; k < spare; k++) {
      child(t, 'TablixBody/TablixColumns')!.children.push(el('TablixColumn', el('Width', inch(each))));
      members.children.push(el('TablixMember'));
      for (const row of rowsOf(t)) {
        const tb = newTextbox('__spare', '', '0pt');
        tb.attributes.Name = names.make(fill('blank', { T }));
        named.add(tb);
        // (A rule or band drawn along the row, a border or fill of its last cell, runs on through the spare cells to the
        // table's edge, as it did across the space they are taken from.)
        const rowCells = cellsOf(row).slice(0, at + 1);
        let cover: XmlElement | undefined;
        for (let c = 0, i = 0; i < rowCells.length; i++) {
          const span = Number(textOf(child(child(rowCells[i]!, 'CellContents') ?? el('x'), 'ColSpan')) || 1);
          if (child(rowCells[i]!, 'CellContents') && c <= at && at < c + span) cover = rowCells[i];
          if (child(rowCells[i]!, 'CellContents')) c += span;
        }
        const lastItem = cover ? cellItem(cover) : undefined;
        if (lastItem) {
          const from = ownStyle(lastItem);
          const to = ownStyle(tb);
          for (const side of ['TopBorder', 'BottomBorder', 'BackgroundColor']) {
            const value = child(from, side);
            if (value) {
              removeChildren(to, [side]);
              to.children.push(structuredClone(value));
            }
          }
          const all = child(from, 'Border');
          if (all && !/^none$/i.test(textOf(child(all, 'Style')))) {
            for (const side of ['TopBorder', 'BottomBorder']) if (!child(to, side)) to.children.push(el(side, ...structuredClone(all.children)));
          }
        }
        child(row, 'TablixCells')!.children.push(el('TablixCell', el('CellContents', tb)));
      }
    }
  }

  // A table's empty cells numbered in reading order (row by row, left to right), as the designer lists them, rather
  // than in the order they were made.
  if (conv.names.blank.includes('{n}')) {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const t of descendants(report).filter((e) => e.name === 'Tablix')) {
      const T = t.attributes.Name ?? '';
      const parts = conv.names.blank.replace(/\{S\}/g, S).replace(/\{T\}/g, T).split('{n}');
      const shape = new RegExp(`^${parts.map(escape).join('\\d+')}$`);
      const blanks = rowsOf(t).flatMap((row) => cellsOf(row).flatMap((cell) => {
        const item = cellItem(cell);
        return item && item.name === 'Textbox' && shape.test(item.attributes.Name ?? '') ? [item] : [];
      }));
      // (Nothing refers to an empty cell by name: the numbers are only shuffled among them.)
      blanks.forEach((tb, i) => {
        tb.attributes.Name = parts.join(String(i + 1));
      });
    }
  }

  // Names stay unique: an item kept under its Crystal name gives way to a new one taken.
  const seen = new Set<string>();
  for (const e of descendants(report).filter((x) => (ITEMS.has(x.name) || x.name === 'Group') && x.attributes.Name)) {
    const n = e.attributes.Name!;
    if (!seen.has(n.toLowerCase()) && (named.has(e) || !newNames(named).has(n.toLowerCase()))) {
      seen.add(n.toLowerCase());
      continue;
    }
    let k = 2;
    while (seen.has(`${n}_${k}`.toLowerCase()) || newNames(named).has(`${n}_${k}`.toLowerCase())) k++;
    e.attributes.Name = `${n}_${k}`;
    seen.add(e.attributes.Name.toLowerCase());
    itemRenames.set(n, e.attributes.Name);
  }

  // ----- Looks from the style dataset.
  if (conv.style) applyStyleRoles(report, conv.style, roles, tableCells, unbanded, bandRows, review, dataSources[0]?.attributes.Name ?? conv.dataSource?.name ?? '');
  if (conv.style) {
    for (const t of descendants(report).filter((e) => e.name === 'Tablix')) {
      const heads = descendants(t).filter((e) => e.name === 'Textbox' && roles.get(e) === 'heading');
      const ink = heads.flatMap((e) => descendants(e).filter((x) => x.name === 'Color')).map(textOf).find(Boolean);
      if (!ink) continue;
      const kinds = rowLeaves(t).map((l) => l.kind);
      rowsOf(t).forEach((row, r) => {
        if (kinds[r] !== 'heading' && kinds[r] !== 'groupHeading') return;
        if (!descendants(row).some((e) => heads.includes(e))) return;
        for (const line of descendants(row).filter((e) => e.name === 'Line')) {
          const st = childElements(line, 'Style')[0];
          const border = child(st, 'Border') ?? st;
          if (border) setChild(border, 'Color', ink);
        }
      });
      for (const b of descendants(t).filter((e) => e.attributes.inked)) setChild(b, 'Color', ink);
    }
  }
  for (const b of descendants(report).filter((e) => e.attributes.inked)) delete b.attributes.inked;
  for (const tb of descendants(report).filter((e) => e.attributes.capsize)) {
    const cap = Number(tb.attributes.capsize);
    for (const fs of descendants(tb).filter((e) => e.name === 'FontSize')) {
      const v = textOf(fs);
      if (v.startsWith('=')) fs.children = [`=IIf(Val(${v.slice(1)}) > ${cap}, "${cap}pt", ${v.slice(1)})`];
      else if ((inches(v) ?? 0) * 72 > cap) fs.children = [`${cap}pt`];
    }
    delete tb.attributes.capsize;
  }
  for (const row of descendants(report).filter((e) => e.name === 'TablixRow')) {
    const texts = descendants(row).filter((e) => e.name === 'Textbox');
    if (!texts.some((t) => ruledAbove(t) && !isBlank(t))) continue;
    for (const t of texts.filter((x) => !isBlank(x))) {
      const st = childElements(t, 'Style')[0];
      if (st) setChild(st, 'VerticalAlign', 'Top');
    }
  }


  // ----- References to renamed items, groups, datasets and parameters.
  for (const e of descendants(report)) {
    const t = e.children.length === 1 && typeof e.children[0] === 'string' ? (e.children[0] as string) : undefined;
    if (t === undefined) continue;
    if (['ToggleItem', 'RepeatWith', 'DataSetName', 'DataElementName'].includes(e.name)) {
      if (scopeRenames.has(t)) e.children = [scopeRenames.get(t)!];
      else if (itemRenames.has(t)) e.children = [itemRenames.get(t)!];
      continue;
    }
    if (e.name === 'ParameterName' && paramRenames.has(t)) {
      e.children = [paramRenames.get(t)!];
      continue;
    }
    if (!t.startsWith('=')) continue;
    let v = t.replace(/ReportItems!(\w+)/g, (m, n: string) => (itemRenames.has(n) ? `ReportItems!${itemRenames.get(n)}` : m));
    v = v.replace(/Parameters!(\w+)/g, (m, n: string) => (paramRenames.has(n) ? `Parameters!${paramRenames.get(n)}` : m));
    v = v.replace(/"([^"]*)"/g, (m, n: string) => (scopeRenames.has(n) ? `"${scopeRenames.get(n)}"` : m));
    if (v !== t) e.children = [v];
  }
  fixParameters(report, conv, extra.parameterValues ?? {}, review);
  dropUnused(report, conv, review);
  // Custom code: only what the report still calls (formulas worked out in the query need none).
  const codeEl = child(report, 'Code');
  if (codeEl) {
    const called = new Set(descendants(report).flatMap((e) => (textOf(e).startsWith('=') ? [...textOf(e).matchAll(/\bCode\.(\w+)/g)].map((m) => m[1]!) : [])));
    const kept = usedCode(textOf(codeEl), called);
    if (kept.trim()) codeEl.children = [kept];
    else report.children = report.children.filter((c) => c !== codeEl);
  }
  // Custom code: where reports are combined it has to be added to the combined report by hand, alongside the code of
  // other reports; its functions and the values it keeps take the report's name in front, so no two reports' clash.
  if (codeEl && report.children.includes(codeEl)) {
    let code = textOf(codeEl);
    const own = new Set<string>();
    for (const m of code.matchAll(/^\s*(?:(?:Public|Private|Shared|Friend|Overloads)\s+)*(?:Function|Sub)\s+(\w+)/gim)) own.add(m[1]!);
    // (Values kept between calls: declared outside any function.)
    let depth = 0;
    for (const line of code.split(/\r?\n/)) {
      if (/^\s*(?:(?:Public|Private|Shared|Friend|Overloads)\s+)*(?:Function|Sub)\s+\w+/i.test(line)) depth++;
      else if (/^\s*End\s+(?:Function|Sub)\b/i.test(line)) depth--;
      else if (depth === 0) for (const m of line.matchAll(/^\s*(?:Dim|Private|Public|Shared|Friend|Const)\s+(?:Shared\s+|ReadOnly\s+|Const\s+)*(\w+)/gi)) own.add(m[1]!);
    }
    const renamed = new Map([...own].filter((n) => !n.toLowerCase().startsWith(`${S}_`.toLowerCase())).map((n) => [n, `${S}_${n}`]));
    if (renamed.size) {
      const word = new RegExp(`\\b(${[...renamed.keys()].join('|')})\\b`, 'g');
      // (Not inside quoted text.)
      code = code.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(word, (n) => renamed.get(n) ?? n))).join('');
      codeEl.children = [code];
      for (const e of descendants(report)) {
        const t = e.children.length === 1 && typeof e.children[0] === 'string' ? (e.children[0] as string) : '';
        if (t.startsWith('=') && t.includes('Code.')) e.children = [t.replace(/\bCode\.(\w+)/g, (m, n: string) => (renamed.has(n) ? `Code.${renamed.get(n)}` : m))];
      }
    }
  }
  // What a combined report takes from each template is its box and its datasets: what else this one still needs is
  // listed, to be added where the reports are combined (or taken out).
  if (child(report, 'Code')) {
    const used = [...new Set(descendants(report).flatMap((e) => (textOf(e).startsWith('=') ? [...textOf(e).matchAll(/\bCode\.(\w+)/g)].map((m) => m[1]!) : [])))].sort();
    review.push({ item: 'Custom code', message: `the report uses custom code${used.length ? ` (${used.join(', ')})` : ''}; where reports are combined only the box and its datasets are taken, so its code (written beside the report, .code.vb) must be added once to the combined report's code` });
  }
  if (conv.parameters.length) {
    for (const p of childElements(child(report, 'ReportParameters') ?? el('x'), 'ReportParameter')) {
      const name = p.attributes.Name ?? '';
      if (!conv.parameters.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        review.push({ item: `Parameter ${name}`, message: 'not one of the standard parameters: where reports are combined it must be added there, or its value passed another way' });
      }
    }
  }
  const pictures = childElements(child(report, 'EmbeddedImages') ?? el('x'), 'EmbeddedImage').map((i) => i.attributes.Name);
  if (pictures.length) review.push({ item: 'Pictures', message: `the report shows embedded pictures (${pictures.join(', ')}): where reports are combined they must be embedded there too` });

  // Files beside the template: its custom code, and the stored procedure (with its functions) its dataset reads,
  // which the dataset then calls, as the team's templates do.
  const files: Record<string, string> = {};
  const codeLeft = child(report, 'Code');
  if (codeLeft) files['.code.vb'] = textOf(codeLeft);
  const procedures = proceduresFor(report, conv, extra.sqlFunctions ?? []);
  if (procedures) {
    files['.sql'] = procedures.text;
  }
  // Notes the conversion made that no longer apply (the shared data source replaces the connection).
  return { rdl: toXml(withFunctions(root, extra.sqlFunctions ?? [])), review, settled: conv.dataSource ? ['Data source'] : [], ...(Object.keys(files).length ? { files } : {}) };
}

/** The functions (and the values they keep) of VB code that the names called reach, in their order. */
function usedCode(code: string, called: Set<string>): string {
  // Blocks: each function or sub to its End, and each line outside them.
  const blocks: { name?: string; text: string }[] = [];
  let current: { name?: string; text: string } | undefined;
  for (const line of code.split(/\r?\n/)) {
    const start = /^\s*(?:(?:Public|Private|Shared|Friend|Overloads)\s+)*(?:Function|Sub)\s+(\w+)/i.exec(line);
    if (!current && start) current = { name: start[1], text: line };
    else if (current) {
      current.text += `\n${line}`;
      if (/^\s*End\s+(?:Function|Sub)\b/i.test(line)) {
        blocks.push(current);
        current = undefined;
      }
    } else blocks.push({ text: line });
  }
  if (current) blocks.push(current);
  const keep = new Set<string>();
  const queue = [...called];
  while (queue.length) {
    const name = queue.pop()!;
    if (keep.has(name.toLowerCase())) continue;
    const block = blocks.find((b) => b.name?.toLowerCase() === name.toLowerCase());
    if (!block) continue;
    keep.add(name.toLowerCase());
    for (const other of blocks) if (other.name && !keep.has(other.name.toLowerCase()) && new RegExp(`\\b${other.name}\\b`).test(block.text)) queue.push(other.name);
  }
  const kept = blocks.filter((b) => b.name && keep.has(b.name.toLowerCase()));
  // (A line outside the functions: kept where a kept function uses what it declares.)
  return blocks.filter((b) => {
    if (b.name) return keep.has(b.name.toLowerCase());
    const declared = /^\s*(?:Dim|Private|Public|Shared|Friend|Const)\s+(?:Shared\s+|ReadOnly\s+|Const\s+)*(\w+)/i.exec(b.text)?.[1];
    return declared ? kept.some((k) => new RegExp(`\\b${declared}\\b`).test(k.text)) : !!b.text.trim() && kept.length > 0;
  }).map((b) => b.text).join('\n').trim();
}

/**
 * The stored procedure a team's template reads, drafted from its main dataset's query (the report's tables, its
 * selection, its formulas worked out as columns), with the functions the query calls: to review and deploy.
 */
/**
 * The stored procedures a template's datasets would call: one per dataset running a query of its own (the report's,
 * and those of subreports placed in it), each that query with the team's standard parameters and the query's own,
 * after the functions they use. The main dataset's first.
 */
function proceduresFor(report: XmlElement, conv: Conventions, functions: string[]): { text: string; list: { name: string; dataSet: XmlElement }[] } | undefined {
  const regionSet = descendants(report).find((e) => e.name === 'Tablix' && child(e, 'DataSetName'));
  const sets = descendants(report).filter((e) => e.name === 'DataSet' && e.attributes.Name !== conv.style?.dataset)
    .filter((d) => {
      const query = child(d, 'Query');
      return !!textOf(child(query, 'CommandText')) && textOf(child(query, 'CommandType')) !== 'StoredProcedure';
    })
    .sort((x, y) => Number(y.attributes.Name === textOf(child(regionSet, 'DataSetName'))) - Number(x.attributes.Name === textOf(child(regionSet, 'DataSetName'))));
  if (!sets.length) return undefined;
  const SQL_TYPES: Record<string, string> = { DateTime: 'datetime', Integer: 'int', Float: 'float', Boolean: 'bit', String: 'nvarchar(100)' };
  const schema = conv.style?.command.includes('.') ? conv.style.command.slice(0, conv.style.command.lastIndexOf('.')) : 'dbo';
  const list = sets.map((dataSet) => ({ name: `${schema}.${dataSet.attributes.Name}`, dataSet }));
  const procedure = ({ name, dataSet }: { name: string; dataSet: XmlElement }) => {
    const query = child(dataSet, 'Query');
    const standard = conv.parameters.map((p) => `    @${p.name} ${SQL_TYPES[p.dataType ?? 'String'] ?? 'nvarchar(100)'}`);
    const own = childElements(child(query, 'QueryParameters') ?? el('x'), 'QueryParameter')
      .map((p) => p.attributes.Name ?? '')
      .filter((n) => n && !conv.parameters.some((s) => `@${s.name}`.toLowerCase() === n.toLowerCase()))
      .map((n) => `    ${n} nvarchar(4000) -- the report's own (check its type)`);
    const params = [...standard, ...own];
    return [
      `-- Called by the report's dataset ${dataSet.attributes.Name}.`,
      `CREATE PROCEDURE ${name}`,
      params.map((p, i) => (i < params.length - 1 ? p.replace(/( --|$)/, ',$1') : p)).join('\n'),
      'AS',
      'BEGIN',
      '    SET NOCOUNT ON;',
      textOf(child(query, 'CommandText')).split(/\r?\n/).map((l) => `    ${l}`).join('\n') + ';',
      'END',
      'GO',
      '',
    ];
  };
  const lines = [
    `-- The procedure${list.length > 1 ? 's' : ''} the report's dataset${list.length > 1 ? 's call' : ' calls'}: the Crystal report's tables and selection,`,
    '-- with its formulas worked out as columns (each under the Crystal formula it replaces), and the functions it uses.',
    '-- A first draft: review it, add what the team\'s procedures add (filters on the standard parameters), deploy it.',
    '',
    ...functions.flatMap((f) => [f, 'GO', '']),
    ...list.flatMap(procedure),
  ];
  return { text: lines.join('\n'), list };
}

/** Whether an item lies in a table inside a container (named with that table). */
function inTable(item: XmlElement, container: XmlElement): boolean {
  return descendants(container).some((t) => t !== container && t.name === 'Tablix' && descendants(t).includes(item) && t !== item);
}

/**
 * The height a text box's text needs on one line per paragraph (inches). Where its size is worked out when the report
 * runs (as all text is where the style dataset styles it), the designer draws it at its default size (10pt), so
 * that is what it needs; undefined there unless asked.
 */
function textHeight(textbox: XmlElement, design = false, width?: number): number | undefined {
  const sizes = descendants(textbox).filter((e) => e.name === 'FontSize').map((e) => textOf(e));
  // (Text the style dataset styles takes its size from there: drawn at the default size, or its own if larger.)
  const worked = design || sizes.some((v) => v.startsWith('='));
  if (worked && !design) return undefined;
  const points = sizes.filter((v) => !v.startsWith('=')).map((v) => (inches(v) ?? 0) * 72).filter((v) => v > 0);
  const size = Math.max(worked || !points.length ? DESIGN_FONT : 0, ...points);
  // (Fixed text in a cell of known width: the lines it wraps to there.)
  const wrapped = width !== undefined ? wrapLines(textbox, width, size) : undefined;
  const lines = wrapped ?? Math.max(1, descendants(textbox).filter((e) => e.name === 'Paragraph').length);
  const style = childElements(textbox, 'Style')[0];
  const padding = ['PaddingTop', 'PaddingBottom'].reduce((a, k) => a + (inches(textOf(child(style, k))) ?? 0), 0);
  return (lines * size * (worked ? designLeading : 1.2)) / 72 + padding;
}

/**
 * A table's rows as tall as what they always print: a row holding fixed text (it always prints the text), a row
 * holding a box (as tall as what the box holds). Returns how much taller the table is.
 */
function fitTablix(tablix: XmlElement): number {
  let grown = 0;
  const kinds = rowLeaves(tablix).map((l) => l.kind);
  for (const [r, row] of rowsOf(tablix).entries()) {
    const height = len(row, 'Height');
    let need = 0;
    // Rows printed once (titles, headings, totals) are drawn with room round the designer's default size; rows printed
    // for each record or group just hold a line of it, so that a page holds about as many as Crystal's does.
    designLeading = ['detail', 'groupHeading', 'subtotal'].includes(kinds[r] ?? 'detail') ? DESIGN_TIGHT : DESIGN_LEADING;
    const widths = widthsOf(tablix);
    for (const [c, cell] of cellsOf(row).entries()) {
      const item = cellItem(cell);
      if (!item) continue;
      const span = Number(textOf(child(child(cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1);
      const cellWidth = widths.slice(c, c + span).reduce((a, b) => a + b, 0) || undefined;
      // (Fixed text whose longest word is wider than its cell less Crystal's placing: placed closer to the edges, so
      // the word is not broken.)
      if (item.name === 'Textbox' && cellWidth && fixedText(item)) roomForWords(item, cellWidth, designText);
      if (item.name === 'Rectangle') need = Math.max(need, fitItems(child(item, 'ReportItems')));
      else if (item.name === 'Tablix') need = Math.max(need, len(item, 'Height') + fitTablix(item));
      else if (item.name === 'Textbox' && !child(item, 'Visibility') && textOf(child(item, 'CanShrink')) !== 'true') {
        if (fixedText(item)) need = Math.max(need, textHeight(item, false, cellWidth) ?? 0);
      }
      // (Text in the house's fonts, worked out when the report runs: the designer draws it at its default size, and
      // a row shorter than that cuts it off there.)
      if (item.name === 'Textbox' && designText && !isBlank(item)) need = Math.max(need, textHeight(item, true, fixedText(item) ? cellWidth : undefined)!);
    }
    if (need > height + 0.001) {
      setChild(row, 'Height', inch(need));
      grown += need - height;
    }
  }
  designLeading = DESIGN_LEADING;
  if (grown) setChild(tablix, 'Height', inch(len(tablix, 'Height') + grown));
  return grown;
}

/**
 * Items drawn over each other, as Crystal allows: SSRS moves one of them aside when the report is previewed or saved
 * as a page, document or workbook (only a PDF or a print keeps them over each other), and the designer draws them
 * piled up. A box drawn round other items holds them; a text running on over its neighbour stops where the neighbour
 * starts (centred text equally at both ends, so it stays centred); what is left is listed for review.
 */
function separate(container: XmlElement, review: ReviewNote[]): void {
  const box = (e: XmlElement) => ({ l: len(e, 'Left'), t: len(e, 'Top'), r: len(e, 'Left') + len(e, 'Width'), b: len(e, 'Top') + len(e, 'Height') });
  const items = () => childElements(container).filter((e) => ITEMS.has(e.name) && e.name !== 'Line' && child(e, 'Top'));
  for (let changed = true; changed;) {
    changed = false;
    const list = items();
    pairs: for (const a of list) {
      for (const o of list) {
        if (a === o) continue;
        const A = box(a);
        const O = box(o);
        const ox = Math.min(A.r, O.r) - Math.max(A.l, O.l);
        const oy = Math.min(A.b, O.b) - Math.max(A.t, O.t);
        if (ox <= 0.001 || oy <= 0.001) continue;
        // An empty text box drawn as a band (filled or framed) round the item: a box (a text box holds no items).
        const inside = O.l >= A.l - 0.001 && O.r <= A.r + 0.001 && O.t >= A.t - 0.001 && O.b <= A.b + 0.001;
        if (a.name === 'Textbox' && o.name !== 'Rectangle' && inside && isBlank(a) && drawnAs(a)) {
          a.name = 'Rectangle';
          a.children = a.children.filter((c) => typeof c !== 'object' || ['Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'Style', 'Bookmark', 'DocumentMapLabel'].includes((c as XmlElement).name));
          const st = childElements(a, 'Style')[0];
          if (st) removeChildren(st, ['PaddingLeft', 'PaddingRight', 'PaddingTop', 'PaddingBottom', 'VerticalAlign', 'TextAlign', 'Format', 'Direction', 'WritingMode']);
          changed = true;
          break pairs;
        }
        // A box round the item: the item goes into it.
        if (a.name === 'Rectangle' && o.name !== 'Rectangle' && O.l >= A.l - 0.001 && O.r <= A.r + 0.001 && O.t >= A.t - 0.001 && O.b <= A.b + 0.001) {
          let holder = child(a, 'ReportItems');
          if (!holder) {
            holder = el('ReportItems');
            a.children.unshift(holder);
          }
          setChild(o, 'Top', inch(Math.max(0, O.t - A.t)));
          setChild(o, 'Left', inch(Math.max(0, O.l - A.l)));
          container.children = container.children.filter((c) => c !== o);
          holder.children.push(o);
          separate(holder, review);
          changed = true;
          break pairs;
        }
        if (a.name !== 'Textbox') continue;
        // An empty text box with nothing drawn (no border, no fill) over another item: it shows nothing, so it goes.
        if (isBlank(a) && !drawnAs(a) && !child(a, 'Visibility')) {
          container.children = container.children.filter((c) => c !== a);
          changed = true;
          break pairs;
        }
        const align = textAlignOf(a);
        // An empty frame round a centred title (the same middle, the text starting within it): one bordered text box,
        // the title in the frame's place and with its border.
        if (align === 'Center' && o.name === 'Rectangle' && !child(o, 'ReportItems') && drawnAs(o) && !child(o, 'Visibility')
          && Math.abs((A.l + A.r) / 2 - (O.l + O.r) / 2) < 0.1 && A.t >= O.t - 0.05 && A.t < O.b - 0.05) {
          const frame = childElements(o, 'Style')[0];
          const own = ownStyle(a);
          for (const side of ['Border', ...BORDER_SIDES]) {
            const border = child(frame, side);
            if (border) {
              removeChildren(own, [side]);
              own.children.unshift(border);
            }
          }
          if (child(frame, 'BackgroundColor') && !child(own, 'BackgroundColor')) own.children.push(child(frame, 'BackgroundColor')!);
          setChild(a, 'Top', inch(O.t));
          setChild(a, 'Left', inch(O.l));
          setChild(a, 'Width', inch(O.r - O.l));
          setChild(a, 'Height', inch(Math.max(O.b, A.b) - O.t));
          container.children = container.children.filter((c) => c !== o);
          changed = true;
          break pairs;
        }
        // Centred over a box of the same middle (a frame round a title): within the box, when it fits there.
        if (align === 'Center' && o.name === 'Rectangle' && Math.abs((A.l + A.r) / 2 - (O.l + O.r) / 2) < 0.05 && A.l < O.l && A.r > O.r
          && A.t >= O.t - 0.01 && A.b <= O.b + 0.01 && textWidth(a) <= O.r - O.l) {
          setChild(a, 'Left', inch(O.l));
          setChild(a, 'Width', inch(O.r - O.l));
          if (A.b > O.b) setChild(a, 'Height', inch(O.b - A.t));
          changed = true;
          break pairs;
        }
        // Over its neighbour by a hair from above: it ends where the neighbour starts.
        if (oy < 0.05 && A.t < O.t && A.b < O.b && ox > oy) {
          setChild(a, 'Height', inch(O.t - A.t));
          changed = true;
          break pairs;
        }
        // Over its neighbour along a line of text: the text stops at the neighbour.
        const sliver = ox < 0.05;
        let l = A.l;
        let r = A.r;
        if (align === 'Center' && O.l > A.l && O.r < A.r) {
          // (Centred, the neighbour within its width: equally at both ends, past the neighbour.)
          const cut = O.l - A.l < A.r - O.r ? O.r - A.l : A.r - O.l;
          l = A.l + cut;
          r = A.r - cut;
        } else if (A.l < O.l && (align !== 'Right' || sliver)) {
          r = O.l;
          if (align === 'Center') l = Math.min(O.l, A.l + (A.r - O.l));
        } else if (A.r > O.r && (align !== 'Left' || sliver)) {
          l = O.r;
          if (align === 'Center') r = Math.max(O.r, A.r - (O.r - A.l));
        } else continue;
        // (Centred text too narrow cut at both ends: cut on the neighbour's side only, where it then fits.)
        const need = sliver ? 0.05 : Math.max(0.05, Math.min(A.r - A.l, textWidth(a)));
        if (r - l < need && align === 'Center' && !sliver) {
          if (l > A.l && A.r - l >= need) r = A.r;
          else if (r < A.r && r - A.l >= need) l = A.l;
        }
        if (r - l < need) continue;
        setChild(a, 'Left', inch(l));
        setChild(a, 'Width', inch(r - l));
        changed = true;
        break pairs;
      }
    }
  }
  // A rule drawn along a text box's edge, a hair inside it (an underline at its foot): the text ends where the rule
  // starts (or starts where it ends), so the two lie one under the other.
  const rules = childElements(container).filter((e) => e.name === 'Line' && child(e, 'Top') && len(e, 'Height') === 0);
  for (const tb of items().filter((e) => e.name === 'Textbox')) {
    for (const rule of rules) {
      const T = box(tb);
      const y = len(rule, 'Top');
      const across = Math.min(T.r, len(rule, 'Left') + len(rule, 'Width')) - Math.max(T.l, len(rule, 'Left')) > 0.001;
      if (!across || y <= T.t + 0.001 || y >= T.b - 0.001) continue;
      if (T.b - y < 0.05) setChild(tb, 'Height', inch(y - T.t));
      else if (y - T.t < 0.05) {
        setChild(tb, 'Top', inch(y));
        setChild(tb, 'Height', inch(T.b - y));
      }
    }
  }
}

/**
 * The finished layout, as the designer draws it: items over each other (a preview, page, document or workbook moves
 * one aside; only a PDF or a print keeps them so), an item reaching past its box, a body wider than the page leaves
 * room for (SSRS would add a blank page after each page). Each is listed for review.
 */
function fixParameters(report: XmlElement, conv: Conventions, values: Record<string, string>, review: ReviewNote[]): void {
  if (!conv.parameters.length) return;
  const standard = new Set(conv.parameters.map((p) => p.name.toLowerCase()));
  const list = child(report, 'ReportParameters');
  const others = childElements(list ?? el('x'), 'ReportParameter').filter((p) => !standard.has((p.attributes.Name ?? '').toLowerCase()));
  if (!list || !others.length) return;
  const fixed = new Map<string, string>();
  for (const p of others) {
    const name = p.attributes.Name ?? '';
    const given = Object.entries(values).find(([k]) => k.replace(/^@/, '').toLowerCase() === name.toLowerCase())?.[1]?.trim();
    const type = textOf(child(p, 'DataType'));
    const quoted = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const literal = given === undefined ? 'Nothing'
      : /^(Integer|Float)$/.test(type) && /^-?\d+(\.\d+)?$/.test(given) ? given
        : type === 'Boolean' && /^(true|false)$/i.test(given) ? given
          : type === 'DateTime' ? `CDate(${quoted(given)})` : quoted(given);
    fixed.set(name.toLowerCase(), literal);
    review.push({ item: `Parameter ${name}`, message: given === undefined
      ? 'not a parameter of the base report, which the merge does not copy: passed as Nothing where it is read; set the value this schedule needs'
      : `not a parameter of the base report, which the merge does not copy: ${given} is written where it is read` });
  }
  for (const e of descendants(report)) {
    const t = e.children.length === 1 && typeof e.children[0] === 'string' ? (e.children[0] as string) : undefined;
    if (t === undefined || !t.startsWith('=')) continue;
    const v = t.replace(/Parameters!(\w+)(\.(?:Value|Label))?/g, (m, n: string) => fixed.get(n.toLowerCase()) ?? m);
    if (v !== t) e.children = [v];
  }
  list.children = list.children.filter((c) => !others.includes(c as XmlElement));
  removeChildren(report, ['ReportParametersLayout']);
  const kept = childElements(list, 'ReportParameter');
  if (!kept.length) report.children = report.children.filter((c) => c !== list);
  else {
    const layout = parametersLayout(kept.map((p) => p.attributes.Name ?? ''));
    if (layout) report.children.splice(report.children.indexOf(list) + 1, 0, layout);
  }
}

function withFunctions(root: XmlElement, functions: string[]): XmlElement {
  const named = functions.map((text) => ({ text, name: /CREATE\s+FUNCTION\s+(\S+?)\s*\(/i.exec(text)?.[1] ?? '' })).filter((f) => f.name);
  if (!named.length) return root;
  const copy = structuredClone(root);
  const quoted = (text: string) => `N'${text.replace(/'/g, "''")}'`;
  for (const query of descendants(copy).filter((e) => e.name === 'Query')) {
    if (/^StoredProcedure$/i.test(textOf(child(query, 'CommandType')))) continue;
    const command = child(query, 'CommandText');
    const text = textOf(command);
    const needed: typeof named = [];
    const need = (body: string) => {
      for (const f of named) {
        if (needed.includes(f) || !body.includes(f.name)) continue;
        needed.push(f);
        need(f.text.replace(f.name, ''));
        needed.push(needed.splice(needed.indexOf(f), 1)[0]!);
      }
    };
    need(text);
    if (!needed.length || !command) continue;
    const setup = needed.flatMap((f) => [
      `IF OBJECT_ID(${quoted(f.name)}) IS NULL BEGIN TRY EXEC (${quoted(f.text)}); END TRY BEGIN CATCH END CATCH;`,
      `EXEC (${quoted(f.text.replace(/CREATE\s+FUNCTION/i, 'ALTER FUNCTION'))});`,
    ]);
    command.children = [[...setup, text].join('\n')];
  }
  return copy;
}

function foldMargins(tablix: XmlElement): void {
  const columnsEl = child(tablix, 'TablixBody/TablixColumns');
  const members = child(tablix, 'TablixColumnHierarchy/TablixMembers');
  if (!columnsEl || !members || descendants(child(tablix, 'TablixColumnHierarchy')!).some((e) => e.name === 'Group')) return;
  const spanOf = (cell: XmlElement) => Number(textOf(child(child(cell, 'CellContents') ?? el('x'), 'ColSpan')) || 1);
  const setSpan = (cell: XmlElement, n: number) => {
    const contents = child(cell, 'CellContents')!;
    removeChildren(contents, ['ColSpan']);
    if (n > 1) contents.children.push(el('ColSpan', String(n)));
  };
  const empty = (cell: XmlElement) => descendants(cell).every((e) => (e.name === 'Value' ? !textOf(e).trim() : !/^(Line|Image|Chart|Subreport|Tablix|Map|GaugePanel)$/.test(e.name)));
  const starts = (cells: XmlElement[]) => {
    const out: number[] = [];
    for (let i = 0; i < cells.length;) {
      const n = spanOf(cells[i]!);
      for (let k = 0; k < n; k++) out.push(i);
      i += n;
    }
    return out;
  };
  for (const side of ['left', 'right'] as const) {
    const widths = widthsOf(tablix);
    const n = widths.length;
    if (n < 3 || members.children.filter((m) => typeof m === 'object').length !== n) return;
    const k = side === 'left' ? 0 : n - 1;
    if (widths[k]! > 0.3) continue;
    const rows = rowsOf(tablix);
    const fits = rows.every((row) => {
      const cells = cellsOf(row);
      if (cells.length !== n) return false;
      const s = starts(cells)[k]!;
      return s !== k || spanOf(cells[k]!) > 1 || empty(cells[k]!);
    });
    if (!fits) continue;
    const w = widths[k]!;
    for (const row of rows) {
      const cells = cellsOf(row);
      const holder = child(row, 'TablixCells')!;
      const s = starts(cells)[k]!;
      if (side === 'left') {
        if (spanOf(cells[0]!) > 1) {
          setSpan(cells[0]!, spanOf(cells[0]!) - 1);
          holder.children = holder.children.filter((c) => c !== cells[1]);
        } else {
          holder.children = holder.children.filter((c) => c !== cells[0]);
          const item = cellItem(cells[1]!);
          if (item?.name === 'Textbox') pad(item, { left: w });
          else if (item?.name === 'Rectangle') for (const e of childElements(child(item, 'ReportItems') ?? el('x')).filter((x) => child(x, 'Left'))) setChild(e, 'Left', inch(len(e, 'Left') + w));
        }
      } else if (s < k) {
        setSpan(cells[s]!, spanOf(cells[s]!) - 1);
        holder.children = holder.children.filter((c) => c !== cells[k]);
        const item = cellItem(cells[s]!);
        if (item?.name === 'Textbox') pad(item, { right: w });
      } else {
        holder.children = holder.children.filter((c) => c !== cells[k]);
        const before = starts(cells)[k - 1]!;
        const item = cellItem(cells[before]!);
        if (item?.name === 'Textbox') pad(item, { right: w });
      }
    }
    const columnList = childElements(columnsEl, 'TablixColumn');
    const into = side === 'left' ? 1 : n - 2;
    setChild(columnList[into]!, 'Width', inch(widths[into]! + w));
    columnsEl.children = columnsEl.children.filter((c) => c !== columnList[k]);
    const memberList = childElements(members, 'TablixMember');
    members.children = members.children.filter((c) => c !== memberList[k]);
  }
}

function ruledRow(row: XmlElement, side: 'Top' | 'Bottom'): boolean {
  return descendants(row).some((e) => (e.name === `${side}Border` || e.name === 'Border') && /solid|dashed|dotted|double/i.test(textOf(child(e, 'Style'))));
}

function ruledAbove(textbox: XmlElement): boolean {
  const style = childElements(textbox, 'Style')[0];
  return [child(style, 'TopBorder'), child(style, 'Border')].some((b) => b && /solid|dashed|dotted|double/i.test(textOf(child(b, 'Style'))));
}

/** A row whose cells show nothing: no text, picture, line or rule. */
function emptyRow(row: XmlElement): boolean {
  return cellsOf(row).every((cell) => descendants(cell).every((e) => {
    if (e.name === 'Value') return !textOf(e).trim();
    if (/^(Line|Image|Chart|Subreport|Tablix|Map|GaugePanel)$/.test(e.name)) return false;
    if (/^(Top|Bottom|Left|Right)?Border$/.test(e.name)) return /^None$/i.test(textOf(child(e, 'Style')) || 'None');
    if (e.name === 'BackgroundColor') return !textOf(e).trim() || /^(Transparent|No Color)$/i.test(textOf(e));
    return true;
  }));
}

/**
 * Text of fixed lines ("Order" & vbCrLf & "Date") as one paragraph per line: the designer shows and edits it as
 * text, where an expression shows as «Expr».
 */
function plainLines(report: XmlElement): void {
  for (const paragraphs of descendants(report).filter((e) => e.name === 'Paragraphs')) {
    const list = childElements(paragraphs, 'Paragraph');
    if (list.length !== 1) continue;
    const runs = childElements(child(list[0]!, 'TextRuns') ?? list[0]!, 'TextRun');
    if (runs.length !== 1) continue;
    const lines = literalLines(textOf(child(runs[0]!, 'Value')));
    if (!lines || lines.some((l) => l.startsWith('='))) continue;
    paragraphs.children = lines.map((line) => {
      const p = structuredClone(list[0]!);
      const value = child(child(p, 'TextRuns/TextRun')!, 'Value')!;
      value.children = [line];
      return p;
    });
  }
}

/** The lines of an expression made only of text and line breaks; undefined for any other. */
function literalLines(value: string): string[] | undefined {
  if (!value.startsWith('=')) return undefined;
  const lines = [''];
  let rest = value.slice(1).trim();
  let expectPart = true;
  while (rest) {
    let m: RegExpExecArray | null;
    if (expectPart && (m = /^"((?:[^"]|"")*)"\s*/.exec(rest))) lines[lines.length - 1] += m[1]!.replace(/""/g, '"');
    else if (expectPart && (m = /^(?:vbCrLf|vbNewLine|vbLf|Environment\.NewLine|ChrW?\(10\))\s*/i.exec(rest))) lines.push('');
    else if (!expectPart && (m = /^&\s*/.exec(rest))) { /* joined */ }
    else return undefined;
    expectPart = !expectPart;
    rest = rest.slice(m[0].length);
  }
  return !expectPart && lines.length > 1 ? lines : undefined;
}

function checkLayout(report: XmlElement, body: XmlElement, review: ReviewNote[]): void {
  const extent = (e: XmlElement) => ({ l: len(e, 'Left'), t: len(e, 'Top'), r: len(e, 'Left') + len(e, 'Width'), b: reach(e) });
  for (const holder of descendants(body).filter((e) => e.name === 'ReportItems')) {
    const list = childElements(holder).filter((e) => ITEMS.has(e.name) && e.name !== 'Line' && child(e, 'Top'));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = extent(list[i]!);
        const o = extent(list[j]!);
        if (Math.min(a.r, o.r) - Math.max(a.l, o.l) > 0.001 && Math.min(a.b, o.b) - Math.max(a.t, o.t) > 0.001) {
          review.push({ item: `${list[i]!.attributes.Name} / ${list[j]!.attributes.Name}`, message: 'drawn over each other, as in Crystal: a PDF or a print keeps them so, a preview, page, document or workbook moves one aside; place them apart' });
        }
      }
    }
    const box = descendants(body).find((e) => e.name === 'Rectangle' && child(e, 'ReportItems') === holder);
    if (!box) continue;
    // (A box in a table cell takes the cell's size: its columns' width, its row's height.)
    let boxWidth = len(box, 'Width');
    let boxHeight = Math.max(len(box, 'Height'), contentBottom(box));
    if (!child(box, 'Width')) {
      const row = descendants(body).find((e) => e.name === 'TablixRow' && descendants(e).includes(box));
      const tablix = row && descendants(body).find((e) => e.name === 'Tablix' && rowsOf(e).includes(row));
      const cells = row ? cellsOf(row) : [];
      const at = cells.findIndex((c) => descendants(c).includes(box));
      if (!tablix || at < 0) continue;
      const span = Number(textOf(child(cells[at]!, 'CellContents/ColSpan')) || 1);
      boxWidth = widthsOf(tablix).slice(at, at + span).reduce((a, b) => a + b, 0);
      boxHeight = len(row!, 'Height');
    }
    for (const item of childElements(holder).filter((e) => ITEMS.has(e.name) && child(e, 'Top'))) {
      const e = extent(item);
      if (e.r > boxWidth + 0.01 || e.b > boxHeight + 0.01) {
        review.push({ item: `${item.attributes.Name}`, message: `reaches past its box ${box.attributes.Name}; the designer draws it cut off there` });
      }
    }
  }
  const page = descendants(report).find((e) => e.name === 'Page');
  const width = Math.max(...descendants(report).filter((e) => e.name === 'ReportSection').map((sec) => len(sec, 'Width')), 0);
  const room = page ? len(page, 'PageWidth') - len(page, 'LeftMargin') - len(page, 'RightMargin') : 0;
  if (page && width && len(page, 'PageWidth') && width > room + 0.01) {
    review.push({ item: 'Page', message: `the body is ${width.toFixed(2)}in wide, the page leaves ${room.toFixed(2)}in between its margins: SSRS adds a blank page after each page; narrow the body or widen the page` });
  }
}

/** Whether an item draws anything of its own: a border or a fill. */
function drawnAs(item: XmlElement): boolean {
  const st = childElements(item, 'Style')[0] ?? el('Style');
  return /^(solid|dashed|dotted|double)/i.test(textOf(child(st, 'Border/Style'))) || BORDER_SIDES.some((side) => /^(solid|dashed|dotted|double)/i.test(textOf(child(st, `${side}/Style`))))
    || (!!textOf(child(st, 'BackgroundColor')) && !/^(transparent|#00ffffff)$/i.test(textOf(child(st, 'BackgroundColor'))));
}

/** How a text box's text is set across (its first paragraph's; a number on its own, as SSRS sets it, to the right). */
function textAlignOf(textbox: XmlElement): string {
  const set = textOf(child(descendants(textbox).find((e) => e.name === 'Paragraph') ?? el('x'), 'Style/TextAlign'));
  if (set && set !== 'General') return set;
  const format = descendants(textbox).find((e) => e.name === 'Format');
  return (format && /[#0]|^[NCP]\d*$/i.test(textOf(format))) || /^=\s*(Sum|Count|Avg)\(/i.test(valueOf(textbox)) ? 'Right' : 'Left';
}

/** Widths of Arial's letters, in thousandths of the size (others as a digit). */
const ARIAL: Record<string, number> = Object.fromEntries([
  ...[...' !,./:;I[\\]ijlft'].map((ch) => [ch, ch === 'f' || ch === 't' ? 278 : 'ijl'.includes(ch) ? 222 : 278]),
  ...[...'"'].map((ch) => [ch, 355]), ["'", 191], ['(', 333], [')', 333], ['-', 333], ['r', 333], ['*', 389], ['^', 469],
  ...[...'ckvxyzsJ'].map((ch) => [ch, 500]), ...[...'+<=>'].map((ch) => [ch, 584]), ['F', 611], ['T', 611], ['Z', 611],
  ...[...'ABEKPSVXY&'].map((ch) => [ch, 667]), ...[...'CDHNRUw'].map((ch) => [ch, 722]), ...[...'GOQ'].map((ch) => [ch, 778]),
  ['M', 833], ['m', 833], ['%', 889], ['W', 944], ['@', 1015],
]);

/** How wide a run of text is drawn in Arial at a size (inches); bold a little wider. */
function arialWidth(text: string, size: number, bold: boolean): number {
  let units = 0;
  for (const ch of text) units += ARIAL[ch] ?? 556;
  return (units / 1000) * size * (bold ? 1.1 : 1) / 72;
}

/** The size (pt) and weight fixed text is drawn at in the designer. */
function drawnFont(textbox: XmlElement, design: boolean): { size: number; bold: boolean } {
  const sizes = descendants(textbox).filter((e) => e.name === 'FontSize').map((e) => textOf(e));
  const worked = design || sizes.some((v) => v.startsWith('='));
  const points = sizes.filter((v) => !v.startsWith('=')).map((v) => (inches(v) ?? 0) * 72).filter((v) => v > 0);
  const weights = descendants(textbox).filter((e) => e.name === 'FontWeight').map((e) => textOf(e));
  // (Where the house's styles give the weight, it is not known yet: taken as bold, so there is room either way.)
  return { size: Math.max(worked || !points.length ? DESIGN_FONT : 0, ...points), bold: (design && designText) || weights.some((w) => w.startsWith('=') || /bold|heavy|black/i.test(w)) };
}

/** The padding (inches) of a text box's sides. */
function paddingOf(textbox: XmlElement, sides: string[]): number {
  const style = childElements(textbox, 'Style')[0];
  return sides.reduce((a, k) => a + (inches(textOf(child(style, k))) ?? 0), 0);
}

/** The lines a text box's fixed text wraps to in a cell of a width (its paragraphs, each wrapped at its words). */
function wrapLines(textbox: XmlElement, width: number, size: number): number | undefined {
  const text = fixedText(textbox);
  if (text === undefined) return undefined;
  const { bold } = drawnFont(textbox, true);
  const room = Math.max(0.01, width - paddingOf(textbox, ['PaddingLeft', 'PaddingRight']));
  let lines = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    let line = 0;
    lines++;
    for (const word of paragraph.split(/ +/)) {
      const w = arialWidth(word, size, bold);
      const gap = line ? arialWidth(' ', size, bold) : 0;
      if (line && line + gap + w > room) {
        lines++;
        line = w;
      } else line += gap + w;
      // (A word wider than the room is broken over lines.)
      if (w > room) lines += Math.ceil(w / room) - 1;
    }
  }
  return Math.max(1, lines);
}

/** Fixed text whose longest word is wider than its cell less its padding: the padding at its sides cut back to fit it. */
function roomForWords(textbox: XmlElement, width: number, design: boolean): void {
  const text = fixedText(textbox);
  if (!text) return;
  const { size, bold } = drawnFont(textbox, design);
  const longest = Math.max(...text.split(/\s+/).map((w) => arialWidth(w, size, bold)));
  const style = childElements(textbox, 'Style')[0];
  if (!style) return;
  const left = paddingOf(textbox, ['PaddingLeft']);
  const right = paddingOf(textbox, ['PaddingRight']);
  const spare = width - longest - 0.02;
  if (left + right <= 0 || width - left - right >= longest + 0.02) return;
  const keep = Math.max(0, Math.min(1, spare / (left + right)));
  setChild(style, 'PaddingLeft', `${((left * keep) * 72).toFixed(1)}pt`);
  setChild(style, 'PaddingRight', `${((right * keep) * 72).toFixed(1)}pt`);
}

/**
 * About how wide a text box's fixed text is drawn (inches): as the designer draws it, or (printed) at its own size;
 * unknown (0) for text worked out when the report runs.
 */
function textWidth(textbox: XmlElement, printed = false): number {
  const text = fixedText(textbox);
  if (text === undefined) return 0;
  const sizes = descendants(textbox).filter((e) => e.name === 'FontSize' && !textOf(e).startsWith('=')).map((e) => (inches(textOf(e)) ?? 0) * 72);
  const size = printed && sizes.length ? Math.max(...sizes) : Math.max(DESIGN_FONT, ...sizes);
  const style = childElements(textbox, 'Style')[0];
  const padding = ['PaddingLeft', 'PaddingRight'].reduce((a, k) => a + (inches(textOf(child(style, k))) ?? 0), 0);
  return Math.max(...text.split(/\r?\n/).map((line) => line.length)) * size * 0.55 / 72 + padding;
}

/** What lies under an item that grew (from its old bottom, across part of its width) moves down by as far. */
function moveBelow(container: XmlElement, item: XmlElement, oldBottom: number, by: number, left: number, right: number): void {
  for (const e of childElements(container).filter((x) => ITEMS.has(x.name) && x !== item)) {
    if (len(e, 'Top') >= oldBottom - 0.001 && len(e, 'Left') < right && len(e, 'Left') + len(e, 'Width') > left) setChild(e, 'Top', inchUp(len(e, 'Top') + by));
  }
}

/**
 * Groups a container's items into bands: items whose extents (at their full size) run into each other down the page.
 * A band of more than one item becomes a box of its own round them, as wide as they are, holding them in place.
 */
function band(holder: XmlElement): void {
  const items = childElements(holder).filter((e) => ITEMS.has(e.name) && child(e, 'Top'))
    .sort((a, b) => len(a, 'Top') - len(b, 'Top'));
  const bands: XmlElement[][] = [];
  let bottom = -Infinity;
  for (const item of items) {
    const top = len(item, 'Top');
    if (bands.length && top < bottom - 0.001) bands[bands.length - 1]!.push(item);
    else bands.push([item]);
    bottom = Math.max(bands[bands.length - 1]!.length > 1 ? bottom : -Infinity, reach(item));
  }
  // (One band holding everything is the container itself.)
  if (bands.length < 2) return;
  for (const members of bands.filter((b) => b.length > 1)) {
    const top = Math.min(...members.map((e) => len(e, 'Top')));
    const left = Math.min(...members.map((e) => len(e, 'Left')));
    const right = Math.max(...members.map((e) => len(e, 'Left') + len(e, 'Width')));
    const foot = Math.max(...members.map(reach));
    for (const e of members) {
      setChild(e, 'Top', inch(len(e, 'Top') - top));
      setChild(e, 'Left', inch(len(e, 'Left') - left));
    }
    const box = el('Rectangle', { Name: 'Band' }, el('ReportItems', ...members),
      el('Top', inch(top)), el('Left', inch(left)), el('Height', inchUp(foot - top)), el('Width', inch(right - left)),
      el('Style', el('Border', el('Style', 'None'))));
    const at = holder.children.indexOf(members[0]!);
    holder.children = holder.children.filter((c) => !members.includes(c as XmlElement));
    holder.children.splice(Math.min(at, holder.children.length), 0, box);
  }
}

/**
 * A box in a table cell holding more than the cell's width (a cross-tab Crystal let run past the column it starts
 * in): the cell's last column widens to hold it, as the designer would otherwise cut it off. Inner tables first.
 */
function widenCells(body: XmlElement): void {
  for (const tablix of descendants(body).filter((e) => e.name === 'Tablix').reverse()) {
    // (A table is drawn as tall as its rows and as wide as its columns, whatever its size says.)
    const rowsHeight = rowsOf(tablix).reduce((sum, row) => sum + len(row, 'Height'), 0);
    if (rowsHeight > 0 && Math.abs(rowsHeight - len(tablix, 'Height')) > 0.001) setChild(tablix, 'Height', inchUp(rowsHeight));
    const columnsWidth = widthsOf(tablix).reduce((sum, w) => sum + w, 0);
    if (columnsWidth > 0 && Math.abs(columnsWidth - len(tablix, 'Width')) > 0.001) setChild(tablix, 'Width', inchUp(columnsWidth));
    const columns = childElements(child(tablix, 'TablixBody/TablixColumns') ?? el('x'), 'TablixColumn');
    for (const row of rowsOf(tablix)) {
      let at = 0;
      for (const cell of cellsOf(row)) {
        const span = Number(textOf(child(cell, 'CellContents/ColSpan')) || 1);
        const box = cellItem(cell);
        const holder = box?.name === 'Rectangle' ? child(box, 'ReportItems') : undefined;
        if (holder) {
          const width = (e: XmlElement) => (e.name === 'Tablix' ? widthsOf(e).reduce((a, b) => a + b, 0) : len(e, 'Width'));
          const need = Math.max(0, ...childElements(holder).filter((e) => ITEMS.has(e.name) && child(e, 'Left')).map((e) => len(e, 'Left') + width(e)));
          const have = columns.slice(at, at + span).reduce((a, c) => a + len(c, 'Width'), 0);
          const last = columns[at + span - 1];
          if (last && need > have + 0.01) {
            setChild(last, 'Width', inchUp(len(last, 'Width') + need - have));
            setChild(tablix, 'Width', inchUp(len(tablix, 'Width') + need - have));
          }
        }
        at += span;
      }
    }
  }
}

/** How far down an item reaches as drawn: a table as tall as its rows, a box as its content. */
function reach(item: XmlElement): number {
  const top = len(item, 'Top');
  if (item.name === 'Tablix') return top + Math.max(len(item, 'Height'), rowsOf(item).reduce((sum, row) => sum + len(row, 'Height'), 0));
  if (item.name === 'Rectangle') return top + Math.max(len(item, 'Height'), contentBottom(item));
  return top + len(item, 'Height');
}

/** Where a box's content ends (inches from its top). */
function contentBottom(box: XmlElement): number {
  const holder = child(box, 'ReportItems');
  return holder ? Math.max(0, ...childElements(holder).filter((e) => ITEMS.has(e.name)).map(reach)) : 0;
}

/**
 * A box, table or chart reaching over what lies lower (a frame holding a table that grew, a box drawn half over a
 * chart): the designer draws them piled up, and SSRS moves the lower one down anyway when the report is previewed or
 * saved (only a PDF or a print would keep them piled). A box whose content ends above the lower item stops there;
 * otherwise the lower item, and all below it, moves down below it. Inner boxes first; returns where the lowest ends.
 */
function unpile(container: XmlElement | undefined): number {
  if (!container) return 0;
  const items = () => childElements(container).filter((e) => ITEMS.has(e.name) && child(e, 'Top'));
  for (const box of items().filter((e) => e.name === 'Rectangle')) {
    const inner = unpile(child(box, 'ReportItems'));
    if (inner > len(box, 'Height') + 0.001) setChild(box, 'Height', inchUp(inner));
  }
  // (A table is drawn as tall as its rows and as wide as its columns, whatever its size says.)
  for (const t of items().filter((e) => e.name === 'Tablix')) {
    const rows = rowsOf(t).reduce((sum, row) => sum + len(row, 'Height'), 0);
    const columns = widthsOf(t).reduce((sum, w) => sum + w, 0);
    if (rows > 0 && Math.abs(rows - len(t, 'Height')) > 0.001) setChild(t, 'Height', inchUp(rows));
    if (columns > 0 && Math.abs(columns - len(t, 'Width')) > 0.001) setChild(t, 'Width', inchUp(columns));
  }
  const BLOCKS = new Set(['Rectangle', 'Tablix', 'Chart', 'Subreport', 'GaugePanel', 'Map', 'CustomReportItem']);
  for (let guard = 0; guard < 1000; guard++) {
    const list = items().sort((x, y) => len(x, 'Top') - len(y, 'Top'));
    let fixed = false;
    for (const a of list) {
      if (!BLOCKS.has(a.name)) continue;
      const aTop = len(a, 'Top');
      const aBottom = reach(a);
      const aLeft = len(a, 'Left');
      const aRight = aLeft + len(a, 'Width');
      // (A frame or band whose own content ends above a text drawn over it is how Crystal draws a label on a band:
      // it stays. Its content, or a table or chart, reaching over what lies lower is not.)
      const contentEnd = a.name === 'Rectangle' ? aTop + contentBottom(a) : aBottom;
      const o = list.find((e) => e !== a && e.name !== 'Line' && len(e, 'Top') > aTop + 0.001 && len(e, 'Top') < aBottom - 0.001
        && Math.min(aRight, len(e, 'Left') + len(e, 'Width')) - Math.max(aLeft, len(e, 'Left')) > 0.001
        && (BLOCKS.has(e.name) || len(e, 'Top') < contentEnd - 0.001));
      if (!o) continue;
      const oTop = len(o, 'Top');
      if (contentEnd <= oTop + 0.001) {
        // (A frame whose content ends above a box, table or chart: the frame stops there.)
        setChild(a, 'Height', inch(oTop - aTop));
      } else {
        const by = aBottom - oTop;
        for (const e of list) if (e !== a && len(e, 'Top') >= oTop - 0.001) setChild(e, 'Top', inchUp(len(e, 'Top') + by));
      }
      fixed = true;
      break;
    }
    if (!fixed) break;
  }
  return Math.max(0, ...items().map(reach));
}

/** The size (pt) and line spacing the designer draws text at where its size is worked out when the report runs. */
const DESIGN_FONT = 10;
const DESIGN_LEADING = 1.4;
/** The line spacing a row printed for each record is given: one line of the designer's default size, no more. */
const DESIGN_TIGHT = 1.15;
let designLeading = DESIGN_LEADING;
let designText = false;
/** The width of a thin empty column (inches). */
const SPARE_WIDTH = 0.01;

/** Fits the items in a container (see above); returns where the lowest ends. */
function fitItems(container: XmlElement | undefined): number {
  if (!container) return 0;
  const items = childElements(container).filter((e) => ITEMS.has(e.name));
  const before = new Map(items.map((e) => [e, { top: len(e, 'Top'), bottom: len(e, 'Top') + len(e, 'Height'), left: len(e, 'Left'), right: len(e, 'Left') + len(e, 'Width') }]));
  const grew = new Map<XmlElement, number>();
  for (const e of items) {
    let g = 0;
    if (e.name === 'Rectangle') {
      const inner = fitItems(child(e, 'ReportItems'));
      g = Math.max(0, inner - len(e, 'Height'));
    } else if (e.name === 'Tablix') g = fitTablix(e);
    else if (e.name === 'Textbox' && designText && !isBlank(e)) g = Math.max(0, textHeight(e, true)! - len(e, 'Height'));
    if (g > 0.001) {
      if (e.name === 'Rectangle' || e.name === 'Textbox') setChild(e, 'Height', inchUp(len(e, 'Height') + g));
      grew.set(e, g);
    }
  }
  // What lies under a grown item (across part of its width) moves down with it, as it does when the report runs.
  const shift = new Map<XmlElement, number>();
  const order = [...items].sort((a, b) => before.get(a)!.top - before.get(b)!.top);
  for (const j of order) {
    const bj = before.get(j)!;
    let s = 0;
    for (const i of order) {
      if (i === j) continue;
      const bi = before.get(i)!;
      if (bi.right <= bj.left + 0.001 || bj.right <= bi.left + 0.001) continue;
      // (A rule drawn in the lower half of a text box is that text's rule, along its bottom: it moves with that.)
      const rule = j.name === 'Line' && len(j, 'Height') === 0 && i.name === 'Textbox' && bj.top >= (bi.top + bi.bottom) / 2 - 0.001;
      // (Items Crystal drew touching, or a hair over each other, are one under the other.)
      if (bi.bottom > bj.top + 0.01 && !rule) continue;
      s = Math.max(s, (shift.get(i) ?? 0) + (grew.get(i) ?? 0));
    }
    if (s > 0.001) {
      shift.set(j, s);
      setChild(j, 'Top', inchUp(bj.top + s));
    }
  }
  return Math.max(0, ...items.map((e) => len(e, 'Top') + len(e, 'Height')));
}

/**
 * What nothing reads any more (the page header's dataset, its custom code, its pictures, a placeholder dataset, a
 * parameter only those read) is left out.
 */
function dropUnused(report: XmlElement, conv: Conventions, review: ReviewNote[]): void {
  const texts = () => descendants(report).flatMap((e) => [textOf(e), ...Object.values(e.attributes)]).join('\n');
  const quoted = (name: string) => new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
  // Datasets: read by a table or chart, a parameter's values, or by name in an expression.
  const dataSets = child(report, 'DataSets');
  for (let changed = true; changed;) {
    changed = false;
    for (const ds of childElements(dataSets ?? el('x'), 'DataSet')) {
      const name = ds.attributes.Name ?? '';
      if (name === conv.style?.dataset) continue;
      const others = descendants(report).filter((e) => !descendants(ds).includes(e));
      const read = others.some((e) => (e.name === 'DataSetName' && textOf(e) === name) || (textOf(e).startsWith('=') && quoted(name).test(textOf(e))));
      if (read) continue;
      dataSets!.children = dataSets!.children.filter((c) => c !== ds);
      review.push({ item: `Dataset ${name}`, message: 'left out: nothing in the template reads it (it served the page header or no data)' });
      changed = true;
    }
  }
  // Parameters only the dropped datasets passed on (the team's standard ones stay).
  const params = child(report, 'ReportParameters');
  const all = texts();
  for (const p of childElements(params ?? el('x'), 'ReportParameter')) {
    const name = p.attributes.Name ?? '';
    if (conv.parameters.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
    if (new RegExp(`Parameters!${name}\\b`).test(all)) continue;
    params!.children = params!.children.filter((c) => c !== p);
    review.push({ item: `Parameter ${name}`, message: 'left out: nothing in the template uses it' });
  }
  if (params && !childElements(params, 'ReportParameter').length) report.children = report.children.filter((c) => c !== params);
  const layout = child(report, 'ReportParametersLayout');
  if (layout) {
    const names = childElements(params ?? el('x'), 'ReportParameter').map((p) => p.attributes.Name ?? '');
    const fresh = parametersLayout(names);
    report.children = report.children.flatMap((c) => (c === layout ? (fresh ? [fresh] : []) : [c]));
  }
  // Custom code nothing calls; pictures nothing shows.
  const code = child(report, 'Code');
  if (code && !/\bCode\./.test(descendants(report).filter((e) => e !== code).map(textOf).join('\n'))) {
    report.children = report.children.filter((c) => c !== code);
    review.push({ item: 'Custom code', message: 'left out: nothing in the template calls it' });
  }
  const images = child(report, 'EmbeddedImages');
  if (images) {
    const shown = new Set(descendants(report).filter((e) => e.name === 'Image' && textOf(child(e, 'Source')) === 'Embedded').map((e) => textOf(child(e, 'Value'))));
    const before = childElements(images, 'EmbeddedImage').length;
    images.children = images.children.filter((c) => !(c && typeof c === 'object' && (c as XmlElement).name === 'EmbeddedImage' && !shown.has((c as XmlElement).attributes.Name ?? '')));
    if (!childElements(images, 'EmbeddedImage').length) report.children = report.children.filter((c) => c !== images);
    const dropped = before - childElements(images, 'EmbeddedImage').length;
    if (dropped) review.push({ item: 'Pictures', message: `${dropped} left out: nothing in the template shows them (the page header's logo)` });
  }
}

const newNames = (named: Set<XmlElement>) => new Set([...named].map((e) => (e.attributes.Name ?? '').toLowerCase()));

const BORDER_SIDES = ['TopBorder', 'BottomBorder', 'LeftBorder', 'RightBorder'];

function insertBefore(parent: XmlElement, item: XmlElement, before: string[]): void {
  const i = parent.children.findIndex((c) => typeof c === 'object' && c !== null && before.includes((c as XmlElement).name));
  if (i < 0) parent.children.push(item);
  else parent.children.splice(i, 0, item);
}

/** Each role's looks, as expressions reading the style dataset; the dataset itself, with the fields used. */
function applyStyleRoles(report: XmlElement, style: NonNullable<Conventions['style']>, roles: Map<XmlElement, RoleKey>, tableCells: Set<XmlElement>,
  unbanded: Set<XmlElement>, bandRows: XmlElement[], review: ReviewNote[], dataSourceName: string): void {
  const used = new Set<string>();
  const field = (role: string, prop: string) => {
    const name = style.field.replace(/\{role\}/g, role).replace(/\{prop\}/g, prop);
    used.add(name);
    return name;
  };
  const expr = (name: string) => `First(Fields!${name}.Value, "${style.dataset}")`;
  const banded = new Set(bandRows);
  const hiddenBy = new Map<XmlElement, string>();
  for (const t of descendants(report).filter((e) => e.name === 'Tablix')) {
    const rows = rowsOf(t);
    let r = 0;
    const walk = (members: XmlElement | undefined, conds: string[]) => {
      for (const m of childElements(members ?? el('TablixMembers'), 'TablixMember')) {
        const hidden = textOf(child(m, 'Visibility/Hidden')).trim();
        const own = hidden.startsWith('=') && !/CountRows\(\)/.test(hidden) ? [...conds, `(${hidden.slice(1)})`] : conds;
        const nested = child(m, 'TablixMembers');
        if (nested) walk(nested, own);
        else {
          const row = rows[r++];
          if (row && own.length) for (const tb of descendants(row).filter((e) => e.name === 'Textbox')) hiddenBy.set(tb, own.join(' OrElse '));
        }
      }
    };
    walk(child(t, 'TablixRowHierarchy/TablixMembers'), []);
  }
  const isRed = (v: string) => /^(red|#ff0000|#ff0000ff)$/i.test(v.trim());
  for (const [tb, roleKey] of roles) {
    const role = style.roles[roleKey];
    if (!role) continue;
    const runs = runStyles(tb);
    for (const prop of ['FontFamily', 'FontSize', 'FontWeight', 'Color'] as const) {
      const word = style.props[prop];
      if (!word) continue;
      for (const s of runs) {
        const current = textOf(child(s, prop));
        // A colour Crystal works out by a formula, or prints in red, is kept.
        if (prop === 'Color' && (current.startsWith('=') || isRed(current))) continue;
        // So is a weight Crystal works out by a formula (a statement's bold lines), and bold text in a table's data or
        // in plain text (Crystal's emphasis), where the role's weight would lose it.
        if (prop === 'FontWeight' && (current.startsWith('=')
          || (/^(semibold|bold|extrabold|heavy)$/i.test(current) && ['body', 'bodyFirst', 'number', 'text', 'footer'].includes(roleKey)))) continue;
        setChild(s, prop, `=${expr(field(role, word))}`);
      }
    }
    for (const prop of ['TextAlign'] as const) {
      const word = style.props[prop];
      if (!word) continue;
      for (const p of descendants(tb).filter((e) => e.name === 'Paragraph')) {
        let ps = child(p, 'Style');
        if (!ps) p.children.push((ps = el('Style')));
        setChild(ps, prop, `=${expr(field(role, word))}`);
      }
    }
    const own = ownStyle(tb);
    if (style.props.VerticalAlign) setChild(own, 'VerticalAlign', `=${expr(field(role, style.props.VerticalAlign))}`);
    // Fills: a table's title, headings, group rows and totals take their role's; data rows the odd and even bands.
    const fillWord = style.props.BackgroundColor;
    const current = textOf(child(own, 'BackgroundColor'));
    const plain = !current || /^(transparent|white|#ffffff|#00ffffff)$/i.test(current);
    if (fillWord && tableCells.has(tb) && plain) {
      if (roleKey === 'body' || roleKey === 'bodyFirst' || roleKey === 'number') {
        if (style.rowBands && !unbanded.has(tb)) {
          const counted = hiddenBy.has(tb) ? `RunningValue(IIf(${hiddenBy.get(tb)}, 0, 1), Sum, Nothing)` : 'RowNumber(Nothing)';
          setChild(own, 'BackgroundColor', `=IIF(${counted} Mod 2, ${expr(field(style.rowBands.odd, fillWord))}, ${expr(field(style.rowBands.even, fillWord))})`);
          const hides = textOf(child(tb, 'Visibility/Hidden')).trim();
          const values = descendants(tb).filter((e) => e.name === 'Value');
          if (hides.startsWith('=') && !child(child(tb, 'Visibility')!, 'ToggleItem') && values.length === 1) {
            const v = textOf(values[0]).trim();
            values[0]!.children = [`=IIf(${hides.slice(1)}, Nothing, ${v.startsWith('=') ? v.slice(1) : `"${v.replace(/"/g, '""')}"`})`];
            tb.children = tb.children.filter((x) => typeof x !== 'object' || (x as XmlElement).name !== 'Visibility');
          }
        }
      } else setChild(own, 'BackgroundColor', `=${expr(field(role, fillWord))}`);
    }
  }
  // Blank cells of painted rows take the row's fill, so the band runs across.
  for (const row of banded) {
    const cells = cellsOf(row).map(cellItem).filter((x): x is XmlElement => !!x && (x.name === 'Textbox' || x.name === 'Rectangle'));
    const painted = descendants(row).filter((e) => e.name === 'Textbox').map((c) => textOf(child(ownStyle(c), 'BackgroundColor'))).find((v) => v.startsWith('=First(') || v.startsWith('=IIF(RowNumber') || v.startsWith('=IIF(RunningValue'));
    if (!painted) continue;
    for (const c of cells) {
      const s = ownStyle(c);
      const cur = textOf(child(s, 'BackgroundColor'));
      if (!cur || /^(transparent|white|#ffffff|#00ffffff)$/i.test(cur)) setChild(s, 'BackgroundColor', painted);
    }
  }
  // Borders Crystal draws in black take the house's border colour.
  if (style.border) {
    for (const e of descendants(report).filter((x) => x.name === 'Style')) {
      for (const side of ['Border', ...BORDER_SIDES]) {
        const b = child(e, side);
        if (!b) continue;
        const kind = textOf(child(b, 'Style'));
        if (!kind || /^none$/i.test(kind)) continue;
        const color = textOf(child(b, 'Color'));
        if (color && !/^(black|#000000|#000000ff)$/i.test(color)) continue;
        const word = side === 'Border' ? 'bottom' : side.replace('Border', '').toLowerCase();
        const name = style.border.replace(/\{side\}/g, word);
        used.add(name);
        setChild(b, 'Color', `=${expr(name)}`);
      }
    }
  }
  if (!used.size) return;
  // The style dataset: its fields, those the report reads.
  const dataSets = child(report, 'DataSets');
  if (!dataSets) return;
  if (childElements(dataSets, 'DataSet').some((d) => d.attributes.Name === style.dataset)) {
    review.push({ item: `Dataset ${style.dataset}`, message: 'already in the report; its fields are left as they are' });
    return;
  }
  dataSets.children.push(el('DataSet', { Name: style.dataset },
    el('Query', el('DataSourceName', dataSourceName), style.commandType ? el('CommandType', style.commandType) : null, el('CommandText', style.command)),
    el('Fields', ...[...used].sort().map((f) => el('Field', { Name: f }, el('DataField', f), el('rd:TypeName', 'System.String'))))));
}

