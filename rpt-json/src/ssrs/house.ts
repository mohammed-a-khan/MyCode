/**
 * Lays converted Crystal reports out with a house template: an existing SSRS report whose look is copied.
 *
 * From the template:   data source, page setup, page header and footer (with the datasets, images and code they
 *                      use), parameters, and the styles of its first table: title row, column-heading row,
 *                      "no data" row, detail row and totals row (each cell's textbox is copied, so fonts,
 *                      colours, borders and expressions such as alternating row colours come along).
 * From each report:    its dataset (the Crystal report's own query or stored procedure), title, detail columns
 *                      with their headings and formats, and grand totals.
 *
 * Each report becomes one block (the template's table, or its rectangle around the table, with its page
 * break); several reports can be combined into one SSRS report, one block after another. A block with no rows
 * still shows its title and column headings, with the template's "no data" row.
 */

import type { DataSourceInfo, ReportDefinition } from '../crystal/model.ts';
import { vbString } from './formula.ts';
import { convertToBlock, NameSet, parameterElement, parametersLayout, sanitizeName, type BlockParts, type ParameterEntry, type ReviewNote } from './rdl.ts';
import { child, childElements, cloneElement, descendants, el, parseXml, textOf, toXml, type XmlElement } from './xml.ts';

/** A table row of the template, as a textbox to copy per cell. */
interface Slot {
  textbox: XmlElement;
}

interface RowTemplate {
  height: number;
  /** The row's static member in the row hierarchy (KeepWithGroup, RepeatOnNewPage, ...), without visibility. */
  member: XmlElement;
}

export interface HouseTemplate {
  root: XmlElement;
  dataSources: XmlElement[];
  dataSourceName: string;
  /** Datasets the template's page header/footer and styles read (branding, header data, ...). */
  supportDataSets: XmlElement[];
  /** Datasets of the template's own table (replaced by each report's dataset). */
  tableDataSets: string[];
  page?: XmlElement;
  bodyStyle?: XmlElement;
  width: number;
  parameters: XmlElement[];
  embeddedImages: XmlElement[];
  code?: string;
  /** Other top-level elements kept as they are (language, variables, custom properties, ...). */
  extras: XmlElement[];
  tablix: XmlElement;
  tablixName: string;
  rectangle?: XmlElement;
  /** The table's position inside its rectangle (or the body). */
  tableTop: number;
  tableLeft: number;
  /** Space from the top of the body to the first block. */
  bodyTop: number;
  title?: Slot & { text: string; row: RowTemplate };
  heading?: { first: Slot; other: Slot; row: RowTemplate };
  noData?: Slot & { text: string; row: RowTemplate };
  detail: { first: Slot; text: Slot; number: Slot; row: RowTemplate };
  total?: { label: Slot; value: Slot; blank: Slot; blankNumber: Slot; text: string; row: RowTemplate };
  warnings: string[];
}

const AGGREGATE = /\b(Sum|Count|CountDistinct|Avg|Min|Max|First|Last|RunningValue)\s*\(/i;

const inchesOf = (value: string | undefined): number => {
  const m = /^\s*([\d.]+)\s*(in|cm|mm|pt|pc)?\s*$/i.exec(value ?? '');
  if (!m) return 0;
  const n = Number(m[1]);
  switch ((m[2] ?? 'in').toLowerCase()) {
    case 'cm': return n / 2.54;
    case 'mm': return n / 25.4;
    case 'pt': return n / 72;
    case 'pc': return n / 6;
    default: return n;
  }
};
const inches = (value: number) => `${Math.round(value * 100000) / 100000}in`;

/** The first text run's value of a textbox. */
function runValue(textbox: XmlElement): string {
  return textOf(child(textbox, 'Paragraphs/Paragraph/TextRuns/TextRun/Value'));
}

const isStatic = (value: string) => !value.startsWith('=') || /^=\s*"([^"]|"")*"\s*$/.test(value);
const literal = (value: string) => (value.startsWith('=') ? value.replace(/^=\s*"|"\s*$/g, '').replace(/""/g, '"') : value);

/** Leaf members of a hierarchy, in row order. */
function leafMembers(members: XmlElement | undefined): XmlElement[] {
  return childElements(members ?? el('TablixMembers'), 'TablixMember').flatMap((m) => {
    const nested = child(m, 'TablixMembers');
    return nested ? leafMembers(nested) : [m];
  });
}

/** Names of datasets an element refers to: in DataSetName elements and as "Name" scopes in expressions. */
function referencedDataSets(root: XmlElement, names: string[]): Set<string> {
  const found = new Set<string>();
  for (const e of descendants(root)) {
    const text = textOf(e);
    if (!text) continue;
    for (const name of names) {
      if ((e.name === 'DataSetName' && text === name) || text.includes(`"${name}"`)) found.add(name);
    }
  }
  return found;
}

export function readHouseTemplate(xml: string): HouseTemplate {
  const root = parseXml(xml);
  if (root.name !== 'Report') throw new Error('the template is not a report definition (no <Report> element)');
  const namespace = root.attributes.xmlns ?? '';
  if (!/\/(2010|2016)\/01\/reportdefinition$/.test(namespace)) {
    throw new Error(`the template uses report definition schema "${namespace}"; open and save it in Report Builder or Visual Studio 2017 or later (RDL 2010/2016) first`);
  }
  const warnings: string[] = [];
  const section = child(root, 'ReportSections/ReportSection');
  const body = child(section, 'Body');
  if (!section || !body) throw new Error('the template has no report body');

  const dataSources = childElements(child(root, 'DataSources') ?? el('DataSources'), 'DataSource');
  if (!dataSources.length) throw new Error('the template has no data source');
  const dataSets = childElements(child(root, 'DataSets') ?? el('DataSets'), 'DataSet');
  const dataSetNames = dataSets.map((d) => d.attributes.Name);

  // The template's table: the first tablix in the body (directly or inside a rectangle).
  let tablix: XmlElement | undefined;
  let rectangle: XmlElement | undefined;
  for (const item of childElements(child(body, 'ReportItems') ?? el('ReportItems'))) {
    if (item.name === 'Tablix') {
      tablix = item;
      break;
    }
    if (item.name === 'Rectangle') {
      const inner = childElements(child(item, 'ReportItems') ?? el('ReportItems'), 'Tablix')[0];
      if (inner) {
        tablix = inner;
        rectangle = item;
        break;
      }
    }
  }
  if (!tablix) throw new Error('the template has no table in its body to copy the styles from');
  const tableDataSets = [textOf(child(tablix, 'DataSetName'))].filter(Boolean);

  // Datasets the rest of the report needs: those the page header/footer, styles or parameters read.
  const page = child(section, 'Page');
  const parameters = childElements(child(root, 'ReportParameters') ?? el('ReportParameters'), 'ReportParameter');
  const keep = new Set<string>();
  if (page) for (const n of referencedDataSets(page, dataSetNames)) keep.add(n);
  for (const style of descendants(root).filter((e) => e.name === 'Style')) for (const n of referencedDataSets(style, dataSetNames)) keep.add(n);
  for (const p of parameters) for (const n of referencedDataSets(p, dataSetNames)) keep.add(n);
  const supportDataSets = dataSets.filter((d) => keep.has(d.attributes.Name));
  for (const d of dataSets) {
    if (!keep.has(d.attributes.Name) && !tableDataSets.includes(d.attributes.Name)) {
      warnings.push(`dataset ${d.attributes.Name} of the template is not used by its page header, footer, styles or parameters; it was left out`);
    }
  }

  // Rows of the table, by role.
  const columnCount = childElements(child(tablix, 'TablixBody/TablixColumns') ?? el('TablixColumns'), 'TablixColumn').length;
  const rows = childElements(child(tablix, 'TablixBody/TablixRows') ?? el('TablixRows'), 'TablixRow');
  const members = leafMembers(child(tablix, 'TablixRowHierarchy/TablixMembers'));
  const memberTemplate = (member: XmlElement | undefined): XmlElement => {
    const copy = cloneElement(member ?? el('TablixMember'));
    copy.children = copy.children.filter((c) => typeof c !== 'object' || !c || !['Visibility', 'Group', 'SortExpressions', 'TablixMembers', 'TablixHeader'].includes((c as XmlElement).name));
    return copy;
  };
  let title: HouseTemplate['title'];
  let heading: HouseTemplate['heading'];
  let noData: HouseTemplate['noData'];
  let detail: HouseTemplate['detail'] | undefined;
  let total: HouseTemplate['total'];
  rows.forEach((row, index) => {
    const cells = childElements(child(row, 'TablixCells') ?? el('TablixCells'), 'TablixCell');
    const boxes = cells.map((c) => ({ textbox: child(c, 'CellContents/Textbox'), span: Number(textOf(child(c, 'CellContents/ColSpan')) || 1) }))
      .filter((b): b is { textbox: XmlElement; span: number } => Boolean(b.textbox));
    if (!boxes.length) return;
    const values = boxes.map((b) => runValue(b.textbox));
    const member = members[index];
    const rowTemplate: RowTemplate = { height: inchesOf(textOf(child(row, 'Height'))) || 0.25, member: memberTemplate(member) };
    const fullWidth = boxes.length === 1 && (boxes[0].span >= columnCount || columnCount === 1);
    const isDetailMember = Boolean(member && child(member, 'Group') && !child(member, 'Group/GroupExpressions'));
    if (values.some((v) => AGGREGATE.test(v))) {
      if (total) return;
      const label = boxes.find((b, i) => isStatic(values[i]) && literal(values[i]).trim()) ?? boxes[0];
      const value = boxes.find((_, i) => AGGREGATE.test(values[i]))!;
      const blanks = boxes.filter((_, i) => !values[i].trim());
      const hasFormat = (b: { textbox: XmlElement }) => descendants(b.textbox).some((e) => e.name === 'Format');
      const blank = blanks.find((b) => !hasFormat(b)) ?? blanks[0] ?? label;
      total = {
        label: { textbox: label.textbox }, value: { textbox: value.textbox },
        blank: { textbox: blank.textbox }, blankNumber: { textbox: (blanks.find(hasFormat) ?? blank).textbox },
        text: literal(runValue(label.textbox)).trim(), row: rowTemplate,
      };
    } else if (isDetailMember || (values.some((v) => v.includes('Fields!')) && !fullWidth)) {
      if (detail) return;
      const hasFormat = (b: { textbox: XmlElement }) => descendants(b.textbox).some((e) => e.name === 'Format');
      const rest = boxes.slice(1);
      const number = rest.find(hasFormat) ?? rest[0] ?? boxes[0];
      const text = rest.find((b) => !hasFormat(b)) ?? boxes[0];
      detail = { first: { textbox: boxes[0].textbox }, text: { textbox: text.textbox }, number: { textbox: number.textbox }, row: rowTemplate };
    } else if (fullWidth) {
      const text = literal(values[0]);
      const hidden = Boolean(member && child(member, 'Visibility'));
      if (!title && !hidden && !heading) title = { textbox: boxes[0].textbox, text, row: rowTemplate };
      else if (!noData) noData = { textbox: boxes[0].textbox, text, row: rowTemplate };
    } else if (!heading && !detail) {
      heading = { first: { textbox: boxes[0].textbox }, other: { textbox: (boxes[1] ?? boxes[0]).textbox }, row: rowTemplate };
    }
  });
  if (!detail) throw new Error('the template\'s table has no detail row (a row showing field values) to copy the styles from');
  if (!heading) warnings.push('the template\'s table has no column-heading row; the reports\' headings were left out');

  const bodyItems = childElements(child(body, 'ReportItems') ?? el('ReportItems'));
  const holder = rectangle ?? tablix;
  const extras = childElements(root).filter((e) => ![
    'DataSources', 'DataSets', 'ReportSections', 'ReportParameters', 'ReportParametersLayout', 'Code', 'EmbeddedImages',
    'rd:ReportID', 'am:AuthoringMetadata',
  ].includes(e.name));
  return {
    root,
    dataSources,
    dataSourceName: dataSources[0].attributes.Name,
    supportDataSets,
    tableDataSets,
    page,
    bodyStyle: child(body, 'Style'),
    width: inchesOf(textOf(child(section, 'Width'))),
    parameters,
    embeddedImages: childElements(child(root, 'EmbeddedImages') ?? el('EmbeddedImages'), 'EmbeddedImage'),
    code: textOf(child(root, 'Code')) || undefined,
    extras,
    tablix,
    tablixName: tablix.attributes.Name,
    rectangle,
    tableTop: rectangle ? inchesOf(textOf(child(tablix, 'Top'))) : 0,
    tableLeft: rectangle ? inchesOf(textOf(child(tablix, 'Left'))) : 0,
    bodyTop: Math.min(...bodyItems.filter((i) => i === holder).map((i) => inchesOf(textOf(child(i, 'Top'))))),
    title, heading, noData, detail, total,
    warnings,
  };
}

/** A report to place as a block. */
export interface HouseInput {
  /** Name for the block's dataset and items (the report's file name). */
  name: string;
  definition: ReportDefinition;
  dataSource?: DataSourceInfo;
}

export interface HouseResult {
  rdl: string;
  review: ReviewNote[];
}

/** Builds one SSRS report from one or more Crystal reports, laid out with the house template. */
export function buildHouseReport(template: HouseTemplate, inputs: HouseInput[], reportName: string): HouseResult {
  const review: ReviewNote[] = template.warnings.map((message) => ({ item: 'Template', message }));
  const itemNames = new NameSet();
  const imageNames = new NameSet();
  const codeNames = new NameSet();
  const dataSetNames = new NameSet();
  // Names already used by what is copied from the template.
  const pageItems = template.page ? descendants(template.page) : [];
  for (const e of pageItems) if (e.attributes.Name && e.name !== 'ReportParameter') itemNames.make(e.attributes.Name);
  for (const image of template.embeddedImages) imageNames.make(image.attributes.Name);
  for (const d of template.supportDataSets) dataSetNames.make(d.attributes.Name);

  const blocks: { input: HouseInput; parts: BlockParts }[] = inputs.map((input) => {
    const dataset = dataSetNames.make(input.name);
    const parts = convertToBlock(input.definition, input.dataSource, {
      reportName: input.name,
      inline: { dataset, itemNames, imageNames, codeNames },
    });
    for (const n of parts.review) review.push({ item: inputs.length > 1 ? `${input.name}: ${n.item}` : n.item, message: n.message });
    if (!parts.columns.length) review.push({ item: input.name, message: 'the report has no detail fields; its block shows only the title' });
    return { input, parts };
  });

  // Body: one block per report, stacked.
  const bodyItems: XmlElement[] = [];
  let top = Number.isFinite(template.bodyTop) ? template.bodyTop : 0;
  let width = template.width;
  for (const { input, parts } of blocks) {
    const table = houseTable(template, parts, input.name, itemNames);
    const holderLeft = inchesOf(textOf(child(template.rectangle ?? template.tablix, 'Left')));
    if (template.rectangle) {
      const rect = cloneElement(template.rectangle);
      rect.attributes.Name = itemNames.make(`${input.name}_Block`);
      // The rectangle's own expressions (visibility, ...) read the block's data instead of the template's.
      for (const e of descendants(rect)) {
        e.children = e.children.map((c) => (typeof c === 'string' ? template.tableDataSets.reduce((t, own) => t.split(`"${own}"`).join(vbString(parts.datasetName)), c) : c));
      }
      const tableHeight = template.tableTop + table.height;
      const originalTableBottom = template.tableTop + inchesOf(textOf(child(template.tablix, 'Height')));
      const padding = Math.max(0.05, Math.min(0.5, inchesOf(textOf(child(template.rectangle, 'Height'))) - originalTableBottom - footnoteHeight(template)));
      setChild(table.item, 'Top', inches(template.tableTop));
      setChild(table.item, 'Left', inches(template.tableLeft));
      rect.children = rect.children.map((c) => (typeof c === 'object' && c && (c as XmlElement).name === 'ReportItems' ? el('ReportItems', table.item) : c));
      setChild(rect, 'Top', inches(top));
      setChild(rect, 'Height', inches(tableHeight + padding));
      const rectWidth = Math.max(inchesOf(textOf(child(template.rectangle, 'Width'))), template.tableLeft + table.width);
      setChild(rect, 'Width', inches(rectWidth));
      bodyItems.push(rect);
      top += tableHeight + padding;
      width = Math.max(width, holderLeft + rectWidth);
    } else {
      setChild(table.item, 'Top', inches(top));
      setChild(table.item, 'Left', inches(holderLeft));
      bodyItems.push(table.item);
      top += table.height + 0.25;
      width = Math.max(width, holderLeft + table.width);
    }
  }

  // Parameters: the template's, then any other parameter the reports need.
  const parameterNames = template.parameters.map((p) => p.attributes.Name);
  const extraParameters: ParameterEntry[] = [];
  for (const { parts } of blocks) {
    for (const p of parts.parameters) {
      const same = (n: string) => n.toLowerCase() === p.name.toLowerCase();
      if (parameterNames.some(same) || extraParameters.some((x) => same(x.name))) continue;
      extraParameters.push(p);
    }
  }
  const parameters = [...template.parameters, ...extraParameters.map(parameterElement)];

  // Code: the template's, then the reports' (helpers shared by several reports once).
  const codeParts: string[] = template.code ? [template.code] : [];
  const members = new Map<string, string>();
  for (const { parts } of blocks) {
    for (const [name, type] of Object.entries(parts.codeMembers)) members.set(name, type);
    for (const code of parts.codeFunctions) if (!codeParts.includes(code)) codeParts.push(code);
  }
  const code = [...[...members].map(([name, type]) => `Dim ${name} As ${type}`), ...codeParts].join('\r\n\r\n');

  const pageElement = template.page ? cloneElement(template.page) : el('Page');
  const report = el('Report', { ...template.root.attributes },
    ...template.extras.map(cloneElement),
    el('DataSources', ...template.dataSources.map(cloneElement)),
    el('DataSets', ...template.supportDataSets.map(cloneElement), ...blocks.map(({ parts }) => parts.dataset(template.dataSourceName))),
    el('ReportSections', el('ReportSection',
      el('Body', el('ReportItems', ...bodyItems), el('Height', inches(Math.max(top, 0.25))), template.bodyStyle ? cloneElement(template.bodyStyle) : el('Style')),
      el('Width', inches(width)),
      pageElement)),
    parameters.length ? el('ReportParameters', ...parameters) : null,
    parametersLayout(parameters.map((p) => p.attributes.Name)),
    code ? el('Code', code) : null,
    template.embeddedImages.length ? el('EmbeddedImages', ...template.embeddedImages.map(cloneElement)) : null,
    el('rd:ReportID', reportGuid(reportName)));
  if (!report.attributes['xmlns:rd']) report.attributes['xmlns:rd'] = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';

  review.push({
    item: 'Data source',
    message: `every report's data comes from the template's data source "${template.dataSourceName}", with the Crystal report's own query or stored procedure; check it points to the database the Crystal reports read`,
  });
  return { rdl: toXml(report), review };
}

/** Height of a text box below the table inside the template's rectangle (a footnote), if any. */
function footnoteHeight(template: HouseTemplate): number {
  if (!template.rectangle) return 0;
  return childElements(child(template.rectangle, 'ReportItems') ?? el('ReportItems'))
    .filter((i) => i !== template.tablix)
    .reduce((sum, i) => sum + inchesOf(textOf(child(i, 'Height'))), 0);
}

function setChild(parent: XmlElement, name: string, value: string): void {
  const existing = childElements(parent, name)[0];
  if (existing) existing.children = [value];
  else parent.children.push(el(name, value));
}

/** A copy of a template textbox with a new name, value and format. */
function fillTextbox(slot: Slot, name: string, value: string, format: string | undefined, rename: (text: string) => string, keepFormat = false): XmlElement {
  const box = cloneElement(slot.textbox);
  box.attributes.Name = name;
  // Expressions copied from the template that read the template's own table data now read the block's.
  for (const e of descendants(box)) {
    e.children = e.children.map((c) => (typeof c === 'string' ? rename(c) : c));
  }
  box.children = box.children.filter((c) => typeof c !== 'object' || !c || !['rd:Selected', 'rd:DefaultName'].includes((c as XmlElement).name));
  const paragraphs = child(box, 'Paragraphs');
  const paragraph = paragraphs ? childElements(paragraphs, 'Paragraph')[0] : undefined;
  const runs = paragraph ? child(paragraph, 'TextRuns') : undefined;
  const run = runs ? childElements(runs, 'TextRun')[0] : undefined;
  if (!paragraphs || !paragraph || !runs || !run) return box;
  // One paragraph with one run holds the value.
  paragraphs.children = [paragraph];
  runs.children = [run];
  setChild(run, 'Value', value);
  let style = child(run, 'Style');
  if (!style) {
    style = el('Style');
    run.children.push(style);
  }
  const hasFormat = Boolean(child(style, 'Format'));
  if (format && !(keepFormat && hasFormat)) setChild(style, 'Format', format);
  else if (!format && !keepFormat) style.children = style.children.filter((c) => typeof c !== 'object' || !c || (c as XmlElement).name !== 'Format');
  return box;
}

/** Crystal's default formats for a type, which the template's own number format replaces. */
const DEFAULT_FORMATS = new Set(['C2', 'N2', 'N0', 'P2']);

/**
 * The format for a value in a template cell: the report's own format when it set one, otherwise undefined to
 * keep the template's; whole numbers (N0) get the template's format without decimals.
 */
function numberFormat(slot: Slot, format: string | undefined): string | undefined {
  if (!format || !DEFAULT_FORMATS.has(format)) return format;
  const own = descendants(slot.textbox).find((e) => e.name === 'Format');
  const ownText = own ? textOf(own) : '';
  if (format === 'N0' && ownText && !ownText.startsWith('=')) return ownText.replace(/\.0+/g, '').replace(/\.#+/g, '');
  return undefined;
}

function houseTable(template: HouseTemplate, parts: BlockParts, name: string, names: NameSet): { item: XmlElement; height: number; width: number } {
  const tableName = names.make(`${name}_Table`);
  const dataset = parts.datasetName;
  const renameScopes = (text: string) => {
    let out = text;
    for (const own of template.tableDataSets) out = out.split(`"${own}"`).join(vbString(dataset));
    return out.split(template.tablixName).join(tableName);
  };
  const columns = parts.columns.length ? parts.columns : [{ name: 'Empty', heading: '', value: '', numeric: false, width: 2 }];
  const count = columns.length;
  // Column widths in the Crystal report's proportions, spread over the template table's width.
  const available = Math.max(1, template.width - inchesOf(textOf(child(template.rectangle ?? template.tablix, 'Left'))) - template.tableLeft);
  const target = Math.min(available, inchesOf(textOf(child(template.tablix, 'Width'))) || available);
  const natural = columns.reduce((sum, c) => sum + c.width, 0);
  const widths = columns.map((c) => Math.max(0.3, (c.width * target) / natural));
  const width = widths.reduce((sum, w) => sum + w, 0);
  const title = parts.title ?? name.replace(/_/g, ' ');

  const rows: XmlElement[] = [];
  const memberList: XmlElement[] = [];
  let height = 0;
  const cell = (textbox: XmlElement, span = 1) => el('TablixCell', el('CellContents', textbox, span > 1 ? el('ColSpan', String(span)) : null));
  const addRow = (rowTemplate: RowTemplate, cells: XmlElement[], hidden?: string) => {
    rows.push(el('TablixRow', el('Height', inches(rowTemplate.height)), el('TablixCells', ...cells)));
    height += rowTemplate.height;
    const member = cloneElement(rowTemplate.member);
    if (hidden) member.children.unshift(el('Visibility', el('Hidden', hidden)));
    memberList.push(member);
  };
  const spanRow = (textbox: XmlElement) => [cell(textbox, count), ...Array.from({ length: count - 1 }, () => el('TablixCell'))];
  const swapTitle = (text: string) => {
    // The template's message names its own report: put this block's title in its place.
    const own = template.title?.text.trim();
    if (!own) return text;
    const at = text.toLowerCase().indexOf(own.toLowerCase());
    if (at < 0) return text;
    const replacement = text === text.toUpperCase() ? title.toUpperCase() : title;
    return text.slice(0, at) + replacement + text.slice(at + own.length);
  };

  if (template.title) {
    addRow(template.title.row, spanRow(fillTextbox(template.title, names.make(`${name}_Title`), title, undefined, renameScopes)));
  }
  if (template.heading) {
    const heading = template.heading;
    addRow(heading.row, columns.map((c, i) =>
      cell(fillTextbox(i === 0 ? heading.first : heading.other, names.make(`${name}_${c.name}_Heading`), c.heading, undefined, renameScopes))));
  }
  const countRows = `CountRows(${vbString(dataset)})`;
  if (template.noData) {
    const message = swapTitle(template.noData.text);
    addRow(template.noData.row, spanRow(fillTextbox(template.noData, names.make(`${name}_NoData`), `=${vbString(message)}`, undefined, renameScopes)), `=${countRows} > 0`);
  }
  // Detail row.
  const detail = template.detail;
  const detailCells = columns.map((c, i) => {
    const slot = i === 0 ? detail.first : c.numeric ? detail.number : detail.text;
    const format = numberFormat(slot, c.format);
    return cell(fillTextbox(slot, names.make(`${name}_${c.name}_Value`), c.value, format, renameScopes, format === undefined && c.numeric));
  });
  rows.push(el('TablixRow', el('Height', inches(detail.row.height)), el('TablixCells', ...detailCells)));
  height += detail.row.height;
  memberList.push(el('TablixMember',
    el('Group', { Name: names.make(`${name}_Details`) }),
    parts.sorts.length ? el('SortExpressions', ...parts.sorts.map((s) => el('SortExpression', el('Value', s.expression), s.descending ? el('Direction', 'Descending') : null))) : null));
  // Totals row, when the report has totals.
  const total = template.total;
  if (total && columns.some((c) => c.total)) {
    const label = parts.totalLabel ?? total.text;
    const totalCells = columns.map((c, i) => {
      if (c.total) {
        const format = numberFormat(total.value, c.total.format);
        return cell(fillTextbox(total.value, names.make(`${name}_${c.name}_Total`), c.total.value, format, renameScopes, format === undefined));
      }
      if (i === 0) return cell(fillTextbox(total.label, names.make(`${name}_TotalLabel`), label, undefined, renameScopes));
      return cell(fillTextbox(c.numeric ? total.blankNumber : total.blank, names.make(`${name}_${c.name}_Blank`), '', undefined, renameScopes));
    });
    addRow(total.row, totalCells, `=${countRows} = 0`);
  }

  // Settings of the template's table other than its layout and data (repeat headers, page breaks, ...).
  const own = new Set(['TablixBody', 'TablixColumnHierarchy', 'TablixRowHierarchy', 'DataSetName', 'Top', 'Left', 'Height', 'Width', 'Filters', 'SortExpressions', 'NoRowsMessage', 'rd:DefaultName']);
  const settings = childElements(template.tablix).filter((e) => !own.has(e.name)).map((e) => {
    const copy = cloneElement(e);
    for (const d of descendants(copy)) d.children = d.children.map((c) => (typeof c === 'string' ? renameScopes(c) : c));
    return copy;
  });
  const style = settings.find((e) => e.name === 'Style');
  const item = el('Tablix', { Name: tableName },
    el('TablixBody',
      el('TablixColumns', ...widths.map((w) => el('TablixColumn', el('Width', inches(w))))),
      el('TablixRows', ...rows)),
    el('TablixColumnHierarchy', el('TablixMembers', ...columns.map(() => el('TablixMember')))),
    el('TablixRowHierarchy', el('TablixMembers', ...memberList)),
    ...settings.filter((e) => e !== style),
    el('DataSetName', dataset),
    el('Top', '0in'),
    el('Left', '0in'),
    el('Height', inches(height)),
    el('Width', inches(width)),
    style ?? el('Style', el('Border', el('Style', 'None'))));
  return { item, height, width };
}

/** A stable GUID-shaped id for a report name. */
function reportGuid(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of name) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = Math.imul(h2 + ch.charCodeAt(0), 2246822519) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export { sanitizeName };
