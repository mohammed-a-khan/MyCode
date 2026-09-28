/**
 * Describes the entries found inside a Crystal Reports .rpt container: what each stream holds
 * and the plaintext header of the encrypted report streams (see streams.ts for decoding them).
 */

import type { CfbNode, CfbStorage } from '../cfb/types.ts';

const DESCRIPTIONS: Record<string, string> = {
  Contents: 'Report definition (layout, formulas, groups, sections, objects) - encrypted',
  QESession: 'Query engine session (connections, tables, fields, joins, SQL commands) - encrypted',
  PromptManager: 'Parameter prompting definitions - encrypted',
  ReportInfo: 'Capability cache (chart/map flags)',
  '\u0005SummaryInformation': 'OLE summary properties (title, author, timestamps, thumbnail)',
  '\u0005DocumentSummaryInformation': 'OLE document summary properties',
  Subdocument: 'Subreport storage',
  Embedding: 'Embedded OLE object storage (image, logo, chart)',
  CompObj: 'OLE object class information',
  Ole: 'OLE object link information',
  CONTENTS: 'Embedded object payload',
  DataSourceManager: 'Saved-data batch directory',
  SavedRecordsStream: 'Saved (cached) records',
  MemoValuesStream: 'Saved memo/blob field values',
  ReportParametersStream: 'Saved parameter current values - encrypted',
  CHART: 'Chart definition',
  zlibBLOB: 'zlib-compressed payload',
  CrystalReportDesignerStream: 'Designer state (design-time only)',
  ExportFormatOptionsStream: 'Saved export options',
  TotallerStream: 'Summary/running-total cache',
  AnalysisGridsStream: 'Cross-tab/OLAP grid cache',
  ConstantRecordsStream: 'Formula constant cache',
  FormulaRecordsStream: 'Formula record cache',
  ViewInformationStream: 'Preview view state',
  DataViewSortIndex: 'Browsed view sort index',
  DataViewRecordFilter: 'Browsed view record filter',
};

const ENCRYPTED_WITH_HEADER = new Set(['Contents', 'ReportParametersStream']);

/** "TotallerStream 3l" -> "TotallerStream", "\u0001CompObj" -> "CompObj". */
export function baseName(name: string): string {
  return name.replace(/^[\u0001-\u0005]/, '').replace(/ \d+\w?$/, '');
}

export function describeEntry(name: string): string | undefined {
  return DESCRIPTIONS[name] ?? DESCRIPTIONS[baseName(name)];
}

export interface StreamHeaderInfo {
  encrypted: boolean;
  version: number;
  initializationVector: string;
}

/**
 * Decodes the plaintext header record (type 0xFFFF) that precedes the encrypted payload of a
 * Contents-style stream. Framing: a flag byte (length size in bits 6-7, schema word in bit 5,
 * masked content in bit 3, extended type in bit 2), the type, an optional schema word and a
 * big-endian length. The content is isEncrypted, version, useFixedKey and the 16-byte IV.
 */
export function readStreamHeader(data: Uint8Array): StreamHeaderInfo | undefined {
  if (data.length < 4) return undefined;
  const flags = data[0];
  let pos = 2;
  let type = ((flags & 0x03) << 8) | data[1];
  if (flags & 0x04) {
    type = data[pos] | (data[pos + 1] << 8);
    pos += 2;
  }
  if (flags & 0x20) pos += 2; // schema word
  const lengthSize = [0, 1, 2, 4][flags >> 6];
  if (type !== 0xffff || pos + lengthSize > data.length) return undefined;
  let length = 0;
  for (let i = 0; i < lengthSize; i++) length = length * 256 + data[pos + i];
  pos += lengthSize;
  if (length < 6 || pos + length > data.length) return undefined;
  const mask = flags & 0x08 ? type & 0xff : 0;
  const content = data.slice(pos, pos + length).map((b) => b ^ mask);
  const encrypted = ((content[0] << 8) | content[1]) !== 0;
  return {
    encrypted,
    version: (content[2] << 8) | content[3],
    initializationVector: encrypted && length >= 22 ? Buffer.from(content.subarray(6, 22)).toString('hex') : '',
  };
}

export interface CatalogEntry {
  path: string;
  type: 'storage' | 'stream';
  size?: number;
  description?: string;
  header?: StreamHeaderInfo | { magic: string };
}

export interface ReportCatalog {
  subreports: string[];
  embeddedObjects: string[];
  entries: CatalogEntry[];
}

export function buildCatalog(root: CfbStorage): ReportCatalog {
  const catalog: ReportCatalog = { subreports: [], embeddedObjects: [], entries: [] };
  const visit = (node: CfbNode, path: string): void => {
    const base = baseName(node.name);
    const entry: CatalogEntry = { path, type: node.type, description: describeEntry(node.name) };
    if (node.type === 'storage') {
      if (base === 'Subdocument') catalog.subreports.push(path);
      if (base === 'Embedding') catalog.embeddedObjects.push(path);
      catalog.entries.push(entry);
      for (const child of node.children) visit(child, `${path}/${child.name}`);
      return;
    }
    entry.size = node.data.length;
    if (ENCRYPTED_WITH_HEADER.has(base)) entry.header = readStreamHeader(node.data);
    else if (base === 'QESession' && node.data.length >= 4) entry.header = { magic: String.fromCharCode(...node.data.subarray(0, 4)) };
    catalog.entries.push(entry);
  };
  for (const child of root.children) visit(child, child.name);
  return catalog;
}
