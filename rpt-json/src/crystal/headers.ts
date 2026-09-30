/**
 * Header text of a report: titles and labels in the report and page headers, group headers, column headings
 * above the detail rows, and chart titles; optionally also footer and detail text. Subreports are included,
 * labelled with the area of the main report they sit in.
 */

import { classifyAreas, type ClassifiedAreas } from './areas.ts';
import type { ReportDefinition, ReportObject, SectionInfo } from './model.ts';

export interface HeaderText {
  /** Source file name, when known. */
  file?: string;
  /** "Main report", or the subreport ("Subdocument 1") with the area it sits in. */
  report: string;
  /** "Report Header", "Page Header", "Group Header 1", ... */
  area: string;
  section: string;
  /** "column heading", "text", "chart title" or (with all) "field". */
  kind: 'column heading' | 'text' | 'chart title' | 'field';
  /** Column number, left to right, for column headings. */
  column?: number;
  /** The text; embedded database fields appear as {Table.Field}. */
  text: string;
  object: string;
  /** Position in inches from the section's top-left corner. */
  x: number;
  y: number;
}

export interface HeaderOptions {
  /** Also list footer and detail text, and field objects. */
  all?: boolean;
  file?: string;
}

interface ReportModel {
  storage: string;
  definition?: ReportDefinition;
}

const TWIPS_PER_INCH = 1440;
const round = (twips: number | undefined) => Math.round(((twips ?? 0) / TWIPS_PER_INCH) * 1000) / 1000;

/** The visible text of a text object: its runs with embedded fields as {Table.Field}; lines separated by "\n". */
function objectText(obj: ReportObject): string {
  const text = obj.runs?.length ? obj.runs.map((r) => ('field' in r ? `{${r.field}}` : r.text)).join('') : obj.text ?? '';
  return text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Areas in reading order, as [label, sections, isHeader]. */
function orderedAreas(areas: ClassifiedAreas, all: boolean): [string, SectionInfo[]][] {
  const levels = [...new Set([...areas.groupHeaders.keys(), ...areas.groupFooters.keys()])].sort((a, b) => a - b);
  const list: [string, SectionInfo[], boolean][] = [
    ['Report Header', areas.reportHeader, true],
    ['Page Header', areas.pageHeader, true],
    ...levels.map((l): [string, SectionInfo[], boolean] => [`Group Header ${l}`, areas.groupHeaders.get(l) ?? [], true]),
    ['Details', areas.detail, false],
    ...[...levels].reverse().map((l): [string, SectionInfo[], boolean] => [`Group Footer ${l}`, areas.groupFooters.get(l) ?? [], false]),
    ['Report Footer', areas.reportFooter, false],
    ['Page Footer', areas.pageFooter, false],
  ];
  return list.filter(([, sections, isHeader]) => sections.length > 0 && (isHeader || all)).map(([label, sections]) => [label, sections]);
}

/** Horizontal extent of an object in twips. */
const extent = (obj: ReportObject) => ({ left: obj.position?.x ?? 0, right: (obj.position?.x ?? 0) + (obj.size?.width ?? 0) });

/**
 * Text objects that label the detail columns. A heading sits mostly within one detail column's span (a
 * description running across several columns is not a heading). Two or more such texts on one row are
 * column headings; a single one counts when it lines up with its column's left or right edge and nothing
 * else (a field value) shares its row, as a form label would.
 */
function columnHeadings(section: SectionInfo, detailObjects: ReportObject[]): Set<ReportObject> {
  const columns = detailObjects.filter((o) => o.position).map(extent);
  /** The detail column a text heads, if any. */
  const columnOf = (obj: ReportObject): number => {
    const e = extent(obj);
    const width = e.right - e.left || 1;
    let best = -1;
    let bestOverlap = 0;
    columns.forEach((c, i) => {
      const overlap = Math.min(e.right, c.right) - Math.max(e.left, c.left);
      const columnWidth = c.right - c.left || 1;
      const fits = overlap >= 0.5 * width || (overlap >= 0.8 * columnWidth && width <= 2.5 * columnWidth);
      if (overlap > bestOverlap && fits) {
        best = i;
        bestOverlap = overlap;
      }
    });
    return best;
  };
  const sameRow = (a: ReportObject, b: ReportObject) => Math.abs((a.position?.y ?? 0) - (b.position?.y ?? 0)) <= 120;
  // A heading is a short label: one line, no database values in it, and not in a title's larger font.
  const detailSize = Math.max(0, ...detailObjects.map((o) => o.style?.size ?? 0));
  const isLabel = (o: ReportObject) => {
    const text = objectText(o);
    if (detailSize && (o.style?.size ?? 0) > detailSize + 2) return false;
    return text.length > 0 && text.length <= 60 && !o.runs?.some((r) => 'field' in r);
  };
  const candidates = section.objects
    .filter((o) => o.kind === 'text' && o.position && isLabel(o))
    .map((o) => ({ obj: o, column: columnOf(o) }))
    .filter((c) => c.column >= 0);
  const result = new Set<ReportObject>();
  for (const c of candidates) {
    const row = candidates.filter((o) => sameRow(o.obj, c.obj));
    if (new Set(row.map((o) => o.column)).size >= 2) {
      result.add(c.obj);
      continue;
    }
    const col = columns[c.column];
    const e = extent(c.obj);
    const narrow = e.right - e.left <= 1.5 * (col.right - col.left || 1);
    const aligned = narrow && (Math.abs(e.left - col.left) <= 144 || Math.abs(e.right - col.right) <= 144);
    const alone = !section.objects.some((o) => o !== c.obj && o.position && sameRow(o, c.obj));
    if (row.length === 1 && aligned && alone) result.add(c.obj);
  }
  return result;
}

function reportHeaders(definition: ReportDefinition, report: string, subreport: boolean, options: HeaderOptions): HeaderText[] {
  const areas = classifyAreas(definition.layout, subreport);
  const detailObjects = areas.detail.flatMap((s) => s.objects);
  const out: HeaderText[] = [];
  for (const [area, sections] of orderedAreas(areas, options.all ?? false)) {
    for (const section of sections) {
      const headings = area === 'Details' ? new Set<ReportObject>() : columnHeadings(section, detailObjects);
      const columnOrder = [...headings].sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
      const objects = [...section.objects].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
      for (const obj of objects) {
        const base = { ...(options.file ? { file: options.file } : {}), report, area, section: section.name, object: obj.name, x: round(obj.position?.x), y: round(obj.position?.y) };
        if (obj.kind === 'text') {
          const text = objectText(obj);
          if (!text) continue;
          if (headings.has(obj)) out.push({ ...base, kind: 'column heading', column: columnOrder.indexOf(obj) + 1, text });
          else out.push({ ...base, kind: 'text', text });
        } else if (obj.kind === 'chart' && obj.chart) {
          for (const title of [obj.chart.title, obj.chart.categoryTitle, obj.chart.valueTitle]) {
            if (title?.trim()) out.push({ ...base, kind: 'chart title', text: title.trim() });
          }
        } else if (obj.kind === 'field' && obj.field && options.all) {
          out.push({ ...base, kind: 'field', text: `{${obj.field}}` });
        }
      }
    }
  }
  return out;
}

/** Header text of a report and its subreports (the models buildMetadata returns). */
export function extractHeaders(reports: ReportModel[], options: HeaderOptions = {}): HeaderText[] {
  const main = reports.find((r) => !r.storage)?.definition;
  // Where each subreport sits in the main report.
  const placement = new Map<number, string>();
  if (main) {
    const areas = classifyAreas(main.layout);
    for (const [area, sections] of orderedAreas(areas, true)) {
      for (const obj of sections.flatMap((s) => s.objects)) {
        if (obj.kind === 'subreport' && obj.subreport) placement.set(obj.subreport.index, area);
      }
    }
  }
  const out: HeaderText[] = [];
  for (const model of reports) {
    if (!model.definition) continue;
    const index = Number(/^Subdocument (\d+)$/.exec(model.storage)?.[1]);
    const where = placement.get(index);
    const report = model.storage ? `${model.storage}${where ? ` (in ${where})` : ''}` : 'Main report';
    out.push(...reportHeaders(model.definition, report, Boolean(model.storage), options));
  }
  return out;
}

/** Readable listing, grouped by report and area; column headings on one line, left to right. */
export function formatHeadersText(items: HeaderText[]): string {
  const lines: string[] = [];
  let file: string | undefined;
  let report: string | undefined;
  let area: string | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.file !== file) {
      file = item.file;
      report = area = undefined;
      if (file) lines.push(file);
    }
    const indent = file ? '  ' : '';
    if (item.report !== report) {
      report = item.report;
      area = undefined;
      lines.push(`${indent}${report}`);
    }
    if (item.area !== area) {
      area = item.area;
      lines.push(`${indent}  ${area}`);
    }
    if (item.kind === 'column heading') {
      // All column headings of a section go on one line, at the first of them, left to right.
      const sameSection: HeaderText[] = [];
      for (let j = i; j < items.length && items[j].section === item.section && items[j].report === item.report && items[j].file === item.file; j++) {
        if (items[j].kind === 'column heading') sameSection.push(items[j]);
      }
      const first = items.findIndex((h) => h.kind === 'column heading' && h.section === item.section && h.report === item.report && h.file === item.file);
      if (first === i) {
        const row = sameSection.sort((a, b) => (a.column ?? 0) - (b.column ?? 0)).map((h) => h.text.replace(/\n/g, ' '));
        lines.push(`${indent}    ${'column headings'.padEnd(16)}  ${row.join(' | ')}`);
      }
      continue;
    }
    lines.push(`${indent}    ${item.kind.padEnd(16)}  ${item.text.replace(/\n/g, ' / ')}`);
  }
  return lines.join('\n') + '\n';
}

const csvCell = (value: unknown) => {
  let text = value === undefined ? '' : String(value);
  // Excel runs a cell starting with = + - @ as a formula; a leading ' keeps it text.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function formatHeadersCsv(items: HeaderText[]): string {
  const columns: (keyof HeaderText)[] = ['file', 'report', 'area', 'section', 'kind', 'column', 'text', 'object', 'x', 'y'];
  return [columns.join(','), ...items.map((item) => columns.map((c) => csvCell(item[c])).join(','))].join('\r\n') + '\r\n';
}
