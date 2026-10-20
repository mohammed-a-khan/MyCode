/** Converts a whole .rpt (main report and subreports) into SSRS report definitions. */

import { buildMetadata, type ReportModel } from '../json.ts';
import type { CfbDocument, CfbNode, CfbStorage } from '../cfb/types.ts';
import { convertToRdl, sanitizeName, type ReviewNote, type SubreportInfo } from './rdl.ts';
import { buildHouseReport, type HouseInput, type HouseTemplate } from './house.ts';
import { classifyAreas } from '../crystal/areas.ts';
import { extractHeaders } from '../crystal/headers.ts';

export interface ConvertedReport {
  /** File name for the .rdl (without directory). */
  fileName: string;
  /** Storage path inside the .rpt ("" for the main report). */
  storage: string;
  rdl: string;
  review: ReviewNote[];
  /** Files to write beside the .rdl, by the ending that replaces ".rdl" (".sql", ".code.vb"). */
  files?: Record<string, string>;
}

export interface SsrsOptions {
  /** Overrides the generated connection string for every report. */
  connectionString?: string;
  /** A shared data source on the report server, used instead of an embedded connection. */
  sharedDataSource?: string;
  /** Keep every subreport as its own .rdl (by default those outside the table are built into the report). */
  separateSubreports?: boolean;
  /** Add "Page N" at the right of the page footer. */
  pageNumber?: boolean;
  /** Parameter values to convert for: suppress formulas that depend only on them are decided at conversion. */
  parameterValues?: Record<string, string>;
  /** Number format for chart value axes the .rpt does not show (e.g. "0.00%"). */
  chartAxisFormat?: string;
  /** Formulas worked out per record become columns of the query where SQL gives exactly the same. */
  formulasInQuery?: boolean;
  /** Rules moved by formulas with a field are drawn as the text's underline or overline. */
  rulesAsText?: boolean;
  /** A last step over each report's RDL (a house style laid over the Crystal layout, ...). */
  restyle?: (rdl: string) => string;
  partsFormat?: 'standalone' | 'report';
  /** The very last step: the report reshaped as a team's template (names, structure, looks), with notes. */
  reshape?: (rdl: string, reportName: string, extra?: { sqlFunctions?: string[]; prefix?: string }) => { rdl: string; review: ReviewNote[]; settled?: string[]; settles?: RegExp; files?: Record<string, string> };
}

const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Report';

export function convertDocumentToSsrs(doc: CfbDocument, baseName: string, options: SsrsOptions = {}): ConvertedReport[] {
  const models = buildMetadata(doc).reports ?? [];
  const base = safeFileName(baseName);
  const nameOf = (storage: string) => (storage ? `${base}_${safeFileName(storage)}` : base);

  // Subreports by their "Subdocument N" number (they live directly under the main report).
  // Linked subreports receive values through parameters Crystal names "Pm-Table.Field".
  const subreports = new Map<number, SubreportInfo>();
  for (const m of models) {
    const n = /^Subdocument (\d+)$/.exec(m.storage)?.[1];
    if (!n) continue;
    const links = (m.definition?.parameters ?? [])
      .filter((p) => /^Pm-/i.test(p.name))
      .map((p) => ({ parameter: sanitizeName(p.name), field: p.name.slice(3) }));
    subreports.set(Number(n), {
      name: nameOf(m.storage),
      links,
      parameters: (m.definition?.parameters ?? []).map((p) => p.name),
      definition: m.definition,
      dataSource: m.dataSource,
      images: embeddedImages(storageAt(doc.root, m.storage)),
    });
  }

  const results = models.map((model) => {
    const reportName = nameOf(model.storage);
    if (!model.definition) {
      return {
        fileName: `${reportName}.rdl`,
        storage: model.storage,
        rdl: '',
        review: [{ item: 'Report', message: `could not be decoded: ${(model.errors ?? []).join('; ')}` }],
      };
    }
    const { rdl, review, referenced, sqlFunctions } = convertToRdl(model.definition, model.dataSource, {
      reportName,
      connectionString: options.connectionString,
      sharedDataSource: options.sharedDataSource,
      embedSubreports: !options.separateSubreports,
      pageNumber: options.pageNumber,
      parameterValues: options.parameterValues,
      chartAxisFormat: options.chartAxisFormat,
      formulasInQuery: options.formulasInQuery,
      rulesAsText: options.rulesAsText,
      subreports: model.storage ? new Map() : subreports,
      subreport: Boolean(model.storage),
      images: embeddedImages(storageAt(doc.root, model.storage)),
    });
    const { out, files } = finish(rdl, review, reportName, sqlFunctions, options);
    return { fileName: `${reportName}.rdl`, storage: model.storage, rdl: out, review, referenced, files };
  });
  // Only the subreports the main report refers to need an .rdl of their own: those placed inside it need none, nor
  // those it never prints (in a section always suppressed). All are kept where the main report could not be converted.
  const main = results.find((r) => !r.storage);
  const used = main?.referenced ? new Set(main.referenced) : undefined;
  return results
    .filter((r) => !r.storage || !used || used.has(Number(/^Subdocument (\d+)$/.exec(r.storage)?.[1])))
    .map(({ referenced: _, ...r }) => r);
}

function finish(rdl: string, review: ReviewNote[], reportName: string, sqlFunctions: string[] | undefined, options: SsrsOptions, prefix?: string): { out: string; files?: Record<string, string> } {
  let out = rdl && options.restyle ? options.restyle(rdl) : rdl;
  let files: Record<string, string> | undefined;
  if (out && options.reshape) {
    const shaped = options.reshape(out, reportName, { sqlFunctions, ...(prefix ? { prefix } : {}) });
    out = shaped.rdl;
    files = shaped.files;
    const settled = new Set(shaped.settled ?? []);
    const gone = (n: ReviewNote) => [...n.message.matchAll(/\bCode\.(\w+)/g)].some((m) => !new RegExp(`\\bCode\\.(\\w+_)?${m[1]}\\b`).test(out ?? ''));
    review.splice(0, review.length, ...review.filter((n) => !settled.has(n.item) && !shaped.settles?.test(n.item) && !gone(n)), ...shaped.review);
  }
  return { out, files };
}

export function convertSubreportsStandalone(doc: CfbDocument, baseName: string, options: SsrsOptions = {}, prefix?: string): ConvertedReport[] {
  return standaloneParts(buildMetadata(doc).reports ?? [], baseName, options, prefix, (storage) => embeddedImages(storageAt(doc.root, storage)));
}

export function standaloneParts(models: ReportModel[], baseName: string, options: SsrsOptions = {}, prefix?: string, imagesOf?: (storage: string) => Map<number, Uint8Array>): ConvertedReport[] {
  const main = models.find((m) => !m.storage)?.definition;
  if (!main) return [];
  const base = safeFileName(baseName);
  const areas = classifyAreas(main.layout);
  const levels = [...new Set([...areas.groupHeaders.keys(), ...areas.groupFooters.keys()])].sort((a, b) => a - b);
  const sections = [
    ...areas.reportHeader, ...levels.flatMap((l) => areas.groupHeaders.get(l) ?? []), ...areas.detail,
    ...[...levels].reverse().flatMap((l) => areas.groupFooters.get(l) ?? []), ...areas.reportFooter,
  ].filter((section) => !section.suppressed || section.conditions?.suppress);
  const named = (t: string) => /[A-Za-z]/.test(t) && !/^report$/i.test(t) && !/^[a-z0-9_]+$/.test(t) && !/^\{[^}]*\}$/.test(t) && !/^(there (is|are|has been|have been) no|no) /i.test(t);
  type ReportObject = NonNullable<ReportModel['definition']>['layout'][number]['sections'][number]['objects'][number];
  const fixed = (name: string) => /^\s*\(?\s*"([^"]*)"\s*\)?\s*;?\s*$/.exec(main.formulas.find((f) => `@${f.name}`.toLowerCase() === name.toLowerCase())?.text ?? '')?.[1] ?? '';
  const wording = (o: ReportObject) => (o.kind === 'field' && o.field?.startsWith('@') ? fixed(o.field) : o.runs?.length ? o.runs.map((r) => ('field' in r ? '' : r.text)).join('') : o.text ?? '').replace(/\s+/g, ' ').trim();
  const order: { index: number; above: string; section: (typeof sections)[number]; object: ReportObject }[] = [];
  for (const section of sections) {
    const placed = section.objects.filter((o) => o.kind === 'subreport' && o.subreport && (!o.suppressed || o.conditions?.suppress))
      .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
    for (const o of placed) {
      if (order.some((e) => e.index === o.subreport!.index)) continue;
      const x = o.position?.x ?? 0;
      const y = o.position?.y ?? 0;
      const right = x + (o.size?.width ?? 0);
      const above = section.objects
        .filter((t) => (t.kind === 'text' || t.kind === 'field') && !t.suppressed && named(wording(t)))
        .map((t) => ({ t, foot: (t.position?.y ?? 0) + (t.size?.height ?? 0) }))
        .filter(({ t, foot }) => foot <= y + 72 && foot >= y - 864 && Math.min(right, (t.position?.x ?? 0) + (t.size?.width ?? 0)) - Math.max(x, t.position?.x ?? 0) > 0)
        .sort((a, b) => b.foot - a.foot)[0];
      order.push({ index: o.subreport!.index, above: above ? wording(above.t) : '', section, object: o });
    }
  }
  const mainModel = models.find((m) => !m.storage)!;
  const framed = (entry: (typeof order)[number], model: ReportModel, reportName: string) => {
    const o = entry.object;
    const S = { l: o.position?.x ?? 0, t: o.position?.y ?? 0, r: (o.position?.x ?? 0) + (o.size?.width ?? 0), b: (o.position?.y ?? 0) + (o.size?.height ?? 0) };
    const box = (q: ReportObject) => ({ l: q.position?.x ?? 0, t: q.position?.y ?? 0, r: (q.position?.x ?? 0) + (q.size?.width ?? 0), b: (q.position?.y ?? 0) + (q.size?.height ?? 0) });
    const others = entry.section.objects.filter((q) => q !== o && !q.suppressed && q.kind !== 'subreport');
    const R = { ...S };
    if (options.partsFormat === 'report') {
      const around = others.filter((q) => q.kind === 'box' && box(q).l <= S.l + 30 && box(q).r >= S.r - 30 && box(q).t <= S.t + 30 && box(q).b >= S.b - 30)
        .sort((a, b) => (box(a).r - box(a).l) * (box(a).b - box(a).t) - (box(b).r - box(b).l) * (box(b).b - box(b).t))[0];
      const across = (q: ReportObject) => box(q).t < S.b && box(q).b > S.t;
      const edges = [...others.filter((q) => q.kind === 'line' && !(q.size?.width) && across(q)).map((q) => box(q).l),
        ...others.filter((q) => q.kind === 'box' && across(q)).flatMap((q) => [box(q).l, box(q).r]),
        ...entry.section.objects.filter((q) => q !== o && q.kind === 'subreport' && across(q)).flatMap((q) => [box(q).l, box(q).r])];
      R.l = Math.max(around ? box(around).l : S.l, ...edges.filter((x) => x <= S.l + 30));
      R.r = Math.min(around ? box(around).r : S.r, ...edges.filter((x) => x >= S.r - 30));
      const titles = others.filter((q) => (q.kind === 'text' || q.kind === 'field') && box(q).b <= S.t + 72 && box(q).b >= S.t - 864 && Math.min(box(q).r, R.r) - Math.max(box(q).l, R.l) > 0);
      R.t = Math.min(S.t, around ? box(around).t : S.t, ...titles.map((q) => box(q).t));
      R.b = Math.max(S.b, around ? box(around).b : S.b);
    }
    const inside = (q: ReportObject) => { const B = box(q); const mid = (B.l + B.r) / 2; return mid >= R.l && mid <= R.r && B.t >= R.t - 30 && B.b <= R.b + 30; };
    const kept = options.partsFormat === 'report' ? others.filter((q) => q.kind === 'box' || q.kind === 'line' ? Math.min(box(q).r, R.r) - Math.max(box(q).l, R.l) >= (q.size?.width ? 1 : 0) && box(q).t < R.b + 30 && box(q).b > R.t - 30 : inside(q)) : [];
    const place = (q: ReportObject): ReportObject => {
      const B = box(q);
      const l = q.kind === 'box' || q.kind === 'line' ? Math.max(B.l, R.l) : B.l;
      const r = q.kind === 'box' || q.kind === 'line' ? Math.min(B.r, R.r) : B.r;
      const t = q.kind === 'box' || q.kind === 'line' ? Math.max(B.t, R.t) : B.t;
      const b = q.kind === 'box' || q.kind === 'line' ? Math.min(B.b, R.b) : B.b;
      const { conditions: _c, ...rest } = q;
      return { ...rest, position: { x: l - R.l, y: t - R.t }, size: { width: r - l, height: b - t } };
    };
    const { conditions: _c, ...part } = o;
    const objects = [...kept.map(place), { ...part, suppressed: false, ...(options.partsFormat === 'report' ? {} : { border: undefined }), position: { x: S.l - R.l, y: S.t - R.t } }];
    const reads = objects.some((q) => q.field && !q.field.startsWith('@') && !q.field.startsWith('?') && q.field.includes('.'));
    const definition = {
      ...main, page: main.page,
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: R.b - R.t, objects }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      ],
    };
    const links = (model.definition?.parameters ?? []).filter((p) => /^Pm-/i.test(p.name)).map((p) => ({ parameter: sanitizeName(p.name), field: p.name.slice(3) }));
    const info: SubreportInfo = { name: reportName, links, parameters: (model.definition?.parameters ?? []).map((p) => p.name), definition: model.definition, dataSource: model.dataSource, images: imagesOf?.(model.storage) };
    return convertToRdl(definition as never, reads ? mainModel.dataSource : { connections: [], tables: [], links: [] } as never, {
      reportName,
      connectionString: options.connectionString,
      sharedDataSource: options.sharedDataSource,
      pageNumber: options.pageNumber,
      parameterValues: options.parameterValues,
      chartAxisFormat: options.chartAxisFormat,
      formulasInQuery: options.formulasInQuery,
      rulesAsText: options.rulesAsText,
      embedSubreports: true,
      subreports: new Map([[o.subreport!.index, info]]),
      images: imagesOf?.(''),
    });
  };
  const convert = (model: ReportModel, reportName: string, number: string, entry?: (typeof order)[number]) => {
    if (entry && options.partsFormat) {
      const { rdl, review, sqlFunctions } = framed(entry, model, reportName);
      const { out, files } = finish(rdl, review, reportName, sqlFunctions, options, `${prefix ?? base}_${number}`);
      return { out, review, files };
    }
    const definition = { ...model.definition!, page: model.definition!.page ?? main.page };
    const { rdl, review, sqlFunctions } = convertToRdl(definition, model.dataSource, {
      reportName,
      connectionString: options.connectionString,
      sharedDataSource: options.sharedDataSource,
      pageNumber: options.pageNumber,
      parameterValues: options.parameterValues,
      chartAxisFormat: options.chartAxisFormat,
      formulasInQuery: options.formulasInQuery,
      rulesAsText: options.rulesAsText,
      subreports: new Map(),
      subreport: true,
      images: imagesOf?.(model.storage),
    });
    const { out, files } = finish(rdl, review, reportName, sqlFunctions, options, `${prefix ?? base}_${number}`);
    return { out, review, files };
  };
  const shape = (rdl: string) => rdl
    .replace(/Subdocument_\d+/g, 'Subdocument')
    .replace(/<FilterValue>[^<]*<\/FilterValue>/g, '<FilterValue />')
    .replace(/<CommandText>[^<]*<\/CommandText>/g, (q) => q.replace(/'(?:[^']|'')*'/g, "''").replace(/\b\d+(?:\.\d+)?\b/g, '0'));
  const kept: { index: number; above: string; model: ReportModel; also: string[]; entry: (typeof order)[number] }[] = [];
  const seen = new Map<string, (typeof kept)[number]>();
  for (const entry of order) {
    const { index, above } = entry;
    const model = models.find((m) => m.storage === `Subdocument ${index}`);
    if (!model) continue;
    if (!model.definition) { kept.push({ index, above, model, also: [], entry }); continue; }
    const key = shape(convert(model, `${base}_00`, '00').out);
    const first = seen.get(key);
    if (first) { first.also.push(model.storage); continue; }
    const part = { index, above, model, also: [] as string[], entry };
    seen.set(key, part);
    kept.push(part);
  }
  const width = Math.max(2, String(kept.length).length);
  const used = new Set<string>();
  return kept.map(({ above, model, also, entry }, k) => {
    const number = String(k + 1).padStart(width, '0');
    const inner = model.definition ? extractHeaders([model]).find((h) => (h.kind === 'chart title' || h.kind === 'text') && named(h.text.replace(/\s+/g, ' ').trim()))?.text ?? '' : '';
    const words = above || inner ? safeFileName(above || inner).split('_').filter(Boolean).slice(0, 6).join('_') : '';
    let reportName = words ? `${base}_${number}_${words}` : `${base}_${number}`;
    for (let n = 2; used.has(reportName.toLowerCase()); n++) reportName = `${base}_${number}_${words ? `${words}_` : ''}${n}`;
    used.add(reportName.toLowerCase());
    if (!model.definition) {
      return { fileName: `${reportName}.rdl`, storage: model.storage, rdl: '', review: [{ item: 'Report', message: `could not be decoded: ${(model.errors ?? []).join('; ')}` }] };
    }
    const { out, review, files } = convert(model, reportName, number, entry);
    if (also.length) review.unshift({ item: 'Report', message: `stands for ${also.length} more part(s) of the same design that only pick other rows (${also.join(', ')}); its own pick is kept` });
    return { fileName: `${reportName}.rdl`, storage: model.storage, rdl: out, review, files };
  });
}

function storageAt(root: CfbStorage, path: string): CfbStorage | undefined {
  let node: CfbStorage | undefined = root;
  for (const part of path ? path.split('/') : []) {
    const child: CfbNode | undefined = node?.children.find((c) => c.name === part);
    node = child?.type === 'storage' ? child : undefined;
  }
  return node;
}

/** Image bytes of the "Embedding N" storages directly inside a report storage. */
function embeddedImages(storage: CfbStorage | undefined): Map<number, Uint8Array> {
  const images = new Map<number, Uint8Array>();
  for (const child of storage?.children ?? []) {
    const n = /^Embedding (\d+)$/.exec(child.name)?.[1];
    if (!n || child.type !== 'storage') continue;
    const contents = child.children.find((c) => c.name === 'CONTENTS');
    if (contents?.type === 'stream') images.set(Number(n), contents.data);
  }
  return images;
}

/** Markdown review checklist for converted reports. */
export function reviewMarkdown(sourceName: string, reports: ConvertedReport[]): string {
  const lines = [`# SSRS conversion review: ${sourceName}`, ''];
  for (const report of reports) {
    lines.push(`## ${report.fileName}${report.storage ? ` (subreport ${report.storage})` : ''}`, '');
    if (report.review.length === 0) lines.push('No manual review items.', '');
    // Items sharing a message are listed together, so each kind of check appears once.
    const byMessage = new Map<string, string[]>();
    for (const note of report.review) {
      // The custom code function's name goes with its item, so notes about converted formulas group too.
      const code = / \((Code\.\w+)\)/.exec(note.message);
      const message = code ? note.message.replace(code[0], '') : note.message;
      const item = code ? `${note.item} (${code[1]})` : note.item;
      byMessage.set(message, [...(byMessage.get(message) ?? []), item]);
    }
    for (const [message, items] of byMessage) {
      lines.push(items.length === 1 ? `- [ ] **${items[0]}**: ${message}` : `- [ ] ${message} (${items.length} items)`);
      if (items.length > 1) for (const item of items) lines.push(`  - ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * One SSRS report laid out with a house template, from one or more .rpt files (one block each, in order).
 * Only each file's main report is used; its subreports are listed in the review notes.
 */
export function convertDocumentsWithTemplate(template: HouseTemplate, documents: { doc: CfbDocument; name: string }[], reportName: string): ConvertedReport {
  const names = new Set<string>();
  const inputs: HouseInput[] = [];
  const notes: ReviewNote[] = [];
  for (const { doc, name } of documents) {
    const main = (buildMetadata(doc).reports ?? []).find((m) => !m.storage);
    if (!main?.definition) {
      notes.push({ item: name, message: `could not be decoded: ${(main?.errors ?? []).join('; ') || 'no report definition'}` });
      continue;
    }
    let base = safeFileName(name);
    for (let n = 2; names.has(base.toLowerCase()); n++) base = `${safeFileName(name)}_${n}`;
    names.add(base.toLowerCase());
    inputs.push({ name: base, definition: main.definition, dataSource: main.dataSource });
  }
  if (!inputs.length) throw new Error('none of the reports could be decoded');
  const { rdl, review } = buildHouseReport(template, inputs, reportName);
  return { fileName: `${safeFileName(reportName)}.rdl`, storage: '', rdl, review: [...notes, ...review] };
}
