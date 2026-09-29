/** Converts a whole .rpt (main report and subreports) into SSRS report definitions. */

import { buildMetadata } from '../json.ts';
import type { CfbDocument, CfbNode, CfbStorage } from '../cfb/types.ts';
import { convertToRdl, sanitizeName, type ReviewNote, type SubreportInfo } from './rdl.ts';

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

  return models.map((model) => {
    const reportName = nameOf(model.storage);
    if (!model.definition) {
      return {
        fileName: `${reportName}.rdl`,
        storage: model.storage,
        rdl: '',
        review: [{ item: 'Report', message: `could not be decoded: ${(model.errors ?? []).join('; ')}` }],
      };
    }
    const { rdl, review } = convertToRdl(model.definition, model.dataSource, {
      reportName,
      connectionString: options.connectionString,
      subreports: model.storage ? new Map() : subreports,
      subreport: Boolean(model.storage),
      images: embeddedImages(storageAt(doc.root, model.storage)),
    });
    return { fileName: `${reportName}.rdl`, storage: model.storage, rdl, review };
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
    for (const note of report.review) lines.push(`- [ ] **${note.item}**: ${note.message}`);
    lines.push('');
  }
  return lines.join('\n');
}
