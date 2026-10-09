/**
 * Converts the report model extracted from a Crystal report into an SSRS report definition
 * (RDL, 2016 schema: SSRS 2016/2017/2019/2022 and Power BI Report Server).
 *
 * Layout mapping:
 *   Page header / page footer  -> page header / footer items (column headings move into the table)
 *   Report header / footer     -> items above / below the table
 *   Group header / footer      -> table group header / footer rows
 *   Details                    -> table detail row, one column per field position
 *   Cross-tabs                 -> matrices; charts -> charts; pictures -> embedded images
 *   Lines / boxes              -> lines / rectangles (in table rows: cell borders)
 *
 * Everything that cannot be converted faithfully is listed in the review notes.
 */

import type {
  AreaInfo,
  BorderInfo,
  DateFormatInfo,
  NumberFormatInfo,
  TimeFormatInfo,
  ValueFormat,
  DataSourceInfo,
  FormulaInfo,
  FormulaRef,
  ReportDefinition,
  ReportObject,
  SectionInfo,
  TableInfo,
} from '../crystal/model.ts';
import { classifyAreas, type ClassifiedAreas } from '../crystal/areas.ts';
import { detailColumnHeadings } from '../crystal/headers.ts';
import { CODE_HELPERS, SPECIAL_FIELDS, translateFormula, translateToSql, vbString, type FormulaContext, type Translation } from './formula.ts';
import { child, childElements, el, escapeXml, textOf, toXml, type XmlChild, type XmlElement } from './xml.ts';

export interface RdlOptions {
  /** Name of the report (used for ids and review notes). */
  reportName: string;
  /** Overrides the generated connection string. */
  connectionString?: string;
  /** Name (or path) of a shared data source on the report server, used instead of an embedded connection. */
  sharedDataSource?: string;
  /**
   * Subreports outside the table (report header/footer) become part of the report, reading their own dataset,
   * instead of separate .rdl files shown through subreport items (default true).
   */
  embedSubreports?: boolean;
  /** Adds "Page N" at the right of the page footer (for reports whose page numbers the application printed). */
  pageNumber?: boolean;
  /**
   * Parameter values to convert for (by name, any case): a suppress formula that depends on nothing else is
   * decided here, so what it hides is left out (and takes no space, as in Crystal).
   */
  parameterValues?: Record<string, string>;
  /**
   * Number format for chart value axes whose format the .rpt does not show (it is in Crystal's encrypted chart
   * data), e.g. "0.00%"; charts with value labels use their labels' format.
   */
  chartAxisFormat?: string;
  /** Subreports by their "Subdocument N" number: RDL name and link parameters (Crystal "Pm-" parameters). */
  subreports?: Map<number, SubreportInfo>;
  /** Image bytes by their "Embedding N" number. */
  images?: Map<number, Uint8Array>;
  /** The report is a subreport: its areas have no page header or footer. */
  subreport?: boolean;
  /** Internal: build the report as items inside another report (a subreport in a page header/footer). */
  inline?: InlineTarget;
}

export interface InlineTarget {
  dataset: string;
  itemNames: NameSet;
  imageNames: NameSet;
  codeNames: NameSet;
}

/** A report built as items for another report. */
interface InlineResult {
  items: XmlElement[];
  height: number;
  width: number;
  connectionString: string;
  dataset: (dataSourceName: string) => XmlElement;
  parameters: ParameterEntry[];
  codeFunctions: string[];
  codeMembers: Record<string, string>;
  embeddedImages: XmlElement[];
  review: ReviewNote[];
  /** Shared variables the report sets from its own data: variable (lower case) -> expression scoped to its dataset. */
  shared: Map<string, string>;
  /** Translations of the formulas in it that read shared variables, for when no value is known. */
  sharedFallbacks: Map<string, string>;
}

export interface ParameterEntry {
  name: string;
  type: string;
  prompt: string;
  multiple: boolean;
  nullable: boolean;
  /** Default value from the first row of a dataset field; with hidden, the parameter is not prompted. */
  defaultFrom?: { dataset: string; field: string };
  hidden?: boolean;
}

export interface SubreportInfo {
  name: string;
  /** Subreport parameter (SSRS name) fed from a main-report field (Crystal "Table.Field"). */
  links: { parameter: string; field: string }[];
  /** The subreport's own parameters (Crystal names), passed from same-named main-report parameters. */
  parameters?: string[];
  /** The subreport itself, for placing its content directly where SSRS allows no subreport (page header/footer). */
  definition?: ReportDefinition;
  dataSource?: DataSourceInfo;
  images?: Map<number, Uint8Array>;
}

/** The identifier NameSet gives a name the first time it is used. */
export function sanitizeName(base: string): string {
  let name = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (!/^[A-Za-z]/.test(name)) name = `F_${name}`;
  return name === 'F_' ? 'Item' : name;
}

export interface ReviewNote {
  item: string;
  message: string;
}

export interface RdlResult {
  rdl: string;
  review: ReviewNote[];
  /** Subreports ("Subdocument N" numbers) whose content was placed inline and that need no .rdl of their own. */
  inlinedOnly?: number[];
  /** Subreports ("Subdocument N" numbers) the report refers to as subreports, each needing an .rdl of its own. */
  referenced?: number[];
}

/** One detail column of a report laid out as a plain list (see buildBlock). */
export interface BlockColumn {
  /** Base for item names (the field's name). */
  name: string;
  heading: string;
  /** Value expression (with "="). */
  value: string;
  format?: string;
  numeric: boolean;
  /** Width in inches, from the Crystal object. */
  width: number;
  /** Grand total for the column (expression with "="), from a summary in a footer. */
  total?: { value: string; format?: string };
}

/** A report reduced to a list: title, detail columns with headings and totals, and its data. */
export interface BlockParts {
  title?: string;
  totalLabel?: string;
  columns: BlockColumn[];
  sorts: { expression: string; descending: boolean }[];
  datasetName: string;
  dataset: (dataSourceName: string) => XmlElement;
  parameters: ParameterEntry[];
  codeFunctions: string[];
  codeMembers: Record<string, string>;
  review: ReviewNote[];
}

/** Builds a report as a list block (used to lay it out with a house template). */
export function convertToBlock(definition: ReportDefinition, dataSource: DataSourceInfo | undefined, options: RdlOptions & { inline: InlineTarget }): BlockParts {
  return new RdlBuilder(definition, dataSource ?? { connections: [], tables: [], links: [] }, options).buildBlock();
}

/** A ReportParameter element. */
export function parameterElement(p: ParameterEntry): XmlElement {
  return el('ReportParameter', { Name: p.name },
    el('DataType', p.type),
    p.nullable ? el('Nullable', 'true') : null,
    p.defaultFrom ? el('DefaultValue', el('DataSetReference', el('DataSetName', p.defaultFrom.dataset), el('ValueField', p.defaultFrom.field))) : null,
    el('Prompt', p.prompt),
    p.hidden ? el('Hidden', 'true') : null,
    p.multiple ? el('MultiValue', 'true') : null);
}

/** The ReportParametersLayout for parameters, four to a row. */
export function parametersLayout(names: string[]): XmlElement | null {
  if (!names.length) return null;
  return el('ReportParametersLayout', el('GridLayoutDefinition',
    el('NumberOfColumns', String(Math.min(4, names.length))),
    el('NumberOfRows', String(Math.ceil(names.length / 4))),
    el('CellDefinitions', ...names.map((name, i) => el('CellDefinition',
      el('ColumnIndex', String(i % 4)), el('RowIndex', String(Math.floor(i / 4))), el('ParameterName', name))))));
}

const RDL_NS = 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';
const RD_NS = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';
const DATASET = 'DataSet1';
const DATASOURCE = 'DataSource1';
const TWIPS_PER_INCH = 1440;
const MIN_ROW_HEIGHT = 0.2;
const DEFAULT_HEIGHT = 0.25;
/** The lowest an item is designed when what it shows decides its height (inches). */
const MIN_DESIGN_HEIGHT = 0.01;
const DEFAULT_WIDTH = 1.5;
/** Crystal's default ("use printer defaults") margin. */
const MARGIN = 0.25;

/** Paper sizes by Windows DEVMODE code: [width, height] in inches (portrait). */
const PAPER_SIZES: Record<number, [number, number]> = { 1: [8.5, 11], 5: [8.5, 14], 9: [8.27, 11.69], 8: [11.69, 16.54], 11: [5.83, 8.27] };

const inches = (value: number) => `${Math.round(value * 1000) / 1000}in`;
const twipsToInches = (twips: number) => twips / TWIPS_PER_INCH;
/** The length of the pieces a line moved by formulas is drawn in (0.05in): its ends fall within half of one. */
/** The gap Crystal leaves between a rule along a field's top and its text (twips). */
const RULE_GAP = 40;
const RULE_PIECE = 72;
const inchesToTwips = (value: number) => value * TWIPS_PER_INCH;

const TYPE_NAMES: Record<string, string> = {
  string: 'System.String', memo: 'System.String', integer: 'System.Int32', number: 'System.Double',
  currency: 'System.Decimal', boolean: 'System.Boolean', date: 'System.DateTime', dateTime: 'System.DateTime',
  time: 'System.TimeSpan', blob: 'System.Byte[]',
};
const PARAMETER_TYPES: Record<string, string> = {
  string: 'String', integer: 'Integer', number: 'Float', currency: 'Float', boolean: 'Boolean',
  date: 'DateTime', dateTime: 'DateTime', time: 'DateTime',
};
const FORMATS: Record<string, string> = { currency: 'N2', number: 'N2', integer: 'N0', date: 'd', dateTime: 'g' };

const SUMMARY_OPERATIONS: Record<string, string> = {
  sum: 'Sum', count: 'Count', average: 'Avg', maximum: 'Max', minimum: 'Min', 'distinct count': 'CountDistinct',
  'standard deviation': 'StDev', 'pop. standard deviation': 'StDevP', variance: 'Var', 'pop. variance': 'VarP',
};
const SUMMARY_NAME = new RegExp(`^(${Object.keys(SUMMARY_OPERATIONS).map((k) => k.replace('.', '\\.')).join('|')}|[A-Za-z. ]+?) of (.+)$`, 'i');
const AGGREGATE_CALL = /\b(Sum|Count|Avg|Max|Min|CountDistinct|StDev|StDevP|Var|VarP|First|Last|Previous|RowNumber|RunningValue)\(/;
const BORDER_STYLES: Record<number, string> = { 1: 'Solid', 2: 'Dashed', 3: 'Dotted', 4: 'Double' };

export class NameSet {
  private readonly used = new Set<string>();

  /** A CLS-compliant identifier, unique within this set. */
  make(base: string): string {
    const name = sanitizeName(base);
    let candidate = name;
    for (let i = 2; this.used.has(candidate.toLowerCase()); i++) candidate = `${name}_${i}`;
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

interface DatasetField {
  name: string;
  table: string;
  column: string;
  type: string;
  used: boolean;
}

interface Column {
  x: number;
  width: number;
}

type Scope = 'row' | 'body' | 'page';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Classified {
  pageHeader: SectionInfo[];
  pageFooter: SectionInfo[];
  reportHeader: SectionInfo[];
  reportFooter: SectionInfo[];
  detail: SectionInfo[];
  groupHeaders: Map<number, SectionInfo[]>;
  groupFooters: Map<number, SectionInfo[]>;
  columnHeadings: ReportObject[];
  /** Page header sections laid out as the table's heading rows: printed once (page 1 only) or repeated on every page. */
  headingSections?: { section: SectionInfo; repeat: boolean }[];
}

/** Whether every bracket in a text closes in order. */
function balanced(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Columns placed by formulas (Crystal "dynamic columns"): fields designed one on top of another, each moved across by
 * its X position formula to a place read from the data. SSRS cannot place an item by an expression, so each set of
 * fields sharing an X position formula (a column's heading, values and total) becomes a column of its own, side by
 * side in their design order after the fixed fields beside them. Returns the layout and how many columns were laid out.
 */
export function spreadFormulaColumns(definition: ReportDefinition): { definition: ReportDefinition; columns: number } {
  // The same formula written a little differently (spacing, brackets, case, a table name before the field) is the
  // same column.
  const text = (ref: { index: number } | undefined) => {
    if (!ref) return '';
    let t = (definition.formulaTexts?.[ref.index] ?? definition.formulas.find((f) => f.index === ref.index)?.text ?? '')
      .toLowerCase().replace(/\{[^}.]*\.([^}]*)\}/g, '{$1}').replace(/\s+/g, '');
    while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) t = t.slice(1, -1);
    // Above all, the fields it reads its place from.
    const read = [...new Set([...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]))].sort();
    return read.length ? read.join('|') : t;
  };
  const placed = (o: ReportObject) => (o.kind === 'field' || o.kind === 'text') && !!o.position && !!o.size;
  const moving = (o: ReportObject) => placed(o) && !!text(o.conditions?.deltaX);
  const sections = definition.layout.flatMap((area) => area.sections);
  // Stacked: two fields moved by different formulas overlapping (most of the narrower one) in one section.
  const overlap = (a: ReportObject, b: ReportObject) => {
    const from = Math.max(a.position!.x, b.position!.x);
    const to = Math.min(a.position!.x + a.size!.width, b.position!.x + b.size!.width);
    return to - from > Math.min(a.size!.width, b.size!.width) / 2;
  };
  const stacked = sections.some((s) => {
    const m = s.objects.filter(moving);
    return m.some((a, i) => m.slice(i + 1).some((b) => text(a.conditions!.deltaX) !== text(b.conditions!.deltaX) && overlap(a, b)));
  });
  if (!stacked) return { definition, columns: 0 };
  // Column order: as designed in the section with the most of them (the headings), then any others as they come.
  const keysIn = (s: { objects: ReportObject[] }) => [...new Set(s.objects.filter(moving).map((o) => text(o.conditions!.deltaX)))];
  const richest = sections.reduce((best, s) => (keysIn(s).length > keysIn(best).length ? s : best), sections[0]);
  const order = [...new Set([...keysIn(richest), ...sections.flatMap(keysIn)])];
  // They start after the fixed fields beside them (the row's name column).
  let start = Infinity;
  let base = 0;
  for (const s of sections) {
    const m = s.objects.filter(moving);
    if (!m.length) continue;
    const from = Math.min(...m.map((o) => o.position!.x));
    const to = Math.max(...m.map((o) => o.position!.x + o.size!.width));
    start = Math.min(start, from);
    const top = Math.min(...m.map((o) => o.position!.y));
    const bottom = Math.max(...m.map((o) => o.position!.y + o.size!.height));
    for (const o of s.objects) {
      if (!placed(o) || moving(o) || o.suppressed) continue;
      // On their line, where they start (a title above them is not beside them).
      const beside = o.position!.y < bottom && o.position!.y + o.size!.height > top;
      if (beside && o.position!.x < to && o.position!.x + o.size!.width > from && o.position!.x <= from + 288) base = Math.max(base, o.position!.x + o.size!.width + 144);
    }
  }
  base = Math.max(base, start);
  const widths = order.map((key) => Math.max(...sections.flatMap((s) => s.objects).filter((o) => moving(o) && text(o.conditions!.deltaX) === key).map((o) => o.size!.width)));
  // Spread over the width the report's other objects reach (a title, the rules), as the formulas spread them.
  const right = Math.max(...sections.flatMap((s) => s.objects).filter((o) => o.position && o.size).map((o) => o.position!.x + o.size!.width));
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = total > 0 && right > base ? (right - base) / total : 1;
  const lefts = new Map(order.map((key) => [key, Math.min(...sections.flatMap((s) => s.objects).filter((o) => moving(o) && text(o.conditions!.deltaX) === key).map((o) => o.position!.x))]));
  const xs = new Map<string, { x: number; width: number }>();
  let x = base;
  order.forEach((key, i) => {
    const width = Math.floor(widths[i] * scale);
    xs.set(key, { x, width });
    x += width;
  });
  const layout = definition.layout.map((area) => ({
    ...area,
    sections: area.sections.map((s) => ({
      ...s,
      objects: s.objects.map((o) => {
        if (!moving(o)) return o;
        const key = text(o.conditions!.deltaX);
        const place = xs.get(key)!;
        const { deltaX: _x, deltaWidth: _w, ...conditions } = o.conditions!;
        // Each keeps its own width and its place in the column (a heading narrower than its values wraps as in Crystal,
        // totals each keep their own rule with a gap between them).
        const offset = Math.max(o.position!.x - (lefts.get(key) ?? o.position!.x), 0);
        const width = Math.min(o.size!.width, place.width);
        return { ...o, position: { ...o.position!, x: place.x + Math.min(offset, place.width - width) }, size: { ...o.size!, width }, conditions };
      }),
    })),
  }));
  return { definition: { ...definition, layout }, columns: order.length };
}

export function convertToRdl(definition: ReportDefinition, dataSource: DataSourceInfo | undefined, options: RdlOptions): RdlResult {
  return new RdlBuilder(definition, dataSource ?? { connections: [], tables: [], links: [] }, options).build();
}

class RdlBuilder {
  private readonly review: ReviewNote[] = [];
  private readonly itemNames = new NameSet();
  /** Placing the report footer: conditions read the last record, as in Crystal. */
  private lastRecord = false;
  /** Subreports drawn with an empty frame where their own formula hides them: they hold their own place. */
  private readonly framed = new Set<string>();
  private readonly fieldNames = new NameSet();
  private readonly imageNames = new NameSet();
  private readonly fields = new Map<string, DatasetField>();
  private readonly calculated: { name: string; expression: string }[] = [];
  private readonly formulaResults = new Map<string, string | null>();
  private readonly parameterNames = new Map<string, string>();
  /** Parameter names are their own namespace, so a subreport's parameters match the main report's. */
  private readonly parameterNameSet = new NameSet();
  private readonly groupFields: string[] = [];
  private readonly groupNames: string[] = [];
  private readonly embeddedImages: XmlElement[] = [];
  private readonly codeNames = new NameSet();
  private readonly codeFunctions: string[] = [];
  private readonly codeMembers: Record<string, string> = {};
  private readonly customFunctions = new Map<string, string | null>();
  private readonly definition: ReportDefinition;
  private readonly source: DataSourceInfo;
  private readonly options: RdlOptions;
  /** Name of this report's dataset (a subreport placed inline gets its own). */
  private readonly dataset: string;
  private readonly datasetNames = new NameSet();
  /** Datasets, data sources and parameters of subreports placed inline. */
  private readonly extraDataSets: XmlElement[] = [];
  private readonly extraDataSources: { name: string; connectionString: string }[] = [];
  private readonly extraParameters: ParameterEntry[] = [];
  /** Subreports (by "Subdocument N" number) placed inline, and those kept as subreport items. */
  private readonly inlinedSubreports = new Set<number>();
  private readonly referencedSubreports = new Set<number>();
  /** Values of shared variables set by subreports placed inline, in the order the subreports run. */
  private readonly sharedValues = new Map<string, string[]>();
  /** Expressions to use for shared variables whose value is not known from a subreport. */
  private readonly sharedFallbacks = new Map<string, string>();
  private cachedConnectionString?: string;
  /** The data source's name: a shared data source keeps its own name ("/Data Sources/Sales" -> Sales). */
  private readonly dataSourceName: string;

  constructor(definition: ReportDefinition, source: DataSourceInfo, options: RdlOptions) {
    const spread = spreadFormulaColumns(definition);
    // Text objects show only the lines their height holds, as in Crystal.
    this.definition = { ...spread.definition, layout: spread.definition.layout.map((area) => ({ ...area,
      sections: area.sections.map((section) => ({ ...section, objects: section.objects.map(clippedText) })) })) };
    for (const field of this.definition.groupsKeptTogether ?? []) {
      this.note(`Group on ${field}`, 'is kept together on a page (Crystal Keep Group Together, read from the group record): a value that does not fit in what is left of a page starts the next; SSRS does this in print and PDF, its web viewer may not');
    }
    if (spread.columns) {
      this.note('Layout', `${spread.columns} columns are placed by X position formulas (each read from the data); they are laid out side by side in their design order, so their places do not follow the data`);
    }
    this.source = source;
    this.options = options;
    this.dataset = options.inline?.dataset ?? DATASET;
    const shared = options.sharedDataSource?.split('/').filter(Boolean).pop();
    this.dataSourceName = shared ? sanitizeName(shared) : DATASOURCE;
    this.datasetNames.make(DATASET);
    if (options.inline) {
      // Global (not Shared) variables stay separate per placed copy of a subreport.
      this.formulaContext.memberPrefix = `${options.inline.dataset}_`;
      // Item, image and code names must be unique across the report the items are placed in.
      this.itemNames = options.inline.itemNames;
      this.imageNames = options.inline.imageNames;
      this.codeNames = options.inline.codeNames;
    }
  }

  private note(item: string, message: string): void {
    if (!this.review.some((r) => r.item === item && r.message === message)) this.review.push({ item, message });
  }

  // ---- data -----------------------------------------------------------------------------

  private registerFields(): void {
    const columnCounts = new Map<string, number>();
    for (const table of this.source.tables) {
      for (const f of table.fields) columnCounts.set(f.name.toLowerCase(), (columnCounts.get(f.name.toLowerCase()) ?? 0) + 1);
    }
    for (const table of this.source.tables) {
      for (const f of table.fields) {
        const ambiguous = (columnCounts.get(f.name.toLowerCase()) ?? 0) > 1;
        const name = this.fieldNames.make(ambiguous ? `${table.alias}_${f.name}` : f.name);
        this.fields.set(fieldKey(table.alias, f.name), { name, table: table.alias, column: f.name, type: f.type, used: false });
      }
    }
  }

  private readonly sqlExpressions = new Map<string, { name: string; sql: string }>();

  /** A Crystal SQL expression field becomes a computed column of the query. */
  private sqlExpressionField(name: string, item: string): string | undefined {
    const key = name.toLowerCase();
    const existing = this.sqlExpressions.get(key);
    if (existing) return existing.name;
    const expression = this.definition.sqlExpressions.find((e) => e.name.toLowerCase() === key && e.text);
    if (!expression) {
      this.note(item, `refers to SQL expression {%${name}}, which was not found`);
      return undefined;
    }
    // Crystal stores the expression in the source database's dialect; convert `quoted` names to [quoted].
    const sql = expression.text.replace(/`([^`]*)`/g, (_, n: string) => `[${n.replace(/]/g, ']]')}]`);
    const fieldName = this.fieldNames.make(name);
    this.sqlExpressions.set(key, { name: fieldName, sql });
    this.note(item, `SQL expression {%${name}} was added to the query as ${sql}; check it is valid T-SQL`);
    return fieldName;
  }

  /**
   * A dataset field by Crystal's table and column. The table may be named differently from the data source's alias
   * (by its own name, with its owner or database in front, or a stored procedure's ";1"): it is then matched by its
   * last part, by the source table's name, or, failing those, by a column only one table has.
   */
  private findField(table: string, column: string): DatasetField | undefined {
    const direct = this.fields.get(fieldKey(table, column));
    if (direct) return direct;
    const bare = (name: string) => name.replace(/;\d+$/, '').replace(/^.*[.\\]/, '').replace(/^\[|\]$/g, '').toLowerCase();
    const wanted = bare(table);
    const source = this.source.tables.find((t) => bare(t.alias) === wanted || bare(t.name) === wanted);
    if (source) {
      const byTable = this.fields.get(fieldKey(source.alias, column));
      if (byTable) return byTable;
    }
    const same = [...this.fields.values()].filter((f) => f.column.toLowerCase() === column.toLowerCase());
    return same.length === 1 ? same[0] : undefined;
  }

  private lookupField(table: string, column: string): DatasetField | undefined {
    const field = this.findField(table, column);
    if (field) field.used = true;
    return field;
  }

  private groupScopeOf(ref: string): string | undefined {
    const level = this.groupFields.findIndex((g) => g.toLowerCase() === ref.toLowerCase());
    // The outer group on a constant holds every record: no group of its own, its scope is the whole table.
    if (level === 0 && this.isConstantGroup(this.groupFields[0])) return '';
    return level >= 0 ? this.groupNames[level] : undefined;
  }

  private readonly formulaContext: FormulaContext = {
    field: (table, column) => this.lookupField(table, column)?.name,
    formula: (name) => this.formulaExpression(name) ?? undefined,
    parameter: (name) => this.parameterName(name),
    groupScope: (ref) => this.groupScopeOf(ref),
    dataset: () => this.dataset,
    runningTotal: (name) => this.runningTotalExpression(name, `Running total {#${name}}`),
    customFunction: (name) => this.customFunction(name),
    parameterRange: (name) => this.parameterRange(name),
    parameterMultiple: (name) => this.parameterInfo(name)?.allowMultiple === true,
    nextValue: (ref) => this.nextValue(ref),
    fieldType: (ref) => {
      const dot = ref.lastIndexOf('.');
      return dot > 0 ? this.findField(ref.slice(0, dot), ref.slice(dot + 1))?.type : undefined;
    },
  };

  /** Crystal Next(field): a LEAD() column in the query (direct table access only). */
  private readonly nextColumns = new Map<string, { name: string; field: DatasetField }>();

  private nextValue(ref: string): string | undefined {
    if (this.source.tables.some((t) => t.kind !== 'table')) return undefined;
    const dot = ref.lastIndexOf('.');
    const field = dot > 0 ? this.lookupField(ref.slice(0, dot), ref.slice(dot + 1)) : undefined;
    if (!field) return undefined;
    const key = `${field.table}.${field.column}`.toLowerCase();
    let next = this.nextColumns.get(key);
    if (!next) {
      next = { name: this.fieldNames.make(`Next_${field.name}`), field };
      this.nextColumns.set(key, next);
      this.note(`Next(${ref})`, 'computed in the query with LEAD() in the report\'s sort order; check the ORDER BY');
    }
    return `Fields!${next.name}.Value`;
  }

  private parameterInfo(name: string) {
    return this.definition.parameters.find((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  private readonly rangeNames = new Map<string, { start: string; end: string }>();

  /** A range parameter (Crystal "from ... to ...") becomes two SSRS parameters. */
  private parameterRange(name: string): { start: string; end: string } | undefined {
    const info = this.parameterInfo(name);
    if (!info?.allowRange) return undefined;
    if (info.allowDiscrete) this.note(`Parameter ${name}`, 'accepted single values or ranges in Crystal; it was converted as a range (start and end)');
    const key = name.toLowerCase();
    let names = this.rangeNames.get(key);
    if (!names) {
      const base = this.parameterName(name);
      names = { start: this.parameterNameSet.make(`${base}_Start`), end: this.parameterNameSet.make(`${base}_End`) };
      this.rangeNames.set(key, names);
    }
    return names;
  }

  /** Adds translated custom code (a VB function and its class-level variables) to the report. */
  private addCode(t: Translation): void {
    for (const helper of t.helpers ?? []) {
      if (!this.codeFunctions.includes(CODE_HELPERS[helper])) this.codeFunctions.push(CODE_HELPERS[helper]);
    }
    if (t.code) this.codeFunctions.push(t.code);
    Object.assign(this.codeMembers, t.members ?? {});
  }

  /** A Crystal custom function (a formula written as "Function (...)") becomes a VB function in Code. */
  private customFunction(name: string): string | undefined {
    const key = name.toLowerCase();
    if (this.customFunctions.has(key)) return this.customFunctions.get(key) ?? undefined;
    const formula = this.definition.formulas.find((f) => f.name.toLowerCase() === key && isCustomFunction(f.text));
    if (!formula) return undefined;
    this.customFunctions.set(key, null); // cycle guard
    const vbName = this.codeNames.make(`F_${formula.name}`);
    const t = translateFormula(formula.text, this.formulaContext, { codeName: vbName });
    for (const issue of t.issues) this.note(`Custom function ${formula.name}`, issue);
    if (!t.code) return undefined;
    this.addCode(t);
    this.customFunctions.set(key, vbName);
    return vbName;
  }

  private parameterName(crystalName: string): string {
    const key = crystalName.toLowerCase();
    let name = this.parameterNames.get(key);
    if (!name) {
      name = this.parameterNameSet.make(crystalName.replace(/^[@?]/, ''));
      this.parameterNames.set(key, name);
    }
    return name;
  }

  /**
   * Expression for a formula (without "="). Row-level formulas become calculated dataset fields;
   * formulas using aggregates, page globals or running values are inlined where they are used.
   */
  private formulaExpression(name: string): string | null {
    const key = name.toLowerCase();
    if (this.formulaResults.has(key)) {
      const cached = this.formulaResults.get(key);
      if (cached === null) this.note(`Formula {@${name}}`, 'refers to itself (directly or indirectly)');
      return cached ?? null;
    }
    const formula = this.definition.formulas.find((f) => f.name.toLowerCase() === key);
    if (!formula) return null;
    this.formulaResults.set(key, null); // cycle guard
    if (isCustomFunction(formula.text)) {
      this.customFunction(formula.name);
      this.formulaResults.set(key, 'Nothing');
      return 'Nothing';
    }
    const t = translateFormula(formula.text, this.formulaContext, { codeName: this.codeNames.make(`F_${formula.name}`) });
    this.addCode(t);
    for (const issue of t.issues) this.note(`Formula {@${formula.name}}`, issue);
    const expression = t.expression.slice(1);
    // A formula that only reads a shared variable: the value a subreport placed inline sets it to, filled in
    // when the report is written (a dataset field would be computed before any subreport has run).
    const variable = sharedRead(formula.text);
    if (variable) {
      this.sharedFallbacks.set(variable, `(${expression})`);
      const token = sharedToken(variable);
      this.formulaResults.set(key, token);
      return token;
    }
    let result: string;
    // A formula reading no database field (a fixed title, a parameter) is its expression: as a dataset field it
    // would be empty when the dataset has no rows, where Crystal still prints it.
    if (!expression.includes('Fields!') || AGGREGATE_CALL.test(expression) || expression.includes('Globals!') || expression.includes('Me.Value') || expression.includes(SHARED_TOKEN)) {
      result = `(${expression})`;
    } else {
      const fieldName = this.fieldNames.make(`F_${formula.name}`);
      this.calculated.push({ name: fieldName, expression: t.expression });
      result = `Fields!${fieldName}.Value`;
    }
    this.formulaResults.set(key, result);
    return result;
  }

  /** A formatting-condition formula (by name and position in the formula list), translated for a property. */
  /** Building table rows outside every group (a constant outer group's header and footer). */
  private ungroupedRows = false;

  private conditionExpression(ref: FormulaRef, colors: boolean, item: string, scope: Scope = 'row'): string | undefined {
    const text = this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text;
    if (!text?.trim()) {
      // An empty formatting formula sets nothing, as in Crystal.
      if (text === undefined) this.note(item, `refers to formatting formula ${ref.name} (#${ref.index}), which is not in the report's formula list (${this.definition.formulaTexts?.length ?? 0} entries); set it manually`);
      return undefined;
    }
    const formula = { text };
    // Suppress conditions (Object_Visibility, Section_Visibility, ...) are True/False.
    const boolean = !colors && /visib|suppress|new_?page|keep_?together/i.test(ref.name);
    const t = translateFormula(formula.text, this.formulaContext, { colors, boolean, codeName: this.codeNames.make(`C_${ref.name}_${ref.index}`) });
    this.addCode(t);
    for (const issue of t.issues) this.note(`${item}: formula ${ref.name}`, issue);
    if (t.expression === '=Nothing') return undefined;
    // A condition reading a database field that is empty on the record has no result in Crystal (it converts no
    // empty value to a default unless told to): the condition does not hold, so what it would suppress still prints.
    // SSRS would compare the empty value as 0 or "". Unless the formula tests IsNull itself.
    const fields = [...new Set([...text.matchAll(/\{([^}@?#][^}]*\.[^}]*)\}/g)].map((m) => m[1]))];
    const nullable = boolean && fields.length > 0 && !/\bisnull\b/i.test(text);
    const expression = nullable ? `=${this.unlessEmpty(t.expression.slice(1))}` : t.expression;
    // Outside the table, fields need a dataset scope; table rows outside every group read the first record.
    const outside = scope !== 'row';
    if (!outside && !this.ungroupedRows) return expression;
    // Crystal reads a report footer's conditions on the last record.
    const scoped = outside ? scopeOutsideRegion(expression.slice(1), this.dataset, this.lastRecord ? 'Last' : 'First') : expression.slice(1);
    // With no records Crystal gives such a formula no result: the condition does not hold, so what it suppresses
    // still prints.
    if (nullable) return `=(CountRows(${vbString(this.dataset)}) > 0) AndAlso (${scoped})`;
    return `=${scoped}`;
  }

  /** Whether a formatting formula reads a shared variable, itself or through the formulas it uses. */
  private readsShared(ref: FormulaRef): boolean {
    const byName = new Map(this.definition.formulas.filter((f) => f.kind === 'formula').map((f) => [f.name.toLowerCase(), f.text]));
    const seen = new Set<string>();
    const reads = (text: string | undefined): boolean => {
      if (!text) return false;
      if (/\bshared\b/i.test(text)) return true;
      return [...text.matchAll(/\{@([^}]+)\}/g)].some((m) => {
        const name = m[1].toLowerCase();
        if (seen.has(name)) return false;
        seen.add(name);
        return reads(byName.get(name));
      });
    };
    return reads(this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text);
  }

  /** A True/False expression that holds only where none of the database fields it reads is empty on the record. */
  private unlessEmpty(expression: string): string {
    const types = new Map([...this.fields.values()].map((f) => [f.name, f.type]));
    // Summaries leave empty values out (in Crystal too): only the fields read outside them count.
    const summarized: [number, number][] = [];
    for (const m of expression.matchAll(/\b(?:Sum|Avg|Min|Max|Count|CountDistinct|RunningValue|Aggregate|StDev|StDevP|Var|VarP)\(/g)) {
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < expression.length; end++) {
        if (expression[end] === '(') depth++;
        else if (expression[end] === ')' && --depth === 0) break;
      }
      summarized.push([m.index!, end]);
    }
    const reads = new Set<string>();
    for (const m of expression.matchAll(/(?:First|Last)\(Fields!(\w+)\.Value(?:, "[^"]*")?\)|Fields!(\w+)\.Value/g)) {
      if (summarized.some(([from, to]) => m.index! > from && m.index! < to)) continue;
      if (['integer', 'number', 'currency', 'string', 'memo'].includes(types.get(m[1] ?? m[2]) ?? '')) reads.add(m[0]);
    }
    return reads.size ? `${[...reads].map((r) => `Not IsNothing(${r})`).join(' AndAlso ')} AndAlso (${expression})` : expression;
  }

  private runningTotalExpression(name: string, item: string): string | undefined {
    const total = this.definition.runningTotals?.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!total) return undefined;
    const value = this.fieldObjectValue(total.field, 'row', item).expression;
    const operation = SUMMARY_OPERATIONS[total.operation.toLowerCase()];
    if (!operation) {
      this.note(item, `running total operation "${total.operation}" is not converted`);
      return undefined;
    }
    if (total.evaluateOnChangeOf) {
      this.note(item, `Crystal evaluates it once per change of ${total.evaluateOnChangeOf}; if the dataset has several rows per ${total.evaluateOnChangeOf}, adjust the expression`);
    }
    return `RunningValue(${value}, ${operation}, ${vbString(this.dataset)})`;
  }

  // ---- expressions for report objects ------------------------------------------------------

  /** The value type of a field reference, when known (for applying its Crystal format). */
  private valueTypeOf(ref: string): string | undefined {
    const special = ref.toLowerCase();
    if (['print date', 'data date', 'modification date', 'current date'].includes(special)) return 'date';
    if (['print time', 'data time', 'modification time'].includes(special)) return 'time';
    if (['page number', 'total page count', 'record number', 'group number'].includes(special)) return 'integer';
    if (ref.startsWith('?')) return this.parameterInfo(ref.slice(1))?.valueType;
    const summary = SUMMARY_NAME.exec(ref);
    if (summary) {
      const operation = summary[1].toLowerCase();
      if (operation === 'count' || operation === 'distinct count') return 'integer';
      const inner = this.valueTypeOf(summary[2]);
      return operation === 'average' && inner === 'integer' ? 'number' : inner;
    }
    // A formula's result type is stored with it.
    if (ref.startsWith('@')) return this.definition.formulas.find((f) => f.name.toLowerCase() === ref.slice(1).toLowerCase())?.valueType;
    if (ref.startsWith('#') || ref.startsWith('%')) return undefined;
    return this.formulaContext.fieldType?.(ref);
  }

  /** Sort expressions for the report's record sort (taken per group by its first record), or nothing. */
  private recordOrder(): XmlElement | null {
    const sorts = (this.definition.sorts ?? this.definition.sortFields.map((field) => ({ field, descending: false, bySummary: false })))
      .filter((s) => !s.bySummary)
      .map((s) => ({ ...s, value: this.fieldObjectValue(s.field, 'row', 'Record sort').expression }))
      .filter((s) => s.value !== 'Nothing');
    if (!sorts.length) return null;
    return el('SortExpressions', ...sorts.map((s) => el('SortExpression',
      // SSRS allows no First in a sort expression: a category's first record under an ascending sort has its
      // smallest value (Min), under a descending one its largest (Max).
      // A date held as text sorts by its date, as in Crystal (as text, 01/08/2026 would come before 05/08/2025).
      el('Value', `=${s.descending ? 'Max' : 'Min'}(${this.categorySortValue(s.field, s.value)})`), s.descending ? el('Direction', 'Descending') : null)));
  }

  /**
   * The sort value of a chart category. Crystal orders dates by date; a date held as text (e.g. "02/09/2026")
   * would sort as text in SSRS, so values that read as dates sort by their date.
   */
  private categorySortValue(category: string, expression: string): string {
    const type = this.valueTypeOf(category);
    // Numbers, dates and times sort by their own value; only text that reads as a date is turned into one.
    if (type && type !== 'string') return expression;
    // IIf evaluates both branches: the inner IIf keeps CDate from failing on text that is not a date.
    return `IIf(IsDate(${expression}), Format(CDate(IIf(IsDate(${expression}), ${expression}, "1900-01-01")), "yyyyMMddHHmmss"), CStr(${expression}))`;
  }

  /** Expression (without "=") and format for a field object's reference. */
  private fieldObjectValue(ref: string, scope: Scope, item: string): { expression: string; format?: string } {
    const special = SPECIAL_FIELDS[ref.toLowerCase()];
    if (special) {
      if (scope !== 'page' && special.includes('Globals!Page')) this.note(item, 'SSRS shows page numbers only in the page header or footer, so this one was left blank');
      return { expression: special, format: special.includes('ExecutionTime') ? 'd' : undefined };
    }
    // A group's name: "Group #2 Name", or "GroupName ({Table.Field})" naming the group by its field.
    const byField = /^GroupName\s*\(\s*\{?([^{}]+?)\}?\s*(?:,\s*"[^"]*"\s*)?\)$/i.exec(ref);
    const fieldLevel = byField ? this.groupFields.findIndex((g) => g.toLowerCase() === byField[1].trim().toLowerCase()) + 1 : 0;
    if (byField && !fieldLevel) return this.fieldObjectValue(byField[1].trim(), scope, item);
    // "Group #2" alone is how some Crystal versions name the group's name field.
    const groupName = fieldLevel ? [ref, String(fieldLevel)] : /^Group #(\d+)(?: Name)?$/i.exec(ref);
    if (groupName) {
      const display = this.groupDisplay.get(Number(groupName[1]));
      if (display) return { expression: this.scoped(display, scope) };
      const field = this.groupFields[Number(groupName[1]) - 1];
      if (field) return this.fieldObjectValue(field, scope, item);
      this.note(item, `refers to group ${groupName[1]}, which was not found`);
      return { expression: 'Nothing' };
    }
    if (ref.startsWith('@')) {
      const expression = this.formulaExpression(ref.slice(1));
      if (expression === null) {
        this.note(item, `refers to formula {${ref}}, which was not found`);
        return { expression: 'Nothing' };
      }
      return { expression: this.scoped(expression, scope) };
    }
    if (ref.startsWith('?')) return { expression: `Parameters!${this.parameterName(ref.slice(1))}.Value` };
    if (ref.startsWith('#')) {
      const expression = this.runningTotalExpression(ref.slice(1), item);
      if (expression) {
        const total = this.definition.runningTotals?.find((r) => r.name.toLowerCase() === ref.slice(1).toLowerCase());
        const inner = total ? this.fieldObjectValue(total.field, 'row', item) : undefined;
        if (scope !== 'row') this.note(item, 'a running total outside the table shows the final total');
        return { expression, format: inner?.format };
      }
      this.note(item, `refers to running total {${ref}}, which was not found`);
      return { expression: 'Nothing' };
    }
    const percentage = /^Percentage of (.+)$/i.exec(ref);
    if (percentage) {
      // Share of the grand total: the summary in the current scope over the same summary for the dataset.
      const part = this.fieldObjectValue(percentage[1], 'row', item).expression;
      const whole = this.fieldObjectValue(percentage[1], 'body', item).expression;
      if (part === 'Nothing') return { expression: 'Nothing' };
      if (scope !== 'row') this.note(item, 'a percentage outside the table is always 100%; check it');
      return { expression: `IIf(${whole} = 0, Nothing, ${part} / ${whole})`, format: 'P2' };
    }
    if (ref.startsWith('%')) {
      const field = this.sqlExpressionField(ref.slice(1), item);
      return field ? { expression: this.scoped(`Fields!${field}.Value`, scope) } : { expression: 'Nothing' };
    }
    const summary = SUMMARY_NAME.exec(ref);
    if (summary) {
      const operation = SUMMARY_OPERATIONS[summary[1].toLowerCase()];
      const inner = this.fieldObjectValue(summary[2], 'row', item);
      if (!operation) {
        this.note(item, `summary "${summary[1]}" has no direct SSRS aggregate; check the expression`);
        return { expression: 'Nothing' };
      }
      const scopeArg = scope === 'row' ? '' : `, ${vbString(this.dataset)}`;
      const format = operation === 'Count' || operation === 'CountDistinct' ? 'N0' : inner.format;
      return { expression: `${operation}(${inner.expression}${scopeArg})`, format };
    }
    const dot = ref.lastIndexOf('.');
    if (dot > 0) {
      const field = this.lookupField(ref.slice(0, dot), ref.slice(dot + 1));
      if (field) return { expression: this.scoped(`Fields!${field.name}.Value`, scope), format: FORMATS[field.type] };
    }
    this.note(item, `refers to "${ref}", which could not be resolved`);
    return { expression: 'Nothing' };
  }

  /** Outside a data region, field references must be wrapped in an aggregate with a dataset scope. */
  private scoped(expression: string, scope: Scope): string {
    if (scope === 'row' || !expression.includes('Fields!')) return expression;
    // A shared variable's value is filled in later with its own First(..., subreport dataset): wrapping the whole
    // expression would nest aggregates, so each field reference is scoped on its own.
    if (!AGGREGATE_CALL.test(expression) && !expression.includes(SHARED_TOKEN)) return `First(${expression}, ${vbString(this.dataset)})`;
    return scopeOutsideRegion(expression, this.dataset);
  }

  private objectValue(obj: ReportObject, scope: Scope): { value: string; format?: string } {
    const item = `${obj.kind} object "${obj.name}"`;
    if (obj.kind === 'field' && obj.field) {
      const { expression, format } = this.fieldObjectValue(obj.field, scope, item);
      return { value: `=${expression}`, format: (obj.format && formatFor(obj.format, this.valueTypeOf(obj.field))) ?? format };
    }
    if (obj.kind === 'text') {
      const text = obj.embeddedFields?.length ? obj.text ?? '' : wrapSpaces(tabIndent(obj).text, obj);
      if (obj.embeddedFields?.length) {
        // Text and embedded fields in their original order; tabs become spaces (text boxes do not tab).
        // Consecutive text runs are one piece of text (a paragraph break is a run of its own).
        const runs = (obj.runs ?? [{ text }, ...obj.embeddedFields.map((field) => ({ field }))])
          .reduce<({ text: string } | { field: string })[]>((out, r) => {
            const last = out[out.length - 1];
            if (!('field' in r) && last && !('field' in last)) out[out.length - 1] = { text: last.text + r.text };
            else out.push(r);
            return out;
          }, []);
        let fieldIndex = 0;
        const parts = runs.map((r, i) => {
          if (!('field' in r)) {
            // A piece's ends that meet no field on the same line are line ends: Crystal drops the spaces there.
            const atStart = i === 0;
            const atEnd = i === runs.length - 1;
            return vbString(wrapSpaces(r.text.replace(/\t+/g, '    '), obj, true, obj.align, { start: atStart, end: atEnd }));
          }
          const { expression } = this.fieldObjectValue(r.field, scope, item);
          // An embedded field shows with its own format (in text, a value is shown as Crystal formats it).
          const own = obj.fieldFormats?.[fieldIndex++];
          const type = this.valueTypeOf(r.field);
          const format = own && formatFor(own, type);
          if (format) return `Format(${expression}, ${vbString(format)})`;
          // Text from a fixed-width database column carries trailing spaces Crystal does not show: in SSRS they
          // would widen the line (pushing centred text aside) and wrap into a blank line.
          return type === 'string' ? `RTrim(${expression})` : expression;
        });
        return { value: `=${parts.join(' & ')}` };
      }
      // Multi-line text becomes an expression so each line break is kept (vbCrLf).
      return { value: text.startsWith('=') || text.includes('\n') ? `=${vbString(text)}` : text };
    }
    return { value: '' };
  }

  // ---- styles -----------------------------------------------------------------------------

  private textRunStyle(obj: ReportObject | undefined, format: string | undefined, scope: Scope): XmlElement {
    const style = obj?.style;
    let colorValue: string | undefined = style?.color;
    if (obj?.conditions?.fontColor) {
      colorValue = this.conditionExpression(obj.conditions.fontColor, true, `${obj.kind} object "${obj.name}"`, scope) ?? colorValue;
    }
    // A font style formula (crBold, crItalic, crBoldItalic, crRegular) sets both weight and slant; DefaultAttribute
    // keeps the object's own.
    const fontStyle = obj?.conditions?.fontStyle ? this.conditionExpression(obj.conditions.fontStyle, false, `${obj.kind} object "${obj.name}"`, scope)?.slice(1) : undefined;
    const styled = (word: string, on: string, off: string, own: boolean) => fontStyle
      ? `=IIf(IsNothing(${fontStyle}), "${own ? on : off}", IIf(InStr(CStr(${fontStyle}), "${word}") > 0, "${on}", "${off}"))`
      : own ? on : undefined;
    const italic = styled('Italic', 'Italic', 'Normal', !!style?.italic);
    const bold = styled('Bold', 'Bold', 'Normal', !!style?.bold);
    return el('Style',
      italic ? el('FontStyle', italic) : null,
      obj?.font ? el('FontFamily', obj.font) : null,
      style?.size ? el('FontSize', `${style.size}pt`) : null,
      bold ? el('FontWeight', bold) : null,
      format ? el('Format', format) : null,
      style?.underline ? el('TextDecoration', 'Underline') : null,
      colorValue ? el('Color', colorValue) : null);
  }

  /** Border and background elements for an item's Style. */
  private borderStyle(border: BorderInfo | undefined, extra: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean } = {}, formulas: { top?: string; bottom?: string; left?: string; right?: string } = {}, blankWhen?: string): XmlElement[] {
    const side = (name: string, style: number, formula?: string, own = false) => {
      if (!formula && own && blankWhen && BORDER_STYLES[style]) {
        // The object's own line, left out where its value is empty.
        return el(name,
          el('Color', border?.color ?? 'Black'),
          el('Style', `=IIf(${blankWhen}, "None", "${BORDER_STYLES[style]}")`),
          el('Width', `${Math.max(0.25, ((border?.width ?? 20) / 20)).toFixed(2)}pt`));
      }
      if (formula) {
        // A line style formula decides the side's line; DefaultAttribute keeps the object's own.
        return el(name,
          el('Color', border?.color ?? 'Black'),
          el('Style', `=IIf(IsNothing(${formula}), "${BORDER_STYLES[style] ?? 'None'}", ${formula})`),
          el('Width', `${Math.max(0.25, ((border?.width ?? 20) / 20)).toFixed(2)}pt`));
      }
      const lineStyle = BORDER_STYLES[style];
      if (!lineStyle) return null;
      return el(name,
        border?.color ? el('Color', border.color) : null,
        el('Style', lineStyle),
        border?.width ? el('Width', `${Math.max(0.25, (border.width / 20)).toFixed(2)}pt`) : null);
    };
    const [sideLeft, sideRight, sideTop, sideBottom] = border?.sides ?? [0, 0, 0, 0];
    // Lines drawn along a table row become that row's top/bottom border; lines down the table, left/right borders.
    const top = extra.top && !sideTop ? 1 : sideTop;
    const bottom = extra.bottom && !sideBottom ? 1 : sideBottom;
    const left = extra.left && !sideLeft ? 1 : sideLeft;
    const right = extra.right && !sideRight ? 1 : sideRight;
    const conditional = !!(formulas.top || formulas.bottom || formulas.left || formulas.right);
    const same = left === right && right === top && top === bottom && !conditional && !blankWhen;
    const out: XmlElement[] = [];
    if (same && left > 0) out.push(side('Border', left)!);
    else {
      out.push(el('Border', el('Style', 'None')));
      if (!same) {
        for (const [name, style, formula, own] of [['TopBorder', top, formulas.top, sideTop], ['BottomBorder', bottom, formulas.bottom, sideBottom], ['LeftBorder', left, formulas.left, sideLeft], ['RightBorder', right, formulas.right, sideRight]] as const) {
          const e = side(name, style, formula, own > 0);
          if (e) out.push(e);
        }
      }
    }
    if (border?.background) out.push(el('BackgroundColor', border.background));
    return out;
  }

  private textbox(name: string, value: string, obj: ReportObject | undefined, format: string | undefined, scope: Scope, box?: Box, hidden?: string, lines: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean } = {}, padding?: { left: number; right: number; top?: number; exact?: { left: number; right: number } }): XmlElement {
    const item = obj ? `${obj.kind} object "${obj.name}"` : name;
    const conditions = obj?.conditions ?? {};
    const hyperlink = conditions.hyperlink ? this.conditionExpression(conditions.hyperlink, false, item, scope) : undefined;
    const toolTip = conditions.toolTip ? this.conditionExpression(conditions.toolTip, false, item, scope) : undefined;
    const backColor = conditions.backColor ? this.conditionExpression(conditions.backColor, true, item, scope) : undefined;
    // Suppressed in Crystal: hidden (kept, so the item and any formula in it are still there to unhide).
    // A suppress formula decides on its own (as in Crystal); without one, the Suppress box does.
    const suppress = conditions.suppress ? this.conditionExpression(conditions.suppress, false, item, scope) : obj?.suppressed ? '=True' : undefined;
    for (const key of Object.keys(conditions)) {
      if (!['fontColor', 'hyperlink', 'toolTip', 'backColor', 'suppress', 'fontStyle', 'topLine', 'bottomLine', 'leftLine', 'rightLine', 'deltaX', 'deltaWidth'].includes(key)) this.note(item, `formatting formula ${conditions[key].name} is not converted; set it on the text box manually`);
    }
    const formulaOf = (ref: FormulaRef | undefined) => (ref ? this.conditionExpression(ref, false, item, scope)?.slice(1) : undefined);
    const lineFormulas = { top: formulaOf(conditions.topLine), bottom: formulaOf(conditions.bottomLine), left: formulaOf(conditions.leftLine), right: formulaOf(conditions.rightLine) };
    // A total's own rule: not drawn where the total is empty (a group with nothing to add up).
    // So is a field's own line in a row printed with or without records (no value when there are none).
    const total = obj?.kind === 'field' && (/^=\s*(Sum|Count|CountDistinct|Avg|Min|Max)\(/i.test(value) || (this.ungroupedRows && value.startsWith('='))) ? value.slice(1) : undefined;
    const blankWhen = total && obj?.border && !obj.border.sides.every((side) => side > 0) ? `IsNothing(${total})` : undefined;
    // Formulas moving the object across (X position) and changing its width, in twips from its own place and size
    // (DefaultAttribute leaves them): the text moves within its box by as much (its left edge with X, its right edge
    // with X and the width), from where the object is in its cell (not the capped padding), in whole points (a size
    // written with a decimal comma on some servers would not be one).
    const deltaX = formulaOf(conditions.deltaX);
    const deltaWidth = formulaOf(conditions.deltaWidth);
    const shift = (formula: string | undefined) => (formula ? `IIf(IsNothing(${formula}), 0, CDbl(${formula}))` : '0');
    const placeLeft = padding?.exact?.left ?? padding?.left ?? 0;
    const placeRight = padding?.exact?.right ?? padding?.right ?? 0;
    const border = backColor ? { ...(obj?.border ?? { sides: [0, 0, 0, 0] as [number, number, number, number] }), background: backColor } : obj?.border;
    const framed = !!obj?.border && obj.border.sides.every((side) => side > 0);
    // A rule drawn above a field placed at its own position (a total under its column): Crystal keeps the text a
    // little below it.
    const ruleAbove = !!box && !framed && !!obj?.border && obj.border.sides[2] > 0;
    // Paragraphs aligned each their own way (a plain text, not a formula's value).
    const paragraphs = obj && !value.startsWith('=Fields') ? textParagraphs(obj)?.map((p) => ({
      value: p.lines.length > 1 ? `=${p.lines.map((l) => vbString(l)).join(' & vbCrLf & ')}` : (p.lines[0].startsWith('=') ? `=${vbString(p.lines[0])}` : p.lines[0]),
      align: p.align,
    })) : undefined;
    // Lines all starting at a tab stop: the paragraphs are indented there (text boxes do not tab).
    const indent = obj && !value.startsWith('=Fields') ? tabIndent(obj).indent : 0;
    return el('Textbox', { Name: name },
      // A page header or footer keeps its size, as Crystal's does: a text box growing there pushes what is
      // below it down (on to a rule drawn under it).
      el('CanGrow', scope === 'page' ? 'false' : 'true'),
      el('KeepTogether', 'true'),
      el('Paragraphs', ...(paragraphs ?? [{ value, align: obj?.align }]).map((p) => el('Paragraph',
        el('TextRuns', el('TextRun', el('Value', p.value), this.textRunStyle(obj, format, scope))),
        el('Style', p.align ? el('TextAlign', TEXT_ALIGN[p.align]) : null),
        indent ? el('LeftIndent', `${(indent / 20).toFixed(1)}pt`) : null))),
      hyperlink ? el('ActionInfo', el('Actions', el('Action', el('Hyperlink', hyperlink)))) : null,
      toolTip ? el('ToolTip', toolTip) : null,
      box ? el('Top', inches(box.top)) : null,
      box ? el('Left', inches(box.left)) : null,
      box ? el('Height', inches(box.height)) : null,
      box ? el('Width', inches(box.width)) : null,
      hidden || suppress ? el('Visibility', el('Hidden', hidden && suppress ? `=(${hidden.slice(1)}) OrElse (${suppress.slice(1)})` : (hidden ?? suppress)!)) : null,
      // Crystal draws text right up to the object's edges: SSRS's default 2pt padding would make it wrap sooner.
      el('Style', ...this.borderStyle(border, lines, lineFormulas, blankWhen),
        // Crystal keeps a text object's text a little inside its own border.
        el('PaddingLeft', deltaX
          ? `=CStr(CInt(Math.Max(0, ${placeLeft + (framed ? 80 : 0)} + ${shift(deltaX)}) / 20)) & "pt"`
          : `${((padding?.left ?? 0) / 20 + (framed ? 4 : 0)).toFixed(1)}pt`),
        el('PaddingRight', deltaX || deltaWidth
          ? `=CStr(CInt(Math.Max(0, ${placeRight + (framed ? 80 : 0)} - ${shift(deltaX)}${deltaWidth ? ` - ${shift(deltaWidth)}` : ''}) / 20)) & "pt"`
          : `${((padding?.right ?? 0) / 20 + (framed ? 4 : 0)).toFixed(1)}pt`),
        el('PaddingTop', `${((padding?.top ?? 0) / 20 + (framed ? 1 : ruleAbove ? 2 : 0)).toFixed(1).replace(/\.0$/, '')}pt`), el('PaddingBottom', '0pt')));
  }

  // ---- free-standing items (page header/footer, report header/footer) -------------------------

  private boxOf(obj: ReportObject, top: number): Box {
    return {
      top: top + twipsToInches(obj.position?.y ?? 0),
      left: twipsToInches(obj.position?.x ?? 0),
      width: obj.size ? Math.max(twipsToInches(obj.size.width), 0.01) : DEFAULT_WIDTH,
      height: obj.size ? twipsToInches(obj.size.height) : DEFAULT_HEIGHT,
    };
  }

  /** Places a section's objects at their positions starting at `top`; returns items and the block height. */
  private placeSection(section: SectionInfo, top: number, scope: Scope, area: string, pageLike = false, afterOff?: string): { items: XmlElement[]; height: number } {
    const hidden = section.conditions?.suppress ? this.conditionExpression(section.conditions.suppress, false, `Section ${section.name}`, scope) : undefined;
    if (hidden) this.note(`Section ${section.name}`, 'its suppress condition was applied to each item as a Hidden expression');
    const items: XmlElement[] = [];
    let bottom = 0;
    // Boxes first, then charts and pictures: SSRS draws items in document order, so they stay behind the text
    // (a chart title placed over a chart's top stays readable), as in Crystal.
    const layer = (o: ReportObject) => (o.kind === 'box' ? 0 : ['chart', 'picture', 'subreport'].includes(o.kind) ? 1 : 2);
    const ordered = [...section.objects].sort((a, b) => layer(a) - layer(b));
    // A section a formula can hide, holding only subreports filling it (that grow to what they show): SSRS keeps a
    // hidden item's designed height, Crystal gives a suppressed section none, so it is designed as low as it goes.
    const collapsible = scope === 'body' && !!hidden && this.options.embedSubreports !== false && !this.options.inline
      && section.objects.length > 0 && section.objects.every((o) => o.kind === 'subreport' && !!o.size
        && (o.position?.y ?? 0) <= 15 && (o.position?.y ?? 0) + o.size.height >= (section.height ?? 0) - 15);
    for (const obj of ordered) {
      const box = this.boxOf(obj, top);
      if (collapsible) box.height = MIN_DESIGN_HEIGHT;
      if (obj.kind === 'chart') this.belowTitles(obj, section, box);
      if (scope === 'body' && this.runOn.has(obj)) {
        this.spanning.push({ obj, section, box, area, hidden });
        bottom = Math.max(bottom, box.top - top + box.height);
        continue;
      }
      const embed = scope === 'body' && this.options.embedSubreports !== false && !this.options.inline;
      if (obj.kind === 'subreport' && (scope === 'page' || embed)) {
        // SSRS allows no subreport in a page header/footer: its content is placed there directly; outside the
        // table, a subreport is built into the report too (one .rdl, nothing to deploy alongside it).
        // The subreport object's own suppress formula (or Suppress box) hides it too, with its section's.
        const own = obj.conditions?.suppress
          ? this.conditionExpression(obj.conditions.suppress, false, `subreport object "${obj.name}" in ${area}`, scope)
          : obj.suppressed ? '=True' : undefined;
        const both = hidden && own ? `=(${hidden.slice(1)}) OrElse (${own.slice(1)})` : (hidden ?? own);
        // Page 1's page header, moved into the body, keeps its subreports as in a page header (first row, items
        // at their places).
        const room = collapsible ? MIN_DESIGN_HEIGHT : section.height !== undefined ? twipsToInches(section.height) - (box.top - top) : undefined;
        const inline = this.inlineSubreport(obj, box, area, both, scope === 'page' || pageLike ? 'page' : 'body', room);
        if (inline) items.push(inline.item);
        // Crystal still draws the frame of a bordered subreport its own formula hides (its section shown), in a column
        // of its own: an empty box at its place, shown just where the subreport is hidden. Subreports sharing a column
        // are alternatives (one shows in place of the others), and those that do not show leave nothing.
        const x = obj.position?.x ?? 0;
        const right = x + (obj.size?.width ?? 0);
        const ownColumn = !section.objects.some((o) => o !== obj && (o.position?.x ?? 0) < right && (o.position?.x ?? 0) + (o.size?.width ?? 0) > x);
        if (inline && own && own !== '=True' && ownColumn && obj.border?.sides.some((side) => side > 0)) {
          const name = inline.item.attributes.Name ?? obj.name;
          const frame = el('Rectangle', { Name: this.itemNames.make(`${name}_Frame`) },
            el('KeepTogether', 'true'),
            el('Top', inches(itemNumber(inline.item, 'Top'))), el('Left', inches(itemNumber(inline.item, 'Left'))),
            el('Height', inches(itemNumber(inline.item, 'Height'))), el('Width', inches(itemNumber(inline.item, 'Width'))),
            el('Visibility', el('Hidden', hidden ? `=(${hidden.slice(1)}) OrElse Not (${own.slice(1)})` : `=Not (${own.slice(1)})`)),
            el('Style', ...this.borderStyle(obj.border)));
          items.push(frame);
          this.framed.add(name).add(frame.attributes.Name);
        }
        bottom = Math.max(bottom, box.top - top + (inline?.height ?? box.height));
        continue;
      }
      const item = this.reportItem(obj, scope, area, box, hidden);
      if (item) items.push(item);
      bottom = Math.max(bottom, box.top - top + box.height);
    }
    // Framed subreports side by side in a row are drawn as tall as the tallest of them, as Crystal prints the row
    // (one with nothing to show, a chart without data, still draws its frame down to the row's foot).
    const framedRow = items.filter((item) => item.name === 'Rectangle' && this.contentHeights.has(item)
      && !/^none$/i.test(textOf(child(item, 'Style/Border/Style')) || 'None'));
    for (const item of framedRow) {
      const row = framedRow.filter((other) => Math.abs(itemNumber(other, 'Top') - itemNumber(item, 'Top')) < 0.05);
      if (row.length < 2) continue;
      const tallest = Math.max(...row.map((other) => Math.max(itemNumber(other, 'Height'), this.contentHeights.get(other) ?? 0)));
      if (tallest - itemNumber(item, 'Height') >= 0.005) {
        // With the empty frame drawn in its place where its own formula hides it.
        const frame = items.find((other) => other.attributes.Name === `${item.attributes.Name}_Frame`);
        for (const target of frame ? [item, frame] : [item]) {
          target.children = target.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'Height' ? el('Height', inches(tallest)) : c));
        }
      }
      // An empty text at its foot keeps the row's height, whichever of its boxes has nothing to show.
      const foot = footMark(this.itemNames.make(`${item.attributes.Name}_RowFoot`), tallest);
      const holder = child(item, 'ReportItems');
      if (holder) holder.children.push(foot);
      else item.children.unshift(el('ReportItems', foot));
      bottom = Math.max(bottom, itemNumber(item, 'Top') - top + tallest);
    }
    // Crystal's New Page Before: the section's items in a rectangle that starts a new page (hidden with the
    // section, so a hidden section breaks no page).
    // A New Page Before formula decides on its own (the break is switched off where it is false).
    const breakFormula = section.conditions?.newPageBefore
      ? this.conditionExpression(section.conditions.newPageBefore, false, `Section ${section.name}`, 'body')
      : undefined;
    // New Page After likewise ends the page after the section's items.
    const afterFormula = section.conditions?.newPageAfter
      ? this.conditionExpression(section.conditions.newPageAfter, false, `Section ${section.name}`, 'body')
      : undefined;
    const before = !!(section.newPageBefore || breakFormula);
    const after = !!(section.newPageAfter || afterFormula);
    if (scope === 'body' && (before || after) && items.length) {
      const sectionHeight = collapsible ? bottom : Math.max(section.height !== undefined ? twipsToInches(section.height) : 0, bottom);
      // One break element: where both are formulas, each side is decided by its own (a break that is off is disabled).
      const both = before && after;
      // The break after it is off, too, where nothing prints after it (afterOff).
      const afterIsOff = afterFormula && afterOff ? `(Not (${afterFormula.slice(1)}) OrElse (${afterOff}))` : afterFormula ? `Not (${afterFormula.slice(1)})` : afterOff ? `(${afterOff})` : undefined;
      const formulaOff = both
        ? (breakFormula && afterIsOff ? `=Not (${breakFormula.slice(1)}) AndAlso ${afterIsOff}` : undefined)
        : before ? (breakFormula ? `=Not (${breakFormula.slice(1)})` : undefined) : (afterIsOff ? `=${afterIsOff}` : undefined);
      // A hidden section breaks no page (SSRS may still apply a hidden item's break).
      const switchedOff = hidden && hidden !== '=True'
        ? `=(${hidden.slice(1)})${formulaOff ? ` OrElse (${formulaOff.slice(1)})` : ''}`
        : formulaOff;
      const wrapper = el('Rectangle', { Name: this.itemNames.make(`${section.name || 'Section'}_Page`) },
        el('ReportItems', ...items.map((item) => moveItem(item, -top, 0))),
        el('PageBreak', el('BreakLocation', both ? 'StartAndEnd' : before ? 'Start' : 'End'), switchedOff ? el('Disabled', switchedOff) : null),
        el('KeepTogether', 'false'),
        el('Top', inches(top)), el('Left', '0in'), el('Height', inches(sectionHeight)),
        el('Width', inches(Math.max(...items.map(itemRight), 0.1))),
        hidden ? el('Visibility', el('Hidden', hidden)) : null,
        el('Style', el('Border', el('Style', 'None'))));
      items.splice(0, items.length, wrapper);
    }
    const height = collapsible ? bottom : Math.max(section.height !== undefined ? twipsToInches(section.height) : 0, bottom);
    return { items, height: section.objects.length || section.height ? height : 0 };
  }

  /**
   * Text placed over the top of a chart (its title, drawn over the chart's empty top strip in Crystal): the chart
   * starts below it instead, as SSRS cannot draw items over each other in every viewer.
   */
  private belowTitles(chart: ReportObject, section: SectionInfo, box: Box): void {
    const x = chart.position?.x ?? 0;
    const y = chart.position?.y ?? 0;
    const w = chart.size?.width ?? 0;
    const h = chart.size?.height ?? 0;
    let titleBottom = y;
    for (const o of section.objects) {
      if ((o.kind !== 'text' && o.kind !== 'field') || !o.position || !o.size) continue;
      const overlapsX = o.position.x < x + w && o.position.x + o.size.width > x;
      // Only text in the chart's top fifth is a title; text further down (a "no data" message) is left alone.
      if (overlapsX && o.position.y >= y - 60 && o.position.y < y + h / 5) titleBottom = Math.max(titleBottom, o.position.y + o.size.height);
    }
    // Below the title Crystal leaves a little space before a bar or line chart's plot (its top value label sits
    // there); a pie keeps its own margins.
    const isPie = chart.chart?.family === 3 || chart.chart?.family === 4;
    const gap = titleBottom > y && !isPie ? 0.08 : 0;
    const shift = twipsToInches(titleBottom - y) + gap;
    if (shift > 0 && shift < box.height / 3) {
      box.top += shift;
      box.height -= shift;
    }
  }

  /**
   * Places a subreport's content inside a rectangle, reading its own dataset: in a page header/footer as items
   * showing the first row, in the body as its whole body (table and all).
   */
  /**
   * `room`: in the body, the space down to the bottom of the subreport's section. The rectangle takes it, so it
   * pushes what follows down only by what it grows beyond the section, as Crystal does (SSRS would otherwise keep
   * the whole gap below the subreport's own height).
   */
  private inlineSubreport(obj: ReportObject, box: Box, area: string, hidden: string | undefined, mode: 'page' | 'body', room?: number): { item: XmlElement; height: number } | null {
    const item = `subreport object "${obj.name}" in ${area}`;
    const info = obj.subreport ? this.options.subreports?.get(obj.subreport.index) : undefined;
    if (!info?.definition) {
      if (mode === 'body') {
        // Not decoded: fall back to a subreport item.
        const fallback = this.reportItem(obj, 'body', area, box, hidden);
        return fallback ? { item: fallback, height: box.height } : null;
      }
      this.note(item, 'SSRS allows no subreport in a page header or footer, and the subreport could not be placed inline; move its content here manually');
      return null;
    }
    this.inlinedSubreports.add(obj.subreport!.index);
    const dataset = this.datasetNames.make(`DataSet_${info.name}`);
    const child = new RdlBuilder(info.definition, info.dataSource ?? { connections: [], tables: [], links: [] }, {
      reportName: info.name,
      connectionString: this.options.connectionString,
      subreport: true,
      images: info.images,
      parameterValues: this.options.parameterValues,
      chartAxisFormat: this.options.chartAxisFormat,
      inline: { dataset, itemNames: this.itemNames, imageNames: this.imageNames, codeNames: this.codeNames },
    });
    const result = mode === 'page' ? child.buildInline() : child.buildEmbedded();

    // The subreport's data source: the main one when the connection matches (or it reads no database), otherwise its own.
    let dataSource = this.dataSourceName;
    const readsData = (info.dataSource?.tables.length ?? 0) > 0;
    if (readsData && !this.options.sharedDataSource && result.connectionString !== this.connectionString()) {
      const existing = this.extraDataSources.find((d) => d.connectionString === result.connectionString);
      dataSource = existing?.name ?? `DataSource${this.extraDataSources.length + 2}`;
      if (!existing) this.extraDataSources.push({ name: dataSource, connectionString: result.connectionString });
    }
    this.extraDataSets.push(result.dataset(dataSource));
    for (const [variable, fallback] of result.sharedFallbacks) if (!this.sharedFallbacks.has(variable)) this.sharedFallbacks.set(variable, fallback);
    for (const [variable, value] of result.shared) {
      const known = this.sharedValues.get(variable) ?? [];
      if (!known.includes(value)) this.sharedValues.set(variable, [...known, value]);
    }
    for (const p of result.parameters) {
      // A linked subreport's "Pm-Table.Field" parameter takes the main report's field, unprompted.
      const link = info.links.find((l) => l.parameter.toLowerCase() === p.name.toLowerCase());
      const dot = link ? link.field.lastIndexOf('.') : -1;
      const linkedField = link && dot > 0 ? this.lookupField(link.field.slice(0, dot), link.field.slice(dot + 1)) : undefined;
      if (link && !linkedField) this.note(item, `its link parameter ${p.name} (from ${link.field}) needs a value; set its default manually`);
      const entry = linkedField ? { ...p, defaultFrom: { dataset: this.dataset, field: linkedField.name }, hidden: true } : p;
      const existing = this.extraParameters.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
      const main = this.definition.parameters.find((x) => this.parameterName(x.name).toLowerCase() === p.name.toLowerCase());
      if (main && PARAMETER_TYPES[main.valueType ?? 'string'] !== p.type) {
        this.note(item, `its parameter ${p.name} has type ${p.type}, the main report's parameter of that name has another type; the main report's is used`);
      }
      if (!existing) this.extraParameters.push(entry);
    }
    if (info.links.length) this.note(item, 'is linked to the main report: its link parameters take the first row\'s values of the linked fields');
    if (obj.subreport?.onDemand && mode === 'body') this.note(item, 'was an on-demand subreport in Crystal; it is now always shown');
    for (const code of result.codeFunctions) if (!this.codeFunctions.includes(code)) this.codeFunctions.push(code);
    // Crystal shared variables are shared with subreports: same-named class members are the same variable.
    Object.assign(this.codeMembers, result.codeMembers);
    this.embeddedImages.push(...result.embeddedImages);
    for (const n of result.review) {
      // Notes about a connection it shares with the main report are already in the main report's notes.
      if (n.item === 'Data source' && dataSource === this.dataSourceName) continue;
      // Placed inline, a subreport without a database simply shows its formulas and parameters.
      if (n.item === 'Dataset' && !readsData) continue;
      this.note(`${item}: ${n.item}`, n.message);
    }
    if (mode === 'page') this.note(item, `SSRS allows no subreport in a page header or footer, so its content was placed here directly, reading dataset ${dataset} (first row)`);

    // In the body a subreport keeps its Crystal size and grows with what it shows, as in Crystal (SSRS rectangles
    // grow but never shrink: sized to all their content, parts hidden by data would leave blank space). A page
    // header cannot grow, so there it gets its content's height.
    // Its report header and footer sections that always print keep their height, whatever they show (a chart
    // without data leaves its space, as in Crystal).
    const fixed = (() => {
      const { reportHeader, reportFooter } = classifyAreas(info.definition.layout, true);
      return twipsToInches([...reportHeader, ...reportFooter]
        .filter((s) => !s.suppressed && !s.conditions?.suppress)
        .reduce((sum, s) => sum + (s.height ?? 0), 0));
    })();
    // One a formula can hide is designed within its section (Crystal gives a suppressed one no room): shown, it grows
    // to its sections that always print, moving what follows down, as in Crystal.
    const height = mode === 'body' ? Math.max(box.height, room ?? 0, hidden ? 0 : fixed) : Math.max(box.height, result.height);
    // SSRS gives up the space of items hidden at a rectangle's foot: an empty mark at the foot of the sections
    // that always print keeps it.
    const keep = mode === 'body' && fixed > 0 ? [footMark(this.itemNames.make(`${obj.name || 'Subreport'}_Foot`), fixed)] : [];
    // Crystal clips a subreport's content to the subreport object's frame: items reaching past it are trimmed to it
    // (otherwise the frame would grow, possibly past the page's edge).
    const fitted = result.width > box.width + 0.001 ? fitWidth(result.items, box.width) : result.items;
    const content = mode === 'body' ? this.frameFormulas(obj, item, fitted) : fitted;
    const rectangle = el('Rectangle', { Name: this.itemNames.make(obj.name || 'Subreport') },
      content.length || keep.length ? el('ReportItems', ...content, ...keep) : null,
      el('KeepTogether', 'true'),
      el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(height)), el('Width', inches(box.width)),
      hidden ? el('Visibility', el('Hidden', hidden)) : null,
      // The subreport object's own border (Crystal draws a box around the subreport).
      el('Style', ...this.borderStyle(obj.border)));
    this.contentHeights.set(rectangle, Math.max(box.height, result.height));
    return { item: rectangle, height };
  }

  /**
   * A subreport object's X position and width formulas (in twips, from its own place and size): Crystal moves the
   * frame and cuts its content off at the frame's right edge. SSRS cannot size or move an item by a formula; its
   * tables can hide columns by one, and a hidden column closes up. So the columns of the subreport's tables past the
   * frame's width are hidden, and blank columns ahead of them (of 1, 2, 4, ... times 30 twips, each shown by one
   * bit of the move) move them across.
   */
  private frameFormulas(obj: ReportObject, item: string, items: XmlElement[]): XmlElement[] {
    const { deltaX, deltaWidth } = obj.conditions ?? {};
    if (!deltaX && !deltaWidth) return items;
    const twips = (ref: typeof deltaX) => {
      const e = ref ? this.conditionExpression(ref, false, item, 'body') : undefined;
      return e ? `IIf(IsNothing(${e.slice(1)}), 0, CDbl(${e.slice(1)}))` : undefined;
    };
    const width = twips(deltaWidth);
    const move = twips(deltaX);
    const frame = obj.size?.width ?? 0;
    let tables = 0;
    const clip = (element: XmlElement, left: number): XmlElement => {
      if (element.name === 'Rectangle') {
        const own = left + itemNumber(element, 'Left');
        return { ...element, children: element.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'ReportItems'
          ? { ...(c as XmlElement), children: (c as XmlElement).children.map((i) => (typeof i === 'object' && i !== null ? clip(i as XmlElement, own) : i)) }
          : c)) };
      }
      if (element.name !== 'Tablix') return element;
      tables++;
      const body = child(element, 'TablixBody')!;
      const columns = child(body, 'TablixColumns')!.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null);
      const members = child(child(element, 'TablixColumnHierarchy')!, 'TablixMembers')!;
      const columnMembers = members.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null);
      if (columnMembers.length !== columns.length) return element;
      // Each column's middle, in twips from the frame's left edge.
      let x = inchesToTwips(left + itemNumber(element, 'Left'));
      const hiddenColumns = columnMembers.map((m, i) => {
        const w = inchesToTwips(itemNumber(columns[i], 'Width'));
        const middle = Math.round(x + w / 2);
        x += w;
        return width ? { ...m, children: [...m.children, el('Visibility', el('Hidden', `=${frame} + ${width} < ${middle}`))] } : m;
      });
      const bits = move ? Array.from({ length: Math.max(1, Math.ceil(Math.log2(frame / 30 + 1))) }, (_, k) => k) : [];
      const spacerColumns = bits.map((k) => el('TablixColumn', el('Width', inches(twipsToInches(30 * 2 ** k)))));
      const spacerMembers = bits.map((k) => el('TablixMember', el('Visibility', el('Hidden', `=((CInt(Math.Max(0, ${move}) / 30) \\ ${2 ** k}) Mod 2) = 0`))));
      const spacerCell = () => el('TablixCell', el('CellContents', el('Textbox', { Name: this.itemNames.make('Spacer') },
        el('CanGrow', 'false'), el('KeepTogether', 'true'),
        el('Paragraphs', el('Paragraph', el('TextRuns', el('TextRun', el('Value', ''))))),
        el('Style', el('Border', el('Style', 'None'))))));
      const rows = child(body, 'TablixRows')!;
      return {
        ...element,
        children: element.children.map((c) => {
          if (typeof c !== 'object' || c === null) return c;
          const e = c as XmlElement;
          if (e.name === 'TablixColumnHierarchy') return el('TablixColumnHierarchy', el('TablixMembers', ...spacerMembers, ...hiddenColumns));
          if (e.name !== 'TablixBody') return e;
          return el('TablixBody',
            el('TablixColumns', ...spacerColumns, ...columns),
            { ...rows, children: rows.children.map((r) => {
              if (typeof r !== 'object' || r === null) return r;
              const row = r as XmlElement;
              return { ...row, children: row.children.map((rc) => (typeof rc === 'object' && rc !== null && (rc as XmlElement).name === 'TablixCells'
                ? { ...(rc as XmlElement), children: [...bits.map(spacerCell), ...(rc as XmlElement).children] }
                : rc)) };
            }) });
        }),
      };
    };
    const out = items.map((i) => clip(i, 0));
    if (tables) {
      this.note(item, 'has X position and width formulas: the columns of its table past the width are hidden, and blank columns ahead move it across (SSRS cannot move or size an item by a formula)');
    } else {
      this.note(item, 'has X position and width formulas, which are not converted (SSRS cannot move or size an item by a formula); it keeps its own place and size');
    }
    return out;
  }

  private keepContentHeight(from: XmlElement, to: XmlElement): XmlElement {
    const h = this.contentHeights.get(from);
    if (h !== undefined) this.contentHeights.set(to, h);
    return to;
  }

  /** The height of the content of subreports placed in the body (their rectangles start at the Crystal size). */
  private readonly contentHeights = new Map<XmlElement, number>();

  private reportItem(obj: ReportObject, scope: Scope, area: string, box: Box, hidden?: string): XmlElement | null {
    const item = `${obj.kind} object "${obj.name}" in ${area}`;
    const name = () => this.itemNames.make(obj.name || obj.kind);
    const visibility = hidden ? el('Visibility', el('Hidden', hidden)) : null;
    switch (obj.kind) {
      case 'field':
      case 'text': {
        // Lines centred with spaces in Crystal are centred here (the spaces themselves cannot be kept: SSRS wraps
        // them differently).
        const shown = paddedCentred(obj) ? { ...obj, align: 'center' as const } : obj;
        const { value, format } = this.objectValue(shown, scope);
        return this.textbox(name(), value, shown, format, scope, box, hidden);
      }
      case 'line':
        return el('Line', { Name: name() },
          // Crystal draws a thick line's width down from its place (SSRS around it): a horizontal one is moved down by
          // half its width, so a rule at a section's foot still meets what follows.
          el('Top', inches(box.top + (obj.size?.height ? 0 : twipsToInches(thickHalf(obj))))), el('Left', inches(box.left)),
          el('Height', inches(obj.size ? box.height : 0)), el('Width', inches(box.width)),
          visibility,
          el('Style', el('Border',
            el('Color', obj.border?.color ?? 'Black'),
            el('Style', BORDER_STYLES[Math.max(...(obj.border?.sides ?? [1]))] ?? 'Solid'),
            // A line running down a table is as wide as the table's cell borders that continue it.
            el('Width', `${Math.max(0.25, ((obj.border?.width ?? 20) + (this.runOn.has(obj) ? 10 : 0)) / 20).toFixed(2)}pt`))));
      case 'box':
        return el('Rectangle', { Name: name() },
          el('KeepTogether', 'true'),
          el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
          visibility,
          el('Style', ...this.borderStyle(obj.border)));
      case 'picture':
        return this.image(obj, box, item, visibility);
      case 'subreport': {
        const info = obj.subreport ? this.options.subreports?.get(obj.subreport.index) : undefined;
        if (!info) {
          this.note(item, 'the subreport could not be matched to a converted subreport');
          return null;
        }
        const reportName = info.name;
        if (obj.subreport) this.referencedSubreports.add(obj.subreport.index);
        // Linked subreports: each "Pm-Table.Field" parameter receives that field's value.
        const parameters = info.links.map((link) => el('Parameter', { Name: link.parameter },
          el('Value', `=${this.fieldObjectValue(link.field, scope, item).expression}`)));
        // Subreport parameters named like a main-report parameter receive its value.
        for (const name of info.parameters ?? []) {
          const main = this.definition.parameters.find((p) => p.name.toLowerCase() === name.toLowerCase());
          if (!main || /^Pm-/i.test(name)) continue;
          const own = sanitizeName(name.replace(/^[@?]/, ''));
          // A range parameter is two SSRS parameters (_Start and _End), on either side.
          const mainRange = this.parameterRange(main.name);
          const subRange = info.definition?.parameters.find((p) => p.name.toLowerCase() === name.toLowerCase())?.allowRange === true;
          const mainValue = `=Parameters!${this.parameterName(main.name)}.Value`;
          if (subRange) {
            parameters.push(
              el('Parameter', { Name: `${own}_Start` }, el('Value', mainRange ? `=Parameters!${mainRange.start}.Value` : mainValue)),
              el('Parameter', { Name: `${own}_End` }, el('Value', mainRange ? `=Parameters!${mainRange.end}.Value` : mainValue)));
          } else if (mainRange) {
            this.note(item, `receives parameter ${main.name}, a range in the main report; its start value was passed`);
            parameters.push(el('Parameter', { Name: own }, el('Value', `=Parameters!${mainRange.start}.Value`)));
          } else {
            parameters.push(el('Parameter', { Name: own }, el('Value', mainValue)));
          }
        }
        if (info.links.length && scope !== 'row') this.note(item, 'is linked to the main report but sits outside the table; it receives the first record\'s values');
        if (obj.subreport?.onDemand) this.note(item, 'was an on-demand subreport in Crystal; consider a drillthrough action instead');
        return el('Subreport', { Name: name() },
          el('ReportName', reportName),
          parameters.length ? el('Parameters', ...parameters) : null,
          el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
          visibility,
          el('Style', el('Border', el('Style', 'None'))));
      }
      case 'crossTab':
      case 'chart':
        if (scope === 'page') {
          // SSRS allows no data regions (tables, matrices, charts) in a page header or footer.
          this.note(item, 'SSRS allows no charts or cross-tabs in a page header or footer; it was left out, place it in the report body');
          return null;
        }
        return obj.kind === 'chart' ? this.chart(obj, box, item, scope === 'body' ? hidden ?? '' : undefined) : this.matrix(obj, box, item);
      default:
        this.note(item, 'this object type is not converted');
        return null;
    }
  }

  private image(obj: ReportObject, box: Box, item: string, visibility: XmlElement | null): XmlElement | null {
    const data = obj.embedding !== undefined ? this.options.images?.get(obj.embedding) : undefined;
    if (!data) {
      this.note(item, 'the picture data was not found; add the image manually');
      return null;
    }
    const mime = imageMimeType(data);
    if (!mime) {
      this.note(item, 'the picture is not in a format SSRS can embed (BMP, PNG, JPEG, GIF); convert it and add it manually');
      return null;
    }
    const imageName = this.imageNames.make(obj.name || 'Image');
    this.embeddedImages.push(el('EmbeddedImage', { Name: imageName },
      el('MIMEType', mime),
      el('ImageData', Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'))));
    return el('Image', { Name: this.itemNames.make(obj.name || 'Image') },
      el('Source', 'Embedded'),
      el('Value', imageName),
      // Crystal stretches a picture to its frame.
      el('Sizing', obj.size ? 'Fit' : 'FitProportional'),
      el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
      visibility,
      el('Style', el('Border', el('Style', 'None'))));
  }

  // ---- cross-tab (matrix) -----------------------------------------------------------------

  private matrix(obj: ReportObject, box: Box, item: string): XmlElement | null {
    const ct = obj.crossTab;
    if (!ct || ct.rows.length === 0 || ct.columns.length === 0 || ct.summaries.length === 0) {
      this.note(item, 'the cross-tab definition is incomplete; recreate it as a matrix');
      return null;
    }
    if (ct.summaries.length > 1) this.note(item, `only the first summary (${ct.summaries[0]}) was converted; add the others to the matrix cells`);
    this.note(item, 'converted to a matrix with grand totals; check subtotals and formatting');
    const value = this.fieldObjectValue(ct.summaries[0], 'row', item);
    const cell = (name: string, v: string, format?: string, bold = false) =>
      el('CellContents', this.textbox(this.itemNames.make(name), v, bold ? { kind: 'text', name, style: { bold: true } } : undefined, format, 'row'));
    const header = (field: string, name: string) => this.fieldObjectValue(field, 'row', item).expression;
    const width = 1.0;
    const height = 0.25;

    const groupMember = (fields: string[], prefix: string, axis: 'Row' | 'Column'): XmlElement => {
      const [first, ...rest] = fields;
      const expression = header(first, prefix);
      const groupName = this.itemNames.make(`${obj.name}_${axis}_${first.split('.').pop()}`);
      return el('TablixMember',
        el('Group', { Name: groupName }, el('GroupExpressions', el('GroupExpression', `=${expression}`))),
        el('SortExpressions', el('SortExpression', el('Value', `=${expression}`))),
        el('TablixHeader', el('Size', inches(axis === 'Row' ? width : height)), cell(`${groupName}_Header`, `=${expression}`)),
        rest.length ? el('TablixMembers', groupMember(rest, prefix, axis)) : null);
    };
    const totalMember = (axis: 'Row' | 'Column', depth: number): XmlElement => {
      let member = el('TablixMember', el('TablixHeader', el('Size', inches(axis === 'Row' ? width : height)), cell(`${obj.name}_${axis}Total`, 'Total', undefined, true)));
      // A total spans all nested levels: its header is the outermost; inner levels have no members.
      for (let i = 1; i < depth; i++) member = el('TablixMember', el('TablixHeader', el('Size', inches(axis === 'Row' ? width : height)), cell(`${obj.name}_${axis}Total_${i}`, '')), el('TablixMembers', member));
      return member;
    };

    const cells = (rowName: string) => el('TablixCells',
      el('TablixCell', cell(`${obj.name}_${rowName}_Value`, `=${value.expression}`, value.format)),
      el('TablixCell', cell(`${obj.name}_${rowName}_ColumnTotal`, `=${value.expression}`, value.format, true)));
    const cornerRows = ct.columns.map((_, r) => el('TablixCornerRow', ...ct.rows.map((__, c) =>
      el('TablixCornerCell', cell(`${obj.name}_Corner_${r}_${c}`, '')))));

    return el('Tablix', { Name: this.itemNames.make(obj.name || 'Matrix') },
      el('TablixCorner', el('TablixCornerRows', ...cornerRows)),
      el('TablixBody',
        el('TablixColumns', el('TablixColumn', el('Width', inches(width))), el('TablixColumn', el('Width', inches(width)))),
        el('TablixRows',
          el('TablixRow', el('Height', inches(height)), cells('Detail')),
          el('TablixRow', el('Height', inches(height)), cells('RowTotal')))),
      el('TablixColumnHierarchy', el('TablixMembers', groupMember(ct.columns, 'Column', 'Column'), totalMember('Column', ct.columns.length))),
      el('TablixRowHierarchy', el('TablixMembers', groupMember(ct.rows, 'Row', 'Row'), totalMember('Row', ct.rows.length))),
      el('DataSetName', this.dataset),
      el('Top', inches(box.top)), el('Left', inches(box.left)),
      el('Height', inches(height * (ct.columns.length + 2))),
      el('Width', inches(width * (ct.rows.length + 2))),
      el('Style', el('Border', el('Style', 'None'))));
  }

  // ---- chart --------------------------------------------------------------------------------


  /** `hidden`: in the body ("" when nothing else hides it), the chart is also hidden when it has no data. */
  private chart(obj: ReportObject, box: Box, item: string, hidden?: string): XmlElement | null {
    const chart = obj.chart;
    // Layout 2 charts a cross-tab: its summaries and columns.
    const crossTab = this.definition.layout.flatMap((a) => a.sections.flatMap((s) => s.objects)).find((o) => o.crossTab)?.crossTab;
    const ofCrossTab = chart?.layoutCode === 2 && crossTab;
    const values = chart?.values.length ? chart.values : ofCrossTab ? crossTab.summaries : [];
    // Categories: the chart's "on change of" field, a cross-tab's column, or (a group chart) the first group; an
    // advanced chart "for all records" has none and shows one point per value.
    const category = chart?.onChangeOf ?? (ofCrossTab ? crossTab.columns[0] : chart?.layoutCode === 0 ? undefined : this.groupFields[0]);
    if (!chart || values.length === 0 || (!category && chart.layoutCode !== 0)) {
      this.note(item, 'the chart data could not be determined; recreate the chart');
      return null;
    }
    const style = chartStyle(chart.family, chart.graphType);
    if (style.note) this.note(item, style.note);
    const categoryExpression = category ? this.fieldObjectValue(category, 'row', item).expression : undefined;
    const chartName = this.itemNames.make(obj.name || 'Chart');
    // A second "on change of" field: one series per value of it.
    const seriesExpression = chart.series ? this.fieldObjectValue(chart.series, 'row', item).expression : undefined;
    // Several values without series: each named by its field, as Crystal's legend has them ("Unit Price" for a
    // unit_price field), not "Average of table.field".
    const valueName = (v: string) => {
      const name = v.replace(/^\w+ of /, '').replace(/^.*\./, '').replace(/^[@?]/, '').replace(/_/g, ' ').trim();
      return name.replace(/\b[a-z]/g, (c) => c.toUpperCase()) || v;
    };
    const valueMembers = values.map((v) => el('ChartMember', el('Label', values.length > 1 && !chart.series ? valueName(v) : v)));
    const seriesHierarchy = seriesExpression && seriesExpression !== 'Nothing'
      ? [el('ChartMember',
        el('Group', { Name: this.itemNames.make(`${chartName}_Series`) }, el('GroupExpressions', el('GroupExpression', `=${seriesExpression}`))),
        chart.seriesOrder === 2 ? null : el('SortExpressions', el('SortExpression', el('Value', `=${seriesExpression}`),
          chart.seriesOrder === 1 ? el('Direction', 'Descending') : null)),
        values.length > 1 ? el('ChartMembers', ...valueMembers) : null,
        el('Label', `=${seriesExpression}`))]
      : valueMembers;
    // Crystal: horizontal gridlines from the value axis, every category labelled, and the value axis scaled to the
    // values (not from zero).
    const isLine = style.type === 'Line';
    // Crystal scales a bar chart of a single bar from 0.4 to 1.6 times its value (40% to 160% for 100%); SSRS
    // would start just below the value and run far above it. Otherwise the axis is SSRS's own.
    const barValue = style.type === 'Column' && values.length === 1 && !seriesExpression && !!categoryExpression && categoryExpression !== 'Nothing'
      ? this.fieldObjectValue(values[0], 'row', item).expression : undefined;
    // Only a summary of a field's categories can be read for the whole chart.
    const single = barValue && /^(Sum|Avg|Min|Max|Count|CountDistinct)\(/.test(barValue) && /\bFields!/.test(categoryExpression ?? '') ? barValue : undefined;
    // A bar chart's values, row by row: where the smallest is 0 Crystal starts the axis at 0 (SSRS would run below
    // it), and where all are 0 it runs from -5 to 5 (-500% to 500%), a step of 1 apart.
    // A field, or an expression of a row's fields (not of custom code or of other summaries).
    const rowValue = (v: string) => {
      const expression = this.fieldObjectValue(v, 'row', item).expression;
      const inner = /^=?(?:Sum|Avg|Min|Max)\(([\s\S]+)\)$/.exec(expression)?.[1];
      return inner && /\bFields!/.test(inner) && !/\bCode\.|\b(?:Sum|Avg|Min|Max|Count|CountDistinct|CountRows|RunningValue|Previous|First|Last|Lookup\w*)\(/.test(inner) ? inner : undefined;
    };
    const rows = (style.type === 'Column' || isLine) ? values.map(rowValue) : [];
    const raw = rows[0];
    const allRows = rows.length > 0 && rows.every(Boolean) ? rows as string[] : undefined;
    const lowest = raw && `CDbl(IIf(IsNothing(Min(${raw})), 1, Min(${raw})))`;
    const highest = raw && `CDbl(IIf(IsNothing(Max(${raw})), 0, Max(${raw})))`;
    // Crystal's own scale: from a multiple of a step to a multiple of it, the step the smallest of 1, 2, 4 or 5 times a
    // power of ten that covers the values in eight steps or fewer (100% to 180% every 10% for 102% to 170%). Read
    // where each row is one point (its values are the points' values).
    const onePerPoint = allRows && (values.length === 1 || !seriesExpression) && categoryExpression && categoryExpression !== 'Nothing'
      ? `CountRows() = CountDistinct(CStr(${categoryExpression}) & "|" & CStr(${seriesExpression && seriesExpression !== 'Nothing' ? seriesExpression : '""'}))`
      : undefined;
    if (onePerPoint && !this.codeFunctions.includes(AXIS_CODE)) this.codeFunctions.push(AXIS_CODE);
    // Over all the chart's values (a price and its limit alike).
    const extreme = (fn: 'Min' | 'Max') => (allRows ?? []).map((r) => `CDbl(IIf(IsNothing(${fn}(${r})), 0, ${fn}(${r})))`)
      .reduce((acc, e) => (acc ? `Math.${fn}(${acc}, ${e})` : e), '');
    const crystalScale = (part: number) => `Code.CrAxis(${extreme('Min')}, ${extreme('Max')}, ${part})`;
    // For the axis's minimum (0.4), maximum (1.6) and interval (0.2).
    const part = (factor: number) => ({ 0.4: 0, 1.6: 1 }[factor] ?? 2);
    const own = (factor: number) => !raw || style.type !== 'Column' ? 'Double.NaN' : factor === 0.4 ? `IIf(${lowest} = 0, 0, Double.NaN)` : 'Double.NaN';
    const fit = (factor: number) => !raw ? 'Double.NaN'
      : `IIf(${lowest} = 0 AndAlso ${highest} = 0${style.type === 'Column' ? '' : ' AndAlso False'}, ${{ 0.4: '-5', 1.6: '5' }[factor] ?? '1'}, ${onePerPoint ? `IIf(${onePerPoint}, ${crystalScale(part(factor))}, ${own(factor)})` : own(factor)})`;
    const scaled = (factor: number) => single
      ? `=IIf(CountDistinct(${categoryExpression}) = 1 AndAlso CDbl(IIf(IsNothing(${single}), 0, ${single})) > 0, CDbl(IIf(IsNothing(${single}), 0, ${single})) * ${factor}, ${fit(factor)})`
      : raw ? `=${fit(factor)}` : 'NaN';
    const angled = style.type !== 'Shape' && !isLine && chart.look === 1;
    const flat = style.type !== 'Shape' && !angled;
    // Crystal lays a bar chart's category labels flat where they fit side by side, angles them where each still has
    // room at 45 degrees, and turns them upright where even that would overlap (about 0.04in a character, 0.13in a
    // label at 45 degrees, at 5.5pt, over the plot without its value axis).
    const turned = flat && style.type === 'Column' && categoryExpression && categoryExpression !== 'Nothing'
      ? (() => {
        const n = `CountDistinct(${categoryExpression})`;
        const slot = `${Math.max(0.5, box.width - 0.6).toFixed(2)} / IIf(${n} < 1, 1, ${n})`;
        return `=IIf(Max(Len(CStr(${categoryExpression}))) * 0.04 + 0.04 <= ${slot}, 0, IIf(${slot} >= 0.13, -45, -90))`;
      })()
      : undefined;
    const axis = (title: string | undefined, kind: 'category' | 'value', format?: string) => el('ChartAxis', { Name: 'Primary' },
      // Crystal's axis text is small, as small as its data labels.
      el('Style', el('FontFamily', 'Arial'), el('FontSize', '5.5pt'), el('FontWeight', 'Normal'), format ? el('Format', format) : null),
      el('ChartAxisTitle', el('Caption', title ?? ''), el('Style', el('FontFamily', 'Arial'), el('FontSize', '5.5pt'), el('FontWeight', 'Normal'))),
      // Crystal's single bar: six steps from 0.4 to 1.6 times its value (every 20% for 100%).
      kind === 'category' ? el('Interval', '1') : (single || raw) && kind === 'value' ? el('Interval', scaled(0.2)) : null,
      // Crystal angles bar charts' category labels; a line chart's dates are staggered on two rows where they do
      // not fit on one (SSRS may offset them, but neither turn nor resize them).
      // As the chart's look has them: angled; or flat where they fit side by side. A bar chart's are turned (up to
      // upright, for long names) where they do not, at their size; a line chart's dates are never turned (staggered,
      // or made smaller, where they do not fit).
      kind === 'category' && angled ? el('Angle', '-45') : null,
      kind === 'category' && turned ? el('Angle', turned) : null,
      ...(kind === 'category' && flat && !turned ? [el('PreventFontGrow', 'true'), isLine ? null : el('PreventLabelOffset', 'true'), el('PreventWordWrap', 'true'),
        ...(isLine ? [el('AllowLabelRotation', 'None'), el('MinFontSize', '5pt')] : [el('PreventFontShrink', 'true'), el('AllowLabelRotation', 'Rotate90')])] : []),
      // SSRS would otherwise resize axis text to fit (up to 10pt); Crystal keeps its size.
      el('LabelsAutoFitDisabled', kind === 'category' && flat && !turned ? 'false' : 'true'),
      el('ChartMajorGridLines', el('Enabled', kind === 'value' ? 'True' : 'False'), el('Style', el('Border', el('Color', 'Black'), el('Width', '0.5pt')))),
      el('ChartMinorGridLines', el('Style')),
      el('ChartMinorTickMarks', el('Length', '0.5')),
      el('CrossAt', 'NaN'),
      // Crystal fits the value axis to the values (bars too: 1.00% to 1.40%, not from zero).
      kind === 'value' && !isPie ? el('IncludeZero', 'false') : null,
      el('Minimum', kind === 'value' ? scaled(0.4) : 'NaN'), el('Maximum', kind === 'value' ? scaled(1.6) : 'NaN'),
      el('ChartAxisScaleBreak', el('Style')));
    // One value over categories, as bars: Crystal gives each bar its own colour, in its palette's order (SSRS
    // would colour the whole series alike), and shows no legend for it.
    const barPerPoint = style.type === 'Column' && values.length === 1 && !seriesExpression && !!categoryExpression && categoryExpression !== 'Nothing';
    if (barPerPoint) {
      this.codeMembers.crPointColors = 'New System.Collections.Hashtable';
      if (!this.codeFunctions.includes(POINT_COLOR_CODE)) this.codeFunctions.push(POINT_COLOR_CODE);
    }

    // Data labels as Crystal shows them: the category, the value (in the chart's number format), or both.
    // A bar chart of the angled look prints its percentages whole, inside the bars (otherwise as its format says, above).
    const insideBars = style.type === 'Column' && chart.look === 1 && [5, 6, 7].includes(chart.dataLabels?.format ?? 0);
    // A format of the chart's own that .NET cannot read as a number (no digit in it) would print as it is, in place of
    // the value: whole numbers with thousands separators, as Crystal shows them.
    const ownFormat = chart.dataLabels?.custom;
    const unreadable = ownFormat !== undefined && !/[0#]/.test(ownFormat);
    const custom = unreadable ? '#,##0' : ownFormat;
    // The list's formats (its first, read where the marker places it, is a plain number to three places: 49.000).
    const listFormat = chart.dataLabels ? (chart.dataLabels.format === 0 && chart.dataLabels.listed ? '0.000' : CHART_NUMBER_FORMATS[chart.dataLabels.format]) : undefined;
    const labelFormat = chart.dataLabels ? (custom ?? (insideBars ? '0%' : listFormat)) : undefined;
    // The value axis: in the labels' list format; with a format of the chart's own, Crystal's plain number (1,000.00).
    const axisFormat = custom ? (custom.includes('%') || unreadable ? custom : '#,##0.00') : listFormat;
    const valueKeyword = labelFormat ? `#VALY{${labelFormat}}` : '#VALY';
    // #AXISLABEL is the category's text (#VALX would give its position for text categories).
    // Both: the category over the value, on two lines, as Crystal prints them.
    const labelText = { 1: '#AXISLABEL', 2: valueKeyword, 3: `="#AXISLABEL" & vbCrLf & ${vbString(valueKeyword)}` }[chart.dataLabels?.kind ?? 0];
    const isPie = style.type === 'Shape';
    // Crystal labels no empty pie slice.
    const dataLabel = (expression: string) => labelText
      ? el('ChartDataLabel', el('Style', el('FontFamily', 'Arial'), el('FontSize', '5.5pt'), el('FontWeight', 'Normal')), el('Label', labelText),
        insideBars ? el('Position', 'Center') : null,
        el('Visible', isPie ? `=CDbl(IIf(IsNothing(${expression}), 0, ${expression})) <> 0` : 'true'))
      : el('ChartDataLabel', el('Style'));
    const legendWrap = !isPie && !!seriesExpression && seriesExpression !== 'Nothing' && !(chart.legend && !chart.legend.visible);
    if (legendWrap && !this.codeFunctions.includes(WRAP_CODE)) this.codeFunctions.push(WRAP_CODE);
    const series = values.map((v, i) => {
      const value = this.fieldObjectValue(v, 'row', item);
      return el('ChartSeries', { Name: this.itemNames.make(`${chartName}_Series${i + 1}`) },
        el('ChartDataPoints', el('ChartDataPoint',
          // Crystal draws no slice for 0 (SSRS would draw a sliver, pulled out on a 3D pie).
          el('ChartDataPointValues', el('Y', isPie ? `=IIf(CDbl(IIf(IsNothing(${value.expression}), 0, ${value.expression})) = 0, Nothing, ${value.expression})` : `=${value.expression}`)),
          dataLabel(value.expression),
          // Crystal draws lines thick (SSRS takes a line's width from its data points).
          el('Style', barPerPoint ? el('Color', `=Code.CrPointColor(${vbString(chartName)}, ${categoryExpression})`) : null,
            // Crystal outlines each bar and pie slice in black.
            isLine ? el('Border', el('Width', '1.5pt')) : el('Border', el('Color', 'Black'), el('Style', 'Solid'), el('Width', '0.5pt'))),
          // A distinct marker shape per line, clearly visible.
          el('ChartMarker', style.markers ? el('Type', 'Auto') : null, style.markers ? el('Size', '4pt') : null, el('Style')),
          // Crystal's 3D pies draw their slices pulled out from the centre.
          isPie && style.threeD ? el('CustomProperties', el('CustomProperty', el('Name', 'Exploded'), el('Value', 'True'))) : null,
          el('DataElementOutput', 'Output'))),
        el('Type', style.type),
        style.subtype ? el('Subtype', style.subtype) : null,
        // Crystal's bars are slim: half their category's width, or for a chart with series, the bars of a category
        // two fifths of it together (SSRS would give them four fifths).
        style.type === 'Column' && !style.threeD ? el('CustomProperties',
          el('CustomProperty', el('Name', 'PointWidth'), el('Value', chart.look === 1 ? '0.4' : '0.5'))) : null,
        // Crystal places pie labels outside the slices, with a line to each.
        isPie && labelText ? el('CustomProperties',
          el('CustomProperty', el('Name', 'PieLabelStyle'), el('Value', 'Outside')),
          el('CustomProperty', el('Name', 'PieLineColor'), el('Value', 'Black')),
          // Crystal's leader lines are short.
          el('CustomProperty', el('Name', '3DLabelLineSize'), el('Value', '40'))) : null,
        // Crystal draws lines solid and clearly visible.
        isLine ? el('Style', el('Border', el('Width', '1.5pt'))) : el('Style'),
        el('ChartEmptyPoints', el('Style'), el('ChartMarker', el('Style')), el('ChartDataLabel', el('Style'))),
        // Crystal wraps each legend entry to lines of about 20 characters (a longer word on a line of its own).
        legendWrap ? el('ChartItemInLegend', el('LegendText', `=Code.CrWrap(CStr(${seriesExpression}), 20)`)) : null,
        el('ValueAxisName', 'Primary'),
        el('CategoryAxisName', 'Primary'),
        // Labels may sit outside the plot area (not cut short to fit beside a small pie).
        el('ChartSmartLabel', el('AllowOutSidePlotArea', 'True'), el('CalloutLineColor', 'Black'), el('MinMovingDistance', '0pt')));
    });
    // Crystal frames a flat chart's plot on all four sides: the axes' lines repeated opposite them, unlabelled.
    const frame = isPie || style.threeD ? null : el('ChartAxis', { Name: 'Secondary' },
      el('Visible', 'True'), el('Style', el('FontSize', '5.5pt')), el('ChartAxisTitle', el('Caption', ''), el('Style')),
      el('ChartMajorGridLines', el('Enabled', 'False'), el('Style')), el('ChartMinorGridLines', el('Style')),
      el('ChartMajorTickMarks', el('Enabled', 'False'), el('Style')), el('ChartMinorTickMarks', el('Style')),
      el('CrossAt', 'NaN'), el('Location', 'Opposite'), el('HideLabels', 'true'), el('ChartAxisScaleBreak', el('Style')));
    return el('Chart', { Name: chartName },
      el('ChartCategoryHierarchy', el('ChartMembers', categoryExpression
        ? el('ChartMember',
          el('Group', { Name: this.itemNames.make(`${chartName}_Category`) }, el('GroupExpressions', el('GroupExpression', `=${categoryExpression}`))),
          // Crystal's order: as the data comes (no sort), or ascending/descending by value.
          // "In original order" is the order of the records after the report's record sort, which a chart group
          // would otherwise lose: sorted by the record sort fields (by the first record of each category).
          chart.categoryOrder === 2 ? this.recordOrder() : el('SortExpressions', el('SortExpression',
            el('Value', `=${this.categorySortValue(category!, categoryExpression)}`),
            chart.categoryOrder === 1 ? el('Direction', 'Descending') : null)),
          el('Label', `=${categoryExpression}`))
        : el('ChartMember', el('Label', chart.title ?? '')))),
      el('ChartSeriesHierarchy', el('ChartMembers', ...seriesHierarchy)),
      el('ChartData', el('ChartSeriesCollection', ...series)),
      el('ChartAreas', el('ChartArea', { Name: 'Default' },
        el('ChartCategoryAxes', axis(chart.categoryTitle, 'category'), frame),
        el('ChartValueAxes', axis(chart.valueTitle, 'value', axisFormat ?? (isPie ? undefined : this.options.chartAxisFormat)), frame),
        // Crystal's 3D pies are tilted well back, with a thick edge.
        style.threeD ? el('ChartThreeDProperties', el('Enabled', 'true'),
          el('Rotation', isPie ? '0' : '20'), el('Inclination', isPie ? '50' : '20'),
          isPie ? el('DepthRatio', '150') : null, el('Shading', 'Real')) : null,
        // Crystal draws pies large, with their labels around them.
        // Crystal's chart fills its object: the chart area takes the whole chart, less the legend's strip.
        // With a legend, SSRS lays the area and the legend out itself (fixed sizes would let them overlap).
        chart.legend?.visible && !isPie ? null : el('ChartElementPosition', el('Top', '1'), el('Left', '1'), el('Height', '98'), el('Width', '98')),
        isPie ? el('ChartInnerPlotPosition', el('Top', '7'), el('Left', '17'), el('Height', '86'), el('Width', '66')) : null,
        // Crystal's plot area is light grey behind bars and lines.
        el('Style', isPie ? null : el('BackgroundColor', '#D9D9D9')))),
      // The legend as Crystal has it (shown or not, and where); a bar per colour has none by default.
      el('ChartLegends', el('ChartLegend', { Name: 'Default' },
        (chart.legend ? !chart.legend.visible : barPerPoint) ? el('Hidden', 'true') : null,
        // Crystal frames its legend with a thin line.
        el('Style', el('Border', el('Color', 'Black'), el('Style', 'Solid'), el('Width', '0.5pt')), el('FontFamily', 'Arial'), el('FontSize', '5.5pt'), el('FontWeight', 'Normal')),
        el('Position', LEGEND_POSITIONS[chart.legend?.position ?? 0] ?? 'RightCenter'),
        el('AutoFitTextDisabled', 'true'),
        // Each entry on one line, as Crystal prints it (SSRS leaves a wrapped entry's last line against the frame).
        el('TextWrapThreshold', '0'))),
      chart.title ? el('ChartTitles', el('ChartTitle', { Name: 'Default' }, el('Caption', chart.title), el('Style', el('FontWeight', 'Bold')))) : null,
      // Crystal's chart colours, in its order.
      el('Palette', 'Custom'),
      // A pie whose style record has no tail starts at Crystal's second colour (orange), as Crystal draws it.
      el('ChartCustomPaletteColors', ...(isPie ? (chart.styleTail === false && chart.family === 3 ? [...CRYSTAL_PIE_PALETTE.slice(1), CRYSTAL_PIE_PALETTE[0]] : CRYSTAL_PIE_PALETTE)
        : isLine ? CRYSTAL_LINE_PALETTE : CRYSTAL_PALETTE).map((c) => el('ChartCustomPaletteColor', c))),
      el('ChartBorderSkin', el('Style')),
      // Crystal prints nothing for a chart without data.
      el('ChartNoDataMessage', { Name: 'NoDataMessage' }, el('Caption', ''), el('Style')),
      el('DataSetName', this.dataset),
      el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
      // Crystal prints nothing for a chart without data; hidden, it leaves the space to what is placed over it
      // (such as a "no data" message), which SSRS would otherwise move aside.
      hidden !== undefined ? el('Visibility', el('Hidden', hidden
        ? `=(${hidden.slice(1)}) OrElse (CountRows(${vbString(this.dataset)}) = 0)`
        : `=CountRows(${vbString(this.dataset)}) = 0`)) : null,
      // Transparent, as in Crystal: a title placed over the chart's top stays readable.
      el('Style', el('Border', el('Style', 'None')), el('BackgroundColor', 'Transparent')));
  }

  // ---- table (tablix) -------------------------------------------------------------------

  private columnsFor(all: SectionInfo[]): Column[] {
    const own = all.filter((s) => !messageSections.has(s));
    const sections = own.length ? own : all;
    const sectionOf = new Map(sections.flatMap((s) => s.objects.map((o) => [o, s] as const)));
    const cellObjects = sections.flatMap((s) => s.objects).filter((o) => o.kind === 'field' || o.kind === 'text');
    // An object laid across two or more others on its line (a message shown in place of a row's values) spans their columns:
    // its own edge would cut a sliver of a column out of the one beside it.
    const left = (o: ReportObject) => o.position?.x ?? 0;
    const top = (o: ReportObject) => o.position?.y ?? 0;
    const sameLine = (a: ReportObject, b: ReportObject) => sectionOf.get(a) === sectionOf.get(b) && top(a) < top(b) + (b.size?.height ?? 0) && top(b) < top(a) + (a.size?.height ?? 0);
    const spansOthers = (o: ReportObject) => cellObjects.filter((q) => q !== o && sameLine(o, q) && left(q) > left(o) + 144 && left(q) < left(o) + (o.size?.width ?? 0)).length >= 2;
    const edges = cellObjects.filter((o) => !spansOthers(o));
    const xs = [...new Set((edges.length ? edges : cellObjects).map(left))].sort((a, b) => a - b);
    const merged: number[] = [];
    for (const x of xs) if (merged.length === 0 || x - merged[merged.length - 1] > 144) merged.push(x);
    return merged.map((x, i) => {
      // Each column ends where the next begins, so every column keeps its Crystal position.
      if (i + 1 < merged.length) return { x, width: twipsToInches(merged[i + 1] - x) };
      const widest = Math.max(0, ...cellObjects.filter((o) => (o.position?.x ?? 0) >= x).map((o) => o.size?.width ?? 0));
      return { x, width: widest ? Math.max(twipsToInches(widest), 0.3) : DEFAULT_WIDTH };
    });
  }

  private columnIndex(columns: Column[], x: number): number {
    let best = 0;
    for (let i = 0; i < columns.length; i++) if (x >= columns[i].x - 144) best = i;
    return best;
  }

  /**
   * The table columns that take a border from a line running down the table (tableRules): the left border of
   * the column whose left edge is nearest the line, or the right border of the last column.
   */
  private columnRules(columns: Column[]): { left: Set<number>; right: Set<number> } {
    const left = new Set<number>();
    const right = new Set<number>();
    const tableRight = columns[columns.length - 1].x + inchesToTwips(columns[columns.length - 1].width);
    for (const x of this.tableRules) {
      let best = -1;
      let distance = Infinity;
      columns.forEach((c, i) => {
        const d = Math.abs(c.x - x);
        if (d < distance) { distance = d; best = i; }
      });
      if (Math.abs(tableRight - x) < distance) {
        if (Math.abs(tableRight - x) <= 360) right.add(columns.length - 1);
      } else if (distance <= 360) left.add(best);
    }
    return { left, right };
  }

  /**
   * A table cell's border, as wide as the lines it continues (SSRS draws a table cell's border thinner than a
   * rectangle's of the same width, so it gets half a point more, matching the boxes around it).
   */
  private ruledBorder(border: BorderInfo | undefined, ruled: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean; width?: number }): BorderInfo | undefined {
    if (!ruled.top && !ruled.bottom && !ruled.left && !ruled.right) return border;
    // A line along the row keeps its own width (Crystal draws thick rules under headings).
    const along = (ruled.top || ruled.bottom) && ruled.width ? ruled.width + 10 : 0;
    return { ...(border ?? { sides: [0, 0, 0, 0] }), width: Math.max(border?.width ?? 0, this.tableRuleWidth + 10, along) };
  }

  private ruledBorderObject(obj: ReportObject | undefined, ruled: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean; width?: number }): ReportObject | undefined {
    const border = this.ruledBorder(obj?.border, ruled);
    return border === obj?.border ? obj : { ...(obj ?? { kind: 'text', name: '' }), border };
  }

  /**
   * A free-form section with a line across the table in its middle, where nothing straddles the line and the
   * lines running down the table start at it: the parts above and below it.
   */
  private splitAtRule(columns: Column[], section: SectionInfo): { upper: SectionInfo; lower: SectionInfo } | null {
    if (!section.height || this.isTabular(columns, section)) return null;
    const tableWidth = inchesToTwips(columns.reduce((sum, c) => sum + c.width, 0));
    const rule = section.objects
      .filter((o) => o.kind === 'line' && !this.runOn.has(o) && !(o.size?.height) && (o.size?.width ?? 0) >= tableWidth * 0.8)
      .map((o) => ({ o, y: o.position?.y ?? 0 }))
      .filter((r) => r.y > 60 && r.y < section.height! - 60)
      .sort((a, b) => a.y - b.y)[0];
    if (!rule) return null;
    const others = section.objects.filter((o) => o !== rule.o);
    const top = (o: ReportObject) => o.position?.y ?? 0;
    const bottom = (o: ReportObject) => top(o) + (o.size?.height ?? 0);
    // A box framing the table from the section's top: its sides are the table's rules, its top the upper row's
    // top border.
    const frames = others.filter((o) => this.runOn.has(o) && o.kind === 'box' && top(o) <= 60);
    const down = others.filter((o) => this.runOn.has(o) && !frames.includes(o));
    if (down.some((o) => o.kind !== 'line' || Math.abs(top(o) - rule.y) > 60)) return null;
    const rest = others.filter((o) => !this.runOn.has(o));
    if (rest.some((o) => top(o) < rule.y - 30 && bottom(o) > rule.y + 30)) return null;
    const { conditions, ...base } = section;
    const frameTop = frames.map((f) => ({ ...rule.o, name: `${f.name}_Top`, position: { x: rule.o.position?.x ?? 0, y: 0 }, border: f.border }));
    // SSRS centres a cell's bottom border on the row's edge: a thick rule would reach up into the title above it
    // (Crystal draws it from the line down). The row ends half the rule's width lower.
    const cut = Math.min(rule.y + thickHalf(rule.o), section.height - 44);
    return {
      upper: { ...section, height: cut, objects: [...frameTop, ...rest.filter((o) => top(o) < rule.y), { ...rule.o, position: { x: rule.o.position?.x ?? 0, y: cut } }] },
      // The lines running down start here: the row's cell borders (the table's rules) draw them.
      lower: { ...base, conditions: conditions?.backColor ? { backColor: conditions.backColor } : undefined, name: `${section.name}_Lower`, height: section.height - cut,
        objects: rest.filter((o) => top(o) >= rule.y).map((o) => ({ ...o, position: { x: o.position?.x ?? 0, y: Math.max(top(o) - cut, 0) } })) },
    };
  }

  /**
   * A section whose last object is a line across the table drawn above its bottom (a rule under the
   * column headings): the row ends at the line (its bottom border) and an empty row keeps the space Crystal leaves
   * below it, so the next row's text does not touch the line.
   */
  private splitBelowRule(columns: Column[], section: SectionInfo): { upper: SectionInfo; lower: SectionInfo } | null {
    if (!section.height) return null;
    const tableWidth = inchesToTwips(columns.reduce((sum, c) => sum + c.width, 0));
    const rules = section.objects.filter((o) => o.kind === 'line' && !this.runOn.has(o) && !(o.size?.height) && (o.size?.width ?? 0) >= tableWidth * 0.8);
    const rule = rules.map((o) => ({ o, y: o.position?.y ?? 0 })).filter((r) => r.y > section.height! / 2).sort((a, b) => b.y - a.y)[0];
    if (!rule) return null;
    // SSRS centres a cell's bottom border on the row's edge, half of it in the next row: the row ends half a thick
    // rule's width below the line, and the space Crystal leaves below the rule is kept; below a thick rule there is
    // always some (it would otherwise touch the next row's text). A row is at least 0.03in (44 twips) high.
    const upperHeight = Math.min(rule.y + thickHalf(rule.o), section.height);
    const thick = thickHalf(rule.o) > 0;
    let gap = section.height - upperHeight;
    if (gap < 44) {
      if (!thick) return null;
      gap = 44;
    }
    // Nothing else may start below the line, nor any line run down the table from this section. A heading whose
    // frame merely reaches past the line (its text ends well above it) is cut at the line.
    if (section.objects.some((o) => o !== rule.o && ((o.position?.y ?? 0) > rule.y - 10 || this.runOn.has(o)))) return null;
    const { conditions, ...base } = section;
    const cutAt = (o: ReportObject) => {
      const top = o.position?.y ?? 0;
      return o.size && top + o.size.height > rule.y ? { ...o, size: { ...o.size, height: Math.max(rule.y - top, 0) } } : o;
    };
    return {
      upper: { ...section, height: upperHeight, objects: section.objects.map((o) => (o === rule.o ? { ...o, position: { x: o.position?.x ?? 0, y: upperHeight } } : cutAt(o))) },
      lower: { ...base, conditions: conditions?.backColor ? { backColor: conditions.backColor } : undefined, name: `${section.name}_Below`, height: gap, objects: [] },
    };
  }

  /** Whether a section fits a plain table row: one line of fields/text, at most one per column. */
  private isTabular(columns: Column[], section: SectionInfo): boolean {
    const cellObjects = section.objects.filter((o) => o.kind === 'field' || o.kind === 'text');
    if (section.objects.some((o) => o.kind !== 'field' && o.kind !== 'text' && o.kind !== 'line')) return false;
    const used = new Set<number>();
    for (const obj of cellObjects) {
      const i = this.columnIndex(columns, obj.position?.x ?? 0);
      if (used.has(i)) return false;
      used.add(i);
    }
    // An object running on over the next column, where nothing else in the row starts (a heading or label wider
    // than its column): it keeps its width across the columns, so the row is laid out free-form.
    for (const obj of cellObjects) {
      const i = this.columnIndex(columns, obj.position?.x ?? 0);
      const end = (obj.position?.x ?? 0) + (obj.size?.width ?? 0);
      if (i + 1 < columns.length && end > columns[i + 1].x + 144 && !used.has(i + 1)) return false;
    }
    const ys = cellObjects.map((o) => o.position?.y ?? 0);
    return ys.length === 0 || Math.max(...ys) - Math.min(...ys) <= 144;
  }

  /** A table row for one section: a cell per column, or one merged cell with the objects at their positions. */
  /** A group on a formula that reads no fields, parameters or other formulas: every record is in one group. */
  private isConstantGroup(field: string | undefined): boolean {
    if (!field?.startsWith('@')) return false;
    const formula = this.definition.formulas.find((f) => f.name.toLowerCase() === field.slice(1).toLowerCase());
    return !!formula && formula.referencedFields.length === 0 && !/[{]/.test(formula.text);
  }

  private tableRow(columns: Column[], section: SectionInfo, rowName: string, area: string, minHeight = MIN_ROW_HEIGHT, outerOnly = false, splitDone: boolean | 'below' = false): { row: XmlElement; height: number; hidden?: string; more?: { row: XmlElement; height: number }[] } {
    // Split once, at the first rule (the one under the heading's title); a rule lower down closes the headings.
    // The part below a title's rule may still end at a rule of its own (the one under the column headings).
    // Below the first rule, any further rule across the middle splits the rest again (a rule between a block of figures
    // and the column headings under it).
    const atRule = splitDone === true ? null : this.splitAtRule(columns, section);
    const split = atRule ?? (splitDone === true ? null : this.splitBelowRule(columns, section));
    if (split) {
      // A line across the middle of the section (a rule under a heading): two rows, the upper ending at the line
      // (its bottom border), the lower starting there; the lines running down from it are the lower row's cell
      // borders, drawn as in the rows below it.
      // Above a title's rule the row is the title's alone; a row ending at a rule below it is laid out as usual.
      const upper = this.tableRow(columns, split.upper, rowName, area, minHeight, !!atRule && !splitDone, true);
      const lower = this.tableRow(columns, split.lower, `${rowName}_Lower`, area, minHeight, false, atRule ? 'below' : true);
      // The lower part may itself end at a rule, with an empty row after it.
      const lowerOwn = lower.height - (lower.more ?? []).reduce((h, m) => h + m.height, 0);
      return { row: upper.row, height: upper.height + lower.height, hidden: upper.hidden, more: [{ row: lower.row, height: lowerOwn }, ...(lower.more ?? [])] };
    }
    const suppress = section.conditions?.suppress;
    let hidden = suppress ? this.conditionExpression(suppress, false, `Section ${section.name}`) : undefined;
    if (!hidden && blankRows.has(section) && section.objects[0]) {
      // A message's own row: hidden where the message is blank.
      const { value } = this.objectValue(section.objects[0], 'row');
      if (value.startsWith('=')) hidden = `=IsNothing(${value.slice(1)}) OrElse Len(Trim(CStr(${value.slice(1)}))) = 0`;
    }
    const messages = messageRows.get(section);
    if (messages && !section.objects.some((o) => o.kind === 'text' && !o.suppressed && (o.text ?? '').trim())) {
      // The row a message was laid over, showing nothing else where the message shows: the message's row stands
      // in for it (Crystal prints the message on its line), so it is not left as a blank line above.
      const blank = (o: ReportObject) => {
        const { value } = this.objectValue(o, 'row');
        return value.startsWith('=') ? `Len(Trim(CStr(${value.slice(1)}))) = 0` : undefined;
      };
      const shows = messages.map(blank);
      const empty = section.objects.filter((o) => o.kind === 'field' && !o.suppressed).map(blank);
      if (shows.every(Boolean) && empty.every(Boolean)) {
        const own = [`Not (${shows.join(' AndAlso ')})`, ...empty].join(' AndAlso ');
        hidden = hidden ? `=(${hidden.slice(1)}) OrElse (${own})` : `=${own}`;
      }
    }
    const background = section.conditions?.backColor ? this.conditionExpression(section.conditions.backColor, true, `Section ${section.name}`) : undefined;
    const sectionHeight = section.height !== undefined ? twipsToInches(section.height) : 0;
    const tableLeft = columns[0].x;
    const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);

    if (outerOnly || !this.isTabular(columns, section)) {
      // Free-form: every object keeps its position. Each run of columns the objects cover is one cell (holding
      // them in a rectangle), so the lines running down the table are the cells' borders: they reach the full
      // height of a row whose text wraps, as Crystal's lines do.
      const tableRight = tableLeft + inchesToTwips(tableWidth);
      const edges = [...columns.map((c) => c.x), tableRight];
      const placed: { obj: ReportObject; first: number; last: number; x: number }[] = [];
      const lines = { top: false, bottom: false, width: 0 };
      let bottom = 0;
      for (const obj of section.objects) {
        let x = obj.position?.x ?? 0;
        const width = obj.size?.width ?? 0;
        if (obj.kind === 'line' && !this.runOn.has(obj) && width >= inchesToTwips(tableWidth) * 0.8 && !(obj.size?.height)) {
          // A line along the whole row: the row's top or bottom border.
          if (section.height && (obj.position?.y ?? 0) > section.height / 2) lines.bottom = true;
          else lines.top = true;
          lines.width = Math.max(lines.width, obj.border?.width ?? 20);
          continue;
        }
        if (obj.kind === 'line' && this.runOn.has(obj)) {
          // A line running down the table sits on the column edge the rows' borders use.
          const edge = edges.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
          if (Math.abs(edge - x) <= 360) x = edge;
        }
        const first = x >= tableRight ? columns.length - 1 : this.columnIndex(columns, x);
        let last = first;
        for (let i = first + 1; i < columns.length; i++) if (columns[i].x < x + width - 144) last = i;
        placed.push({ obj, first, last, x });
        bottom = Math.max(bottom, twipsToInches((obj.position?.y ?? 0) + (obj.size?.height ?? 0)));
      }
      // Columns joined by an object that spans them.
      const segments: [number, number][] = [];
      for (let i = 0; i < columns.length; i++) {
        let last = i;
        for (let grown = true; grown;) {
          grown = false;
          for (const p of placed) if (p.first <= last && p.last > last && p.first >= i) { last = p.last; grown = true; }
        }
        segments.push([i, last]);
        i = last;
      }
      const height = sectionHeight > 0 ? sectionHeight : Math.max(bottom, MIN_ROW_HEIGHT);
      // Lines running down the table (tableRules) cross this row too, at the column edges; not in the section
      // they start in, which draws them itself from where they start.
      const startsHere = section.objects.some((o) => this.runOn.has(o));
      const all = startsHere ? { left: new Set<number>(), right: new Set<number>() } : this.columnRules(columns);
      // Above a heading's rule only the frame's sides cross the row.
      const rules = outerOnly ? { left: new Set([...all.left].filter((i) => i === 0)), right: all.right } : all;
      const cells: XmlElement[] = [];
      for (const [first, last] of segments) {
        const left = columns[first].x;
        const width = columns.slice(first, last + 1).reduce((sum, c) => sum + c.width, 0);
        const items: XmlElement[] = [];
        const inCell = placed.filter((q) => q.first >= first && q.first <= last);
        for (const p of inCell) {
          const box = this.boxOf(p.obj, 0);
          box.left = Math.min(Math.max(0, twipsToInches(p.x - left)), width);
          box.width = Math.min(box.width, Math.max(width - box.left, 0.01));
          // Left-aligned text may run on to the next object beside it or the cell's end (SSRS fonts are a little
          // wider than Crystal's, and would wrap it sooner).
          const o = p.obj;
          if (o.kind === 'text' || o.kind === 'field') {
            const leftAligned = o.align === 'left' || (!o.align && (o.kind === 'text' || (o.field !== undefined && this.valueTypeOf(o.field) === 'string')));
            // Text set to the right within its own column ends where that column's values end in the rows laid out
            // a cell per column (at most 288 twips short of the column's edge).
            if (!leftAligned && p.first === p.last) {
              const columnRight = columns[p.first].x + inchesToTwips(columns[p.first].width);
              const objectRight = p.x + (o.size?.width ?? 0);
              // Unless the column's values end where it does (or are all set to the left): it stays where it is.
              const ends = this.detailValueEnds(columns, p.first);
              if (objectRight <= columnRight && columnRight - objectRight > 288 && ends.length && !ends.some((end) => Math.abs(end - objectRight) <= 60)) {
                box.left = Math.max(0, twipsToInches(columnRight - 288 - left) - box.width);
              }
            }
            const y = o.position?.y ?? 0;
            const bottom = y + (o.size?.height ?? 0);
            const next = inCell
              .filter((q) => q !== p && q.x > p.x && (q.obj.position?.y ?? 0) < bottom && (q.obj.position?.y ?? 0) + (q.obj.size?.height ?? 0) > y)
              .reduce((min, q) => Math.min(min, twipsToInches(q.x - left)), width);
            if (leftAligned && next - box.left > box.width) box.width = next - box.left;
          }
          const item = this.reportItem(p.obj, 'row', area, box);
          if (item) items.push(item);
        }
        // Lines down the table inside a cell that spans columns.
        for (let i = first + 1; i <= last; i++) {
          if (!rules.left.has(i)) continue;
          items.push(el('Line', { Name: this.itemNames.make(`${rowName}_Rule`) },
            el('Top', '0in'), el('Left', inches(twipsToInches(columns[i].x - left))), el('Height', inches(height)), el('Width', '0in'),
            el('Style', el('Border', el('Color', 'Black'), el('Style', 'Solid'), el('Width', `${((this.tableRuleWidth + 10) / 20).toFixed(2)}pt`)))));
        }
        const ruled = { ...lines, left: rules.left.has(first), right: last === columns.length - 1 && rules.right.has(last) };
        const rectangle = el('Rectangle', { Name: this.itemNames.make(`${rowName}_Area`) },
          items.length ? el('ReportItems', ...items) : null,
          el('KeepTogether', 'true'),
          el('Style', ...this.borderStyle(this.ruledBorder(background ? { sides: [0, 0, 0, 0], background } : undefined, ruled), ruled)));
        cells.push(el('TablixCell', el('CellContents', rectangle, last > first ? el('ColSpan', String(last - first + 1)) : null)));
        for (let i = first; i < last; i++) cells.push(el('TablixCell'));
      }
      const row = el('TablixRow', el('Height', inches(height)), el('TablixCells', ...cells));
      this.noteTopRule(row, section, tableWidth);
      return { row, height, hidden };
    }

    const rules = this.columnRules(columns);
    const cells: (ReportObject | undefined)[] = columns.map(() => undefined);
    let rowHeight = 0;
    const rowLines: ReportObject[] = [];
    for (const obj of section.objects) {
      if (obj.kind === 'line') {
        rowLines.push(obj);
        continue;
      }
      cells[this.columnIndex(columns, obj.position?.x ?? 0)] = obj;
      rowHeight = Math.max(rowHeight, twipsToInches(obj.size?.height ?? 0) + twipsToInches(obj.position?.y ?? 0));
    }
    // A row is as tall as its Crystal section (text boxes grow when their text needs more room).
    const height = sectionHeight > 0 ? Math.max(sectionHeight, Math.min(minHeight, 0.03)) : Math.max(rowHeight, minHeight);
    const row = el('TablixRow',
      el('Height', inches(height)),
      el('TablixCells', ...cells.map((obj, i) => {
        // The lines along the row over this column: one across the column is the cell's top or bottom border; one
        // shorter than the column (a rule under a heading only) is drawn at its own place and width.
        const columnLeft = columns[i].x;
        const columnEnd = columnLeft + inchesToTwips(columns[i].width);
        const lines = { top: false, bottom: false, width: 0 };
        const partLines: ReportObject[] = [];
        for (const line of rowLines) {
          const x = line.position?.x ?? 0;
          const right = x + (line.size?.width ?? 0);
          // A line of unknown (or no) width is taken as running along the whole row.
          const whole = !line.size?.width || line.size.width >= inchesToTwips(tableWidth) * 0.8;
          // A line running on past the table's edge belongs to the first or last column.
          const from = i === 0 ? Math.min(columnLeft, x) : columnLeft;
          const to = i === columns.length - 1 ? Math.max(columnEnd, right) : columnEnd;
          const overlap = whole ? columnEnd - columnLeft : Math.min(right, to) - Math.max(x, from);
          if (overlap <= 60) continue;
          if (whole || overlap >= columnEnd - columnLeft - 60 || line.size?.height) {
            if (section.height && (line.position?.y ?? 0) > section.height / 2) lines.bottom = true;
            else lines.top = true;
            lines.width = Math.max(lines.width, line.border?.width ?? 20);
          } else partLines.push(line);
        }
        const { value, format } = obj ? this.objectValue(obj, 'row') : { value: '', format: undefined };
        const name = this.itemNames.make(obj?.name || `${rowName}_${i + 1}`);
        const cellObj = background ? { ...(obj ?? { kind: 'text', name }), border: { ...(obj?.border ?? { sides: [0, 0, 0, 0] as [number, number, number, number] }), background } } : obj;
        const ruled = { ...lines, left: rules.left.has(i), right: rules.right.has(i) };
        // The object's place within its column, as padding (keeps text off the column lines, as in Crystal).
        const columnRight = columns[i].x + inchesToTwips(columns[i].width);
        // Left-aligned text may run on to the column's end (SSRS fonts are a little wider than Crystal's, and
        // would wrap it sooner).
        const leftAligned = obj?.align === 'left' || (!obj?.align && (obj?.kind === 'text' || (obj?.field !== undefined && this.valueTypeOf(obj.field) === 'string')));
        const padding = obj?.position && obj.size ? {
          left: Math.min(Math.max(obj.position.x - columns[i].x, 0), 288),
          // Text set to the right keeps its place (as far as SSRS's 1in of padding goes), unless the column's values
          // are moved across by a formula: then it ends at most 288 twips short of the column's edge, as they do.
          right: leftAligned ? 0 : Math.min(Math.max(columnRight - (obj.position.x + obj.size.width), 0), this.detailValueEnds(columns, i).length ? 288 : 1440),
          // Its place down the section (a heading set lower in its row), as far as the row's height allows.
          top: section.height ? Math.min(Math.max(obj.position.y, 0), Math.max(section.height - obj.size.height, 0), 1440) : 0,
          // Its whole distance from the column's edges, which formulas moving or widening it start from.
          exact: { left: Math.max(obj.position.x - columns[i].x, 0), right: leftAligned ? 0 : Math.max(columnRight - (obj.position.x + obj.size.width), 0) },
        } : undefined;
        // A field drawing its own border (a total's rule): Crystal's line is as wide as the field, with gaps between
        // neighbouring totals, at the field's own height in the row; the cell keeps it at its own place and size.
        const ownBorder = obj?.border?.sides.some((side) => side > 0) && !ruled.left && !ruled.right && !lines.top && !lines.bottom;
        // A border is drawn on the box's edges: the field keeps its own box unless it fills its cell (as wide as the
        // column, from the row's top to its bottom) — set lower in the row, a cell's top border would sit too high.
        const fillsCell = !!obj?.position && !!obj.size && obj.size.width >= inchesToTwips(columns[i].width) - 60
          && obj.position.y <= 15 && (!section.height || section.height - (obj.position.y + obj.size.height) <= 30);
        if (ownBorder && obj?.position && obj.size && padding && !fillsCell) {
          // Text set to the right ends where the column's other values end (the same right padding); text to the
          // left starts where theirs start.
          const columnWidth = inchesToTwips(columns[i].width);
          const right = leftAligned ? padding.left + obj.size.width : columnWidth - (padding.right ?? 0);
          const boxLeft = Math.max(right - obj.size.width, 0);
          const box = {
            // Its own height in the row (the text padding is capped; the box is not).
            top: twipsToInches(Math.max(Math.min(obj.position.y, (section.height ?? obj.position.y + obj.size.height) - obj.size.height), 0)), left: twipsToInches(boxLeft),
            width: twipsToInches(Math.min(obj.size.width, columnWidth - boxLeft)),
            height: twipsToInches(obj.size.height),
          };
          return el('TablixCell', el('CellContents', el('Rectangle', { Name: this.itemNames.make(`${name}_Area`) },
            el('ReportItems', this.textbox(name, value, cellObj, format, 'row', box)),
            el('KeepTogether', 'true'),
            el('Style', el('Border', el('Style', 'None'))))));
        }
        // A line style formula on a field narrower than its column (a rule under a total): Crystal draws the line under
        // the field only, so it is a line of its own there rather than the cell's border.
        const ruleFormulas = obj?.position && obj.size && !fillsCell && !ruled.top && !ruled.bottom
          ? (['topLine', 'bottomLine'] as const).filter((key) => obj.conditions?.[key]) : [];
        if (partLines.length || ruleFormulas.length) {
          const columnWidth = twipsToInches(columnEnd - columnLeft);
          // The text is placed as in the column's other rows (so a heading lines up with the values under it); a line
          // under it moves with it, by as far as the text is from its place in Crystal.
          const cellWidth = columnEnd - columnLeft;
          let moved = 0;
          if (obj?.position && obj.size && padding) {
            const ownLeft = obj.position.x - columnLeft;
            const ownRight = ownLeft + obj.size.width;
            const textLeft = padding.left;
            const textRight = cellWidth - padding.right;
            moved = obj.align === 'center' ? (textLeft + textRight - ownLeft - ownRight) / 2
              : obj.align === 'right' || (!leftAligned && obj.align !== 'left') ? textRight - ownRight
                : textLeft - ownLeft;
          }
          const under = (line: ReportObject) => !!obj?.position && !!obj.size
            && (line.position?.x ?? 0) < obj.position.x + obj.size.width && (line.position?.x ?? 0) + (line.size?.width ?? 0) > obj.position.x;
          const items: (XmlElement | null)[] = partLines.map((line) => {
            const shift = under(line) ? moved : 0;
            const width = Math.min(line.size?.width ?? 0, cellWidth);
            const x = Math.min(Math.max((line.position?.x ?? 0) + shift, columnLeft), columnEnd - Math.max(width, 60));
            const right = Math.max(Math.min(x + width, columnEnd), x + 60);
            const box = { top: Math.min(twipsToInches(line.position?.y ?? 0), height), left: twipsToInches(x - columnLeft), width: twipsToInches(right - x), height: 0 };
            return this.reportItem({ ...line, size: { width: right - x, height: 0 } }, 'row', area, box);
          });
          for (const key of ruleFormulas) {
            const style = this.conditionExpression(obj!.conditions![key]!, false, `${obj!.kind} object "${obj!.name}"`, 'row');
            if (!style) continue;
            // Crystal keeps the text a little below a rule along the field's top (2pt): the rule is drawn that much
            // higher (the row keeps its height, as Crystal's does), as far as the row's top allows.
            const y = key === 'topLine' ? Math.max(0, obj!.position!.y - RULE_GAP) : obj!.position!.y + obj!.size!.height;
            const sides = obj!.border?.sides ?? [0, 0, 0, 0];
            const own = BORDER_STYLES[key === 'topLine' ? sides[2] : sides[3]] ?? 'None';
            // Formulas moving or widening the field move its line too. A line's place cannot be an expression, so the line
            // is drawn in short pieces across the cell, each drawn where it falls within the line the formulas give. The
            // pieces outside it are drawn with no line rather than hidden: SSRS moves what is beside a hidden item in a
            // rectangle across into its place, so the pieces left would slide to the start of the cell.
            const dx = obj!.conditions?.deltaX;
            const dw = obj!.conditions?.deltaWidth;
            const dxValue = dx ? this.conditionExpression(dx, false, `${obj!.kind} object "${obj!.name}"`, 'row')?.slice(1) : undefined;
            const dwValue = dw ? this.conditionExpression(dw, false, `${obj!.kind} object "${obj!.name}"`, 'row')?.slice(1) : undefined;
            const offset = (value: string | undefined) => (value ? `IIf(IsNothing(${value}), 0, CDbl(${value}))` : '0');
            const moving = !!(dxValue || dwValue);
            // Where the text is: moved with it, unless formulas moving the field place the text from the field's own place.
            const ownLeft = obj!.position!.x - columnLeft + (moving ? 0 : moved);
            const pieces: { x: number; right: number; within?: string }[] = [];
            if (moving) {
              const start = `(${ownLeft} + ${offset(dxValue)})`;
              const end = `(${ownLeft + obj!.size!.width} + ${offset(dxValue)}${dwValue ? ` + ${offset(dwValue)}` : ''})`;
              // Short of the cell's right edge: a piece reaching past it once rounded would widen the column (and a
              // table fitted to the page would print its overflow on a page of its own).
              const inside = cellWidth - 15;
              for (let x = 0; x < inside; x += RULE_PIECE) {
                const right = Math.min(x + RULE_PIECE, inside);
                const middle = Math.round((x + right) / 2);
                pieces.push({ x, right, within: `(${start} <= ${middle} AndAlso ${middle} <= ${end})` });
              }
            } else {
              const x = Math.min(Math.max(ownLeft, 0), cellWidth - 75);
              pieces.push({ x, right: Math.max(Math.min(ownLeft + obj!.size!.width, cellWidth - 15), x + 60) });
            }
            for (const piece of pieces) {
              items.push(el('Line', { Name: this.itemNames.make(`${name}_${key === 'topLine' ? 'Above' : 'Below'}`) },
                el('Top', inches(Math.min(twipsToInches(y), height))), el('Left', inches(twipsToInches(piece.x))),
                el('Height', '0in'), el('Width', inches(twipsToInches(piece.right - piece.x))),
                el('Style', el('Border',
                  el('Color', obj!.border?.color ?? 'Black'),
                  el('Style', piece.within
                    ? `=IIf(${piece.within}, IIf(IsNothing(${style.slice(1)}), "${own}", ${style.slice(1)}), "None")`
                    : `=IIf(IsNothing(${style.slice(1)}), "${own}", ${style.slice(1)})`),
                  el('Width', `${Math.max(0.25, (obj!.border?.width ?? 20) / 20).toFixed(2)}pt`)))));
            }
          }
          // The text without the line formulas drawn here.
          const textObj = ruleFormulas.length && cellObj
            ? { ...cellObj, conditions: Object.fromEntries(Object.entries(cellObj.conditions ?? {}).filter(([key]) => !(ruleFormulas as readonly string[]).includes(key))) }
            : cellObj;
          // The part of the gap below a rule along the top that the row's top left no room for moves the text down.
          const short = Math.max(0, RULE_GAP - (obj?.position?.y ?? 0));
          const textPadding = ruleFormulas.includes('topLine') && padding && short ? { ...padding, top: (padding.top ?? 0) + short } : padding;
          const text = obj || ruled.top || ruled.bottom || ruled.left || ruled.right || background
            ? this.textbox(name, value, this.ruledBorderObject(textObj, ruled), format, 'row', { top: 0, left: 0, width: columnWidth, height }, undefined, ruled, textPadding)
            : null;
          return el('TablixCell', el('CellContents', el('Rectangle', { Name: this.itemNames.make(`${name}_Area`) },
            el('ReportItems', ...(text ? [text] : []), ...items.filter((item): item is XmlElement => !!item)),
            el('KeepTogether', 'true'),
            el('Style', el('Border', el('Style', 'None'))))));
        }
        return el('TablixCell', el('CellContents', this.textbox(name, value, this.ruledBorderObject(cellObj, ruled), format, 'row', undefined, undefined, ruled, padding)));
      })));
    this.noteTopRule(row, section, tableWidth);
    return { row, height, hidden };
  }

  /** Right edges (twips) of the detail values in a column moved across by a formula (not drawn where Crystal has them). */
  private detailValueEnds(columns: Column[], index: number): number[] {
    return this.definition.layout.filter((a) => /^Detail/i.test(a.name)).flatMap((a) => a.sections).flatMap((s) => s.objects)
      .filter((o) => o.kind === 'field' && o.position && o.size && !o.suppressed && !!o.conditions?.deltaX
        && this.columnIndex(columns, o.position.x) === index)
      .map((o) => o.position!.x + o.size!.width);
  }

  /** Rows whose top border is a line along the row, with the line's width (twips). */
  private readonly topRules = new WeakMap<XmlElement, number>();

  private noteTopRule(row: XmlElement, section: SectionInfo, tableWidth: number): void {
    const widths = section.objects
      .filter((o) => o.kind === 'line' && !this.runOn.has(o) && !(o.size?.height)
        && (!o.size?.width || o.size.width >= inchesToTwips(tableWidth) * 0.8)
        && (!section.height || (o.position?.y ?? 0) <= section.height / 2))
      .map((o) => o.border?.width ?? 20);
    if (widths.length) this.topRules.set(row, Math.max(...widths));
  }

  /** Crystal Top N with an "Others" group: ranks groups in SQL (direct table access only). */
  private othersGroup?: { level: number; rank: string; total: string; column: DatasetField; group: DatasetField; outer: DatasetField[]; operation: string; descending: boolean; topN: number; label: string };

  private planOthersGroup(level: number, summaryRef: string, descending: boolean, topN: number, label: string): string | undefined {
    if (this.source.tables.some((t) => t.kind !== 'table')) return undefined;
    const summary = SUMMARY_NAME.exec(summaryRef);
    const operation = summary ? SUMMARY_OPERATIONS[summary[1].toLowerCase()] : undefined;
    const sqlOperation = ({ Sum: 'SUM', Count: 'COUNT', Avg: 'AVG', Max: 'MAX', Min: 'MIN' } as Record<string, string>)[operation ?? ''];
    const inner = summary?.[2] ?? '';
    const dot = inner.lastIndexOf('.');
    const column = dot > 0 ? this.lookupField(inner.slice(0, dot), inner.slice(dot + 1)) : undefined;
    const groupRef = this.groupFields[level - 1];
    const gdot = groupRef.lastIndexOf('.');
    const group = gdot > 0 ? this.lookupField(groupRef.slice(0, gdot), groupRef.slice(gdot + 1)) : undefined;
    if (!sqlOperation || !column || !group) return undefined;
    // An inner group ranks within each value of the groups around it.
    const outer = this.groupFields.slice(0, level - 1).map((ref) => {
      const d = ref.lastIndexOf('.');
      return d > 0 ? this.lookupField(ref.slice(0, d), ref.slice(d + 1)) : undefined;
    });
    if (outer.some((f) => !f)) return undefined;
    this.othersGroup = {
      level, column, group, descending, topN, label, outer: outer as DatasetField[],
      operation: sqlOperation,
      rank: this.fieldNames.make(`Group${level}_Rank`),
      total: this.fieldNames.make(`Group${level}_Total`),
    };
    const expression = `IIf(Fields!${this.othersGroup.rank}.Value <= ${topN}, Fields!${group.name}.Value, ${vbString(label)})`;
    this.groupDisplay.set(level, expression);
    return expression;
  }

  /** Display expression per group level, when it differs from the group field (e.g. an "Others" group). */
  private readonly groupDisplay = new Map<number, string>();

  private buildTablix(areas: Classified, top: number): { tablix: XmlElement | null; height: number; width: number; left: number } {
    const detailObjects = areas.detail.flatMap((s) => s.objects);
    const layoutSource = detailObjects.some((o) => o.kind === 'field' || o.kind === 'text')
      ? areas.detail
      : [...areas.groupHeaders.values()].flat();
    let columns = this.columnsFor(layoutSource);
    const anyContent = [...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().some((s) => s.objects.length > 0);
    if (columns.length === 0 && anyContent) {
      // No tabular columns at all (a form-style report): one column spanning the content.
      const objects = [...(areas.headingSections ?? []).map((h) => h.section), ...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().flatMap((s) => s.objects);
      const left = Math.min(...objects.map((o) => o.position?.x ?? 0));
      const right = Math.max(...objects.map((o) => (o.position?.x ?? 0) + (o.size?.width ?? 1440)));
      columns = [{ x: left, width: Math.max(twipsToInches(right - left), 1) }];
    }
    if (columns.length === 0) return { tablix: null, height: 0, width: 0, left: 0 };
    if (this.tableRules.length) {
      // The table reaches out to the frame drawn around it: its sides are the lines running down the table.
      const outerLeft = Math.min(...this.tableRules);
      if (outerLeft < columns[0].x && columns[0].x - outerLeft <= 360) {
        columns[0] = { ...columns[0], x: outerLeft, width: columns[0].width + twipsToInches(columns[0].x - outerLeft) };
      }
      const last = columns[columns.length - 1];
      const right = last.x + inchesToTwips(last.width);
      const outerRight = Math.max(...this.tableRules);
      if (outerRight > right && outerRight - right <= 1440) columns[columns.length - 1] = { ...last, width: last.width + twipsToInches(outerRight - right) };
      // A line running down the table is a column edge: the column nearest it starts there, so the cells'
      // borders fall where Crystal drew the line (and line up with it where it is drawn above the table).
      for (const x of [...new Set(this.tableRules)].sort((a, b) => a - b)) {
        let best = -1;
        columns.forEach((c, i) => { if (i > 0 && Math.abs(c.x - x) <= 360 && (best < 0 || Math.abs(c.x - x) < Math.abs(columns[best].x - x))) best = i; });
        if (best < 0) continue;
        const shift = twipsToInches(columns[best].x - x);
        if (columns[best - 1].width - shift < 0.05 || columns[best].width + shift < 0.05) continue;
        columns[best - 1] = { ...columns[best - 1], width: columns[best - 1].width - shift };
        columns[best] = { ...columns[best], x, width: columns[best].width + shift };
      }
    }

    // Text in a group's header or footer set further left than the first column (a group name standing out to the left
    // of the rows under it): the table starts there, with a column of its own, so the text keeps its place.
    {
      const outdented = [...areas.groupHeaders.values(), ...areas.groupFooters.values()].flat()
        .filter((s) => !s.suppressed).flatMap((s) => s.objects)
        .filter((o) => (o.kind === 'field' || o.kind === 'text') && !o.suppressed && o.position)
        .map((o) => o.position!.x);
      const left = Math.min(...outdented);
      if (outdented.length && columns[0].x - left > 144) columns = [{ x: left, width: twipsToInches(columns[0].x - left) }, ...columns];
    }
    // A line along the rows reaching past the outer columns (a rule across the page, under a table set in from its
    // edges): the table reaches out to its ends, with an empty column on either side, so the row's border is as wide.
    {
      const tableLeft = columns[0].x;
      const last = columns[columns.length - 1];
      const tableRight = last.x + inchesToTwips(last.width);
      const rowLines = [...(areas.headingSections ?? []).map((h) => h.section), ...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().flatMap((s) => s.objects)
        .filter((o) => o.kind === 'line' && !this.runOn.has(o) && !(o.size?.height) && (o.size?.width ?? 0) >= (tableRight - tableLeft) * 0.8);
      const lineLeft = Math.min(...rowLines.map((o) => o.position?.x ?? 0));
      const lineRight = Math.max(...rowLines.map((o) => (o.position?.x ?? 0) + (o.size?.width ?? 0)));
      // Only where nothing else of the table would fall in the new column (it holds the line alone).
      const others = [...(areas.headingSections ?? []).map((h) => h.section), ...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().flatMap((s) => s.objects)
        .filter((o) => o.kind !== 'line');
      const clearLeft = others.every((o) => (o.position?.x ?? 0) >= tableLeft - 144);
      const clearRight = others.every((o) => (o.position?.x ?? 0) + (o.size?.width ?? 0) <= tableRight + 144);
      // Where page headings laid out in the table would fall in the new column, the outer column reaches out to the
      // line instead.
      const widen = !!areas.headingSections;
      if (rowLines.length && tableLeft - lineLeft > 144 && (clearLeft || widen)) {
        columns = clearLeft
          ? [{ x: lineLeft, width: twipsToInches(tableLeft - lineLeft) }, ...columns]
          : [{ x: lineLeft, width: columns[0].width + twipsToInches(tableLeft - lineLeft) }, ...columns.slice(1)];
      }
      if (rowLines.length && lineRight - tableRight > 144 && (clearRight || widen)) {
        const last = columns[columns.length - 1];
        columns = clearRight
          ? [...columns, { x: tableRight, width: twipsToInches(lineRight - tableRight) }]
          : [...columns.slice(0, -1), { ...last, width: last.width + twipsToInches(lineRight - tableRight) }];
      }
    }

    const rows: XmlElement[] = [];
    let height = 0;
    /** Adds a row per section with content; returns the static members for them. */
    const addRows = (sections: SectionInfo[] | undefined, name: string, area: string, keepWith: 'After' | 'Before' | null, always = false, minHeight?: number): XmlElement[] => {
      const members: XmlElement[] = [];
      // A group's section with nothing in it still prints its height of blank space, as Crystal does (a gap after a
      // group's last row), unless it is set to be suppressed where blank.
      const blank = (s: SectionInfo) => area.startsWith('Group') && !s.suppressed && (s.height ?? 0) >= 60 && !suppressedWhenBlank(s);
      const withContent = (sections ?? []).filter((s) => s.objects.length > 0 || blank(s));
      const list = withContent.length === 0 && always ? [{ name: `${name} (empty)`, objects: [] } as SectionInfo] : withContent;
      list.forEach((section, i) => {
        const r = this.tableRow(columns, section, list.length > 1 ? `${name}_${i + 1}` : name, area, minHeight);
        height += r.height;
        for (const row of [r.row, ...(r.more ?? []).map((m) => m.row)]) {
          rows.push(row);
          members.push(el('TablixMember',
            r.hidden ? el('Visibility', el('Hidden', r.hidden)) : null,
            keepWith ? el('KeepWithGroup', keepWith) : null));
        }
      });
      return members;
    };

    const repeatOn = (members: XmlElement[]) => members.map((m) => ({ ...m, children: [...m.children, el('RepeatOnNewPage', 'true')] }));
    const headingMembers = areas.headingSections
      ? areas.headingSections.flatMap(({ section, repeat }) => {
        const members = addRows([section], 'Header', 'Page Header', 'After');
        return repeat ? repeatOn(members) : members;
      })
      : areas.columnHeadings.length
        ? repeatOn(addRows([{ name: 'Column headings', objects: areas.columnHeadings }], 'Header', 'Page Header', 'After'))
        : [];
    const levels = this.groupFields.length;
    const headerMembers: XmlElement[][] = [];
    for (let level = 1; level <= levels; level++) {
      this.ungroupedRows = level === 1 && this.isConstantGroup(this.groupFields[0]);
      headerMembers[level - 1] = addRows(areas.groupHeaders.get(level), `Group${level}Header`, `Group Header ${level}`, 'After');
      this.ungroupedRows = false;
      // Grouping on a constant formula is Crystal's way to repeat a header on every page.
      if (this.isConstantGroup(this.groupFields[level - 1])) {
        headerMembers[level - 1] = headerMembers[level - 1].map((m) => ({ ...m, children: [...m.children, el('RepeatOnNewPage', 'true')] }));
      }
    }
    const detailMembers = addRows(areas.detail, 'Detail', 'Details', null, true);
    const footerMembers: XmlElement[][] = [];
    for (let level = levels; level >= 1; level--) {
      this.ungroupedRows = level === 1 && this.isConstantGroup(this.groupFields[0]);
      footerMembers[level - 1] = addRows(areas.groupFooters.get(level), `Group${level}Footer`, `Group Footer ${level}`, 'Before');
      this.ungroupedRows = false;
      // A box framing a group that holds every record is closed by the table's own bottom border (drawn at the
      // foot of each page, as Crystal closes a box running on to the next page).
      if (this.frameFooters.has(level) && !(level === 1 && this.isConstantGroup(this.groupFields[0]))) {
        // The bottom edge of a box framing the group: a thin row whose cells have a top border.
        const closing: SectionInfo = { name: `Group${level}Frame`, height: 15, objects: [{ kind: 'line', name: 'FrameBottom', position: { x: 0, y: 0 }, size: { width: 0, height: 0 } }] };
        footerMembers[level - 1].push(...addRows([closing], `Group${level}Frame`, `Group Footer ${level}`, 'Before', false, 0.01));
      }
    }

    // A table grouped on a constant prints its outer header and footer even with no data; Crystal prints the
    // sections between them once too, blank (the band under the headings, with its column lines). Rows of their own,
    // shown only where there is no data (kept aside until the table is laid out, as they come last).
    const rowsBefore = rows.length;
    const heightBefore = height;
    const emptyMembers = levels >= 1 && this.isConstantGroup(this.groupFields[0])
      ? [...Array.from({ length: levels - 1 }, (_, i) => areas.groupHeaders.get(i + 2) ?? []).flat(), ...areas.detail,
        ...Array.from({ length: levels - 1 }, (_, i) => areas.groupFooters.get(levels - i) ?? []).flat()]
        .filter((section) => !section.suppressed && section.objects.length > 0)
        .flatMap((section, i) => addRows([section], `NoData_${i + 1}`, 'No data', null))
        .map((m) => {
          const own = (m.children.find((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility') as XmlElement | undefined)
            ?.children.map((c) => (typeof c === 'object' && c !== null ? String((c as XmlElement).children[0] ?? '') : '')).find(Boolean);
          const hidden = own && own.startsWith('=') ? `=CountRows() > 0 OrElse (${own.slice(1)})` : '=CountRows() > 0';
          return { ...m, children: [el('Visibility', el('Hidden', hidden)), ...m.children.filter((c) => !(typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility'))] };
        })
      : [];
    const emptyRows = rows.splice(rowsBefore);
    height = heightBefore;

    // Sorting: record sorts go on the details; group sorts / Top N go on their group.
    const sorts = this.definition.sorts ?? this.definition.sortFields.map((field) => ({ field, descending: false, bySummary: false }));
    const detailSorts = sorts
      .filter((s) => !s.bySummary && !this.groupFields.some((g) => g.toLowerCase() === s.field.toLowerCase()))
      .map((s) => ({ ...s, expression: this.fieldObjectValue(s.field, 'row', 'Record sort').expression }))
      .filter((s) => s.expression !== 'Nothing');
    const summarySort = sorts.find((s) => s.bySummary);
    const pageBreak = (sections: SectionInfo[] | undefined, footer?: SectionInfo[]) => {
      const before = (sections ?? []).some((s) => s.conditions?.newPageBefore || s.newPageBefore);
      const after = [...(sections ?? []), ...(footer ?? [])].some((s) => s.conditions?.newPageAfter || s.newPageAfter);
      return before || after ? el('PageBreak', el('BreakLocation', before && after ? 'StartAndEnd' : before ? 'Between' : 'End')) : null;
    };

    // Details: a single row, or a static member per detail section.
    let member: XmlElement = el('TablixMember',
      el('Group', { Name: this.itemNames.make('Details') }, pageBreak(areas.detail)),
      detailSorts.length ? el('SortExpressions', ...detailSorts.map((s) => el('SortExpression', el('Value', `=${s.expression}`), s.descending ? el('Direction', 'Descending') : null))) : null,
      detailMembers.length > 1 ? el('TablixMembers', ...detailMembers) : null,
      detailMembers.length === 1 ? (detailMembers[0].children.find((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility') ?? null) : null);
    let outer: XmlElement[] | undefined;
    for (let level = levels; level >= 1; level--) {
      const field = this.groupFields[level - 1];
      let expression = this.fieldObjectValue(field, 'row', `Group ${level}`).expression;
      const option = this.definition.groupOptions?.find((g) => g.field.toLowerCase() === field.toLowerCase());
      const fieldSort = sorts.find((s) => !s.bySummary && s.field.toLowerCase() === field.toLowerCase());
      const filters: XmlElement[] = [];
      let sortValue = `=${expression}`;
      // A record sort on the group's field decides its direction; otherwise the group's own order.
      const groupOrder = this.definition.groupSorts?.find((g) => g.field.toLowerCase() === field.toLowerCase())?.order;
      let descending = fieldSort?.descending ?? groupOrder === 1;
      if (summarySort && level === levels) {
        const summary = this.fieldObjectValue(summarySort.field, 'row', `Group ${level} sort`);
        if (summary.expression !== 'Nothing') {
          sortValue = `=${summary.expression}`;
          descending = summarySort.descending;
          const others = option?.topN && option.keepOthers
            ? this.planOthersGroup(level, summarySort.field, descending, option.topN, option.othersName ?? 'Others')
            : undefined;
          if (others) {
            expression = others;
            sortValue = `=Min(Fields!${this.othersGroup!.rank}.Value)`;
            descending = false;
          } else if (option?.topN) {
            filters.push(el('Filter',
              el('FilterExpression', `=${summary.expression}`),
              el('Operator', descending ? 'TopN' : 'BottomN'),
              el('FilterValues', el('FilterValue', { DataType: 'Integer' }, String(option.topN)))));
            if (option.keepOthers) this.note(`Group ${level}`, `Crystal also showed the remaining groups as "Others"; with this data source SSRS shows only the ${descending ? 'top' : 'bottom'} ${option.topN}`);
          }
        }
      }
      const groupSelection = level === levels ? this.groupSelectionFilter() : null;
      if (groupSelection) filters.push(groupSelection);
      if (level === 1 && this.isConstantGroup(field) && !filters.length) {
        // A group on a constant holds every record: its header and footer are the table's own rows, printed (as in
        // Crystal) even when there is no data, where a group's rows are not.
        outer = [...headerMembers[0], member, ...footerMembers[0], ...emptyMembers];
        // Not counted in the table's height: they show only where it has no data (what is laid out around the
        // table, a box or a divider down it, follows its height with data).
        rows.push(...emptyRows);
        continue;
      }
      member = el('TablixMember',
        el('Group', { Name: this.groupNames[level - 1] },
          el('GroupExpressions', el('GroupExpression', `=${expression}`)),
          pageBreak(areas.groupHeaders.get(level), areas.groupFooters.get(level)),
          filters.length ? el('Filters', ...filters) : null),
        el('SortExpressions', el('SortExpression', el('Value', sortValue), descending ? el('Direction', 'Descending') : null),
          // Groups sorted by a summary keep Crystal's order among equal summaries: by the group's own value.
          sortValue !== `=${expression}` ? el('SortExpression', el('Value', `=${expression}`), (fieldSort?.descending ?? groupOrder === 1) ? el('Direction', 'Descending') : null) : null),
        el('TablixMembers', ...headerMembers[level - 1], member, ...footerMembers[level - 1]),
        // Keep Group Together: a group that does not fit in what is left of the page starts on the next.
        this.definition.groupsKeptTogether?.some((g) => g.toLowerCase() === field.toLowerCase()) ? el('KeepTogether', 'true') : null);
    }

    const left = twipsToInches(columns[0].x);
    const width = columns.reduce((sum, c) => sum + c.width, 0);
    // A cell's border is drawn across its edge: a line along the top of the first row would lose its upper half
    // above the table. The table starts half the line lower, as Crystal draws the whole line below its top.
    const firstRule = rows.length ? this.topRules.get(rows[0]) : undefined;
    const ruleOffset = firstRule ? Math.round(twipsToInches((firstRule + 10) / 2) * 1000) / 1000 : 0;
    top += ruleOffset;
    const tablix = el('Tablix', { Name: this.itemNames.make('Table') },
      el('TablixBody',
        el('TablixColumns', ...columns.map((c) => el('TablixColumn', el('Width', inches(c.width))))),
        el('TablixRows', ...rows)),
      el('TablixColumnHierarchy', el('TablixMembers', ...columns.map(() => el('TablixMember')))),
      el('TablixRowHierarchy', el('TablixMembers', ...headingMembers, ...(outer ?? [member]))),
      el('DataSetName', this.dataset),
      el('Top', inches(top)),
      el('Left', inches(left)),
      el('Height', inches(height)),
      el('Width', inches(width)),
      // A framed table that runs on to the next page is closed at the foot of each page, as Crystal closes its box
      // (SSRS draws a table's own border on every page).
      el('Style', el('Border', el('Style', 'None')), this.frameFooters.has(1) && this.isConstantGroup(this.groupFields[0])
        ? el('BottomBorder', el('Color', 'Black'), el('Style', 'Solid'), el('Width', `${((this.tableRuleWidth + 10) / 20).toFixed(2)}pt`))
        : null));
    return { tablix, height: height + ruleOffset, width, left };
  }

  private groupSelectionFilter(): XmlElement | null {
    const { group } = this.definition.selectionFormulas;
    if (!group) return null;
    const t = translateFormula(group, this.formulaContext, { codeName: this.codeNames.make('GroupSelection') });
    this.addCode(t);
    for (const issue of t.issues) this.note('Group selection', issue);
    if (t.expression === '=Nothing') return null;
    this.note('Group selection', 'applied as a filter on the innermost group; check it');
    return el('Filter', el('FilterExpression', t.expression), el('Operator', 'Equal'), el('FilterValues', el('FilterValue', { DataType: 'Boolean' }, '=True')));
  }

  // ---- dataset --------------------------------------------------------------------------

  private connectionString(): string {
    this.cachedConnectionString ??= this.computeConnectionString();
    return this.cachedConnectionString;
  }

  private computeConnectionString(): string {
    if (this.options.connectionString) return this.options.connectionString;
    const connection = this.source.connections[0];
    const props = new Map(Object.entries(connection?.properties ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    // A JDBC URL: jdbc:sqlserver://host[\\instance][:port];databaseName=name;...
    const url = [props.get('connection url'), connection?.database].find((u) => /^jdbc:sqlserver:\/\//i.test(u ?? ''));
    const jdbc = url ? /^jdbc:sqlserver:\/\/([^;:]*)(?::(\d+))?(.*)$/i.exec(url) : null;
    const jdbcDatabase = jdbc ? /;\s*(?:databaseName|database)\s*=\s*([^;]+)/i.exec(jdbc[3])?.[1] : undefined;
    const jdbcServer = jdbc?.[1] ? `${jdbc[1]}${jdbc[2] ? `,${jdbc[2]}` : ''}` : undefined;
    // JDBC escapes the instance separator ("host\\\\INSTANCE").
    const rawServer = jdbcServer ?? props.get('server') ?? props.get('data source') ?? props.get('server name');
    const server = rawServer?.replace(/\\+/g, '\\');
    // The database can be a logon property, the connection's own database entry, or the table names' catalog.
    const ownDatabase = connection?.database && !/[\\/:]|\.\w{2,4}$/.test(connection.database) ? connection.database : undefined;
    const database = props.get('database') ?? props.get('initial catalog') ?? props.get('database name') ?? jdbcDatabase
      ?? this.source.tables.find((t) => t.catalog)?.catalog ?? (ownDatabase !== server ? ownDatabase : undefined);
    const isSqlServer = /sql|sqloledb|msoledbsql|sqlncli/i.test(`${connection?.driver ?? ''} ${props.get('provider') ?? ''} ${props.get('database type') ?? ''} ${props.get('database class name') ?? ''}`) || !!jdbc || !!server;
    if (isSqlServer && server) {
      if (!database) this.note('Data source', 'the database name was not found; add "Initial Catalog" to the connection string');
      if (props.get('user id') || props.get('user name')) {
        this.note('Data source', 'the Crystal report signed in with a SQL Server login; the data source uses Windows authentication, so switch it to stored credentials for that login if needed');
      }
      return `Data Source=${server};Initial Catalog=${database ?? 'YOUR_DATABASE'}`;
    }
    const original = [connection?.driver, connection?.database].filter(Boolean).join(', ');
    // A report that reads no database needs no connection; the placeholder is harmless.
    if (!connection && this.source.tables.length === 0) return 'Data Source=YOUR_SQL_SERVER;Initial Catalog=YOUR_DATABASE';
    this.note('Data source', `the Crystal report used ${original || 'an unknown data source'}; replace the placeholder SQL Server connection string`);
    return 'Data Source=YOUR_SQL_SERVER;Initial Catalog=YOUR_DATABASE';
  }

  private quote(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  private tableRef(table: TableInfo): string {
    return `${table.schema ? `${this.quote(table.schema)}.` : ''}${this.quote(table.name)} AS ${this.quote(table.alias)}`;
  }

  private query(): { commandType?: string; text: string; parameters: XmlElement[]; fieldsFromAll: boolean; noData?: boolean } {
    const tables = this.source.tables;
    const commands = tables.filter((t) => t.kind === 'command');
    const procedures = tables.filter((t) => t.kind === 'storedProcedure');
    if (tables.length === 0) {
      if (this.source.connections.length === 0) {
        this.note('Dataset', 'the Crystal report reads no database (it shows only formulas, parameters or text); if values come from the main report, pass them as subreport parameters');
      } else {
        this.note('Dataset', 'no tables were found in the report; write the query manually');
      }
      // One constant row, so formulas and parameters still evaluate.
      return { text: 'SELECT 1 AS [NoData]', parameters: [], fieldsFromAll: true, noData: true };
    }
    if (commands.length + procedures.length > 0 && tables.length > 1) {
      this.note('Dataset', 'the report combines a SQL command or stored procedure with other tables; SSRS needs one query, so combine them manually');
    }
    if (this.sqlExpressions.size > 0 && commands.length + procedures.length > 0) {
      this.note('Dataset', 'SQL expression fields cannot be added to a stored procedure or SQL command; add them to the command or as calculated fields');
    }
    if (commands.length > 0) {
      // Crystal substitutes {?param} into the command text; SQL Server takes them as @param query parameters.
      const used = new Set<string>();
      const text = substituteCommandParameters(commands[0].sql ?? '', (name) => {
        used.add(name);
        return `@${this.parameterName(name)}`;
      });
      if (used.size) this.note('Dataset', `the SQL command's parameters (${[...used].join(', ')}) became query parameters; check the command still runs on SQL Server`);
      return {
        text,
        parameters: [...used].map((name) => el('QueryParameter', { Name: `@${this.parameterName(name)}` }, el('Value', `=Parameters!${this.parameterName(name)}.Value`))),
        fieldsFromAll: true,
      };
    }
    if (procedures.length > 0) {
      const procedure = procedures[0];
      const name = procedure.name.replace(/;\d+$/, '');
      const parameters = this.definition.parameters
        .filter((p) => p.name.startsWith('@'))
        .map((p) => el('QueryParameter', { Name: p.name }, el('Value', `=Parameters!${this.parameterName(p.name)}.Value`)));
      // Crystal takes a procedure's "@" parameters from the procedure itself, so they already match its signature.
      if (parameters.length === 0 && this.definition.parameters.length > 0) {
        this.note('Dataset', `calls stored procedure ${name} without parameters, while the report has parameters; check the procedure's signature`);
      }
      return {
        commandType: 'StoredProcedure',
        text: procedure.schema ? `${this.quote(procedure.schema)}.${this.quote(name)}` : this.quote(name),
        parameters,
        fieldsFromAll: true,
      };
    }

    // Direct table access: SELECT the fields the report uses, joined the way Crystal links them.
    let used = [...this.fields.values()].filter((f) => f.used);
    if (used.length === 0) used = [...this.fields.values()];
    // Record order for LEAD(): group fields, then record sorts.
    const orderColumns = [...this.groupFields, ...(this.definition.sorts ?? []).filter((s) => !s.bySummary).map((s) => s.field)]
      .map((ref) => {
        const dot = ref.lastIndexOf('.');
        const f = dot > 0 ? this.findField(ref.slice(0, dot), ref.slice(dot + 1)) : undefined;
        const direction = (this.definition.sorts ?? []).find((s) => s.field === ref)?.descending ? ' DESC' : '';
        return f ? `${this.quote(f.table)}.${this.quote(f.column)}${direction}` : undefined;
      })
      .filter((c): c is string => !!c);
    const select = [
      ...used.map((f) => `  ${this.quote(f.table)}.${this.quote(f.column)} AS ${this.quote(f.name)}`),
      ...[...this.sqlExpressions.values()].map((e) => `  ${e.sql} AS ${this.quote(e.name)}`),
      ...[...this.nextColumns.values()].map((n) => `  LEAD(${this.quote(n.field.table)}.${this.quote(n.field.column)}) OVER (ORDER BY ${orderColumns.length ? orderColumns.join(', ') : '(SELECT NULL)'}) AS ${this.quote(n.name)}`),
    ].join(',\n');
    const byAlias = new Map(tables.map((t) => [t.alias.toLowerCase(), t]));
    const linked = tables.filter((t) => this.source.links.some((l) => [l.from.table, l.to.table].includes(t.alias)));
    // Start from a table whose rows an outer join preserves, so the joins read naturally.
    const preserved = this.source.links.find((l) => l.join === 'leftOuter')?.from.table ?? this.source.links.find((l) => l.join === 'rightOuter')?.to.table;
    const first = linked.find((t) => t.alias === preserved) ?? linked[0] ?? tables[0];
    const joined = new Set([first.alias.toLowerCase()]);
    const from = [`FROM ${this.tableRef(first)}`];
    const remaining = [...this.source.links];
    for (let progress = true; progress; ) {
      progress = false;
      for (const table of tables) {
        const key = table.alias.toLowerCase();
        if (joined.has(key)) continue;
        const conditions = remaining.filter((l) => {
          const a = l.from.table.toLowerCase();
          const b = l.to.table.toLowerCase();
          return (a === key && joined.has(b)) || (b === key && joined.has(a));
        });
        if (conditions.length === 0) continue;
        for (const c of conditions) {
          remaining.splice(remaining.indexOf(c), 1);
          if (c.join === 'unknown') this.note('Dataset', `the join between ${c.from.table} and ${c.to.table} uses join codes ${c.codes.join(',')}, which are not known; it was written as INNER JOIN, check it`);
          if (c.operator !== '=') this.note('Dataset', `the link between ${c.from.table} and ${c.to.table} uses a link operator (${c.operator}) that is not decoded; "=" was used, check it`);
        }
        // Outer joins, seen from the table being added: which side's rows must be kept.
        const joinKind = (c: (typeof conditions)[number]) => {
          const adding = c.to.table.toLowerCase() === key ? 'to' : 'from';
          if (c.join === 'fullOuter') return 'FULL OUTER JOIN';
          if (c.join === 'leftOuter') return adding === 'to' ? 'LEFT OUTER JOIN' : 'RIGHT OUTER JOIN';
          if (c.join === 'rightOuter') return adding === 'to' ? 'RIGHT OUTER JOIN' : 'LEFT OUTER JOIN';
          return 'INNER JOIN';
        };
        const kinds = [...new Set(conditions.map(joinKind))];
        if (kinds.length > 1) this.note('Dataset', `table ${table.alias} is linked with different join types; ${kinds[0]} was used, check it`);
        const on = conditions.map((c) => `${this.quote(c.from.table)}.${this.quote(c.from.field)} = ${this.quote(c.to.table)}.${this.quote(c.to.field)}`);
        from.push(`${kinds[0]} ${this.tableRef(table)} ON ${on.join(' AND ')}`);
        joined.add(key);
        progress = true;
      }
    }
    for (const table of tables) {
      if (joined.has(table.alias.toLowerCase())) continue;
      from.push(`CROSS JOIN ${this.tableRef(table)}`);
      this.note('Dataset', `table ${table.alias} is not linked to the other tables; it was added as CROSS JOIN, check it`);
    }
    for (const link of remaining) {
      if (!byAlias.has(link.from.table.toLowerCase()) || !byAlias.has(link.to.table.toLowerCase())) continue;
      from.push(`  /* also linked: ${this.quote(link.from.table)}.${this.quote(link.from.field)} = ${this.quote(link.to.table)}.${this.quote(link.to.field)} */`);
      this.note('Dataset', 'the tables are linked in a loop; one link was left as a comment in the query, check it');
    }
    const where = this.whereClause();
    let text = `SELECT\n${select}\n${from.join('\n')}${where ? `\nWHERE ${where.sql}` : ''}`;
    const others = this.othersGroup;
    if (others) {
      // Rank each group by its summary; groups beyond Top N are shown together as "Others".
      const column = `${this.quote(others.column.table)}.${this.quote(others.column.column)}`;
      const columnOf = (f: DatasetField) => `${this.quote(f.table)}.${this.quote(f.column)}`;
      const partition = [...others.outer, others.group].map(columnOf).join(', ');
      const outerPartition = others.outer.length ? `PARTITION BY ${others.outer.map((f) => `q.${this.quote(f.name)}`).join(', ')} ` : '';
      text = `SELECT\n${select},\n  ${others.operation}(${column}) OVER (PARTITION BY ${partition}) AS ${this.quote(others.total)}\n${from.join('\n')}${where ? `\nWHERE ${where.sql}` : ''}`;
      text = `SELECT q.*,\n  DENSE_RANK() OVER (${outerPartition}ORDER BY q.${this.quote(others.total)} ${others.descending ? 'DESC' : 'ASC'}, q.${this.quote(others.group.name)}) AS ${this.quote(others.rank)}\nFROM (\n${text}\n) AS q`;
    }
    return {
      text,
      parameters: where?.parameters ?? [],
      fieldsFromAll: false,
    };
  }

  /** The record selection formula as a SQL WHERE clause, when it translates exactly (direct table access only). */
  private whereClause(): { sql: string; parameters: XmlElement[] } | undefined {
    const { record } = this.definition.selectionFormulas;
    if (!record || this.source.tables.some((t) => t.kind !== 'table')) return undefined;
    const used = new Set<string>();
    const usedRanges = new Set<string>();
    const sql = translateToSql(record, {
      parameterRange: (name) => {
        const range = this.parameterRange(name);
        if (!range) return undefined;
        usedRanges.add(name);
        return { start: `@${range.start}`, end: `@${range.end}` };
      },
      column: (table, field) => {
        const f = this.findField(table, field);
        return f ? `${this.quote(f.table)}.${this.quote(f.column)}` : undefined;
      },
      columnType: (table, field) => this.findField(table, field)?.type,
      parameterType: (name) => this.parameterInfo(name)?.valueType,
      parameterMultiple: (name) => this.parameterInfo(name)?.allowMultiple === true && !this.parameterRange(name),
      parameter: (name) => {
        used.add(name);
        return `@${this.parameterName(name)}`;
      },
    });
    if (!sql) return undefined;
    this.selectionInQuery = true;
    return {
      sql,
      parameters: [
        ...[...used].map((name) => el('QueryParameter', { Name: `@${this.parameterName(name)}` }, el('Value', `=Parameters!${this.parameterName(name)}.Value`))),
        ...[...usedRanges].flatMap((name) => {
          const range = this.parameterRange(name)!;
          return [range.start, range.end].map((n) => el('QueryParameter', { Name: `@${n}` }, el('Value', `=Parameters!${n}.Value`)));
        }),
      ],
    };
  }

  private selectionInQuery = false;

  private selectionFilter(): XmlElement | null {
    const { record } = this.definition.selectionFormulas;
    if (!record || this.selectionInQuery) return null;
    const t = translateFormula(record, this.formulaContext, { codeName: this.codeNames.make('RecordSelection') });
    this.addCode(t);
    for (const issue of t.issues) this.note('Record selection', issue);
    if (t.expression === '=Nothing') return null;
    this.note('Record selection', 'applied as a dataset filter; for large tables, move it into the query WHERE clause');
    return el('Filters', el('Filter',
      el('FilterExpression', t.expression),
      el('Operator', 'Equal'),
      el('FilterValues', el('FilterValue', { DataType: 'Boolean' }, '=True'))));
  }

  // ---- layout classification -------------------------------------------------------------

  /**
   * A Crystal box or line may run on into the sections below its own, where Crystal stretches it over every row
   * printed in between. The section keeps its Crystal height: the object is cut at the section's bottom, and the
   * body layout (bodyItems) draws the rest as a frame around the table or as column borders down it.
   */
  private clipSpanning(section: SectionInfo): SectionInfo {
    const limit = section.height;
    if (limit === undefined) return section;
    const runsOn = (o: ReportObject) => (o.kind === 'box' || o.kind === 'line') && o.size && (o.position?.y ?? 0) + o.size.height > limit;
    if (!section.objects.some(runsOn)) return section;
    return {
      ...section,
      objects: section.objects.map((o) => {
        if (!runsOn(o)) return o;
        // Cut at the section's bottom: a box keeps its top and sides there, not a bottom edge across the next row.
        const border = o.kind === 'box' && o.border
          ? { ...o.border, sides: [o.border.sides[0], o.border.sides[1], o.border.sides[2], 0] as [number, number, number, number] }
          : o.border;
        const clipped = { ...o, border, size: { ...o.size!, height: Math.max(0, limit - (o.position?.y ?? 0)) } };
        this.runOn.set(clipped, o);
        return clipped;
      }),
    };
  }

  /** Where each report-header box or line that runs on below its section ends, in the design (see findSpanEnds). */
  private readonly spanEnds = new Map<ReportObject, { where: 'header' | 'table' | 'footer'; offset: number }>();

  /**
   * Crystal draws a box or line from its own section down through the design's following sections (hidden ones
   * included) to where its height runs out: within the report header, the table's sections, or the footer.
   */
  private findSpanEnds(areas: Omit<ClassifiedAreas, 'unrecognised'>): void {
    this.findGroupSpans(areas);
    const table = [...[...areas.groupHeaders.values()].flat(), ...areas.detail, ...[...areas.groupFooters.values()].flat()];
    const order = [
      ...areas.reportHeader.map((section) => ({ section, where: 'header' as const })),
      ...table.map((section) => ({ section, where: 'table' as const })),
      ...areas.reportFooter.map((section) => ({ section, where: 'footer' as const })),
    ];
    areas.reportHeader.forEach((section) => {
      for (const o of section.objects) {
        if (o.kind !== 'box' && o.kind !== 'line') continue;
        let remaining = (o.position?.y ?? 0) + (o.size?.height ?? 0) - (section.height ?? Infinity);
        if (remaining <= 0) continue;
        // Past the last section it ends with the footer; within the footer, the offset counts from its top.
        let end: { where: 'header' | 'table' | 'footer'; offset: number } = { where: 'footer', offset: Infinity };
        let footerAbove = 0;
        for (const next of order.slice(order.findIndex((e) => e.section === section) + 1)) {
          const height = next.section.height ?? 0;
          if (remaining <= height) { end = { where: next.where, offset: next.where === 'footer' ? footerAbove + remaining : remaining }; break; }
          remaining -= height;
          if (next.where === 'footer') footerAbove += height;
        }
        this.spanEnds.set(o, end);
      }
    });
  }

  /**
   * With parameter values given (parameterValues), suppress formulas that depend only on them are decided now:
   * a section or object they hide is left out (null for a section), and one they show loses the formula.
   */
  private decideFixed(section: SectionInfo): SectionInfo | null {
    if (!this.options.parameterValues) return section;
    const decide = (ref: FormulaRef | undefined) => {
      const text = ref && (this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text);
      return text === undefined ? undefined : fixedCondition(text, this.options.parameterValues!);
    };
    const withoutSuppress = <T extends { conditions?: Record<string, FormulaRef> }>(item: T): T => {
      const { suppress: _, ...rest } = item.conditions ?? {};
      return { ...item, conditions: rest };
    };
    const sectionHidden = decide(section.conditions?.suppress);
    if (sectionHidden === true) {
      this.note(`Section ${section.name}`, 'is hidden for the given parameter values, so it was left out');
      return null;
    }
    let result: SectionInfo = sectionHidden === false ? { ...withoutSuppress(section), suppressed: false } : section;
    const objects = result.objects.flatMap((o) => {
      const hidden = decide(o.conditions?.suppress);
      if (hidden === true) return [];
      return hidden === false ? [{ ...withoutSuppress(o), suppressed: false }] : [o];
    });
    if (objects.length !== result.objects.length || objects.some((o, i) => o !== result.objects[i])) result = { ...result, objects };
    return result;
  }

  /**
   * Page header sections shown on page 1 only ("PageNumber > 1" hides them) and on the other pages only
   * ("PageNumber <= 1" hides them): page 1's sections (with the unconditional ones) and the other pages'.
   */
  /** The font most of the report's text uses (Arial when none is stored): text without a font of its own takes it. */
  private defaultFont(): string {
    const counts = new Map<string, number>();
    for (const area of this.definition.layout) {
      for (const section of area.sections) {
        for (const o of section.objects) if (o.font && (o.kind === 'text' || o.kind === 'field')) counts.set(o.font, (counts.get(o.font) ?? 0) + 1);
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Arial';
  }

  /**
   * The page header section shown on page 1 only, where it is the only conditional one and the sections after it all
   * print on every page with something to show (the column headings); -1 otherwise.
   */
  /**
   * A formula field giving a message only on some rows ("if ... then <text>", with no final else): blank on the others.
   */
  private isBlankMessage(o: ReportObject): boolean {
    if (o.kind !== 'field' || !o.field?.startsWith('@')) return false;
    const formula = this.definition.formulas.find((f) => f.kind === 'formula' && f.name.toLowerCase() === o.field!.slice(1).toLowerCase());
    const text = (formula?.text ?? '').replace(/"[^"]*"|'[^']*'/g, '""').toLowerCase();
    if (!/^\s*if\b/.test(text) || formula?.valueType && !['string', 'memo'].includes(formula.valueType)) return false;
    const thens = (text.match(/\bthen\b/g) ?? []).length;
    const elses = (text.match(/\belse\b/g) ?? []).length;
    return thens > elses;
  }

  private pageOneSection(sections: SectionInfo[]): number {
    const textOf = (s: SectionInfo) => {
      const ref = s.conditions?.suppress;
      const text = ref && (this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text);
      return (text ?? '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase();
    };
    const at = sections.findIndex((s) => /^pagenumber(>1|>=2|<>1)$/.test(textOf(s)));
    if (at < 0) return -1;
    const after = sections.slice(at + 1);
    if (!after.length || after.some((s) => s.conditions?.suppress) || sections.slice(0, at).some((s) => s.conditions?.suppress)) return -1;
    return after.some((s) => s.objects.some((o) => o.kind === 'text' || o.kind === 'field')) ? at : -1;
  }

  private splitFirstPage(sections: SectionInfo[]): { first: SectionInfo[]; later: SectionInfo[] } | null {
    const textOf = (s: SectionInfo) => {
      const ref = s.conditions?.suppress;
      const text = ref && (this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text);
      return (text ?? '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase();
    };
    const firstOnly = (s: SectionInfo) => /^pagenumber(>1|>=2|<>1)$/.test(textOf(s));
    const laterOnly = (s: SectionInfo) => /^pagenumber(<=1|=1|<2)$/.test(textOf(s));
    if (!sections.some(firstOnly)) return null;
    const unconditional = (s: SectionInfo): SectionInfo => {
      const { suppress: _, ...rest } = s.conditions ?? {};
      return { ...s, conditions: rest };
    };
    return {
      first: sections.filter((s) => !laterOnly(s)).map((s) => (firstOnly(s) ? unconditional(s) : s)),
      later: sections.filter((s) => !firstOnly(s)).map((s) => (laterOnly(s) ? unconditional(s) : s)),
    };
  }

  /** Group-header boxes and lines that run on into the table: their group level, and whether they reach its footer. */
  private readonly groupSpans = new Map<ReportObject, { level: number; closes: boolean }>();
  /** Group levels whose footer closes a box framing the group: the table gets a closing row there. */
  private frameFooters = new Set<number>();

  /**
   * A box or line drawn in a group header can run down through the rows of its group (Crystal draws a table's
   * frame and column lines this way): it ends in the design's following sections, hidden ones included.
   */
  private findGroupSpans(areas: Omit<ClassifiedAreas, 'unrecognised'>): void {
    const levels = [...areas.groupHeaders.keys()].sort((a, b) => a - b);
    const design = [
      ...levels.flatMap((level) => (areas.groupHeaders.get(level) ?? []).map((section) => ({ section, kind: 'header', level }))),
      ...areas.detail.map((section) => ({ section, kind: 'detail', level: 0 })),
      ...[...levels].reverse().flatMap((level) => (areas.groupFooters.get(level) ?? []).map((section) => ({ section, kind: 'footer', level }))),
    ];
    design.forEach((entry, i) => {
      if (entry.kind !== 'header') return;
      for (const o of entry.section.objects) {
        if (o.kind !== 'box' && o.kind !== 'line') continue;
        let remaining = (o.position?.y ?? 0) + (o.size?.height ?? 0) - (entry.section.height ?? Infinity);
        if (remaining <= 0) continue;
        // Past the last section it closes the group too.
        let closes = true;
        for (const next of design.slice(i + 1)) {
          const height = next.section.height ?? 0;
          if (remaining <= height) {
            closes = next.kind === 'footer' && next.level <= entry.level;
            break;
          }
          remaining -= height;
        }
        this.groupSpans.set(o, { level: entry.level, closes });
      }
    });
  }

  /** Boxes and lines cut at their section's bottom (see clipSpanning), with the Crystal object they came from. */
  private readonly runOn = new Map<ReportObject, ReportObject>();
  /** Such objects met while placing body sections: drawn by bodyItems once the table's place is known. */
  private spanning: { obj: ReportObject; section: SectionInfo; box: Box; area: string; hidden?: string }[] = [];
  /** Column borders down the table (x in twips): lines and box edges that run on into it. */
  private tableRules: number[] = [];
  /** The width (twips) of the lines running down the table: its cells' borders are drawn as wide. */
  private tableRuleWidth = 20;

  private classify(layout: AreaInfo[]): Classified {
    const { unrecognised, ...areas } = classifyAreas(layout, this.options.subreport);
    for (const area of unrecognised) this.note(`Area "${area.name}"`, 'unrecognised area; its objects were not converted');
    this.findSpanEnds(areas);
    // A section with its Suppress box ticked never prints, unless a suppress formula decides instead; one reading a
    // shared variable (set by a subreport as it prints, which SSRS only approximates) keeps the box's word.
    const shown = (sections: SectionInfo[]) => sections
      .map((s) => this.decideFixed(s))
      .filter((s): s is SectionInfo => s !== null)
      .filter((s) => !s.suppressed || (s.conditions?.suppress && !this.readsShared(s.conditions.suppress)))
      .map((s) => this.clipSpanning(s));
    // Table sections: an object shown only on a condition and laid across a row's other fields gets a row of its own.
    const tableShown = (sections: SectionInfo[]) => shown(sections).flatMap((s) => splitConditionalSpans(s, (o) => this.isBlankMessage(o)));
    const levels = (map: Map<number, SectionInfo[]>) => new Map([...map].map(([level, sections]) => [level, tableShown(sections)]));
    return {
      pageHeader: shown(areas.pageHeader), pageFooter: shown(areas.pageFooter),
      reportHeader: shown(areas.reportHeader), reportFooter: shown(areas.reportFooter),
      detail: tableShown(areas.detail),
      groupHeaders: levels(areas.groupHeaders), groupFooters: levels(areas.groupFooters),
      columnHeadings: [],
    };
  }

  // ---- report ---------------------------------------------------------------------------

  private datasetParts?: { query: ReturnType<RdlBuilder['query']>; filters: XmlElement | null; datasetFields: DatasetField[] };

  /** Builds the query once all report items have marked the fields they use. */
  private finishDataset(): void {
    if (this.datasetParts) return;
    const query = this.query();
    const filters = this.selectionFilter();
    const datasetFields = [...this.fields.values()].filter((f) => f.used || query.fieldsFromAll || ![...this.fields.values()].some((x) => x.used));
    this.datasetParts = { query, filters, datasetFields };
  }

  private datasetElement(dataSourceName: string): XmlElement {
    this.finishDataset();
    const { query, filters, datasetFields } = this.datasetParts!;
    return el('DataSet', { Name: this.dataset },
        el('Query',
          el('DataSourceName', dataSourceName),
          query.parameters.length ? el('QueryParameters', ...query.parameters) : null,
          query.commandType ? el('CommandType', query.commandType) : null,
          el('CommandText', query.text)),
        el('Fields',
          query.noData ? el('Field', { Name: 'NoData' }, el('rd:TypeName', 'System.Int32'), el('DataField', 'NoData')) : null,
          ...datasetFields.map((f) => el('Field', { Name: f.name }, el('rd:TypeName', TYPE_NAMES[f.type] ?? 'System.String'), el('DataField', query.fieldsFromAll ? f.column : f.name))),
          ...[...this.sqlExpressions.values()].map((e) => el('Field', { Name: e.name }, el('rd:TypeName', 'System.Object'), el('DataField', e.name))),
          ...[...this.nextColumns.values()].map((n) => el('Field', { Name: n.name }, el('rd:TypeName', TYPE_NAMES[n.field.type] ?? 'System.Object'), el('DataField', n.name))),
          ...(this.othersGroup && !query.fieldsFromAll ? [
            el('Field', { Name: this.othersGroup.total }, el('rd:TypeName', 'System.Decimal'), el('DataField', this.othersGroup.total)),
            el('Field', { Name: this.othersGroup.rank }, el('rd:TypeName', 'System.Int64'), el('DataField', this.othersGroup.rank)),
          ] : []),
          ...this.calculated.map((c) => el('Field', { Name: c.name }, el('Value', c.expression)))),
        filters);
  }

  /** Every parameter referenced anywhere must exist, including ones only formulas mention. */
  private parameterEntries(): ParameterEntry[] {
    const def = this.definition;
    return [...this.parameterNames.entries()].flatMap(([key, name]) => {
      const p = def.parameters.find((x) => x.name.toLowerCase() === key);
      if (!p) this.note(`Parameter ${name}`, 'is referenced by a formula but has no definition in the report; it was added as a String parameter');
      else if (!p.valueType) this.note(`Parameter ${p.name}`, 'the value type was not decoded; it was set to String');
      const type = PARAMETER_TYPES[p?.valueType ?? 'string'] ?? 'String';
      const prompt = (p?.prompt ?? name).replace(/:\s*$/, '');
      const range = this.rangeNames.get(key);
      if (range) {
        return [
          { name: range.start, type, prompt: `${prompt} (from)`, multiple: false, nullable: p?.nullable ?? false },
          { name: range.end, type, prompt: `${prompt} (to)`, multiple: false, nullable: p?.nullable ?? false },
        ];
      }
      return [{ name, type, prompt: p?.prompt ?? name, multiple: p?.allowMultiple ?? false, nullable: p?.nullable ?? false }];
    });
  }

  /** Fields, groups and parameters: shared by a full build and an inline one. */
  private prepare(): void {
    const def = this.definition;
    this.registerFields();

    // Groups: "Group #n Order" formulas name the field of each group level.
    const orders = def.formulas
      .map((f) => ({ level: Number(/^Group #(\d+) Order$/i.exec(f.name)?.[1] ?? 0), field: f.referencedFields[0] }))
      .filter((g) => g.level > 0 && g.field)
      .sort((a, b) => a.level - b.level);
    const groups = orders.length ? orders.map((g) => g.field) : def.groups;
    for (const [i, field] of groups.entries()) {
      this.groupFields.push(field);
      this.groupNames.push(this.itemNames.make(`Group${i + 1}_${field.split('.').pop()}`));
    }
    // A group named by a formula shows the formula's value as its name.
    for (const named of def.groupNameFormulas ?? []) {
      const level = this.groupFields.findIndex((g) => g.toLowerCase() === named.field.toLowerCase()) + 1;
      const expression = level ? this.formulaExpression(named.formula) : null;
      if (level && expression) this.groupDisplay.set(level, expression);
    }
    for (const p of def.parameters) this.parameterName(p.name);
  }

  /**
   * Shared variables this report sets from its data ("shared StringVar x; x := {Table.Field}"), as expressions
   * reading its dataset's first row: what the variables hold once the report has printed (in a page header, a
   * subreport prints one record).
   */
  private sharedAssignments(): Map<string, string> {
    const out = new Map<string, string | null>();
    for (const formula of this.definition.formulas) {
      const assignment = sharedAssignment(formula.text);
      if (!assignment) continue;
      const t = translateFormula(assignment.value, this.formulaContext);
      if (t.code || t.issues.length || t.expression === '=Nothing') continue;
      const value = scopeOutsideRegion(t.expression.slice(1), this.dataset);
      const known = out.get(assignment.name);
      out.set(assignment.name, known === undefined || known === value ? value : null);
    }
    return new Map([...out].filter((e): e is [string, string] => e[1] !== null));
  }

  /** SSRS refuses page numbers outside the page header and footer: in the body they are left blank. */
  private withoutBodyPageNumbers(xml: string): string {
    const start = xml.indexOf('<Body>');
    const end = xml.indexOf('</Body>');
    if (start < 0 || end < start) return xml;
    const body = xml.slice(start, end);
    const cleaned = body.replace(PAGE_GLOBALS, 'Nothing');
    if (cleaned === body) return xml;
    this.note('Page numbers', 'SSRS shows page numbers only in the page header or footer; those in the body (often inside a subreport) were left blank');
    return xml.slice(0, start) + cleaned + xml.slice(end);
  }

  /** Fills in the shared variables read by formulas: the subreport's value, or the formula's own translation. */
  private resolveShared(xml: string, escape = escapeXml): string {
    return xml.replace(new RegExp(`${SHARED_TOKEN}([a-z0-9_]+)__`, 'g'), (_, variable: string) => {
      const values = this.sharedValues.get(variable) ?? [];
      if (values.length === 1) {
        this.note(`Shared variable ${variable}`, `is set by a subreport placed in the page header; its value there (${values[0]}) is used directly`);
        return escape(`(${values[0]})`);
      }
      if (values.length > 1) {
        // Several subreports set it: in Crystal the last one to run wins. A subreport hidden for this report
        // sets nothing, so the last value that is not empty is used.
        this.note(`Shared variable ${variable}`, `is set by ${values.length} subreports; the last of their values that is not empty is used`);
        const picked = values.reduce((earlier, value) => `IIf(Len(CStr(${value}) & "") > 0, ${value}, ${earlier})`);
        return escape(`(${picked})`);
      }
      return escape(this.sharedFallbacks.get(variable) ?? 'Nothing');
    });
  }

  /** Builds the report as items for a page header/footer of another report: every section, stacked, reading the first row. */
  buildInline(): InlineResult {
    this.prepare();
    const areas = this.classify(this.definition.layout);
    const sections = [
      ...areas.reportHeader, ...areas.pageHeader,
      ...[...areas.groupHeaders.values()].flat(), ...areas.detail, ...[...areas.groupFooters.values()].flat(),
      ...areas.pageFooter, ...areas.reportFooter,
    ].filter((s) => s.objects.length > 0);
    if ([...areas.detail, ...[...areas.groupHeaders.values()].flat()].some((s) => s.objects.length > 0)) {
      this.note('Details', 'a page header/footer shows one record: the first row of the subreport\'s data is used');
    }
    const items: XmlElement[] = [];
    let top = 0;
    for (const section of sections) {
      const placed = this.placeSection(section, top, 'page', 'Subreport');
      items.push(...placed.items);
      top += placed.height;
    }
    let width = 0;
    for (const item of items) width = Math.max(width, itemRight(item));
    const connectionString = this.connectionString();
    const shared = this.sharedAssignments();
    this.finishDataset();
    return {
      shared,
      sharedFallbacks: this.sharedFallbacks,
      items, height: top, width, connectionString,
      dataset: (dataSourceName) => this.datasetElement(dataSourceName),
      parameters: this.parameterEntries(),
      codeFunctions: this.codeFunctions,
      codeMembers: this.codeMembers,
      embeddedImages: this.embeddedImages,
      review: this.review,
    };
  }

  /**
   * Builds the report as a list block: a title, one column per detail object (with its column heading),
   * grand totals from the summaries in the footers, and the report's dataset. Used to lay a report out with a
   * house template; anything else in the report is listed in the review notes.
   */
  buildBlock(): BlockParts {
    const def = this.definition;
    this.prepare();
    const areas = this.classify(def.layout);
    const { headings, headingObjects } = detailColumnHeadings(def, this.options.subreport);
    const placed = new Set<ReportObject>(headingObjects);

    // Columns: the detail fields (and texts with embedded fields), left to right.
    const detailObjects = areas.detail.flatMap((s) => s.objects)
      .filter((o) => !o.suppressed && ((o.kind === 'field' && o.field) || (o.kind === 'text' && o.embeddedFields?.length)))
      .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
    const columns: BlockColumn[] = detailObjects.map((obj, i) => {
      placed.add(obj);
      const { value, format } = this.objectValue(obj, 'row');
      const ref = obj.field ?? '';
      const type = this.formulaContext.fieldType?.(ref);
      const numeric = ['integer', 'number', 'currency'].includes(type ?? '') || (!!format && /^[NCP]\d*$|[#0]/.test(format));
      const base = ref.replace(/^[@?#%]/, '').split('.').pop() || obj.name || 'Column';
      return {
        name: base,
        heading: headings.get(obj) ?? base.replace(/_/g, ' '),
        value, format, numeric,
        // The space up to the next column (Crystal leaves gaps between objects), the object's own width for the last.
        width: Math.max(twipsToInches(i + 1 < detailObjects.length
          ? (detailObjects[i + 1].position?.x ?? 0) - (obj.position?.x ?? 0)
          : obj.size?.width ?? TWIPS_PER_INCH), 0.3),
      };
    });
    for (const obj of detailObjects) if (!headings.has(obj)) this.note(`${obj.kind} object "${obj.name}"`, 'no column heading was found above it; its field name was used as the heading');

    // Totals: summaries in the report footer, then in the group footers (outermost first), under the column they overlap.
    const extent = (o: ReportObject) => ({ left: o.position?.x ?? 0, right: (o.position?.x ?? 0) + (o.size?.width ?? 0) });
    const columnOf = (o: ReportObject) => {
      const e = extent(o);
      let best = -1;
      let bestOverlap = 0;
      detailObjects.forEach((d, i) => {
        const c = extent(d);
        const overlap = Math.min(e.right, c.right) - Math.max(e.left, c.left);
        if (overlap > bestOverlap) {
          best = i;
          bestOverlap = overlap;
        }
      });
      return best;
    };
    const levels = [...areas.groupFooters.keys()].sort((a, b) => a - b);
    const footers: { sections: SectionInfo[]; level?: number }[] = [
      { sections: areas.reportFooter },
      ...levels.map((level) => ({ sections: areas.groupFooters.get(level) ?? [], level })),
    ];
    let totalLabel: string | undefined;
    for (const { sections, level } of footers) {
      for (const section of sections) {
        const summaries = section.objects.filter((o) => !o.suppressed && o.kind === 'field' && o.field && (SUMMARY_NAME.test(o.field) || o.field.startsWith('#')));
        let used = false;
        for (const obj of summaries) {
          const column = columnOf(obj);
          if (column < 0 || columns[column].total) continue;
          const { value, format } = this.objectValue(obj, 'row');
          // At table level a total covers every row: a group scope would not exist there.
          let total = value;
          for (const group of this.groupNames) total = total.split(`, ${vbString(group)})`).join(')');
          columns[column].total = { value: total, format: format ?? columns[column].format };
          placed.add(obj);
          used = true;
          if (level !== undefined && !this.isConstantGroup(this.groupFields[level - 1])) {
            this.note(`${obj.kind} object "${obj.name}"`, `was a subtotal per ${this.groupFields[level - 1]}; the house layout shows it as a grand total`);
          }
        }
        if (used && totalLabel === undefined) {
          const label = section.objects.filter((o) => o.kind === 'text' && !o.embeddedFields?.length && (o.text ?? '').trim())
            .sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0))[0];
          if (label) {
            totalLabel = (label.text ?? '').trim();
            placed.add(label);
          }
        }
      }
    }

    // Title: the largest text in the report header or page header that is not a column heading.
    const titleObject = [...areas.reportHeader, ...areas.pageHeader].flatMap((s) => s.objects)
      .filter((o) => o.kind === 'text' && !o.suppressed && !o.embeddedFields?.length && (o.text ?? '').trim() && !headingObjects.has(o))
      .sort((a, b) => (b.style?.size ?? 0) - (a.style?.size ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0))[0];
    if (titleObject) placed.add(titleObject);

    // Sorting: group fields (groups become a sort order), then the record sorts.
    const sorts = def.sorts ?? def.sortFields.map((field) => ({ field, descending: false, bySummary: false }));
    const order: { expression: string; descending: boolean }[] = [];
    this.groupFields.forEach((field, i) => {
      if (this.isConstantGroup(field)) return;
      const expression = this.fieldObjectValue(field, 'row', `Group ${i + 1}`).expression;
      if (expression === 'Nothing') return;
      const sort = sorts.find((x) => !x.bySummary && x.field.toLowerCase() === field.toLowerCase());
      order.push({ expression: `=${expression}`, descending: sort?.descending ?? false });
      this.note(`Group ${i + 1}`, `the report was grouped by ${field}; the house layout lists the rows sorted by it, without group headers or footers`);
    });
    for (const sort of sorts) {
      if (sort.bySummary || this.groupFields.some((g) => g.toLowerCase() === sort.field.toLowerCase())) continue;
      const expression = this.fieldObjectValue(sort.field, 'row', 'Record sort').expression;
      if (expression !== 'Nothing') order.push({ expression: `=${expression}`, descending: sort.descending });
    }

    // Everything else is not part of the house layout.
    const left: string[] = [];
    for (const area of def.layout) {
      for (const section of area.sections) {
        for (const obj of section.objects) {
          if (placed.has(obj) || obj.suppressed || obj.kind === 'line' || obj.kind === 'box') continue;
          if (obj.kind === 'text' && !(obj.text ?? '').trim() && !obj.embeddedFields?.length) continue;
          left.push(`${obj.kind} "${obj.name}"${obj.kind === 'text' ? ` (${(obj.text ?? '').trim().slice(0, 40)})` : obj.field ? ` (${obj.field})` : ''}`);
        }
      }
    }
    if (left.length) {
      this.note('Layout', `the house layout shows the title, column headings, detail columns and totals; these items were left out (the template's page header and footer replace the report's): ${left.join(', ')}`);
    }

    this.finishDataset();
    // No subreport runs in a house layout's header: shared variables keep their formulas' own translation.
    const resolve = (text: string) => this.resolveShared(text, (t) => t);
    for (const column of columns) {
      column.value = resolve(column.value);
      if (column.total) column.total.value = resolve(column.total.value);
    }
    for (const sort of order) sort.expression = resolve(sort.expression);
    return {
      title: titleObject ? (titleObject.text ?? '').trim().replace(/\s*\n\s*/g, ' ') : undefined,
      totalLabel,
      columns,
      sorts: order,
      datasetName: this.dataset,
      dataset: (dataSourceName) => this.datasetElement(dataSourceName),
      parameters: this.parameterEntries(),
      codeFunctions: this.codeFunctions,
      codeMembers: this.codeMembers,
      review: this.review,
    };
  }

  /** The body: report header sections, the table, report footer sections. */
  private bodyItems(areas: Classified, start = 0): { items: XmlElement[]; height: number } {
    const items: XmlElement[] = [];
    let top = start;
    this.spanning = [];
    for (const section of areas.reportHeader) {
      const placed = this.placeSection(section, top, 'body', 'Report Header');
      items.push(...placed.items);
      top += placed.height;
    }

    // Boxes and lines from the report header that run on past their section: Crystal stretches them down to
    // where they end, over every row printed in between.
    const headerBottom = top;
    const fromHeader = this.spanning.splice(0).map((span) => {
      const original = this.runOn.get(span.obj)!;
      return { ...span, original, end: this.spanEnds.get(original) ?? { where: 'header' as const, offset: 0 } };
    });
    // The widest box ending below the table frames it (and the header and footer items inside it).
    const frame = fromHeader
      .filter((s) => s.original.kind === 'box' && s.end.where === 'footer')
      .sort((a, b) => b.box.width - a.box.width)[0];
    this.tableRules = [];
    this.tableRuleWidth = 20;
    // Boxes ending within the report header that enclose subreports grow with them (as in Crystal).
    const headerLeft = this.growAround(items, fromHeader.filter((s) => s !== frame && s.end.where === 'header'));
    for (const span of fromHeader) {
      if (span === frame) continue;
      if (span.end.where === 'header' && !headerLeft.includes(span)) continue;
      if (span.end.where === 'header') {
        // It ends within the report header, whose sections are stacked as here: drawn down to its end, at most
        // to the header's bottom (hidden sections it crossed are not there).
        const height = Math.min(twipsToInches(span.original.size?.height ?? 0), headerBottom - span.box.top);
        const item = this.reportItem(span.original, 'body', span.area, { ...span.box, height }, span.hidden);
        if (item) items.push(item);
        continue;
      }
      const x = span.original.position?.x ?? 0;
      this.tableRules.push(x);
      this.tableRuleWidth = Math.max(this.tableRuleWidth, span.original.border?.width ?? 20);
      if (span.original.kind === 'box') this.tableRules.push(x + (span.original.size?.width ?? 0));
      const item = this.reportItem(span.obj, 'body', span.area, span.box, span.hidden);
      if (item) items.push(item);
    }

    // Group-header lines and box edges that run down the table become column borders; a box reaching its
    // group's footer also closes the group with a bottom edge.
    this.frameFooters = new Set();
    for (const sections of areas.groupHeaders.values()) {
      for (const section of sections) {
        for (const o of section.objects) {
          const original = this.runOn.get(o);
          const span = original && this.groupSpans.get(original);
          if (!original || !span) continue;
          const x = original.position?.x ?? 0;
          this.tableRules.push(x);
          this.tableRuleWidth = Math.max(this.tableRuleWidth, original.border?.width ?? 20);
          if (original.kind === 'box') {
            this.tableRules.push(x + (original.size?.width ?? 0));
            if (span.closes) this.frameFooters.add(span.level);
          }
        }
      }
    }
    const table = this.buildTablix(areas, top);
    this.tableRules = [];
    this.tableRuleWidth = 20;
    this.frameFooters = new Set();
    if (table.tablix) {
      items.push(table.tablix);
      // Crystal prints the next section straight after the last row.
      top += table.height;
    }
    const footerTop = top;
    this.lastRecord = true;
    let justBroken: string | undefined;
    let owed: string | undefined;
    for (const [i, original] of areas.reportFooter.entries()) {
      // Crystal prints no page after the report's last section: New Page After there breaks no page. Followed only
      // by sections a formula can hide, it breaks none where they are all hidden.
      let section = original;
      let afterOff: string | undefined;
      if (section.newPageAfter || section.conditions?.newPageAfter) {
        const following = areas.reportFooter.slice(i + 1).filter((s) => !s.suppressed && (s.objects.length || s.height));
        if (!following.length) {
          const { newPageAfter: _formula, ...conditions } = section.conditions ?? {};
          section = { ...section, newPageAfter: false, conditions };
        } else if (following.every((s) => s.conditions?.suppress)) {
          const hidden = following.map((s) => this.conditionExpression(s.conditions!.suppress!, false, `Section ${s.name}`, 'body'));
          if (hidden.every(Boolean)) afterOff = hidden.map((h) => `(${h!.slice(1)})`).join(' AndAlso ');
        }
      }
      const placed = this.placeSection(section, top, 'body', 'Report Footer', false, afterOff);
      const printsHere = !section.suppressed && (section.objects.length > 0 || (section.height ?? 0) > 0);
      const own = printsHere && section.conditions?.suppress
        ? this.conditionExpression(section.conditions.suppress, false, `Section ${section.name}`, 'body') : undefined;
      // A page break owed by a hidden section above (see below): this section starts the new page, where it shows.
      if (owed && printsHere && placed.items.length) {
        const off = `Not (${owed})${own ? ` OrElse (${own.slice(1)})` : ''}`;
        items.push(el('Rectangle', { Name: this.itemNames.make(`${section.name || 'Section'}_Owed_Page`) },
          el('ReportItems', ...placed.items.map((item) => moveItem(item, -top, 0))),
          el('PageBreak', el('BreakLocation', 'Start'), el('Disabled', `=${off}`)),
          el('KeepTogether', 'false'),
          el('Top', inches(top)), el('Left', '0in'), el('Height', inches(Math.max(placed.height, MIN_DESIGN_HEIGHT))),
          el('Width', inches(Math.max(...placed.items.map(itemRight), MIN_DESIGN_HEIGHT))),
          el('Style', el('Border', el('Style', 'None')))));
        // Where this section is hidden, the break is still owed to the one after it.
        owed = own && own !== '=True' ? `(${owed}) AndAlso (${own.slice(1)})` : undefined;
      } else {
        items.push(...placed.items);
      }
      // Crystal breaks the page after a section ticked New Page After even where its formula hides it, unless the
      // page was just broken there (no empty page): the next section shown starts a new page.
      const hidden = section.newPageAfter && !section.suppressed && section.conditions?.suppress
        ? this.conditionExpression(section.conditions.suppress, false, `Section ${section.name}`, 'body') : undefined;
      if (hidden && hidden !== '=True' && justBroken !== 'True') {
        const owedHere = [`(${hidden.slice(1)})`, ...(justBroken ? [`Not (${justBroken})`] : [])].join(' AndAlso ');
        owed = owed ? `(${owed}) OrElse (${owedHere})` : owedHere;
      }
      // Whether the page has just been broken here: after a section ticked New Page After (shown or hidden), and
      // still after sections below it that are hidden.
      if (section.newPageAfter && !section.suppressed) justBroken = 'True';
      else if (printsHere) justBroken = own && justBroken ? (justBroken === 'True' ? `(${own.slice(1)})` : `(${own.slice(1)}) AndAlso ${justBroken}`) : undefined;
      top += placed.height;
    }
    this.lastRecord = false;
    // Run-on objects of the report footer have nothing below them: a box around subreports grows with them,
    // anything else is drawn as cut.
    for (const span of this.growAround(items, this.spanning.splice(0))) {
      const item = this.reportItem(span.obj, 'body', span.area, span.box, span.hidden);
      if (item) items.push(item);
    }
    if (!frame) return { items, height: top };

    // The frame: a rectangle with the box's border holding what it encloses, so it grows with the table.
    const frameTop = frame.box.top;
    const frameBottom = Math.max(footerTop + Math.min(twipsToInches(frame.end.offset), top - footerTop), frameTop);
    const left = frame.box.left;
    const right = left + frame.box.width;
    const inside = (item: XmlElement) => {
      const t = itemNumber(item, 'Top');
      const l = itemNumber(item, 'Left');
      return t >= frameTop - 0.01 && t < frameBottom && l >= left - 0.05 && itemRight(item) <= right + 0.05;
    };
    const enclosed = items.filter(inside);
    const rest = items.filter((item) => !inside(item));
    const container = el('Rectangle', { Name: this.itemNames.make(frame.original.name || 'Frame') },
      enclosed.length ? el('ReportItems', ...enclosed.map((item) => moveItem(item, -frameTop, -left))) : null,
      el('KeepTogether', 'false'),
      el('Top', inches(frameTop)), el('Left', inches(left)),
      el('Height', inches(frameBottom - frameTop)), el('Width', inches(frame.box.width)),
      frame.hidden ? el('Visibility', el('Hidden', frame.hidden)) : null,
      el('Style', ...this.borderStyle(frame.original.border)));
    return { items: [container, ...rest], height: Math.max(top, frameBottom) };
  }

  /**
   * A box that runs on below its section around subreports: Crystal stretches it (and the lines along it) as the
   * subreports grow. Here it becomes a rectangle with the box's border holding what it encloses, so it grows with
   * them; a line in it along a subreport's side becomes that side's border. Returns the spans left to draw.
   */
  private growAround<T extends { obj: ReportObject; box: Box; area: string; hidden?: string; section?: SectionInfo }>(items: XmlElement[], spans: T[]): T[] {
    const left: T[] = [];
    const lines = spans.filter((s) => this.runOn.get(s.obj)?.kind === 'line');
    const used = new Set<T>();
    for (const span of spans) {
      const original = this.runOn.get(span.obj);
      if (original?.kind !== 'box') continue;
      const top = span.box.top;
      const l = span.box.left;
      const r = l + span.box.width;
      // The box holds what its own section places; the sections below follow it (Crystal moves them down as the
      // subreports grow, and so does SSRS once they are outside the box rather than drawn inside it).
      const sectionBottom = span.section && span.section.height !== undefined
        ? top - twipsToInches(original.position?.y ?? 0) + twipsToInches(span.section.height)
        : top + twipsToInches(original.size?.height ?? 0);
      const bottom = sectionBottom;
      // Not what a section above it places (a section designed a hair high, a formula can hide, ends just above it).
      const sectionTop = span.section ? top - twipsToInches(original.position?.y ?? 0) : top - 0.01;
      const inside = (item: XmlElement) => {
        const t = itemNumber(item, 'Top');
        return t >= Math.max(top - 0.01, sectionTop - 0.002) && t < bottom && itemNumber(item, 'Left') >= l - 0.05 && itemRight(item) <= r + 0.05;
      };
      const enclosed = items.filter(inside);
      // Only subreports grow; around anything else the cut box is right as it is.
      if (!enclosed.some((item) => item.name === 'Rectangle')) continue;
      used.add(span);
      const kept: XmlElement[] = [];
      let contents = enclosed;
      for (const line of lines) {
        const lineObj = this.runOn.get(line.obj)!;
        // Only a line of this box's own section (one already drawn with a box above it is not drawn again).
        if (used.has(line) || line.box.top < top - 0.01 || line.box.top >= bottom) continue;
        if ((lineObj.size?.width ?? 0) > 30 || line.box.left < l - 0.05 || line.box.left > r + 0.05) continue;
        used.add(line);
        const x = line.box.left;
        const side = contents.find((item) => item.name === 'Rectangle' && Math.abs(itemRight(item) - x) <= 0.06) ? 'RightBorder'
          : contents.find((item) => item.name === 'Rectangle' && Math.abs(itemNumber(item, 'Left') - x) <= 0.06) ? 'LeftBorder' : undefined;
        if (side) {
          contents = contents.map((item) => item.name === 'Rectangle' && Math.abs((side === 'RightBorder' ? itemRight(item) : itemNumber(item, 'Left')) - x) <= 0.06
            ? this.keepContentHeight(item, withBorder(item, side, lineObj.border)) : item);
        } else {
          // A divider over a subreport runs down with it, to the bottom of the subreport it crosses.
          const crossed = contents.filter((item) => item.name === 'Rectangle' && itemNumber(item, 'Left') < x && itemRight(item) > x);
          const reach = Math.max(line.box.top + line.box.height, ...crossed.map((item) => itemNumber(item, 'Top') + (this.contentHeights.get(item) ?? itemNumber(item, 'Height'))));
          const drawn = this.reportItem(line.obj, 'body', line.area, { ...line.box, height: reach - line.box.top }, line.hidden);
          if (drawn) kept.push(drawn);
        }
      }
      const container = el('Rectangle', { Name: this.itemNames.make(original.name || 'Frame') },
        el('ReportItems', ...[...contents, ...kept].map((item) => moveItem(item, -top, -l))),
        el('KeepTogether', 'true'),
        el('Top', inches(top)), el('Left', inches(l)),
        el('Height', inches(bottom - top)), el('Width', inches(span.box.width)),
        span.hidden ? el('Visibility', el('Hidden', span.hidden)) : null,
        el('Style', ...this.borderStyle(original.border)));
      for (const item of enclosed) items.splice(items.indexOf(item), 1);
      items.push(container);
    }
    for (const span of spans) if (!used.has(span)) left.push(span);
    return left;
  }

  /** Builds a subreport as items for the body of another report: its whole body, with its table reading all rows. */
  buildEmbedded(): InlineResult {
    this.prepare();
    const areas = this.classify(this.definition.layout);
    const { items, height } = this.bodyItems(areas);
    let width = 0;
    for (const item of items) width = Math.max(width, itemRight(item));
    const connectionString = this.connectionString();
    const shared = this.sharedAssignments();
    this.finishDataset();
    return {
      shared,
      sharedFallbacks: this.sharedFallbacks,
      items, height, width, connectionString,
      dataset: (dataSourceName) => this.datasetElement(dataSourceName),
      parameters: this.parameterEntries(),
      codeFunctions: this.codeFunctions,
      codeMembers: this.codeMembers,
      embeddedImages: this.embeddedImages,
      review: this.review,
    };
  }

  build(): RdlResult {
    const def = this.definition;
    this.prepare();

    const areas = this.classify(def.layout);
    const detailXs = new Set(this.columnsFor(areas.detail).map((c) => c.x));
    // A page header with a section for page 1 only (a block of figures between the title and the column headings),
    // all else printed on every page: the sections before it stay the page header; it starts the body (printed once,
    // above the table) and those after it become the table's heading rows, whole (rules too), repeated on every page.
    // (SSRS wants a table's heading rows all repeated or none: the block cannot be one of them.)
    const pageOneAt = this.pageOneSection(areas.pageHeader);
    if (pageOneAt >= 0 && areas.detail.some((s) => s.objects.length)) {
      const sections = areas.pageHeader;
      const { suppress: _, ...conditions } = sections[pageOneAt].conditions ?? {};
      areas.reportHeader = [{ ...sections[pageOneAt], conditions }, ...areas.reportHeader];
      // A rule along the top of a heading section is the bottom border of a thin row of its own (a table's top border
      // is drawn half outside it, so thinner than the other rules).
      areas.headingSections = sections.slice(pageOneAt + 1).flatMap((section) => {
        const rule = section.objects.find((o) => o.kind === 'line' && !(o.size?.height) && (o.position?.y ?? 0) <= 60 && (o.size?.width ?? 0) > 0);
        if (!rule) return [{ section, repeat: true }];
        const cut = Math.max((rule.position?.y ?? 0) + Math.ceil((rule.border?.width ?? 20) / 2), 44);
        const ruleRow: SectionInfo = { name: `${section.name}_Rule`, height: cut, objects: [{ ...rule, position: { x: rule.position?.x ?? 0, y: cut } }] };
        const rest: SectionInfo = {
          ...section,
          height: Math.max((section.height ?? cut) - cut, 44),
          objects: section.objects.filter((o) => o !== rule).map((o) => ({ ...o, position: { x: o.position?.x ?? 0, y: Math.max((o.position?.y ?? 0) - cut, 0) } })),
        };
        return [{ section: ruleRow, repeat: true }, { section: rest, repeat: true }];
      });
      areas.pageHeader = sections.slice(0, pageOneAt);
    }
    // Page-header text objects aligned with detail columns are column headings: they go into the table.
    for (const section of areas.headingSections ? [] : areas.pageHeader) {
      const keep: ReportObject[] = [];
      for (const obj of section.objects) {
        const x = obj.position?.x;
        const isHeading = obj.kind === 'text' && x !== undefined && [...detailXs].some((dx) => Math.abs(dx - x) <= 144);
        (isHeading ? areas.columnHeadings : keep).push(obj);
      }
      section.objects = keep;
    }

    const placeAll = (sections: SectionInfo[], label: string, scope: Scope = 'page') => sections.reduce((acc, s) => {
      const placed = this.placeSection(s, acc.height, scope, label, scope === 'body');
      return { items: [...acc.items, ...placed.items], height: acc.height + placed.height };
    }, { items: [] as XmlElement[], height: 0 });
    // A page header with sections for page 1 only and for the other pages: SSRS's page header has one height,
    // so page 1's version goes at the top of the body and the page header skips page 1.
    const pageOne = this.splitFirstPage(areas.pageHeader);
    let header = placeAll(pageOne ? pageOne.later : areas.pageHeader, 'Page Header');
    let firstPage: { items: XmlElement[]; height: number } = { items: [], height: 0 };
    if (pageOne) {
      // SSRS has one page header height, and reserves it on every page. The other pages' header is printed on
      // every page but hidden on page 1; page 1's header items within that height go into the page header too
      // (hidden after page 1), and the rest of it starts the body.
      const later = header.height;
      const first = placeAll(pageOne.first, 'Page Header (page 1)').items.flatMap((item) => flattenRectangle(item));
      const inHeader = first.filter((item) => itemNumber(item, 'Top') < later - 0.005);
      const height = Math.max(later, ...inHeader.map((item) => itemNumber(item, 'Top') + itemNumber(item, 'Height')));
      // The rest starts the body, keeping its spacing (moved up as one, by no more than the header's height).
      const rest = first.filter((item) => !inHeader.includes(item));
      const shift = Math.min(height, ...rest.map((item) => itemNumber(item, 'Top')));
      const inBody = rest.map((item) => moveItem(item, -shift, 0));
      // Items both versions have alike (a logo, a title) are placed once, on every page; only the differences
      // are shown by page number, so no two items are stacked at the same place.
      const laterItems = header.items.flatMap((item) => flattenRectangle(item));
      const sameAs = (a: XmlElement, b: XmlElement) => withoutName(a) === withoutName(b);
      const shared = laterItems.filter((a) => inHeader.some((b) => sameAs(a, b)));
      // Page 1's header is the taller: the other pages' own items sit at the header's foot, so what they draw
      // last (a rule) stays just above the body, as in Crystal.
      const lower = height - later > 0.01 ? height - later : 0;
      // Each version in a rectangle of its own, both from the header's top: SSRS moves an item up where an item above
      // it is hidden, so a page 1 item hidden on the other pages would pull theirs up (a rule onto the text over it).
      const version = (name: string, items: XmlElement[], hiddenWhen: string) => (items.length
        ? [el('Rectangle', { Name: this.itemNames.make(name) },
          el('ReportItems', ...items),
          el('KeepTogether', 'true'),
          el('Top', '0in'), el('Left', '0in'), el('Height', inches(height)),
          el('Width', inches(Math.max(...items.map((item) => itemNumber(item, 'Left') + itemNumber(item, 'Width'))))),
          el('Visibility', el('Hidden', `=${hiddenWhen}`)),
          el('Style', el('Border', el('Style', 'None'))))]
        : []);
      header = {
        items: [
          ...shared,
          ...version('PageHeaderOtherPages', laterItems.filter((a) => !shared.includes(a)).map((item) => (lower ? moveItem(item, lower, 0) : item)), 'Globals!PageNumber = 1'),
          ...version('PageHeaderPage1', inHeader.filter((b) => !shared.some((a) => sameAs(a, b))), 'Globals!PageNumber > 1'),
        ],
        height,
      };
      firstPage = { items: inBody, height: Math.max(0, ...inBody.map((item) => itemNumber(item, 'Top') + itemNumber(item, 'Height'))) };
      this.note('Page header', 'Crystal prints a different page header on page 1: both versions are in the SSRS page header, each shown on its pages; what of page 1\'s does not fit the page header\'s height starts the body of page 1');
    }
    // Page header and footer items that never show (Crystal's suppressed helper fields that set shared
    // variables) are left out: they print nothing, and stacked under visible items they can disturb the layout.
    header = { ...header, items: withoutHidden(header.items) };
    // A thick rule at the header's foot is drawn half below its place: the header holds all of it (SSRS would move a
    // line reaching past the header's edge up, onto what is above it).
    header.height = Math.max(header.height, strokeFoot(header.items));
    const body = this.bodyItems(areas, firstPage.height);
    const bodyItems = [...firstPage.items, ...body.items];
    const top = body.height;
    const footerPlaced = placeAll(areas.pageFooter, 'Page Footer');
    const footer = { ...footerPlaced, items: withoutHidden(footerPlaced.items) };
    footer.height = Math.max(footer.height, strokeFoot(footer.items));

    let width = 0;
    for (const item of [...bodyItems, ...header.items, ...footer.items]) width = Math.max(width, itemRight(item));
    const [paperWidth, paperHeight] = PAPER_SIZES[def.page?.paperSize ?? 1] ?? PAPER_SIZES[1];
    const margins = def.margins
      ? { left: def.margins.left / TWIPS_PER_INCH, right: def.margins.right / TWIPS_PER_INCH, top: def.margins.top / TWIPS_PER_INCH, bottom: def.margins.bottom / TWIPS_PER_INCH }
      : { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN };
    const landscape = def.page ? def.page.orientation === 'landscape' : width > paperWidth - margins.left - margins.right;
    if (!def.page && landscape && !this.options.subreport) this.note('Page', `the layout is ${inches(width)} wide, so the page was set to landscape; check the page setup`);
    if (def.page?.paperSize && !PAPER_SIZES[def.page.paperSize]) this.note('Page', `paper size code ${def.page.paperSize} is not mapped; Letter was used`);
    const pageWidth = landscape ? paperHeight : paperWidth;
    // Crystal prints nothing past the printable width (an object reaching past it is cut off at the edge); SSRS would
    // print the overflow on a page of its own, after every page. Items reaching past the edge are trimmed to it.
    const printable = pageWidth - margins.left - margins.right;
    if (!this.options.subreport && width > printable + 0.001) {
      bodyItems.splice(0, bodyItems.length, ...fitWidth(bodyItems, printable));
      header.items = fitWidth(header.items, printable);
      footer.items = fitWidth(footer.items, printable);
      width = printable;
    }
    bodyItems.splice(0, bodyItems.length, ...fitInside(bodyItems));
    header.items = fitInside(header.items);
    footer.items = fitInside(footer.items);
    if (width > pageWidth - margins.left - margins.right + 0.01 && !this.options.subreport) this.note('Page', `the layout (${inches(width)}) is wider than the printable page; SSRS will add horizontal pages`);
    // A subreport's margins never apply: it prints inside the main report.
    if (!def.margins && !this.options.subreport) this.note('Page', 'the report uses the printer default margins; 0.25in margins were used');

    if (this.options.pageNumber && !this.options.subreport) {
      const usable = pageWidth - margins.left - margins.right;
      const height = 0.2;
      const top = Math.max(footer.height - height, 0);
      footer.items.push(el('Textbox', { Name: this.itemNames.make('PageNumberFooter') },
        el('CanGrow', 'true'), el('KeepTogether', 'true'),
        el('Paragraphs', el('Paragraph',
          el('TextRuns', el('TextRun', el('Value', '="Page " & Globals!PageNumber'), el('Style', el('FontFamily', 'Times New Roman'), el('FontSize', '8pt')))),
          el('Style', el('TextAlign', 'Right')))),
        el('Top', inches(top)), el('Left', inches(Math.max(usable - 1.5, 0))), el('Height', inches(height)), el('Width', inches(1.5)),
        el('Style', el('Border', el('Style', 'None')), el('PaddingLeft', '0pt'), el('PaddingRight', '0pt'), el('PaddingTop', '0pt'), el('PaddingBottom', '0pt'))));
      footer.height = Math.max(footer.height, height);
    }

    if (this.options.sharedDataSource) {
      this.note('Data source', `uses the shared data source "${this.options.sharedDataSource}" on the report server; it must point to the database the Crystal report read`);
    }
    this.finishDataset();
    // Parameters of subreports placed inline are added unless the main report has one of the same name.
    const ownParameters = this.parameterEntries();
    const parameterList = [...ownParameters, ...this.extraParameters.filter((p) => !ownParameters.some((o) => o.name.toLowerCase() === p.name.toLowerCase()))];
    const parameters = parameterList.map(parameterElement);

    const report = el('Report', { MustUnderstand: 'df', xmlns: RDL_NS, 'xmlns:rd': RD_NS, 'xmlns:df': `${RDL_NS}/defaultfontfamily` },
      el('rd:ReportUnitType', 'Inch'),
      el('rd:ReportID', reportId(this.options.reportName)),
      el('df:DefaultFontFamily', this.defaultFont()),
      el('AutoRefresh', '0'),
      // A subreport's rectangle keeps its Crystal height and grows with its table: the space SSRS would keep below
      // it as well (and a blank page at the end) is given up, as Crystal prints the next section straight after.
      el('ConsumeContainerWhitespace', 'true'),
      el('DataSources', this.options.sharedDataSource
        ? el('DataSource', { Name: this.dataSourceName },
          el('DataSourceReference', this.options.sharedDataSource),
          el('rd:SecurityType', 'None'),
          el('rd:DataSourceID', reportId(`${this.options.reportName}/${this.dataSourceName}`)))
        : el('DataSource', { Name: this.dataSourceName },
          el('rd:SecurityType', 'Integrated'),
          el('ConnectionProperties',
            el('DataProvider', 'SQL'),
            el('ConnectString', this.connectionString()),
            el('IntegratedSecurity', 'true')),
          el('rd:DataSourceID', reportId(`${this.options.reportName}/${this.dataSourceName}`))),
        ...this.extraDataSources.map((d) => el('DataSource', { Name: d.name },
          el('rd:SecurityType', 'Integrated'),
          el('ConnectionProperties', el('DataProvider', 'SQL'), el('ConnectString', d.connectionString), el('IntegratedSecurity', 'true')),
          el('rd:DataSourceID', reportId(`${this.options.reportName}/${d.name}`))))),
      el('DataSets', this.datasetElement(this.dataSourceName), ...this.extraDataSets),
      el('ReportSections', el('ReportSection',
        el('Body', el('ReportItems', ...holdPlaces(clearRoundingOverlaps(fitInside(joinBoxes(clearLineOverlaps(bodyItems)))), this.itemNames, this.framed)), el('Height', inches(top > 0 ? top : DEFAULT_HEIGHT)), el('Style')),
        el('Width', inches(Math.max(width, 1))),
        el('Page',
          header.items.length ? el('PageHeader', el('Height', inches(header.height)), el('PrintOnFirstPage', 'true'), el('PrintOnLastPage', 'true'), el('ReportItems', ...ruleBars(clearLineOverlaps(header.items))), el('Style')) : null,
          footer.items.length ? el('PageFooter', el('Height', inches(footer.height)), el('PrintOnFirstPage', 'true'), el('PrintOnLastPage', 'true'), el('ReportItems', ...ruleBars(clearLineOverlaps(footer.items))), el('Style')) : null,
          el('PageHeight', inches(landscape ? paperWidth : paperHeight)),
          el('PageWidth', inches(pageWidth)),
          el('LeftMargin', inches(margins.left)), el('RightMargin', inches(margins.right)),
          el('TopMargin', inches(margins.top)), el('BottomMargin', inches(margins.bottom)),
          el('Style')))),
      parameters.length ? el('ReportParameters', ...parameters) : null,
      parametersLayout(parameterList.map((p) => p.name)),
      this.codeFunctions.length ? el('Code', [
        ...Object.entries(this.codeMembers).map(([name, type]) => `Dim ${name} As ${type}`),
        ...this.codeFunctions,
      ].join('\r\n\r\n')) : null,
      this.embeddedImages.length ? el('EmbeddedImages', ...this.embeddedImages) : null);

    for (const f of def.formulas.filter((f) => f.kind === 'conditionalFormat')) {
      const used = def.layout.some((a) => a.sections.some((s) =>
        Object.values(s.conditions ?? {}).some((c) => c.index === f.index) ||
        s.objects.some((o) => Object.values(o.conditions ?? {}).some((c) => c.index === f.index))));
      if (!used && f.text.replace(/\/\/[^\n]*/g, '').trim()) this.note(`Formula {@${f.name}}`, 'is a formatting formula that no object uses in a decoded property; check whether it is still needed');
    }
    const inlinedOnly = [...this.inlinedSubreports].filter((n) => !this.referencedSubreports.has(n));
    const rdl = this.withoutBodyPageNumbers(this.resolveShared(toXml(report)));
    return { rdl, review: this.review, ...(inlinedOnly.length ? { inlinedOnly } : {}), referenced: [...this.referencedSubreports] };
  }
}

const PAGE_GLOBALS = /Globals!(?:Overall)?(?:PageNumber|TotalPages)\b/g;

const SCOPED_AGGREGATES = ['Sum', 'Count', 'Avg', 'Max', 'Min', 'CountDistinct', 'StDev', 'StDevP', 'Var', 'VarP', 'First', 'Last'];

/**
 * An expression for a place outside any data region (page header/footer, items outside the table): bare
 * field references read the dataset's first row, and aggregates without a scope get the dataset as scope.
 * Text inside string literals is left alone.
 */
export function scopeOutsideRegion(expression: string, dataset: string, record: 'First' | 'Last' = 'First'): string {
  const scopeArg = vbString(dataset);
  let out = '';
  let i = 0;
  const skipString = (from: number) => {
    let j = from + 1;
    while (j < expression.length && !(expression[j] === '"' && expression[j + 1] !== '"')) j += expression[j] === '"' ? 2 : 1;
    return j + 1;
  };
  while (i < expression.length) {
    const c = expression[i];
    if (c === '"') {
      const end = skipString(i);
      out += expression.slice(i, end);
      i = end;
      continue;
    }
    const aggregate = /^([A-Za-z]+)\(/.exec(expression.slice(i));
    if (aggregate && SCOPED_AGGREGATES.includes(aggregate[1]) && (i === 0 || !/[\w.!]/.test(expression[i - 1]))) {
      // Find the matching parenthesis and whether there is a top-level comma (a scope argument).
      let depth = 0;
      let j = i + aggregate[1].length;
      let hasScope = false;
      for (; j < expression.length; j++) {
        const ch = expression[j];
        if (ch === '"') { j = skipString(j) - 1; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
        else if (ch === ',' && depth === 1) hasScope = true;
      }
      const call = expression.slice(i, j);
      out += hasScope ? `${call})` : `${call}, ${scopeArg})`;
      i = j + 1;
      continue;
    }
    const field = /^Fields!\w+\.Value/.exec(expression.slice(i));
    if (field && (i === 0 || !/[\w.!]/.test(expression[i - 1]))) {
      out += `${record}(${field[0]}, ${scopeArg})`;
      i += field[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Replaces Crystal's {?param} in SQL command text with query parameters. Inside a string literal the literal
 * is split around it ('%{?p}%' becomes '%' + @p + '%'), so the value is still used, not the text "@p".
 */
export function substituteCommandParameters(sql: string, parameter: (name: string) => string): string {
  const reference = /\{\?([^}]+)\}/g;
  return sql.replace(/'(?:[^']|'')*'|[^']+/g, (part) => {
    if (!part.startsWith("'") || !reference.test(part)) return part.replace(reference, (_, name: string) => parameter(name));
    reference.lastIndex = 0;
    const inner = part.slice(1, -1);
    const pieces: string[] = [];
    let last = 0;
    for (const m of inner.matchAll(reference)) {
      if (m.index! > last) pieces.push(`'${inner.slice(last, m.index)}'`);
      pieces.push(parameter(m[1]));
      last = m.index! + m[0].length;
    }
    if (last < inner.length) pieces.push(`'${inner.slice(last)}'`);
    return pieces.join(' + ');
  });
}

/** A Crystal custom function: "Function (...)" after any leading comments. */
function isCustomFunction(text: string): boolean {
  // Crystal syntax: "Function (x ...)"; Basic syntax: "Function name (x As ...)".
  return /^\s*Function\s*(\w+\s*)?\(/i.test(text.replace(/^(\s*(\/\/|')[^\n]*\n)+/, ''));
}

/** Crystal writes table aliases with spaces or underscores interchangeably ("Product Type" / "Product_Type"). */
function fieldKey(table: string, column: string): string {
  return `${table.replace(/[ _.]+/g, '_')}.${column}`.toLowerCase();
}

/** MIME type of an image SSRS can embed, from its first bytes. */
export function imageMimeType(data: Uint8Array): string | undefined {
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  return undefined;
}

/** Right edge (inches) of a positioned report item. */
/**
 * The value of a Crystal True/False formula that compares parameters with constants, with the parameters'
 * values filled in (e.g. "{?kind} = 1 or {?kind} = 3"); undefined when it depends on anything else.
 */
export function fixedCondition(text: string, values: Record<string, string>): boolean | undefined {
  // Crystal names some parameters with a leading @ or ?; either way they match the name given.
  const key = (name: string) => name.trim().replace(/^[@?]+/, '').toLowerCase();
  const known = new Map(Object.entries(values).map(([k, v]) => [key(k), v]));
  let unknown = false;
  const source = text
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\{\?(?:pm-\??)?([^}]+)\}/gi, (_, name: string) => {
      const value = known.get(key(name));
      if (value === undefined) { unknown = true; return ' 0 '; }
      return /^-?\d+(\.\d+)?$/.test(value.trim()) ? ` ${value.trim()} ` : ` "${value.replace(/"/g, '""')}" `;
    })
    .trim().replace(/;\s*$/, '');
  if (unknown) return undefined;
  const tokens = source.match(/"(?:[^"]|"")*"|'[^']*'|-?\d+(?:\.\d+)?|<>|<=|>=|[=<>()]|[A-Za-z]+|\S/g) ?? [];
  let pos = 0;
  type Value = number | string | boolean;
  const literal = (t: string): Value | undefined => {
    if (/^-?\d/.test(t)) return Number(t);
    if (t.startsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
    if (t.startsWith("'")) return t.slice(1, -1);
    if (/^true$/i.test(t)) return true;
    if (/^false$/i.test(t)) return false;
    return undefined;
  };
  const compare = (a: Value, op: string, b: Value): boolean | undefined => {
    if (typeof a !== typeof b) return undefined;
    switch (op) {
      case '=': return a === b;
      case '<>': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: return undefined;
    }
  };
  const expr = (): boolean | undefined => {
    let left = term();
    while (pos < tokens.length && /^(or|and)$/i.test(tokens[pos])) {
      const op = tokens[pos++].toLowerCase();
      const right = term();
      if (left === undefined || right === undefined) return undefined;
      left = op === 'or' ? left || right : left && right;
    }
    return left;
  };
  const term = (): boolean | undefined => {
    if (/^not$/i.test(tokens[pos] ?? '')) {
      pos++;
      const v = term();
      return v === undefined ? undefined : !v;
    }
    if (tokens[pos] === '(') {
      pos++;
      const v = expr();
      if (tokens[pos++] !== ')') return undefined;
      return v;
    }
    const a = literal(tokens[pos++] ?? '');
    if (a === undefined) return undefined;
    if (!/^(=|<>|<|>|<=|>=)$/.test(tokens[pos] ?? '')) return typeof a === 'boolean' ? a : undefined;
    const op = tokens[pos++];
    const b = literal(tokens[pos++] ?? '');
    return b === undefined ? undefined : compare(a, op, b);
  };
  const result = expr();
  return pos === tokens.length ? result : undefined;
}

/** A report item's Top, Left, Width or Height in inches. */
/**
 * Thick horizontal lines of a page header or footer as bars: a rectangle filled in the line's colour over the band
 * the line covers. SSRS would draw the line's stroke elsewhere where it reaches the header's foot (onto the text
 * above it); a rectangle is drawn just where it is placed.
 */
function ruleBars(items: XmlElement[]): XmlElement[] {
  return items.map((item) => {
    if (item.name === 'Rectangle') {
      const inner = child(item, 'ReportItems');
      if (!inner) return item;
      return { ...item, children: item.children.map((c) => (c === inner ? { ...inner, children: ruleBars(childElements(inner)) } : c)) };
    }
    if (item.name !== 'Line' || itemNumber(item, 'Height') !== 0) return item;
    const border = child(item, 'Style/Border');
    const width = parseFloat(textOf(child(border, 'Width'))) || 1;
    if (width < 2 || /^(none|dotted|dashed)$/i.test(textOf(child(border, 'Style')))) return item;
    const half = width / 144;
    return el('Rectangle', { Name: item.attributes.Name },
      el('KeepTogether', 'true'),
      el('Top', inches(Math.max(0, itemNumber(item, 'Top') - half))), el('Left', inches(itemNumber(item, 'Left'))),
      el('Height', inches(half * 2)), el('Width', inches(itemNumber(item, 'Width'))),
      child(item, 'Visibility') ?? null,
      el('Style', el('Border', el('Style', 'None')), el('BackgroundColor', textOf(child(border, 'Color')) || 'Black')));
  });
}

/** Whether a section is set to be suppressed where blank (Crystal's Section Expert; the sixteenth byte of its flags). */
function suppressedWhenBlank(section: SectionInfo): boolean {
  return section.formatFlags?.slice(32, 34) === '01';
}

/** How far down the items' horizontal lines are drawn, half their width below their place (0 where none is). */
function strokeFoot(items: XmlElement[], top = 0): number {
  let foot = 0;
  for (const item of items) {
    const at = top + itemNumber(item, 'Top');
    if (item.name === 'Rectangle') foot = Math.max(foot, strokeFoot(childElements(child(item, 'ReportItems') ?? el('ReportItems')), at));
    if (item.name !== 'Line' || itemNumber(item, 'Height') !== 0) continue;
    const width = parseFloat(textOf(child(item, 'Style/Border/Width'))) || 1;
    // A hair more than half the width: positions are written to a thousandth of an inch.
    foot = Math.max(foot, Math.ceil((at + width / 144 + 0.002) * 1000) / 1000);
  }
  return foot;
}

function itemNumber(item: XmlElement, name: string): number {
  const child = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === name);
  return child ? parseFloat(String(child.children[0])) : 0;
}

/** A copy of a report item with a solid border on one side (a Crystal line drawn along it). */
function withBorder(item: XmlElement, side: 'LeftBorder' | 'RightBorder', border: BorderInfo | undefined): XmlElement {
  const edge = el(side,
    el('Color', border?.color ?? 'Black'),
    el('Style', 'Solid'),
    el('Width', `${Math.max(0.25, (border?.width ?? 20) / 20).toFixed(2)}pt`));
  const hasStyle = item.children.some((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Style');
  return {
    ...item,
    children: hasStyle
      ? item.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'Style' ? { ...(c as XmlElement), children: [...(c as XmlElement).children, edge] } : c))
      : [...item.children, el('Style', edge)],
  };
}

/** The item as XML without its name (for finding identical items). */
function withoutName(item: XmlElement): string {
  return toXml({ ...item, attributes: {} });
}

/** Items (and items inside rectangles) without those hidden for good ("=True"). */
function withoutHidden(items: XmlElement[]): XmlElement[] {
  const hiddenForGood = (item: XmlElement) => item.children.some((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility'
    && (c as XmlElement).children.some((h) => typeof h === 'object' && h !== null && (h as XmlElement).name === 'Hidden' && /^=?true$/i.test(String((h as XmlElement).children[0] ?? ''))));
  return items.filter((item) => !hiddenForGood(item)).map((item) => (item.name !== 'Rectangle' ? item : {
    ...item,
    children: item.children.flatMap((c) => {
      if (typeof c !== 'object' || c === null || (c as XmlElement).name !== 'ReportItems') return [c];
      const kept = withoutHidden((c as XmlElement).children.filter((x): x is XmlElement => typeof x === 'object' && x !== null));
      return kept.length ? [{ ...(c as XmlElement), children: kept }] : [];
    }),
  }));
}

/** A copy of a report item hidden when the expression (without "=") is true, besides when it already was. */
function hideWhen(item: XmlElement, expression: string): XmlElement {
  const visibility = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility');
  const current = visibility?.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Hidden');
  const value = current ? String(current.children[0] ?? '') : '';
  const hidden = !value || /^false$/i.test(value) ? `=${expression}`
    : /^=?true$/i.test(value) ? '=True'
    : `=(${value.replace(/^=/, '')}) OrElse (${expression})`;
  const element = el('Visibility', el('Hidden', hidden));
  if (visibility) return { ...item, children: item.children.map((c) => (c === visibility ? element : c)) };
  // Visibility goes right after the item's Width, as the schema orders them.
  const width = item.children.findIndex((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Width');
  const children = [...item.children];
  children.splice(width < 0 ? children.length : width + 1, 0, element);
  return { ...item, children };
}

/**
 * The items of a plain rectangle (no border, background or visibility of its own) at their places on the page;
 * any other item as it is.
 */
/**
 * Text in a box tall enough for several lines, where runs of spaces push the next words on to a new line: Crystal
 * drops spaces where it wraps a line, SSRS keeps them (centred text then shifts aside, and a run can fill a line
 * of its own). Such a run becomes a line break, and lines lose their trailing spaces.
 */
/**
 * Text of several lines laid out with spaces: no alignment of its own (or left), its lines pushed apart by runs of
 * spaces (its first line indented by them, or two runs or more). Crystal drops the spaces where it wraps, so each line shows centred.
 */
function paddedCentred(obj: ReportObject): boolean {
  if (obj.kind !== 'text' || (obj.align && obj.align !== 'left') || !obj.size) return false;
  const text = (obj.runs ?? [{ text: obj.text ?? '' }]).map((r) => ('text' in r ? r.text : 'x')).join('').replace(/[\t\u00a0\u2000-\u200a\u202f\u3000]/g, ' ');
  const lineHeight = (obj.style?.size ?? 10) * 20 * 1.2;
  const runs = (text.trim().match(/\S {3,}(?=\S)/g) ?? []).length;
  return obj.size.height >= lineHeight * 1.8 && runs > 0 && (/^ {2,}\S/.test(text) || runs >= 2);
}

/**
 * A text or field shown only on a condition (a "no activity" message) and laid across two or more of its line's
 * other fields: in a table it would join their cells into one, where SSRS slides the items beside a hidden one
 * into its place. It gets a row of its own just after the section's, shown on the same condition. A section with
 * a suppress condition of its own is left as it is.
 */
function splitConditionalSpans(section: SectionInfo, blankMessage: (o: ReportObject) => boolean = () => false): SectionInfo[] {
  if (section.conditions?.suppress) return [section];
  const cells = section.objects.filter((o) => o.kind === 'field' || o.kind === 'text');
  const left = (o: ReportObject) => o.position?.x ?? 0;
  const top = (o: ReportObject) => o.position?.y ?? 0;
  const sameLine = (a: ReportObject, b: ReportObject) => top(a) < top(b) + (b.size?.height ?? 0) && top(b) < top(a) + (a.size?.height ?? 0);
  // Shown on a condition: a suppress formula, or a message formula that is blank but where it applies.
  const spanning = cells.filter((o) => (o.conditions?.suppress || blankMessage(o)) && !o.suppressed
    && cells.filter((q) => q !== o && sameLine(o, q) && left(q) > left(o) + 144 && left(q) < left(o) + (o.size?.width ?? 0)).length >= 2);
  if (!spanning.length || spanning.length === cells.length) return [section];
  const rest: SectionInfo = { ...section, objects: section.objects.filter((o) => !spanning.includes(o)) };
  const messages = spanning.filter((o) => !o.conditions?.suppress);
  if (messages.length) messageRows.set(rest, messages);
  return [
    rest,
    ...spanning.map((o, i) => {
      const { suppress, ...rest } = o.conditions ?? {};
      const row = messageSection({
        name: `${section.name}_Shown${i + 1}`,
        height: o.size?.height ?? MIN_ROW_HEIGHT * 1440,
        ...(suppress ? { conditions: { suppress } } : {}),
        objects: [{ ...o, position: { x: left(o), y: 0 }, conditions: Object.keys(rest).length ? rest : undefined }],
      });
      if (!suppress) blankRows.add(row);
      return row;
    }),
  ];
}

/** Rows made by splitConditionalSpans for a message formula: hidden where the message is blank. */
const blankRows = new WeakSet<SectionInfo>();
/** The row a message was laid over, and the message: Crystal prints the message on that row's line. */
const messageRows = new WeakMap<SectionInfo, ReportObject[]>();

/** Rows made by splitConditionalSpans: their message spans the columns, so it does not decide where they are. */
const messageSections = new WeakSet<SectionInfo>();
const messageSection = (section: SectionInfo) => (messageSections.add(section), section);

/** Crystal's default tab stops, in twips (every quarter inch from the text's left edge). */
const TAB_STOP = 360;

/**
 * A plain text whose lines all start with tabs: the text without its common leading tabs, and the indent they
 * make (the tab stop they reach). Otherwise the text as it is and no indent.
 */
function tabIndent(obj: ReportObject): { text: string; indent: number } {
  const text = obj.text ?? '';
  if (obj.kind !== 'text' || obj.embeddedFields?.length || !text.startsWith('\t')) return { text, indent: 0 };
  const lines = text.split('\n');
  const tabs = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\t*/.exec(l)![0].length));
  if (!tabs) return { text, indent: 0 };
  return { text: lines.map((l) => (l.trim() ? l.slice(tabs) : l)).join('\n'), indent: tabs * TAB_STOP };
}

function wrapSpaces(text: string, obj: ReportObject, part = false, align = obj.align, ends: { start: boolean; end: boolean } = { start: !part, end: !part }): string {
  const lineHeight = (obj.style?.size ?? 10) * 20 * 1.2;
  if (!obj.size || obj.size.height < lineHeight * 1.8) return text.replace(/\u00a0/g, ' ');
  const centred = align === 'center' || align === 'right';
  // Line ends of any kind (a lone carriage return too), tabs and wide or non-breaking spaces (SSRS keeps those
  // together on one line).
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\t\u00a0\u2000-\u200a\u202f\u3000]/g, ' ').replace(/[\u200b\ufeff]/g, '')
    .split('\n')
    // Crystal drops the spaces where it wraps a line: spaces at a line's end are dropped (they would add a blank
    // line), and so are those starting a centred line (they would push it aside); a run of spaces between words
    // pushed the next words on to a new line. A piece between embedded fields keeps the spaces at its own ends,
    // where it meets a field.
    .map((line, i, all) => {
      let out = line;
      if (i < all.length - 1 || ends.end) out = out.replace(/\s+$/, '');
      if (centred && (i > 0 || ends.start)) out = out.replace(/^\s+/, '');
      return out.replace(/(\S) {3,}(?=\S)/g, '$1\n');
    });
  const joined = lines.join('\n');
  return part && !ends.end ? joined : joined.replace(/\n+$/, '');
}

/**
 * A text object's paragraphs with their own alignments, where they differ (Crystal aligns each paragraph on its
 * own): each paragraph's lines (as wrapSpaces gives them) and alignment. Undefined for one alignment throughout,
 * or text with embedded fields.
 */
function textParagraphs(obj: ReportObject): { lines: string[]; align?: ReportObject['align'] }[] | undefined {
  if (obj.kind !== 'text' || obj.embeddedFields?.length || !obj.paragraphAligns || obj.paragraphAligns.length < 2) return undefined;
  const parts = tabIndent(obj).text.split('\n');
  if (parts.length !== obj.paragraphAligns.length) return undefined;
  const aligns = obj.paragraphAligns.map((a) => a ?? obj.align);
  if (aligns.every((a) => (a ?? 'left') === (aligns[0] ?? 'left'))) return undefined;
  // Empty paragraphs at the end add nothing to see (as a single paragraph's trailing line breaks are dropped).
  let end = parts.length;
  while (end > 1 && !parts[end - 1].trim()) end--;
  return parts.slice(0, end).map((text, i) => ({ align: aligns[i], lines: wrapSpaces(text, obj, false, aligns[i]).split('\n') }));
}

/**
 * A text object of lines broken by hand, more than its height shows: Crystal prints only the lines that fit (a
 * text object does not grow by itself), where SSRS would grow it to show them all.
 */
function clippedText(obj: ReportObject): ReportObject {
  if (obj.kind !== 'text' || obj.embeddedFields?.length || obj.runs?.some((r) => 'field' in r) || !obj.size) return obj;
  const text = obj.runs ? obj.runs.map((r) => ('text' in r ? r.text : '')).join('') : obj.text ?? '';
  const parts = text.replace(/\n+$/, '').split('\n');
  // A line is the font's size and a seventh again (11pt: 253 twips); one shown at least half is counted.
  const line = (obj.style?.size ?? 10) * 20 * 1.15;
  const fit = Math.max(1, Math.floor((obj.size.height + line / 2) / line));
  if (parts.length <= fit) return obj;
  const kept = parts.slice(0, fit).join('\n');
  return { ...obj, text: kept, ...(obj.runs ? { runs: [{ text: kept }] } : {}),
    ...(obj.paragraphAligns ? { paragraphAligns: obj.paragraphAligns.slice(0, fit) } : {}) };
}

function flattenRectangle(item: XmlElement): XmlElement[] {
  if (item.name !== 'Rectangle') return [item];
  const style = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Style');
  const plain = !style || !toXml(style).match(/<(Top|Bottom|Left|Right)?Border>\s*(<Color>[^<]*<\/Color>\s*)?<Style>(Solid|Dashed|Dotted|Double)|BackgroundColor/);
  const visible = !item.children.some((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility');
  const contents = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'ReportItems');
  if (!plain || !visible || !contents) return [item];
  const top = itemNumber(item, 'Top');
  const left = itemNumber(item, 'Left');
  return contents.children
    .filter((c): c is XmlElement => typeof c === 'object' && c !== null)
    .flatMap((c) => flattenRectangle(moveItem(c, top, left)));
}

/** A copy of a report item moved by the given offsets (inches). */
/**
 * A text box whose foot reaches just past a line drawn across under it (Crystal draws a rule straight under a
 * title, overlapping it by a few twips) ends at the line: SSRS moves or drops items that overlap, and the rule
 * would be lost.
 */
/**
 * An item a formula can hide, with items beside it to its right, gets an empty rectangle as wide as it at its top,
 * a hair high (taking up no room down the page), shown where the item is hidden: SSRS moves the items to the right of
 * a hidden item into its room, where Crystal leaves the room empty.
 */
function holdPlaces(items: XmlElement[], names: { make(name: string): string }, framed: Set<string> = new Set()): XmlElement[] {
  const hiddenBy = (item: XmlElement) => {
    const visibility = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility');
    const hidden = visibility?.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Hidden');
    const expression = String(hidden?.children[0] ?? '');
    return expression.startsWith('=') ? expression : undefined;
  };
  const out: XmlElement[] = [];
  for (let item of items) {
    // A section's page rectangle: the same within it.
    if (item.name === 'Rectangle' && /_Page$/.test(item.attributes.Name ?? '')) {
      item = { ...item, children: item.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'ReportItems'
        ? { ...(c as XmlElement), children: holdPlaces((c as XmlElement).children.filter((x): x is XmlElement => typeof x === 'object' && x !== null), names, framed) } : c)) };
    }
    const top = itemNumber(item, 'Top');
    const bottom = top + itemNumber(item, 'Height');
    const right = itemRight(item);
    // A framed subreport and its frame: one of them shows wherever their section does.
    const hidden = framed.has(item.attributes.Name ?? '') ? undefined : hiddenBy(item);
    const beside = !!hidden && items.some((other) => other !== item && itemNumber(other, 'Left') >= right - 0.01
      && itemNumber(other, 'Top') < bottom && itemNumber(other, 'Top') + itemNumber(other, 'Height') > top);
    if (beside) {
      out.push(el('Rectangle', { Name: names.make(`${item.attributes.Name ?? 'Item'}_Place`) },
        el('KeepTogether', 'true'),
        el('Top', inches(top)), el('Left', inches(itemNumber(item, 'Left'))), el('Height', inches(MIN_DESIGN_HEIGHT)),
        el('Width', inches(right - itemNumber(item, 'Left'))),
        // Only where the item is hidden: over a shown item it would cover its border.
        el('Visibility', el('Hidden', `=Not (${hidden!.slice(1)})`)),
        el('Style', el('Border', el('Style', 'None')))));
    }
    out.push(item);
  }
  return out;
}

/**
 * Items that start a rounding step (up to 0.002in) above the bottom of an item above them start at its bottom
 * instead: SSRS keeps an item that overlaps the one above it at its place beside that one (it is not pushed down
 * when the one above grows or moves to a new page), so rows meant to follow each other would be drawn over each other.
 */
function clearRoundingOverlaps(items: XmlElement[]): XmlElement[] {
  const out = [...items];
  const order = out.map((item, i) => i).sort((a, b) => itemNumber(out[a], 'Top') - itemNumber(out[b], 'Top'));
  for (const [n, i] of order.entries()) {
    const top = itemNumber(out[i], 'Top');
    let push = 0;
    for (const j of order.slice(0, n)) {
      const above = out[j];
      const bottom = itemNumber(above, 'Top') + itemNumber(above, 'Height');
      if (itemNumber(above, 'Top') < top && bottom > top && bottom - top <= 0.002 + 1e-9) push = Math.max(push, bottom - top);
    }
    if (push > 0) out[i] = moveItem(out[i], push, 0);
  }
  return out;
}

function clearLineOverlaps(items: XmlElement[]): XmlElement[] {
  // A line across a box that sticks out past its side by a hair (Crystal draws it a few twips too wide) is cut
  // to the box: SSRS moves an item that sticks out of a rectangle it overlaps, and the line would land elsewhere.
  const boxes = items.filter((i) => i.name === 'Rectangle');
  items = items.map((item) => {
    if (item.name !== 'Line' || itemNumber(item, 'Height') !== 0) return item;
    const top = itemNumber(item, 'Top');
    let left = itemNumber(item, 'Left');
    let right = left + itemNumber(item, 'Width');
    for (const b of boxes) {
      const bTop = itemNumber(b, 'Top');
      const bLeft = itemNumber(b, 'Left');
      const bRight = bLeft + itemNumber(b, 'Width');
      if (top < bTop || top > bTop + itemNumber(b, 'Height') || right <= bLeft || left >= bRight) continue;
      if (left < bLeft && bLeft - left <= 0.05) left = bLeft;
      if (right > bRight && right - bRight <= 0.05) right = bRight;
    }
    if (left === itemNumber(item, 'Left') && right === left + itemNumber(item, 'Width')) return item;
    return { ...item, children: item.children.map((c) => {
      if (typeof c !== 'object' || c === null) return c;
      const e = c as XmlElement;
      if (e.name === 'Left') return el('Left', inches(left));
      if (e.name === 'Width') return el('Width', inches(Math.max(right - left, 0.01)));
      return e;
    }) };
  });
  const rules = items.filter((i) => i.name === 'Line' && itemNumber(i, 'Height') === 0);
  const absorbed = new Set<XmlElement>();
  return items.map((item) => {
    if (item.name === 'Rectangle') {
      return { ...item, children: item.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'ReportItems'
        ? { ...(c as XmlElement), children: clearLineOverlaps((c as XmlElement).children.filter((x): x is XmlElement => typeof x === 'object' && x !== null)) }
        : c)) };
    }
    if (item.name !== 'Textbox') return item;
    const top = itemNumber(item, 'Top');
    const height = itemNumber(item, 'Height');
    const left = itemNumber(item, 'Left');
    const right = left + itemNumber(item, 'Width');
    const rule = rules
      .map((r) => ({ r, y: itemNumber(r, 'Top'), left: itemNumber(r, 'Left'), right: itemNumber(r, 'Left') + itemNumber(r, 'Width') }))
      .filter((r) => r.y > top + height * 0.6 && r.y < top + height + 0.02 && r.left < right && r.right > left)
      .sort((a, b) => a.y - b.y)[0];
    if (!rule) return item;
    const set = (children: XmlChild[], name: string, value: XmlElement) => children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === name ? value : c));
    let children = set(item.children, 'Height', el('Height', inches(Math.max(rule.y - top, 0.01))));
    // A rule along the whole foot of a text box (a title's underline) becomes the text box's bottom border: drawn
    // with the text box wherever it ends up, it cannot be lost.
    const hidden = item.children.some((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility');
    if (!hidden && Math.abs(rule.left - left) <= 0.15 && Math.abs(rule.right - right) <= 0.15) {
      absorbed.add(rule.r);
      const ruleBorder = child(child(rule.r, 'Style') ?? el('Style'), 'Border');
      const newLeft = Math.min(left, rule.left);
      children = set(set(children, 'Left', el('Left', inches(newLeft))), 'Width', el('Width', inches(Math.max(right, rule.right) - newLeft)));
      // The text stays where it was: the box grows by padding on the side it was widened.
      const padLeft = (left - newLeft) * 72;
      const padRight = (Math.max(right, rule.right) - right) * 72;
      const pad = (e: XmlChild, name: string, extra: number) => (typeof e === 'object' && e !== null && (e as XmlElement).name === name
        ? el(name, `${(parseFloat(String((e as XmlElement).children[0])) + extra).toFixed(1)}pt`) : e);
      children = children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'Style'
        ? { ...(c as XmlElement), children: [...(c as XmlElement).children.map((e) => pad(pad(e, 'PaddingLeft', padLeft), 'PaddingRight', padRight)), el('BottomBorder', ...(ruleBorder?.children ?? [el('Style', 'Solid')]))] }
        : c));
    }
    return { ...item, children };
  }).filter((item) => !absorbed.has(item));
}

/**
 * Framed rectangles a hair apart (subreports Crystal places side by side or one under another, each with its own
 * border): Crystal's print shows one line between them; SSRS would draw two lines a few hundredths of an inch
 * apart, reading as one thick line. The second box moves up to the first and leaves that side to it.
 */
/**
 * An empty text ending at a rectangle's foot: SSRS keeps a rectangle down to its last item that shows, so items hidden
 * at its foot (a chart without data) would otherwise take its height with them. (A line without a border is not
 * counted; an empty text is.)
 */
function footMark(name: string, foot: number): XmlElement {
  return el('Textbox', { Name: name },
    el('CanGrow', 'false'), el('KeepTogether', 'true'),
    el('Paragraphs', el('Paragraph', el('TextRuns', el('TextRun', el('Value'), el('Style'))), el('Style'))),
    el('Top', inches(Math.max(0, foot - 0.02))), el('Left', '0in'), el('Height', '0.01in'), el('Width', '0.01in'),
    el('Style', el('Border', el('Style', 'None'))));
}

/** Whether a formula can hide an item. */
function canHide(item: XmlElement): boolean {
  const visibility = child(item, 'Visibility');
  const hidden = visibility && child(visibility, 'Hidden');
  return !!hidden && hidden.children.join('').startsWith('=');
}

function joinBoxes(input: XmlElement[]): XmlElement[] {
  const framed = (i: XmlElement) => {
    if (i.name !== 'Rectangle') return false;
    const style = child(i, 'Style');
    const border = style && child(style, 'Border');
    return !!border && child(border, 'Style')?.children.join('') === 'Solid' && !childNames(style).some((n) => /^(Top|Bottom|Left|Right)Border$/.test(n));
  };
  // Boxes held in a rectangle of their own (a section starting a new page) are joined there first.
  const items = input.map((item) => (item.name === 'Rectangle' && !framed(item)
    ? { ...item, children: item.children.map((e) => (typeof e === 'object' && e !== null && (e as XmlElement).name === 'ReportItems'
      ? { ...(e as XmlElement), children: joinBoxes((e as XmlElement).children.filter((x): x is XmlElement => typeof x === 'object' && x !== null)) }
      : e)) }
    : item));
  const boxes = items.filter(framed);
  const pos = (i: XmlElement) => ({ top: itemNumber(i, 'Top'), left: itemNumber(i, 'Left'), bottom: itemNumber(i, 'Top') + itemNumber(i, 'Height'), right: itemRight(i) });
  const changes = new Map<XmlElement, { top?: number; left?: number; right?: number; sides: string[] }>();
  // Boxes held in a rectangle of their own (a section starting a new page), where they are on the page: the boxes
  // below them join them too.
  // Matched by where they were drawn, lined up with where they are now (joined to each other).
  const held = input.flatMap((r, index) => {
    if (r.name !== 'Rectangle' || framed(r)) return [];
    const children = (e: XmlElement) => (child(e, 'ReportItems')?.children ?? []).filter((x): x is XmlElement => typeof x === 'object' && x !== null);
    const before = children(r);
    const after = children(items[index]);
    const dy = itemNumber(r, 'Top');
    const dx = itemNumber(r, 'Left');
    const shifted = (p: { top: number; bottom: number; left: number; right: number }) => ({ top: p.top + dy, bottom: p.bottom + dy, left: p.left + dx, right: p.right + dx });
    return before.flatMap((i, k) => (framed(i) && after[k] ? [{ item: after[k], p: shifted(pos(i)), final: shifted(pos(after[k])), held: true }] : []));
  });
  for (const b of boxes) {
    const pb = pos(b);
    for (const { item: a, p: pa, final, held: inside } of [...boxes.map((item) => ({ item, p: pos(item), final: pos(item), held: false })), ...held]) {
      if (a === b) continue;
      // A box a formula can hide may not draw the side they share: the other meets it but keeps its own border.
      const own = canHide(a);
      const gapX = pb.left - pa.right;
      // Side by side: a row of boxes alike in height (a grid of panels).
      if (!inside && gapX > 0 && gapX <= 0.1 && Math.abs(pa.top - pb.top) <= 0.05 && Math.abs((pa.bottom - pa.top) - (pb.bottom - pb.top)) <= 0.05) {
        const c = changes.get(b) ?? { sides: [] };
        changes.set(b, { ...c, left: c.right !== undefined ? c.left : pa.right, sides: own ? c.sides : [...c.sides, 'LeftBorder'] });
      }
      const gapY = pb.top - pa.bottom;
      const overlap = Math.min(pa.right, pb.right) - Math.max(pa.left, pb.left);
      // Something placed between them (a table that grows) keeps them apart: the lower box follows it.
      const between = !inside && items.some((o) => o !== a && o !== b && itemNumber(o, 'Top') >= pa.bottom - 0.001 && itemNumber(o, 'Top') < pb.top
        && itemNumber(o, 'Left') < pb.right && itemRight(o) > pb.left);
      // One under another: alike in place and width.
      if (!between && gapY > 0 && gapY <= 0.1 && Math.abs(pa.left - pb.left) <= 0.05 && Math.abs((pa.right - pa.left) - (pb.right - pb.left)) <= 0.1 && overlap > 0) {
        // It also takes the upper box's sides, so the lines between columns run straight on.
        const c = changes.get(b) ?? { sides: [] };
        changes.set(b, { ...c, top: final.bottom, left: final.left, right: final.right, sides: own ? c.sides : [...c.sides, 'TopBorder'] });
      }
    }
  }
  return items.map((item) => {
    const c = changes.get(item);
    if (!c) return item;
    const p = pos(item);
    return { ...item, children: item.children.map((e) => {
      if (typeof e !== 'object' || e === null) return e;
      const x = e as XmlElement;
      if (x.name === 'Top' && c.top !== undefined) return el('Top', inches(c.top));
      if (x.name === 'Height' && c.top !== undefined) return el('Height', inches(p.bottom - c.top));
      if (x.name === 'Left' && c.left !== undefined) return el('Left', inches(c.left));
      if (x.name === 'Width' && (c.left !== undefined || c.right !== undefined)) return el('Width', inches((c.right ?? p.right) - (c.left ?? p.left)));
      if (x.name === 'Style') return { ...x, children: [...x.children, ...[...new Set(c.sides)].map((side) => el(side, el('Style', 'None')))] };
      return x;
    }) };
  });
}

function childNames(e: XmlElement): string[] {
  return e.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null).map((c) => c.name);
}

/**
 * Items trimmed to end at `limit` (inches from their container's left): a wider item narrowed, a table by its last
 * column, a rectangle's own items likewise.
 */
/** Half a thick line's width (twips): what of it SSRS would draw beyond the line's place, as a cell's border. */
function thickHalf(line: ReportObject): number {
  const width = line.border?.width ?? 20;
  return width >= 40 ? width / 2 : 0;
}

/**
 * Keeps what a rectangle holds within its width, at every depth: SSRS widens a rectangle to whatever it holds, and one
 * pushed past the page's printable width prints the overflow on a page of its own after every page.
 */
function fitInside(items: XmlElement[]): XmlElement[] {
  return items.map((item) => {
    if (item.name === 'Tablix') return fitCells(item);
    if (item.name !== 'Rectangle') return item;
    const width = itemNumber(item, 'Width');
    return {
      ...item,
      children: item.children.map((c) => {
        if (typeof c !== 'object' || c === null || (c as XmlElement).name !== 'ReportItems') return c;
        const inner = (c as XmlElement).children.filter((x): x is XmlElement => typeof x === 'object' && x !== null);
        // Only what rounding put past it: a rectangle holding something much wider (a subreport's table wider than
        // its place) is widened by SSRS, as Crystal shows it.
        return { ...(c as XmlElement), children: fitInside(width > 0 ? inner.map((i) => (itemRight(i) - width <= 0.015 ? fitWidth([i], width)[0] : i)) : inner) };
      }),
    };
  });
}

/**
 * Keeps what a table's cells hold within their columns as written (a cell's items each placed to a thousandth of an
 * inch can end a thousandth past it): SSRS widens the column to them, and a table fitted to the page then prints its
 * overflow on a page of its own after every page.
 */
function fitCells(tablix: XmlElement): XmlElement {
  const elements = (e: XmlElement, name?: string) => e.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null && (!name || (c as XmlElement).name === name));
  const body = elements(tablix, 'TablixBody')[0];
  if (!body) return tablix;
  const columns = elements(elements(body, 'TablixColumns')[0] ?? body, 'TablixColumn').map((c) => itemNumber(c, 'Width'));
  const fitCell = (cell: XmlElement, width: number): XmlElement => ({
    ...cell,
    children: cell.children.map((c) => {
      if (typeof c !== 'object' || c === null || (c as XmlElement).name !== 'CellContents') return c;
      const contents = c as XmlElement;
      return {
        ...contents,
        children: contents.children.map((x) => {
          if (typeof x !== 'object' || x === null) return x;
          const content = x as XmlElement;
          if (content.name === 'Tablix') return fitCells(content);
          if (content.name !== 'Rectangle') return content;
          return {
            ...content,
            children: content.children.map((r) => (typeof r === 'object' && r !== null && (r as XmlElement).name === 'ReportItems'
              // A table in a cell (a cross-tab) widens its column on purpose: only what rounding put past it is trimmed.
              // Anything else is kept within the cell (its column may have been narrowed to fit the page).
              ? { ...(r as XmlElement), children: fitInside(elements(r as XmlElement).map((i) => (i.name !== 'Tablix' || itemRight(i) - width <= 0.015 ? fitWidth([i], width)[0] : i))) }
              : r)),
          };
        }),
      };
    }),
  });
  const rows = (e: XmlElement): XmlElement => ({
    ...e,
    children: e.children.map((c) => {
      if (typeof c !== 'object' || c === null) return c;
      const row = c as XmlElement;
      if (row.name !== 'TablixRow') return row;
      let column = 0;
      return {
        ...row,
        children: row.children.map((x) => {
          if (typeof x !== 'object' || x === null || (x as XmlElement).name !== 'TablixCells') return x;
          return {
            ...(x as XmlElement),
            children: (x as XmlElement).children.map((cellNode) => {
              if (typeof cellNode !== 'object' || cellNode === null) return cellNode;
              const cell = cellNode as XmlElement;
              const contents = elements(cell, 'CellContents')[0];
              const span = Math.max(parseInt(String(contents ? elements(contents, 'ColSpan')[0]?.children[0] ?? '1' : '1'), 10) || 1, 1);
              const width = columns.slice(column, column + span).reduce((a, b) => a + b, 0);
              // A cell spanning columns is followed by an empty cell for each further column it spans.
              column += 1;
              return contents ? fitCell(cell, Math.round(width * 1000) / 1000) : cell;
            }),
          };
        }),
      };
    }),
  });
  return { ...tablix, children: tablix.children.map((c) => (typeof c === 'object' && c !== null && (c as XmlElement).name === 'TablixBody'
    ? { ...(c as XmlElement), children: (c as XmlElement).children.map((r) => (typeof r === 'object' && r !== null && (r as XmlElement).name === 'TablixRows' ? rows(r as XmlElement) : r)) }
    : c)) };
}

function fitWidth(items: XmlElement[], limit: number): XmlElement[] {
  return items.map((item) => {
    const left = itemNumber(item, 'Left');
    const width = itemRight(item) - left;
    const over = left + width - limit;
    if (over <= 0.0005) return item;
    const newWidth = Math.max(limit - left, 0.01);
    const cut = width - newWidth;
    // At the very edge, the item moves in by what it cannot give up.
    const newLeft = left + newWidth > limit ? Math.max(limit - newWidth, 0) : left;
    let lastColumnDone = false;
    const fix = (e: XmlElement): XmlElement => {
      if (e.name === 'TablixColumns' && !lastColumnDone) {
        lastColumnDone = true;
        // The cut comes off the last column, and off the ones before it where the last is too narrow to take it all
        // (a table reaching out to a rule across the page ends in a narrow empty column): a table left wider than the
        // page would print its overflow on a page of its own after every page.
        const columns = e.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null);
        const widths = new Map(columns.map((c) => [c, itemNumber(c, 'Width')]));
        // Widths are written to a thousandth of an inch: what they add up to once written must fit too.
        const written = (w: number) => Math.round(w * 1000) / 1000;
        let left = columns.reduce((sum, c) => sum + written(widths.get(c)!), 0) - (newWidth - 0.001);
        // The columns before the last give up a quarter of an inch at most between them: more would squeeze the
        // table's own columns to nothing (a table much wider than its place is left as it is, as SSRS widens that).
        const lastTake = Math.max(written(widths.get(columns[columns.length - 1])!) - 0.05, 0);
        if (columns.length && left - lastTake <= 0.25) {
          for (let i = columns.length - 1; i >= 0 && left > 0.0005; i--) {
            const width = widths.get(columns[i])!;
            const take = Math.min(Math.ceil(left * 1000) / 1000, Math.max(written(width) - 0.05, 0));
            widths.set(columns[i], written(width) - take);
            left -= take;
          }
        }
        return { ...e, children: e.children.map((c) => {
          if (typeof c !== 'object' || c === null || !widths.has(c as XmlElement)) return c;
          const column = c as XmlElement;
          return { ...column, children: column.children.map((x) => (typeof x === 'object' && x !== null && (x as XmlElement).name === 'Width' ? el('Width', inches(widths.get(column)!)) : x)) };
        }) };
      }
      if (e.name === 'TablixBody') return { ...e, children: e.children.map((c) => (typeof c === 'object' && c !== null ? fix(c as XmlElement) : c)) };
      if (e.name === 'ReportItems') return { ...e, children: fitWidth(e.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null), newWidth) };
      if (e.name === 'Width') return el('Width', inches(newWidth));
      if (e.name === 'Left' && newLeft !== left) return el('Left', inches(newLeft));
      return e;
    };
    return { ...item, children: item.children.map((c) => (typeof c === 'object' && c !== null ? fix(c as XmlElement) : c)) };
  });
}

function moveItem(item: XmlElement, top: number, left: number): XmlElement {
  return {
    ...item,
    children: item.children.map((c) => {
      if (typeof c !== 'object' || c === null) return c;
      const e = c as XmlElement;
      if (e.name === 'Top') return el('Top', inches(Math.max(0, itemNumber(item, 'Top') + top)));
      if (e.name === 'Left') return el('Left', inches(Math.max(0, itemNumber(item, 'Left') + left)));
      return e;
    }),
  };
}

function itemRight(item: XmlElement): number {
  const read = (name: string) => {
    const child = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === name);
    return child ? parseFloat(String(child.children[0])) : 0;
  };
  // A table is as wide as its columns as written (each to a thousandth of an inch), whatever its Width says.
  if (item.name === 'Tablix') {
    const body = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'TablixBody');
    const columns = body?.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === 'TablixColumns');
    const total = (columns?.children ?? []).reduce((sum: number, c) => sum + (typeof c === 'object' && c !== null ? itemNumber(c as XmlElement, 'Width') : 0), 0);
    if (total) return read('Left') + Math.max(total, read('Width'));
  }
  return read('Left') + read('Width');
}

/** Deterministic GUID-shaped id derived from a name. */
function reportId(name: string): string {
  let h = 0x811c9dc5;
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (const c of `${name}#${i}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    bytes.push(h & 0xff);
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type { FormulaInfo };

interface ChartStyle {
  type: string;
  subtype?: string;
  threeD?: boolean;
  markers?: boolean;
  /** Review note when SSRS has no exact equivalent or the mapping isn't confirmed by a sample report. */
  note?: string;
}

/** Families confirmed against sample reports (bar, pie, doughnut); the others follow Crystal's documented numbering. */
const CONFIRMED_FAMILIES = new Set([0, 3, 4]);

const FAMILY_NAMES = ['bar', 'line', 'area', 'pie', 'doughnut', '3D riser', '3D surface', 'XY scatter', 'radar', 'bubble', 'stock', 'numeric axis', 'gauge', 'Gantt', 'funnel', 'histogram'];

/**
 * SSRS series type for a Crystal chart. Crystal numbers graph types by family: family * 10 + variant, where
 * bar/line/area variants are 0 plain, 1 stacked, 2 percent, and 3-5 the same in 3D (lines: 3-5 with markers).
 */
/** Number formats of Crystal's chart data labels, by their place in the Chart Expert's list (those confirmed). */
const CHART_NUMBER_FORMATS: Record<number, string> = { 5: '0%', 6: '0.0%', 7: '0.00%' };

/** Crystal legend placements. */
const LEGEND_POSITIONS: Record<number, string> = { 0: 'RightCenter', 1: 'LeftCenter', 2: 'BottomCenter', 3: 'TopCenter' };

/** Crystal's default chart colours, in the order it gives them to series, slices and bars. */
const CRYSTAL_PALETTE = ['#3E6A9E', '#F0A04B', '#2E9B6E', '#E0532B', '#A3335F', '#F2CB4C', '#2A7F94', '#E8735F', '#4A7A35', '#C42E4D'];

/** Crystal's default pie colours: as for bars, with medium grey in green's place. */
/** Crystal's line chart colours: blue, red, green, orange, black, then the bar colours. */
const CRYSTAL_LINE_PALETTE = ['#3E6A9E', '#E02C2C', '#2E9B6E', '#E8742B', '#000000', '#F2CB4C', '#2A7F94', '#A3335F', '#E8735F', '#4A7A35'];
const CRYSTAL_PIE_PALETTE = CRYSTAL_PALETTE.map((c) => (c === '#2E9B6E' ? '#999999' : c));

/** Custom code giving each category of a chart the next Crystal palette colour, in the order categories are drawn. */
/** A text wrapped at spaces to lines of at most `width` characters (a longer word on a line of its own). */
const WRAP_CODE = [
  'Public Function CrWrap(ByVal text As String, ByVal width As Integer) As String',
  '  Dim result As String = ""',
  '  Dim line As String = ""',
  '  For Each word As String In text.Split(" "c)',
  '    If word = "" Then Continue For',
  '    If line = "" Then',
  '      line = word',
  '    ElseIf line.Length + 1 + word.Length <= width Then',
  '      line = line & " " & word',
  '    Else',
  '      result = result & line & vbLf',
  '      line = word',
  '    End If',
  '  Next',
  '  Return result & line',
  'End Function',
].join('\r\n');

/** Crystal's value axis: its minimum (part 0), maximum (1) or step (2) for values from lo to hi. */
const AXIS_CODE = [
  'Public Function CrAxis(ByVal lo As Double, ByVal hi As Double, ByVal part As Integer) As Double',
  '  If hi < lo Then',
  '    Dim swap As Double = lo',
  '    lo = hi',
  '    hi = swap',
  '  End If',
  '  If hi - lo < 1E-12 Then hi = lo + IIf(lo = 0, 1, Math.Abs(lo) / 10)',
  '  Dim power As Integer = CInt(Math.Floor(Math.Log10((hi - lo) / 8))) - 1',
  '  Dim steps() As Double = {1, 2, 4, 5}',
  '  Do',
  '    For Each m As Double In steps',
  '      Dim stepSize As Double = m * Math.Pow(10, power)',
  '      Dim bottom As Double = Math.Floor(lo / stepSize + 1E-9) * stepSize',
  '      Dim top As Double = Math.Ceiling(hi / stepSize - 1E-9) * stepSize',
  '      If (top - bottom) / stepSize <= 8.000001 Then',
  '        If part = 0 Then Return bottom',
  '        If part = 1 Then Return top',
  '        Return stepSize',
  '      End If',
  '    Next',
  '    power = power + 1',
  '  Loop',
  'End Function',
].join('\r\n');

const POINT_COLOR_CODE = [
  'Public Function CrPointColor(ByVal chart As String, ByVal category As Object) As String',
  `  Dim palette() As String = {${CRYSTAL_PALETTE.map((c) => `"${c}"`).join(', ')}}`,
  '  Dim key As String = chart & "|" & CStr(category)',
  '  If Not crPointColors.ContainsKey(key) Then',
  '    Dim used As Integer = 0',
  '    For Each entry As System.Collections.DictionaryEntry In crPointColors',
  '      If CStr(entry.Key).StartsWith(chart & "|") Then used = used + 1',
  '    Next',
  '    crPointColors(key) = palette(used Mod palette.Length)',
  '  End If',
  '  Return CStr(crPointColors(key))',
  'End Function',
].join('\r\n');

export function chartStyle(family: number | undefined, graphType: number | undefined): ChartStyle {
  if (family === undefined) return { type: 'Column', note: 'the Crystal chart type was not found; converted to a column chart' };
  const variant = graphType !== undefined && Math.floor(graphType / 10) === family ? graphType % 10 : 0;
  const stacking = ['Plain', 'Stacked', 'PercentStacked'][variant % 3];
  const name = FAMILY_NAMES[family] ?? `type ${family}`;
  const check = CONFIRMED_FAMILIES.has(family) ? undefined : `converted from a Crystal ${name} chart (graph type ${graphType}); check the chart type`;
  const withNote = (style: ChartStyle, note?: string): ChartStyle => {
    const text = [note, check].filter(Boolean).join('; ');
    return text ? { ...style, note: text } : style;
  };
  switch (family) {
    case 0:
      return withNote({ type: 'Column', subtype: stacking, threeD: variant >= 3 });
    case 1:
      return withNote({ type: 'Line', markers: variant >= 3 }, variant % 3 ? 'Crystal stacked/percent lines have no SSRS equivalent; plain lines were used' : undefined);
    case 2:
      return withNote({ type: 'Area', subtype: stacking, threeD: variant >= 3 });
    case 3:
      return withNote({ type: 'Shape', subtype: 'Pie', threeD: variant === 1 }, variant >= 2 ? 'Crystal multiple pies became one pie chart' : undefined);
    case 4:
      return withNote({ type: 'Shape', subtype: 'Doughnut', threeD: variant === 1 }, variant >= 1 ? 'Crystal multiple doughnuts became one doughnut chart' : undefined);
    case 5:
      return withNote({ type: 'Column', threeD: true });
    case 7:
      return withNote({ type: 'Scatter' }, 'an XY scatter needs X values; set the category to the X field');
    case 8:
      return withNote({ type: 'Polar', subtype: 'Radar' });
    case 9:
      return withNote({ type: 'Scatter', subtype: 'Bubble' }, 'set the bubble size value');
    case 10:
      return withNote({ type: 'Range', subtype: 'Stock' }, 'set the high, low, open and close values');
    case 13:
      return withNote({ type: 'Range', subtype: 'RangeBar' }, 'set the start and end values');
    case 14:
      return withNote({ type: 'Shape', subtype: 'Funnel' });
    default:
      return withNote({ type: 'Column' }, `SSRS has no ${name} chart; a column chart was used (a gauge can be added by hand)`);
  }
}

/** SSRS aligns text General, Left, Center or Right only: Crystal's justified text is left-aligned (its last line is). */
const TEXT_ALIGN: Record<NonNullable<ReportObject['align']>, string> = { left: 'Left', center: 'Center', right: 'Right', justify: 'Left' };

/** A literal in a .NET format string. */
const literalText = (text: string) => (text ? `'${text.replace(/'/g, "\\'")}'` : '');

/** A .NET format string for a Crystal number format. */
export function numberFormatString(f: NumberFormatInfo): string {
  // Without a leading zero, values below 1 show as .50; whole numbers still show 0.
  const zero = f.leadingZero || f.decimals === 0;
  const whole = f.thousands ? (zero ? '#,0' : '#,#') : zero ? '0' : '#';
  const body = whole + (f.decimals > 0 ? `.${'0'.repeat(Math.min(f.decimals, 15))}` : '');
  const symbol = f.symbolType > 0 && f.symbol ? literalText(f.symbol) : '';
  const trailing = f.symbolPosition >= 2;
  const positive = symbol ? (trailing ? body + symbol : symbol + body) : body;
  // Positions 1 and 3 (Crystal's default) put the sign or brackets around the number with its symbol: ($1.00);
  // 0 and 2 keep the symbol outside them: $(1.00).
  const outside = symbol && (f.symbolPosition === 0 || f.symbolPosition === 2);
  const wrap = (core: string) => (f.negative === 3 ? `(${core})` : f.negative === 2 ? `${core}-` : f.negative === 0 ? core : `-${core}`);
  const negative = outside ? (trailing ? wrap(body) + symbol : symbol + wrap(body)) : wrap(positive);
  return `${positive};${negative}`;
}

/** A .NET format string for a Crystal date format. */
export function dateFormatString(f: DateFormatInfo): string {
  const year = ['yy', 'yyyy'][f.year];
  const month = ['M', 'MM', 'MMM', 'MMMM'][f.month];
  const day = ['d', 'dd'][f.day];
  const parts = (f.order === 1 ? [day, month, year] : f.order === 2 ? [month, day, year] : [year, month, day]);
  let out = '';
  parts.forEach((part, i) => {
    if (!part) return;
    if (out) out += literalText(f.separators[Math.min(i, 2) - 1] ?? f.separators[0]);
    out += part;
  });
  const weekday = ['ddd', 'dddd'][f.dayOfWeek];
  if (weekday) out = out ? `${weekday}', '${out}` : weekday;
  return out.length === 1 ? `%${out}` : out;
}

/** A .NET format string for a Crystal time format. */
export function timeFormatString(f: TimeFormatInfo): string {
  let out = `${f.hour12 ? 'h' : 'HH'}${literalText(f.hourMinute || ':')}mm`;
  if (f.seconds) out += `${literalText(f.minuteSecond || ':')}ss`;
  if (f.hour12) out += `${/^\s/.test(f.am) ? ' ' : ''}tt`;
  return out;
}

/** The format Crystal shows a value of a type with, as a .NET format string; undefined when not decided by the format. */
export function formatFor(format: ValueFormat, type: string | undefined): string | undefined {
  switch (type) {
    case 'currency': {
      // Crystal shows currency values with the second number format it stores, as other numbers (the first holds
      // its currency style, a symbol and brackets), whether or not the field keeps the default format.
      const f = format.number ?? format.currency;
      return f && numberFormatString(f);
    }
    case 'number':
    case 'integer':
      return format.number && numberFormatString(format.number);
    case 'date':
      return format.date && dateFormatString(format.date);
    case 'time':
      return format.time && timeFormatString(format.time);
    case 'dateTime': {
      const date = format.date && dateFormatString(format.date);
      const time = format.time && timeFormatString(format.time);
      const separator = literalText(format.dateTimeSeparator?.trim() ? format.dateTimeSeparator : ' ');
      switch (format.dateTimeOrder ?? 0) {
        case 2: return date;
        case 3: return time;
        case 1: return time && date ? `${time}${separator}${date}` : undefined;
        default: return date && time ? `${date}${separator}${time}` : undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Placeholder for a shared variable's value in expressions, replaced when the report is written. */
const SHARED_TOKEN = '__CrShared_';
const sharedToken = (variable: string) => `${SHARED_TOKEN}${variable}__`;

/** Statements of a formula without comments, empty statements and evaluation-time markers. */
function formulaStatements(text: string): string[] | undefined {
  // Split on ";" outside strings and {field} references (stored procedure fields read {proc;1.field}).
  const statements: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '{') {
      const close = c === '{' ? '}' : c;
      const end = text.indexOf(close, i + 1);
      if (end < 0) return undefined;
      current += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ';') {
      statements.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  statements.push(current);
  return statements.map((s) => s.trim())
    .filter((s) => s && !/^(WhilePrintingRecords|WhileReadingRecords|BeforeReadingRecords|EvaluateAfter\s*\(.*\))$/i.test(s));
}

/** "shared StringVar x; x := <value>" (or "shared StringVar x := <value>"): the variable and the value's source text. */
export function sharedAssignment(text: string): { name: string; value: string } | undefined {
  const statements = formulaStatements(text);
  if (!statements) return undefined;
  if (statements.length === 1) {
    const m = /^shared\s+\w+var\s+(\w+)\s*:=\s*([\s\S]+)$/i.exec(statements[0]);
    return m ? { name: m[1].toLowerCase(), value: m[2].trim() } : undefined;
  }
  if (statements.length !== 2) return undefined;
  const declaration = /^shared\s+\w+var\s+(\w+)$/i.exec(statements[0]);
  if (!declaration) return undefined;
  const m = /^(\w+)\s*:=\s*([\s\S]+)$/.exec(statements[1]);
  return m && m[1].toLowerCase() === declaration[1].toLowerCase() ? { name: m[1].toLowerCase(), value: m[2].trim() } : undefined;
}

/** "shared StringVar x; x": the variable a formula only reads. */
export function sharedRead(text: string): string | undefined {
  const statements = formulaStatements(text);
  if (!statements || statements.length !== 2) return undefined;
  const declaration = /^shared\s+\w+var\s+(\w+)$/i.exec(statements[0]);
  return declaration && statements[1].toLowerCase() === declaration[1].toLowerCase() ? declaration[1].toLowerCase() : undefined;
}
