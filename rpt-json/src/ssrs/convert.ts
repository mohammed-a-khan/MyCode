/** Converts a whole .rpt (main report and subreports) into SSRS report definitions. */

import { buildMetadata } from '../json.ts';
import type { CfbDocument, CfbNode, CfbStorage } from '../cfb/types.ts';
import { convertToRdl, sanitizeName, type ReviewNote, type SubreportInfo } from './rdl.ts';
import { buildHouseReport, type HouseInput, type HouseTemplate } from './house.ts';

export interface ConvertedReport {
  /** File name for the .rdl (without directory). */
  fileName: string;
  /** Storage path inside the .rpt ("" for the main report). */
  storage: string;
  rdl: string;
  review: ReviewNote[];
}

export interface SsrsOptions {
  /** Overrides the generated connection string for every report. */
  connectionString?: string;
  /** A shared data source on the report server, used instead of an embedded connection. */
  sharedDataSource?: string;
  /** Keep every subreport as its own .rdl (by default those outside the table are built into the report). */
  separateSubreports?: boolean;
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
    const { rdl, review, inlinedOnly } = convertToRdl(model.definition, model.dataSource, {
      reportName,
      connectionString: options.connectionString,
      sharedDataSource: options.sharedDataSource,
      embedSubreports: !options.separateSubreports,
      subreports: model.storage ? new Map() : subreports,
      subreport: Boolean(model.storage),
      images: embeddedImages(storageAt(doc.root, model.storage)),
    });
    return { fileName: `${reportName}.rdl`, storage: model.storage, rdl, review, inlinedOnly };
  });
  // Subreports placed entirely inside the main report (page header/footer) need no .rdl of their own.
  const inlined = new Set(results.find((r) => !r.storage)?.inlinedOnly ?? []);
  return results
    .filter((r) => !inlined.has(Number(/^Subdocument (\d+)$/.exec(r.storage)?.[1])))
    .map(({ inlinedOnly: _, ...r }) => r);
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
