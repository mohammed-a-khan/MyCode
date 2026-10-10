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
 *                "cellRect": "{T}_{col}_Box",
 *                "line": "{S}_Line{n}", "image": "{S}_Image{n}", "chart": "{S}_Chart{n}", "group": "{S}_Group{n}",
 *                "details": "{S}_Details" },
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
  'blank', 'noData', 'footer', 'text', 'cellRect', 'line', 'image', 'chart', 'group', 'details'] as const;
type NameKey = typeof NAME_KEYS[number];

const ROLE_KEYS = ['title', 'heading', 'headingFirst', 'body', 'bodyFirst', 'number', 'group', 'totalLabel', 'totalValue', 'footer', 'text'] as const;
type RoleKey = typeof ROLE_KEYS[number];

const STYLE_PROPS = ['FontFamily', 'FontSize', 'FontWeight', 'Color', 'BackgroundColor', 'TextAlign', 'VerticalAlign'] as const;

export interface Conventions {
  names: Record<NameKey, string>;
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
  text: '{S}_Text{n}', cellRect: '{T}_{col}_Box', line: '{S}_Line{n}', image: '{S}_Image{n}', chart: '{S}_Chart{n}', group: '{S}_Group{n}', details: '{S}_Details',
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
  const o = object('', raw, ['names', 'dataset', 'dataSource', 'parameters', 'page', 'pageBands', 'noData', 'documentMap', 'style'])!;
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
function fieldOf(textbox: XmlElement): string | undefined {
  const v = valueOf(textbox).trim();
  const m = /^=\s*(?:\w+\(\s*)?Fields!(\w+)\.Value(?:\s*(?:,\s*"[^"]*"\s*)?\))?\s*$/i.exec(v);
  return m?.[1]?.replace(/^F_(?=\w)/, '');
}
/** A name worked from an item's Crystal name (its number dropped). */
const ownWord = (item: XmlElement) => snake((item.attributes.Name ?? '').replace(/_?\d+$/, '')) || undefined;

class Names {
  private readonly used = new Set<string>();
  make(base: string): string {
    let name = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z])/, 'R$1');
    for (let k = 2; this.used.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    this.used.add(name.toLowerCase());
    return name;
  }
}

type RowKind = 'heading' | 'noData' | 'groupHeading' | 'detail' | 'subtotal' | 'total';

interface Leaf {
  member: XmlElement;
  kind: RowKind;
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
export function applyConventions(rdl: string, reportName: string, conv: Conventions): { rdl: string; review: ReviewNote[]; settled: string[] } {
  const review: ReviewNote[] = [];
  const root = parseXml(rdl);
  const report = root.name === 'Report' ? root : descendants(root).find((e) => e.name === 'Report')!;
  const S = snake(reportName) || 'Report';
  const names = new Names();
  const itemRenames = new Map<string, string>();
  const scopeRenames = new Map<string, string>();
  const paramRenames = new Map<string, string>();
  const counters = new Map<string, number>();
  const fill = (key: NameKey, vars: { T?: string; col?: string }) => {
    let pattern = conv.names[key];
    if (pattern.includes('{n}')) {
      // One count per pattern (groups and details groups named alike count together).
      const id = `${pattern}|${pattern.includes('{T}') ? vars.T ?? '' : ''}`;
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
    return name;
  };

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
    for (const region of descendants(report).filter((e) => (e.name === 'Tablix' || e.name === 'Chart') && child(e, 'DataSetName'))) {
      const old = textOf(child(region, 'DataSetName'));
      const ds = dataSets.find((d) => d.attributes.Name === old);
      if (!ds || ds === main || scopeRenames.has(old)) continue;
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
      setChild(tablix, 'Height', inch(len(tablix, 'Height') + height));
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
        setChild(tablix, 'Height', inch(Math.max(0.01, len(tablix, 'Height') - dropped)));
      }
    }

    // A row shown only when there is no data, under the headings.
    const leaves = rowLeaves(tablix);
    if (textOf(child(tablix, 'DataSetName')) && !leaves.some((l) => l.kind === 'noData')) {
      const memberList = child(tablix, 'TablixRowHierarchy/TablixMembers')!;
      const top = childElements(memberList, 'TablixMember');
      // The leading rows that are headings (each its own top-level member).
      let at = 0;
      while (at < top.length && leaves[at]?.member === top[at] && leaves[at]!.kind === 'heading') at++;
      const what = (titleText ?? reportName.replace(/_/g, ' ')).trim();
      const message = conv.noData.replace(/\{TITLE\}/g, what.toUpperCase()).replace(/\{title\}/g, what);
      const row = spanningRow(0.2, newTextbox('__nodata', `="${message.replace(/"/g, '""')}"`), columns);
      child(tablix, 'TablixBody/TablixRows')!.children.splice(at, 0, row);
      const repeat = at > 0 && textOf(child(top[at - 1]!, 'RepeatOnNewPage')) === 'true';
      const member = el('TablixMember', el('KeepWithGroup', 'After'), repeat ? el('RepeatOnNewPage', 'true') : null, el('Visibility', el('Hidden', '=CountRows() > 0')));
      if (at < top.length) memberList.children.splice(memberList.children.indexOf(top[at]!), 0, member);
      else memberList.children.push(member);
      const oldBottom = len(tablix, 'Top') + len(tablix, 'Height');
      setChild(tablix, 'Height', inch(len(tablix, 'Height') + 0.2));
      // What lies under the table moves down as far (the row is hidden when there is data; then all moves back up).
      if (container) {
        for (const e of childElements(container).filter((x) => ITEMS.has(x.name) && x !== tablix)) {
          if (len(e, 'Top') >= oldBottom - 0.001 && len(e, 'Left') < tLeft + tWidth && len(e, 'Left') + len(e, 'Width') > tLeft) setChild(e, 'Top', inch(len(e, 'Top') + 0.2));
        }
      }
    }

    // Column names: the field each column shows in its data row, else its heading.
    const rows = rowsOf(tablix);
    const kinds = rowLeaves(tablix).map((l) => l.kind);
    // A table without column headings, or placing its lines by formula (a statement's indented labels), is lines of
    // text, not rows of data: its rows are not banded.
    const statement = !rows.some((row, i) => kinds[i] === 'heading' && !descendants(row).some((e) => roles.get(e) === 'title')) || rows.some((row, i) => kinds[i] === 'detail'
      && descendants(row).some((e) => e.name === 'Textbox' && textOf(child(childElements(e, 'Style')[0] ?? el('x'), 'PaddingLeft')).startsWith('=')));
    const colNames: (string | undefined)[] = [];
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
        if (name) break;
      }
      if (!name) {
        for (const [i, row] of rows.entries()) {
          if (kinds[i] !== 'heading') continue;
          const tb = textboxIn(cellsOf(row)[c]);
          const t = tb && fixedText(tb);
          if (t) {
            name = snake(t).toLowerCase();
            break;
          }
        }
      }
      colNames.push(name);
    }
    // Each text in its row: named after its column, given its looks.
    rows.forEach((row, i) => {
      const kind = kinds[i]!;
      let labelled = false;
      cellsOf(row).forEach((cell, c) => {
        let item = cellItem(cell);
        if (!item) return;
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
          const rs = ownStyle(item);
          const plain = !/^(solid|dashed|dotted|double)/i.test(textOf(child(rs, 'Border/Style'))) && !BORDER_SIDES.some((s) => /^(solid|dashed|dotted|double)/i.test(textOf(child(rs, `${s}/Style`))))
            && (!textOf(child(rs, 'BackgroundColor')) || /^(transparent|#00ffffff)$/i.test(textOf(child(rs, 'BackgroundColor'))));
          if (inner.length === 1 && inner[0]!.name === 'Textbox' && plain && !child(item, 'Visibility')) {
            const tb = inner[0]!;
            const span = Number(textOf(child(child(cell, 'CellContents'), 'ColSpan')) || 1);
            const cellWidth = widths.slice(c, c + span).reduce((a, b) => a + b, 0);
            pad(tb, { left: len(tb, 'Left'), top: len(tb, 'Top'), right: Math.max(0, cellWidth - len(tb, 'Left') - len(tb, 'Width')) });
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
          const col = fieldOf(tb) ?? colNames[c] ?? ownWord(tb) ?? `col${c + 1}`;
          if (kind === 'noData') return rename(tb, 'noData', { T });
          if (isBlank(tb)) return rename(tb, 'blank', { T, col });
          const totalled = TOTALLED.test(valueOf(tb));
          switch (kind) {
            case 'heading': return rename(tb, 'heading', { T, col: colNames[c] ?? col });
            case 'detail': return rename(tb, 'value', { T, col });
            case 'groupHeading': return rename(tb, 'groupText', { T, col });
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
            else if (d.name === 'Line') rename(d, 'line', { T });
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
    const bottom = fitItems(child(body, 'ReportItems'));
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
          const below = tablixes.length > 0 && len(d, 'Top') >= tablixBottom - 0.01 && parents.get(d) === items;
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
  dropUnused(report, conv, review);
  // Custom code is part of this report alone.
  if (child(report, 'Code')) review.push({ item: 'Custom code', message: 'the report uses custom code (Code.*); where reports are combined, its functions must go with it' });

  // Notes the conversion made that no longer apply (the shared data source replaces the connection).
  return { rdl: toXml(root), review, settled: conv.dataSource ? ['Data source'] : [] };
}

/** Whether an item lies in a table inside a container (named with that table). */
function inTable(item: XmlElement, container: XmlElement): boolean {
  return descendants(container).some((t) => t !== container && t.name === 'Tablix' && descendants(t).includes(item) && t !== item);
}

/** The height a text box's text needs on one line per paragraph (inches); none where its size is worked out. */
function textHeight(textbox: XmlElement): number | undefined {
  const sizes = descendants(textbox).filter((e) => e.name === 'FontSize').map((e) => textOf(e));
  if (sizes.some((v) => v.startsWith('='))) return undefined;
  const points = sizes.map((v) => (inches(v) ?? 0) * 72).filter((v) => v > 0);
  const size = points.length ? Math.max(...points) : 10;
  const lines = Math.max(1, descendants(textbox).filter((e) => e.name === 'Paragraph').length);
  const style = childElements(textbox, 'Style')[0];
  const padding = ['PaddingTop', 'PaddingBottom'].reduce((a, k) => a + (inches(textOf(child(style, k)) || '2pt') ?? 0), 0);
  return (lines * size * 1.2) / 72 + padding;
}

/**
 * A table's rows as tall as what they always print: a row holding fixed text (it always prints the text), a row
 * holding a box (as tall as what the box holds). Returns how much taller the table is.
 */
function fitTablix(tablix: XmlElement): number {
  let grown = 0;
  for (const row of rowsOf(tablix)) {
    const height = len(row, 'Height');
    let need = 0;
    for (const cell of cellsOf(row)) {
      const item = cellItem(cell);
      if (!item) continue;
      if (item.name === 'Rectangle') need = Math.max(need, fitItems(child(item, 'ReportItems')));
      else if (item.name === 'Tablix') need = Math.max(need, len(item, 'Height') + fitTablix(item));
      else if (item.name === 'Textbox' && fixedText(item) && !child(item, 'Visibility') && textOf(child(item, 'CanShrink')) !== 'true') need = Math.max(need, textHeight(item) ?? 0);
    }
    if (need > height + 0.001) {
      setChild(row, 'Height', inch(need));
      grown += need - height;
    }
  }
  if (grown) setChild(tablix, 'Height', inch(len(tablix, 'Height') + grown));
  return grown;
}

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
    if (g > 0.001) {
      if (e.name === 'Rectangle') setChild(e, 'Height', inch(len(e, 'Height') + g));
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
      if (bi.bottom > bj.top + 0.001 || bi.right <= bj.left + 0.001 || bj.right <= bi.left + 0.001) continue;
      s = Math.max(s, (shift.get(i) ?? 0) + (grew.get(i) ?? 0));
    }
    if (s > 0.001) {
      shift.set(j, s);
      setChild(j, 'Top', inch(bj.top + s));
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
        if (style.rowBands && !unbanded.has(tb)) setChild(own, 'BackgroundColor', `=IIF(RowNumber(Nothing) Mod 2, ${expr(field(style.rowBands.odd, fillWord))}, ${expr(field(style.rowBands.even, fillWord))})`);
      } else setChild(own, 'BackgroundColor', `=${expr(field(role, fillWord))}`);
    }
  }
  // Blank cells of painted rows take the row's fill, so the band runs across.
  for (const row of banded) {
    const cells = cellsOf(row).map(cellItem).filter((x): x is XmlElement => !!x && x.name === 'Textbox');
    const painted = cells.map((c) => textOf(child(ownStyle(c), 'BackgroundColor'))).find((v) => v.startsWith('=First(') || v.startsWith('=IIF(RowNumber'));
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
