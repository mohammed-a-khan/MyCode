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
  DataSourceInfo,
  FormulaInfo,
  FormulaRef,
  ReportDefinition,
  ReportObject,
  SectionInfo,
  TableInfo,
} from '../crystal/model.ts';
import { CODE_HELPERS, SPECIAL_FIELDS, translateFormula, translateToSql, vbString, type FormulaContext, type Translation } from './formula.ts';
import { el, toXml, type XmlElement } from './xml.ts';

export interface RdlOptions {
  /** Name of the report (used for ids and review notes). */
  reportName: string;
  /** Overrides the generated connection string. */
  connectionString?: string;
  /** Subreports by their "Subdocument N" number: RDL name and link parameters (Crystal "Pm-" parameters). */
  subreports?: Map<number, SubreportInfo>;
  /** Image bytes by their "Embedding N" number. */
  images?: Map<number, Uint8Array>;
  /** The report is a subreport: its areas have no page header or footer. */
  subreport?: boolean;
}

export interface SubreportInfo {
  name: string;
  /** Subreport parameter (SSRS name) fed from a main-report field (Crystal "Table.Field"). */
  links: { parameter: string; field: string }[];
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
}

const RDL_NS = 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';
const RD_NS = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';
const DATASET = 'DataSet1';
const DATASOURCE = 'DataSource1';
const TWIPS_PER_INCH = 1440;
const MIN_ROW_HEIGHT = 0.2;
const DEFAULT_HEIGHT = 0.25;
const DEFAULT_WIDTH = 1.5;
/** Crystal's default ("use printer defaults") margin. */
const MARGIN = 0.25;

/** Paper sizes by Windows DEVMODE code: [width, height] in inches (portrait). */
const PAPER_SIZES: Record<number, [number, number]> = { 1: [8.5, 11], 5: [8.5, 14], 9: [8.27, 11.69], 8: [11.69, 16.54], 11: [5.83, 8.27] };

const inches = (value: number) => `${Math.round(value * 1000) / 1000}in`;
const twipsToInches = (twips: number) => twips / TWIPS_PER_INCH;

const TYPE_NAMES: Record<string, string> = {
  string: 'System.String', memo: 'System.String', integer: 'System.Int32', number: 'System.Double',
  currency: 'System.Decimal', boolean: 'System.Boolean', date: 'System.DateTime', dateTime: 'System.DateTime',
  time: 'System.TimeSpan', blob: 'System.Byte[]',
};
const PARAMETER_TYPES: Record<string, string> = {
  string: 'String', integer: 'Integer', number: 'Float', currency: 'Float', boolean: 'Boolean',
  date: 'DateTime', dateTime: 'DateTime', time: 'DateTime',
};
const FORMATS: Record<string, string> = { currency: 'C2', number: 'N2', integer: 'N0', date: 'd', dateTime: 'g' };

const SUMMARY_OPERATIONS: Record<string, string> = {
  sum: 'Sum', count: 'Count', average: 'Avg', maximum: 'Max', minimum: 'Min', 'distinct count': 'CountDistinct',
  'standard deviation': 'StDev', 'pop. standard deviation': 'StDevP', variance: 'Var', 'pop. variance': 'VarP',
};
const SUMMARY_NAME = new RegExp(`^(${Object.keys(SUMMARY_OPERATIONS).map((k) => k.replace('.', '\\.')).join('|')}|[A-Za-z. ]+?) of (.+)$`, 'i');
const AGGREGATE_CALL = /\b(Sum|Count|Avg|Max|Min|CountDistinct|StDev|StDevP|Var|VarP|First|Last|Previous|RowNumber|RunningValue)\(/;
const BORDER_STYLES: Record<number, string> = { 1: 'Solid', 2: 'Dashed', 3: 'Dotted', 4: 'Double' };

class NameSet {
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
}

export function convertToRdl(definition: ReportDefinition, dataSource: DataSourceInfo | undefined, options: RdlOptions): RdlResult {
  return new RdlBuilder(definition, dataSource ?? { connections: [], tables: [], links: [] }, options).build();
}

class RdlBuilder {
  private readonly review: ReviewNote[] = [];
  private readonly itemNames = new NameSet();
  private readonly fieldNames = new NameSet();
  private readonly imageNames = new NameSet();
  private readonly fields = new Map<string, DatasetField>();
  private readonly calculated: { name: string; expression: string }[] = [];
  private readonly formulaResults = new Map<string, string | null>();
  private readonly parameterNames = new Map<string, string>();
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

  constructor(definition: ReportDefinition, source: DataSourceInfo, options: RdlOptions) {
    this.definition = definition;
    this.source = source;
    this.options = options;
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

  private lookupField(table: string, column: string): DatasetField | undefined {
    const field = this.fields.get(fieldKey(table, column));
    if (field) field.used = true;
    return field;
  }

  private groupScopeOf(ref: string): string | undefined {
    const level = this.groupFields.findIndex((g) => g.toLowerCase() === ref.toLowerCase());
    return level >= 0 ? this.groupNames[level] : undefined;
  }

  private readonly formulaContext: FormulaContext = {
    field: (table, column) => this.lookupField(table, column)?.name,
    formula: (name) => this.formulaExpression(name) ?? undefined,
    parameter: (name) => this.parameterName(name),
    groupScope: (ref) => this.groupScopeOf(ref),
    runningTotal: (name) => this.runningTotalExpression(name, `Running total {#${name}}`),
    customFunction: (name) => this.customFunction(name),
    parameterRange: (name) => this.parameterRange(name),
    parameterMultiple: (name) => this.parameterInfo(name)?.allowMultiple === true,
    nextValue: (ref) => this.nextValue(ref),
    fieldType: (ref) => {
      const dot = ref.lastIndexOf('.');
      return dot > 0 ? this.fields.get(fieldKey(ref.slice(0, dot), ref.slice(dot + 1)))?.type : undefined;
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
      names = { start: this.itemNames.make(`${base}_Start`), end: this.itemNames.make(`${base}_End`) };
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
      name = this.itemNames.make(crystalName.replace(/^[@?]/, ''));
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
    let result: string;
    if (AGGREGATE_CALL.test(expression) || expression.includes('Globals!') || expression.includes('Me.Value')) {
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
  private conditionExpression(ref: FormulaRef, colors: boolean, item: string): string | undefined {
    const text = this.definition.formulaTexts?.[ref.index] ?? this.definition.formulas.find((f) => f.index === ref.index)?.text;
    if (!text) {
      this.note(item, `refers to formatting formula ${ref.name} (#${ref.index}), which was not found or is empty`);
      return undefined;
    }
    const formula = { text };
    const t = translateFormula(formula.text, this.formulaContext, { colors, codeName: this.codeNames.make(`C_${ref.name}_${ref.index}`) });
    this.addCode(t);
    for (const issue of t.issues) this.note(`${item}: formula ${ref.name}`, issue);
    return t.expression === '=Nothing' ? undefined : t.expression;
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
    return `RunningValue(${value}, ${operation}, ${vbString(DATASET)})`;
  }

  // ---- expressions for report objects ------------------------------------------------------

  /** Expression (without "=") and format for a field object's reference. */
  private fieldObjectValue(ref: string, scope: Scope, item: string): { expression: string; format?: string } {
    const special = SPECIAL_FIELDS[ref.toLowerCase()];
    if (special) {
      if (scope !== 'page' && special.includes('Globals!Page')) this.note(item, 'page numbers are only available in the page header or footer in SSRS');
      return { expression: special, format: special.includes('ExecutionTime') ? 'd' : undefined };
    }
    const groupName = /^Group #(\d+) Name$/i.exec(ref);
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
      const scopeArg = scope === 'row' ? '' : `, ${vbString(DATASET)}`;
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
    if (scope === 'row' || !expression.includes('Fields!') || AGGREGATE_CALL.test(expression)) return expression;
    return `First(${expression}, ${vbString(DATASET)})`;
  }

  private objectValue(obj: ReportObject, scope: Scope): { value: string; format?: string } {
    const item = `${obj.kind} object "${obj.name}"`;
    if (obj.kind === 'field' && obj.field) {
      const { expression, format } = this.fieldObjectValue(obj.field, scope, item);
      return { value: `=${expression}`, format };
    }
    if (obj.kind === 'text') {
      const text = obj.text ?? '';
      if (obj.embeddedFields?.length) {
        // Text and embedded fields in their original order; tabs become spaces (text boxes do not tab).
        const runs = obj.runs ?? [{ text }, ...obj.embeddedFields.map((field) => ({ field }))];
        const parts = runs.map((r) => ('field' in r ? this.fieldObjectValue(r.field, scope, item).expression : vbString(r.text.replace(/\t+/g, '    '))));
        return { value: `=${parts.join(' & ')}` };
      }
      return { value: text.startsWith('=') ? `=${vbString(text)}` : text };
    }
    return { value: '' };
  }

  // ---- styles -----------------------------------------------------------------------------

  private textRunStyle(obj: ReportObject | undefined, format: string | undefined, scope: Scope): XmlElement {
    const style = obj?.style;
    let colorValue: string | undefined = style?.color;
    if (obj?.conditions?.fontColor) {
      colorValue = this.conditionExpression(obj.conditions.fontColor, true, `${obj.kind} object "${obj.name}"`) ?? colorValue;
      if (scope === 'page' && colorValue?.includes('Fields!')) this.note(`${obj.kind} object "${obj.name}"`, 'its colour formula uses fields, which the page header/footer cannot read');
    }
    return el('Style',
      style?.italic ? el('FontStyle', 'Italic') : null,
      obj?.font ? el('FontFamily', obj.font) : null,
      style?.size ? el('FontSize', `${style.size}pt`) : null,
      style?.bold ? el('FontWeight', 'Bold') : null,
      format ? el('Format', format) : null,
      style?.underline ? el('TextDecoration', 'Underline') : null,
      colorValue ? el('Color', colorValue) : null);
  }

  /** Border and background elements for an item's Style. */
  private borderStyle(border: BorderInfo | undefined, extra: { top?: boolean; bottom?: boolean } = {}): XmlElement[] {
    const side = (name: string, style: number) => {
      const lineStyle = BORDER_STYLES[style];
      if (!lineStyle) return null;
      return el(name,
        border?.color ? el('Color', border.color) : null,
        el('Style', lineStyle),
        border?.width ? el('Width', `${Math.max(0.25, (border.width / 20)).toFixed(2)}pt`) : null);
    };
    const [left, right, sideTop, sideBottom] = border?.sides ?? [0, 0, 0, 0];
    // Lines drawn along a table row become that row's top/bottom border.
    const top = extra.top && !sideTop ? 1 : sideTop;
    const bottom = extra.bottom && !sideBottom ? 1 : sideBottom;
    const same = left === right && right === top && top === bottom;
    const out: XmlElement[] = [];
    if (same && left > 0) out.push(side('Border', left)!);
    else {
      out.push(el('Border', el('Style', 'None')));
      if (!same) {
        for (const [name, style] of [['TopBorder', top], ['BottomBorder', bottom], ['LeftBorder', left], ['RightBorder', right]] as const) {
          const e = side(name, style);
          if (e) out.push(e);
        }
      }
    }
    if (border?.background) out.push(el('BackgroundColor', border.background));
    return out;
  }

  private textbox(name: string, value: string, obj: ReportObject | undefined, format: string | undefined, scope: Scope, box?: Box, hidden?: string, lines: { top?: boolean; bottom?: boolean } = {}): XmlElement {
    const item = obj ? `${obj.kind} object "${obj.name}"` : name;
    const conditions = obj?.conditions ?? {};
    const hyperlink = conditions.hyperlink ? this.conditionExpression(conditions.hyperlink, false, item) : undefined;
    const toolTip = conditions.toolTip ? this.conditionExpression(conditions.toolTip, false, item) : undefined;
    const backColor = conditions.backColor ? this.conditionExpression(conditions.backColor, true, item) : undefined;
    const suppress = conditions.suppress ? this.conditionExpression(conditions.suppress, false, item) : undefined;
    for (const key of Object.keys(conditions)) {
      if (!['fontColor', 'hyperlink', 'toolTip', 'backColor', 'suppress'].includes(key)) this.note(item, `formatting formula ${conditions[key].name} is not converted; set it on the text box manually`);
    }
    const border = backColor ? { ...(obj?.border ?? { sides: [0, 0, 0, 0] as [number, number, number, number] }), background: backColor } : obj?.border;
    return el('Textbox', { Name: name },
      el('CanGrow', 'true'),
      el('KeepTogether', 'true'),
      el('Paragraphs', el('Paragraph',
        el('TextRuns', el('TextRun', el('Value', value), this.textRunStyle(obj, format, scope))),
        el('Style'))),
      hyperlink ? el('ActionInfo', el('Actions', el('Action', el('Hyperlink', hyperlink)))) : null,
      toolTip ? el('ToolTip', toolTip) : null,
      box ? el('Top', inches(box.top)) : null,
      box ? el('Left', inches(box.left)) : null,
      box ? el('Height', inches(box.height)) : null,
      box ? el('Width', inches(box.width)) : null,
      hidden || suppress ? el('Visibility', el('Hidden', hidden && suppress ? `=(${hidden.slice(1)}) OrElse (${suppress.slice(1)})` : (hidden ?? suppress)!)) : null,
      el('Style', ...this.borderStyle(border, lines), el('PaddingLeft', '2pt'), el('PaddingRight', '2pt'), el('PaddingTop', '2pt'), el('PaddingBottom', '2pt')));
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
  private placeSection(section: SectionInfo, top: number, scope: Scope, area: string): { items: XmlElement[]; height: number } {
    const hidden = section.conditions?.suppress ? this.conditionExpression(section.conditions.suppress, false, `Section ${section.name}`) : undefined;
    if (hidden) this.note(`Section ${section.name}`, 'its suppress condition was applied to each item as a Hidden expression');
    const items: XmlElement[] = [];
    let bottom = 0;
    for (const obj of section.objects) {
      const box = this.boxOf(obj, top);
      const item = this.reportItem(obj, scope, area, box, hidden);
      if (item) items.push(item);
      bottom = Math.max(bottom, box.top - top + box.height);
    }
    const height = Math.max(section.height !== undefined ? twipsToInches(section.height) : 0, bottom);
    return { items, height: section.objects.length || section.height ? height : 0 };
  }

  private reportItem(obj: ReportObject, scope: Scope, area: string, box: Box, hidden?: string): XmlElement | null {
    const item = `${obj.kind} object "${obj.name}" in ${area}`;
    const name = () => this.itemNames.make(obj.name || obj.kind);
    const visibility = hidden ? el('Visibility', el('Hidden', hidden)) : null;
    switch (obj.kind) {
      case 'field':
      case 'text': {
        const { value, format } = this.objectValue(obj, scope);
        return this.textbox(name(), value, obj, format, scope, box, hidden);
      }
      case 'line':
        return el('Line', { Name: name() },
          el('Top', inches(box.top)), el('Left', inches(box.left)),
          el('Height', inches(obj.size ? twipsToInches(obj.size.height) : 0)), el('Width', inches(box.width)),
          visibility,
          el('Style', el('Border',
            el('Color', obj.border?.color ?? 'Black'),
            el('Style', BORDER_STYLES[Math.max(...(obj.border?.sides ?? [1]))] ?? 'Solid'),
            el('Width', `${Math.max(0.25, (obj.border?.width ?? 20) / 20).toFixed(2)}pt`))));
      case 'box':
        return el('Rectangle', { Name: name() },
          el('KeepTogether', 'true'),
          el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
          el('ZIndex', '-1'),
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
        // Linked subreports: each "Pm-Table.Field" parameter receives that field's value.
        const parameters = info.links.map((link) => el('Parameter', { Name: link.parameter },
          el('Value', `=${this.fieldObjectValue(link.field, scope, item).expression}`)));
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
        return this.matrix(obj, box, item);
      case 'chart':
        return this.chart(obj, box, item);
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
      el('Sizing', 'FitProportional'),
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
      el('DataSetName', DATASET),
      el('Top', inches(box.top)), el('Left', inches(box.left)),
      el('Height', inches(height * (ct.columns.length + 2))),
      el('Width', inches(width * (ct.rows.length + 2))),
      el('Style', el('Border', el('Style', 'None'))));
  }

  // ---- chart --------------------------------------------------------------------------------


  private chart(obj: ReportObject, box: Box, item: string): XmlElement | null {
    const chart = obj.chart;
    if (chart?.layoutCode === 8) {
      this.note(item, 'maps are not converted; use an SSRS map');
      return null;
    }
    // Values: the chart's own summaries, or those of a cross-tab it charts.
    const crossTab = this.definition.layout.flatMap((a) => a.sections.flatMap((s) => s.objects)).find((o) => o.crossTab)?.crossTab;
    const values = chart?.values.length ? chart.values : chart?.layoutCode === 1 && crossTab ? crossTab.summaries : [];
    const category = chart?.onChangeOf ?? (chart?.layoutCode === 1 && crossTab ? crossTab.columns[0] : this.groupFields[0]);
    if (!chart || values.length === 0 || !category) {
      this.note(item, 'the chart data could not be determined; recreate the chart');
      return null;
    }
    const style = chartStyle(chart.family, chart.graphType);
    if (style.note) this.note(item, style.note);
    const categoryExpression = this.fieldObjectValue(category, 'row', item).expression;
    const chartName = this.itemNames.make(obj.name || 'Chart');
    const axis = (title: string | undefined, name: string) => el('ChartAxis', { Name: name },
      el('Style', el('FontSize', '8pt')),
      el('ChartAxisTitle', el('Caption', title ?? ''), el('Style', el('FontSize', '8pt'))),
      el('ChartMajorGridLines', el('Enabled', name === 'Primary' && title === chart.categoryTitle ? 'False' : 'True'), el('Style', el('Border', el('Color', 'Gainsboro')))),
      el('ChartMinorGridLines', el('Style')),
      el('ChartMinorTickMarks', el('Length', '0.5')),
      el('CrossAt', 'NaN'), el('Minimum', 'NaN'), el('Maximum', 'NaN'),
      el('ChartAxisScaleBreak', el('Style')));
    const series = values.map((v, i) => {
      const value = this.fieldObjectValue(v, 'row', item);
      return el('ChartSeries', { Name: this.itemNames.make(`${chartName}_Series${i + 1}`) },
        el('ChartDataPoints', el('ChartDataPoint',
          el('ChartDataPointValues', el('Y', `=${value.expression}`)),
          el('ChartDataLabel', el('Style')),
          el('Style'),
          el('ChartMarker', style.markers ? el('Type', 'Auto') : null, el('Style')),
          el('DataElementOutput', 'Output'))),
        el('Type', style.type),
        style.subtype ? el('Subtype', style.subtype) : null,
        el('Style'),
        el('ChartEmptyPoints', el('Style'), el('ChartMarker', el('Style')), el('ChartDataLabel', el('Style'))),
        el('ValueAxisName', 'Primary'),
        el('CategoryAxisName', 'Primary'),
        el('ChartSmartLabel', el('CalloutLineColor', 'Black'), el('MinMovingDistance', '0pt')));
    });
    return el('Chart', { Name: chartName },
      el('ChartCategoryHierarchy', el('ChartMembers', el('ChartMember',
        el('Group', { Name: this.itemNames.make(`${chartName}_Category`) }, el('GroupExpressions', el('GroupExpression', `=${categoryExpression}`))),
        el('SortExpressions', el('SortExpression', el('Value', `=${categoryExpression}`))),
        el('Label', `=${categoryExpression}`)))),
      el('ChartSeriesHierarchy', el('ChartMembers', ...values.map((v) => el('ChartMember', el('Label', v))))),
      el('ChartData', el('ChartSeriesCollection', ...series)),
      el('ChartAreas', el('ChartArea', { Name: 'Default' },
        el('ChartCategoryAxes', axis(chart.categoryTitle, 'Primary')),
        el('ChartValueAxes', axis(chart.valueTitle, 'Primary')),
        style.threeD ? el('ChartThreeDProperties', el('Enabled', 'true'), el('Rotation', '20'), el('Inclination', '20')) : null,
        el('Style'))),
      el('ChartLegends', el('ChartLegend', { Name: 'Default' }, el('Style'), el('Position', 'RightCenter'))),
      chart.title ? el('ChartTitles', el('ChartTitle', { Name: 'Default' }, el('Caption', chart.title), el('Style', el('FontWeight', 'Bold')))) : null,
      el('Palette', 'BrightPastel'),
      el('ChartBorderSkin', el('Style')),
      el('ChartNoDataMessage', { Name: 'NoDataMessage' }, el('Caption', 'No Data Available'), el('Style')),
      el('DataSetName', DATASET),
      el('Top', inches(box.top)), el('Left', inches(box.left)), el('Height', inches(box.height)), el('Width', inches(box.width)),
      el('Style', el('Border', el('Style', 'None'))));
  }

  // ---- table (tablix) -------------------------------------------------------------------

  private columnsFor(objects: ReportObject[]): Column[] {
    const cellObjects = objects.filter((o) => o.kind === 'field' || o.kind === 'text');
    const xs = [...new Set(cellObjects.map((o) => o.position?.x ?? 0))].sort((a, b) => a - b);
    const merged: number[] = [];
    for (const x of xs) if (merged.length === 0 || x - merged[merged.length - 1] > 144) merged.push(x);
    return merged.map((x, i) => {
      if (i + 1 < merged.length) return { x, width: Math.max(twipsToInches(merged[i + 1] - x), 0.3) };
      const widest = Math.max(0, ...cellObjects.filter((o) => (o.position?.x ?? 0) >= x).map((o) => o.size?.width ?? 0));
      return { x, width: widest ? Math.max(twipsToInches(widest), 0.3) : DEFAULT_WIDTH };
    });
  }

  private columnIndex(columns: Column[], x: number): number {
    let best = 0;
    for (let i = 0; i < columns.length; i++) if (x >= columns[i].x - 144) best = i;
    return best;
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
    const ys = cellObjects.map((o) => o.position?.y ?? 0);
    return ys.length === 0 || Math.max(...ys) - Math.min(...ys) <= 144;
  }

  /** A table row for one section: a cell per column, or one merged cell with the objects at their positions. */
  private tableRow(columns: Column[], section: SectionInfo, rowName: string, area: string): { row: XmlElement; height: number; hidden?: string } {
    const suppress = section.conditions?.suppress;
    const hidden = suppress ? this.conditionExpression(suppress, false, `Section ${section.name}`) : undefined;
    const background = section.conditions?.backColor ? this.conditionExpression(section.conditions.backColor, true, `Section ${section.name}`) : undefined;
    const sectionHeight = section.height !== undefined ? twipsToInches(section.height) : 0;
    const tableLeft = columns[0].x;
    const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);

    if (!this.isTabular(columns, section)) {
      // Free-form: keep every object at its position inside a rectangle spanning the row.
      const items: XmlElement[] = [];
      let bottom = 0;
      for (const obj of section.objects) {
        const box = this.boxOf(obj, 0);
        box.left = Math.max(0, box.left - twipsToInches(tableLeft));
        box.width = Math.min(box.width, Math.max(tableWidth - box.left, 0.1));
        const item = this.reportItem(obj, 'row', area, box);
        if (item) items.push(item);
        bottom = Math.max(bottom, box.top + box.height);
      }
      const height = Math.max(sectionHeight, bottom, MIN_ROW_HEIGHT);
      const rectangle = el('Rectangle', { Name: this.itemNames.make(`${rowName}_Area`) },
        items.length ? el('ReportItems', ...items) : null,
        el('KeepTogether', 'true'),
        el('Style', el('Border', el('Style', 'None')), background ? el('BackgroundColor', background) : null));
      const row = el('TablixRow',
        el('Height', inches(height)),
        el('TablixCells',
          el('TablixCell', el('CellContents', rectangle, columns.length > 1 ? el('ColSpan', String(columns.length)) : null)),
          ...columns.slice(1).map(() => el('TablixCell'))));
      return { row, height, hidden };
    }

    const cells: (ReportObject | undefined)[] = columns.map(() => undefined);
    let rowHeight = 0;
    const lines = { top: false, bottom: false };
    for (const obj of section.objects) {
      if (obj.kind === 'line') {
        const y = obj.position?.y ?? 0;
        if (section.height && y > section.height / 2) lines.bottom = true;
        else lines.top = true;
        continue;
      }
      cells[this.columnIndex(columns, obj.position?.x ?? 0)] = obj;
      rowHeight = Math.max(rowHeight, twipsToInches(obj.size?.height ?? 0) + twipsToInches(obj.position?.y ?? 0));
    }
    const height = Math.max(rowHeight, Math.min(sectionHeight, rowHeight + 0.1), MIN_ROW_HEIGHT);
    const row = el('TablixRow',
      el('Height', inches(height)),
      el('TablixCells', ...cells.map((obj, i) => {
        const { value, format } = obj ? this.objectValue(obj, 'row') : { value: '', format: undefined };
        const name = this.itemNames.make(obj?.name || `${rowName}_${i + 1}`);
        const cellObj = background ? { ...(obj ?? { kind: 'text', name }), border: { ...(obj?.border ?? { sides: [0, 0, 0, 0] as [number, number, number, number] }), background } } : obj;
        return el('TablixCell', el('CellContents', this.textbox(name, value, cellObj, format, 'row', undefined, undefined, lines)));
      })));
    return { row, height, hidden };
  }

  /** Crystal Top N with an "Others" group: ranks groups in SQL (direct table access only). */
  private othersGroup?: { level: number; rank: string; total: string; column: DatasetField; group: DatasetField; operation: string; descending: boolean; topN: number; label: string };

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
    this.othersGroup = {
      level, column, group, descending, topN, label,
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
      ? detailObjects
      : [...areas.groupHeaders.values()].flat().flatMap((s) => s.objects);
    let columns = this.columnsFor(layoutSource);
    const anyContent = [...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().some((s) => s.objects.length > 0);
    if (columns.length === 0 && anyContent) {
      // No tabular columns at all (a form-style report): one column spanning the content.
      const objects = [...areas.groupHeaders.values(), ...areas.groupFooters.values(), areas.detail].flat().flatMap((s) => s.objects);
      const left = Math.min(...objects.map((o) => o.position?.x ?? 0));
      const right = Math.max(...objects.map((o) => (o.position?.x ?? 0) + (o.size?.width ?? 1440)));
      columns = [{ x: left, width: Math.max(twipsToInches(right - left), 1) }];
    }
    if (columns.length === 0) return { tablix: null, height: 0, width: 0, left: 0 };

    const rows: XmlElement[] = [];
    let height = 0;
    /** Adds a row per section with content; returns the static members for them. */
    const addRows = (sections: SectionInfo[] | undefined, name: string, area: string, keepWith: 'After' | 'Before' | null, always = false): XmlElement[] => {
      const members: XmlElement[] = [];
      const withContent = (sections ?? []).filter((s) => s.objects.length > 0);
      const list = withContent.length === 0 && always ? [{ name: `${name} (empty)`, objects: [] } as SectionInfo] : withContent;
      list.forEach((section, i) => {
        const r = this.tableRow(columns, section, list.length > 1 ? `${name}_${i + 1}` : name, area);
        rows.push(r.row);
        height += r.height;
        members.push(el('TablixMember',
          r.hidden ? el('Visibility', el('Hidden', r.hidden)) : null,
          keepWith ? el('KeepWithGroup', keepWith) : null));
      });
      return members;
    };

    const headingMembers = areas.columnHeadings.length
      ? addRows([{ name: 'Column headings', objects: areas.columnHeadings }], 'Header', 'Page Header', 'After').map((m) => ({ ...m, children: [...m.children, el('RepeatOnNewPage', 'true')] }))
      : [];
    const levels = this.groupFields.length;
    const headerMembers: XmlElement[][] = [];
    for (let level = 1; level <= levels; level++) headerMembers[level - 1] = addRows(areas.groupHeaders.get(level), `Group${level}Header`, `Group Header ${level}`, 'After');
    const detailMembers = addRows(areas.detail, 'Detail', 'Details', null, true);
    const footerMembers: XmlElement[][] = [];
    for (let level = levels; level >= 1; level--) footerMembers[level - 1] = addRows(areas.groupFooters.get(level), `Group${level}Footer`, `Group Footer ${level}`, 'Before');

    // Sorting: record sorts go on the details; group sorts / Top N go on their group.
    const sorts = this.definition.sorts ?? this.definition.sortFields.map((field) => ({ field, descending: false, bySummary: false }));
    const detailSorts = sorts
      .filter((s) => !s.bySummary && !this.groupFields.some((g) => g.toLowerCase() === s.field.toLowerCase()))
      .map((s) => ({ ...s, expression: this.fieldObjectValue(s.field, 'row', 'Record sort').expression }))
      .filter((s) => s.expression !== 'Nothing');
    const summarySort = sorts.find((s) => s.bySummary);
    const pageBreak = (sections: SectionInfo[] | undefined, footer?: SectionInfo[]) => {
      const before = (sections ?? []).some((s) => s.conditions?.newPageBefore);
      const after = [...(sections ?? []), ...(footer ?? [])].some((s) => s.conditions?.newPageAfter);
      return before || after ? el('PageBreak', el('BreakLocation', before && after ? 'StartAndEnd' : before ? 'Between' : 'End')) : null;
    };

    // Details: a single row, or a static member per detail section.
    let member: XmlElement = el('TablixMember',
      el('Group', { Name: 'Details' }, pageBreak(areas.detail)),
      detailSorts.length ? el('SortExpressions', ...detailSorts.map((s) => el('SortExpression', el('Value', `=${s.expression}`), s.descending ? el('Direction', 'Descending') : null))) : null,
      detailMembers.length > 1 ? el('TablixMembers', ...detailMembers) : null,
      detailMembers.length === 1 ? (detailMembers[0].children.find((c) => typeof c === 'object' && c !== null && (c as XmlElement).name === 'Visibility') ?? null) : null);
    for (let level = levels; level >= 1; level--) {
      const field = this.groupFields[level - 1];
      let expression = this.fieldObjectValue(field, 'row', `Group ${level}`).expression;
      const option = this.definition.groupOptions?.find((g) => g.field.toLowerCase() === field.toLowerCase());
      const fieldSort = sorts.find((s) => !s.bySummary && s.field.toLowerCase() === field.toLowerCase());
      const filters: XmlElement[] = [];
      let sortValue = `=${expression}`;
      let descending = fieldSort?.descending ?? false;
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
      member = el('TablixMember',
        el('Group', { Name: this.groupNames[level - 1] },
          el('GroupExpressions', el('GroupExpression', `=${expression}`)),
          pageBreak(areas.groupHeaders.get(level), areas.groupFooters.get(level)),
          filters.length ? el('Filters', ...filters) : null),
        el('SortExpressions', el('SortExpression', el('Value', sortValue), descending ? el('Direction', 'Descending') : null)),
        el('TablixMembers', ...headerMembers[level - 1], member, ...footerMembers[level - 1]));
    }

    const left = twipsToInches(columns[0].x);
    const width = columns.reduce((sum, c) => sum + c.width, 0);
    const tablix = el('Tablix', { Name: this.itemNames.make('Table') },
      el('TablixBody',
        el('TablixColumns', ...columns.map((c) => el('TablixColumn', el('Width', inches(c.width))))),
        el('TablixRows', ...rows)),
      el('TablixColumnHierarchy', el('TablixMembers', ...columns.map(() => el('TablixMember')))),
      el('TablixRowHierarchy', el('TablixMembers', ...headingMembers, member)),
      el('DataSetName', DATASET),
      el('Top', inches(top)),
      el('Left', inches(left)),
      el('Height', inches(height)),
      el('Width', inches(width)),
      el('Style', el('Border', el('Style', 'None'))));
    return { tablix, height, width, left };
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
    if (this.options.connectionString) return this.options.connectionString;
    const connection = this.source.connections[0];
    const props = new Map(Object.entries(connection?.properties ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const server = props.get('server') ?? props.get('data source') ?? props.get('server name');
    const database = props.get('database') ?? props.get('initial catalog');
    const isSqlServer = /sql|sqloledb|msoledbsql|sqlncli/i.test(`${connection?.driver ?? ''} ${props.get('provider') ?? ''} ${props.get('database type') ?? ''}`) || !!server;
    if (isSqlServer && server) {
      if (!database) this.note('Data source', 'the database name was not found; add "Initial Catalog" to the connection string');
      return `Data Source=${server};Initial Catalog=${database ?? 'YOUR_DATABASE'}`;
    }
    const original = [connection?.driver, connection?.database].filter(Boolean).join(', ');
    this.note('Data source', `the Crystal report used ${original || 'an unknown data source'}; replace the placeholder SQL Server connection string`);
    return 'Data Source=YOUR_SQL_SERVER;Initial Catalog=YOUR_DATABASE';
  }

  private quote(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  private tableRef(table: TableInfo): string {
    return `${table.schema ? `${this.quote(table.schema)}.` : ''}${this.quote(table.name)} AS ${this.quote(table.alias)}`;
  }

  private query(): { commandType?: string; text: string; parameters: XmlElement[]; fieldsFromAll: boolean } {
    const tables = this.source.tables;
    const commands = tables.filter((t) => t.kind === 'command');
    const procedures = tables.filter((t) => t.kind === 'storedProcedure');
    if (tables.length === 0) {
      this.note('Dataset', 'no tables were found in the report; write the query manually');
      return { text: '-- No tables found in the Crystal report', parameters: [], fieldsFromAll: true };
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
      const text = (commands[0].sql ?? '').replace(/'?\{\?([^}]+)\}'?/g, (_, name: string) => {
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
      this.note('Dataset', `calls stored procedure ${name}; check that its parameters match the report parameters`);
      return {
        commandType: 'StoredProcedure',
        text: procedure.schema ? `${this.quote(procedure.schema)}.${this.quote(name)}` : name,
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
        const f = dot > 0 ? this.fields.get(fieldKey(ref.slice(0, dot), ref.slice(dot + 1))) : undefined;
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
      const group = `${this.quote(others.group.table)}.${this.quote(others.group.column)}`;
      text = `SELECT\n${select},\n  ${others.operation}(${column}) OVER (PARTITION BY ${group}) AS ${this.quote(others.total)}\n${from.join('\n')}${where ? `\nWHERE ${where.sql}` : ''}`;
      text = `SELECT q.*,\n  DENSE_RANK() OVER (ORDER BY q.${this.quote(others.total)} ${others.descending ? 'DESC' : 'ASC'}, q.${this.quote(others.group.name)}) AS ${this.quote(others.rank)}\nFROM (\n${text}\n) AS q`;
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
        const f = this.fields.get(fieldKey(table, field));
        return f ? `${this.quote(f.table)}.${this.quote(f.column)}` : undefined;
      },
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

  private classify(layout: AreaInfo[]): Classified {
    const result: Classified = {
      pageHeader: [], pageFooter: [], reportHeader: [], reportFooter: [], detail: [],
      groupHeaders: new Map(), groupFooters: new Map(), columnHeadings: [],
    };
    // Crystal stores areas in a fixed order: page header, page footer, report header, report footer,
    // one group header/footer pair per group (outermost first), details, then an empty end marker.
    // Using the order keeps areas the report designer renamed (e.g. "Area2").
    // A subreport has no page header/footer areas, so its order starts at the report header.
    const real = layout.filter((a) => a.sections.length > 0);
    const fixed = this.options.subreport ? 3 : 5;
    const first = fixed - 3;
    const groups = (real.length - fixed) / 2;
    if (real.length >= fixed && Number.isInteger(groups)) {
      if (!this.options.subreport) {
        result.pageHeader.push(...real[0].sections);
        result.pageFooter.push(...real[1].sections);
      }
      result.reportHeader.push(...real[first].sections);
      result.reportFooter.push(...real[first + 1].sections);
      for (let i = 0; i < groups; i++) {
        result.groupHeaders.set(i + 1, real[first + 2 + i * 2].sections);
        result.groupFooters.set(groups - i, real[first + 3 + i * 2].sections);
      }
      result.detail.push(...real[real.length - 1].sections);
      return result;
    }
    let groupHeaderCount = 0;
    let groupFooterCount = 0;
    for (const area of layout) {
      const level = Number(/(\d+)$/.exec(area.name)?.[1] ?? 0);
      if (/^PageHeader/i.test(area.name)) result.pageHeader.push(...area.sections);
      else if (/^PageFooter/i.test(area.name)) result.pageFooter.push(...area.sections);
      else if (/^ReportHeader/i.test(area.name)) result.reportHeader.push(...area.sections);
      else if (/^ReportFooter/i.test(area.name)) result.reportFooter.push(...area.sections);
      else if (/^GroupHeader/i.test(area.name)) result.groupHeaders.set(level || ++groupHeaderCount, area.sections);
      else if (/^GroupFooter/i.test(area.name)) result.groupFooters.set(level || ++groupFooterCount, area.sections);
      else if (/^Detail/i.test(area.name) && area.sections.length > 0) result.detail.push(...area.sections);
      else if (area.sections.some((s) => s.objects.length > 0)) this.note(`Area "${area.name}"`, 'unrecognised area; its objects were not converted');
    }
    return result;
  }

  // ---- report ---------------------------------------------------------------------------

  build(): RdlResult {
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
    for (const p of def.parameters) this.parameterName(p.name);

    const areas = this.classify(def.layout);
    const detailXs = new Set(this.columnsFor(areas.detail.flatMap((s) => s.objects)).map((c) => c.x));
    // Page-header text objects aligned with detail columns are column headings: they go into the table.
    for (const section of areas.pageHeader) {
      const keep: ReportObject[] = [];
      for (const obj of section.objects) {
        const x = obj.position?.x;
        const isHeading = obj.kind === 'text' && x !== undefined && [...detailXs].some((dx) => Math.abs(dx - x) <= 144);
        (isHeading ? areas.columnHeadings : keep).push(obj);
      }
      section.objects = keep;
    }

    const bodyItems: XmlElement[] = [];
    let top = 0;
    for (const section of areas.reportHeader) {
      const placed = this.placeSection(section, top, 'body', 'Report Header');
      bodyItems.push(...placed.items);
      top += placed.height;
    }
    const table = this.buildTablix(areas, top);
    if (table.tablix) {
      bodyItems.push(table.tablix);
      top += table.height + 0.1;
    }
    for (const section of areas.reportFooter) {
      const placed = this.placeSection(section, top, 'body', 'Report Footer');
      bodyItems.push(...placed.items);
      top += placed.height;
    }
    const placeAll = (sections: SectionInfo[], label: string) => sections.reduce((acc, s) => {
      const placed = this.placeSection(s, acc.height, 'page', label);
      return { items: [...acc.items, ...placed.items], height: acc.height + placed.height };
    }, { items: [] as XmlElement[], height: 0 });
    const header = placeAll(areas.pageHeader, 'Page Header');
    const footer = placeAll(areas.pageFooter, 'Page Footer');

    let width = 0;
    for (const item of [...bodyItems, ...header.items, ...footer.items]) width = Math.max(width, itemRight(item));
    const [paperWidth, paperHeight] = PAPER_SIZES[def.page?.paperSize ?? 1] ?? PAPER_SIZES[1];
    const margins = def.margins
      ? { left: def.margins.left / TWIPS_PER_INCH, right: def.margins.right / TWIPS_PER_INCH, top: def.margins.top / TWIPS_PER_INCH, bottom: def.margins.bottom / TWIPS_PER_INCH }
      : { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN };
    const landscape = def.page ? def.page.orientation === 'landscape' : width > paperWidth - margins.left - margins.right;
    if (!def.page && landscape) this.note('Page', `the layout is ${inches(width)} wide, so the page was set to landscape; check the page setup`);
    if (def.page?.paperSize && !PAPER_SIZES[def.page.paperSize]) this.note('Page', `paper size code ${def.page.paperSize} is not mapped; Letter was used`);
    const pageWidth = landscape ? paperHeight : paperWidth;
    if (width > pageWidth - margins.left - margins.right + 0.01) this.note('Page', `the layout (${inches(width)}) is wider than the printable page; SSRS will add horizontal pages`);
    // A subreport's margins never apply: it prints inside the main report.
    if (!def.margins && !this.options.subreport) this.note('Page', 'the report uses the printer default margins; 0.25in margins were used');

    const query = this.query();
    const filters = this.selectionFilter();
    const datasetFields = [...this.fields.values()].filter((f) => f.used || query.fieldsFromAll || ![...this.fields.values()].some((x) => x.used));

    // Every parameter referenced anywhere must exist, including ones only formulas mention.
    const parameterList = [...this.parameterNames.entries()].flatMap(([key, name]) => {
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
    const parameters = parameterList.map((p) => el('ReportParameter', { Name: p.name },
      el('DataType', p.type),
      p.nullable ? el('Nullable', 'true') : null,
      el('Prompt', p.prompt),
      p.multiple ? el('MultiValue', 'true') : null));

    const report = el('Report', { MustUnderstand: 'df', xmlns: RDL_NS, 'xmlns:rd': RD_NS, 'xmlns:df': `${RDL_NS}/defaultfontfamily` },
      el('rd:ReportUnitType', 'Inch'),
      el('rd:ReportID', reportId(this.options.reportName)),
      el('df:DefaultFontFamily', 'Arial'),
      el('AutoRefresh', '0'),
      el('DataSources', el('DataSource', { Name: DATASOURCE },
        el('rd:SecurityType', 'Integrated'),
        el('ConnectionProperties',
          el('DataProvider', 'SQL'),
          el('ConnectString', this.connectionString()),
          el('IntegratedSecurity', 'true')),
        el('rd:DataSourceID', reportId(`${this.options.reportName}/${DATASOURCE}`)))),
      el('DataSets', el('DataSet', { Name: DATASET },
        el('Query',
          el('DataSourceName', DATASOURCE),
          query.parameters.length ? el('QueryParameters', ...query.parameters) : null,
          query.commandType ? el('CommandType', query.commandType) : null,
          el('CommandText', query.text)),
        el('Fields',
          ...datasetFields.map((f) => el('Field', { Name: f.name }, el('rd:TypeName', TYPE_NAMES[f.type] ?? 'System.String'), el('DataField', query.fieldsFromAll ? f.column : f.name))),
          ...[...this.sqlExpressions.values()].map((e) => el('Field', { Name: e.name }, el('rd:TypeName', 'System.Object'), el('DataField', e.name))),
          ...[...this.nextColumns.values()].map((n) => el('Field', { Name: n.name }, el('rd:TypeName', TYPE_NAMES[n.field.type] ?? 'System.Object'), el('DataField', n.name))),
          ...(this.othersGroup && !query.fieldsFromAll ? [
            el('Field', { Name: this.othersGroup.total }, el('rd:TypeName', 'System.Decimal'), el('DataField', this.othersGroup.total)),
            el('Field', { Name: this.othersGroup.rank }, el('rd:TypeName', 'System.Int64'), el('DataField', this.othersGroup.rank)),
          ] : []),
          ...this.calculated.map((c) => el('Field', { Name: c.name }, el('Value', c.expression)))),
        filters)),
      el('ReportSections', el('ReportSection',
        el('Body', el('ReportItems', ...bodyItems), el('Height', inches(Math.max(top, DEFAULT_HEIGHT))), el('Style')),
        el('Width', inches(Math.max(width, 1))),
        el('Page',
          header.items.length ? el('PageHeader', el('Height', inches(header.height)), el('PrintOnFirstPage', 'true'), el('PrintOnLastPage', 'true'), el('ReportItems', ...header.items), el('Style')) : null,
          footer.items.length ? el('PageFooter', el('Height', inches(footer.height)), el('PrintOnFirstPage', 'true'), el('PrintOnLastPage', 'true'), el('ReportItems', ...footer.items), el('Style')) : null,
          el('PageHeight', inches(landscape ? paperWidth : paperHeight)),
          el('PageWidth', inches(pageWidth)),
          el('LeftMargin', inches(margins.left)), el('RightMargin', inches(margins.right)),
          el('TopMargin', inches(margins.top)), el('BottomMargin', inches(margins.bottom)),
          el('Style')))),
      parameters.length ? el('ReportParameters', ...parameters) : null,
      parameters.length ? el('ReportParametersLayout', el('GridLayoutDefinition',
        el('NumberOfColumns', String(Math.min(4, parameters.length))),
        el('NumberOfRows', String(Math.ceil(parameters.length / 4))),
        el('CellDefinitions', ...parameterList.map((p, i) => el('CellDefinition',
          el('ColumnIndex', String(i % 4)), el('RowIndex', String(Math.floor(i / 4))), el('ParameterName', p.name)))))) : null,
      this.codeFunctions.length ? el('Code', [
        ...Object.entries(this.codeMembers).map(([name, type]) => `Dim ${name} As ${type}`),
        ...this.codeFunctions,
      ].join('\r\n\r\n')) : null,
      this.embeddedImages.length ? el('EmbeddedImages', ...this.embeddedImages) : null);

    for (const f of def.formulas.filter((f) => f.kind === 'conditionalFormat')) {
      const used = def.layout.some((a) => a.sections.some((s) =>
        Object.values(s.conditions ?? {}).some((c) => c.index === f.index) ||
        s.objects.some((o) => Object.values(o.conditions ?? {}).some((c) => c.index === f.index))));
      if (!used && f.text.trim()) this.note(`Formula {@${f.name}}`, 'is a formatting formula that no object uses in a decoded property; check whether it is still needed');
    }
    return { rdl: toXml(report), review: this.review };
  }
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
function itemRight(item: XmlElement): number {
  const read = (name: string) => {
    const child = item.children.find((c): c is XmlElement => typeof c === 'object' && c !== null && (c as XmlElement).name === name);
    return child ? parseFloat(String(child.children[0])) : 0;
  };
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
