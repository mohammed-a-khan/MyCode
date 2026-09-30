/** Conversion between the in-memory container model and the JSON representation. */

import { createHash } from 'node:crypto';
import { ZERO_GUID } from './cfb/encoding.ts';
import { parsePropertySet, type PropertySetInfo } from './cfb/propertySet.ts';
import { CfbError, type CfbDocument, type CfbNode, type CfbStorage } from './cfb/types.ts';
import { buildCatalog, type ReportCatalog } from './crystal/catalog.ts';
import { decodedToJson, jsonToDecoded, type JsonDecodedStream } from './crystal/decodedJson.ts';
import { applyPrompts, buildDataSource, buildReportDefinition, parsePrompts, type DataSourceInfo, type ReportDefinition } from './crystal/model.ts';
import { decodeStream, encodeStream, encryptedStreamKind, logicalBytes, type DecodedStream } from './crystal/streams.ts';

export const FORMAT_ID = 'crystal-rpt-json';
export const FORMAT_VERSION = 1;

export type DataEncoding = 'base64' | 'hex' | 'utf8' | 'utf16le';

interface JsonEntryBase {
  name: string;
  /** Omitted when all zeros. */
  clsid?: string;
  /** Omitted when 0. */
  stateBits?: number;
  /** ISO-8601 UTC with 100ns precision. Omitted when unset. */
  created?: string;
  modified?: string;
}

export interface JsonStorage extends JsonEntryBase {
  type: 'storage';
  children: JsonNode[];
}

export interface JsonStream extends JsonEntryBase {
  type: 'stream';
  /** Decoded byte length; verified on conversion back to .rpt unless verification is disabled. */
  size?: number;
  /** SHA-256 of the decoded bytes; verified like size. */
  sha256?: string;
  /**
   * Original stream bytes. For an encrypted report stream that also has "decoded", these are
   * written back unchanged when "decoded" still matches them; otherwise "decoded" is re-encrypted.
   */
  encoding?: DataEncoding;
  data?: string;
  /** Decrypted, decompressed content of an encrypted report stream (editable). */
  decoded?: JsonDecodedStream;
  /** Why an encrypted stream could not be decoded (it is then kept only as "data"). */
  decodeError?: string;
}

export type JsonNode = JsonStorage | JsonStream;

/** Informational decode of plaintext parts of the report. Ignored when converting back to .rpt. */
export interface RptMetadata {
  summaryInformation?: PropertySetInfo | { error: string };
  documentSummaryInformation?: PropertySetInfo | { error: string };
  catalog: ReportCatalog;
  /** Readable model of the main report ("") and each subreport storage. */
  reports?: ReportModel[];
}

export interface ReportModel {
  storage: string;
  definition?: ReportDefinition;
  dataSource?: DataSourceInfo;
  errors?: string[];
}

export interface RptJson {
  format: typeof FORMAT_ID;
  formatVersion: typeof FORMAT_VERSION;
  source?: { fileName?: string; size: number; sha256: string };
  container: { majorVersion: 3 | 4; minorVersion: number };
  metadata?: RptMetadata;
  root: JsonStorage;
}

export interface ToJsonOptions {
  /** Encoding for stream bytes. Default "base64". */
  encoding?: 'base64' | 'hex';
  /** Include the informational "metadata" section. Default true. */
  metadata?: boolean;
  /** Decrypt and decode encrypted report streams into "decoded". Default true. */
  decode?: boolean;
  /** Keep the original bytes ("data") of decoded streams. Default true. */
  keepOriginal?: boolean;
  /** Original file bytes / name, recorded under "source". */
  sourceBytes?: Uint8Array;
  fileName?: string;
}

export interface FromJsonOptions {
  /** Check each stream's size and sha256 against its decoded data. Default true. */
  verify?: boolean;
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function findStream(root: CfbStorage, name: string): Uint8Array | undefined {
  const node = root.children.find((c) => c.type === 'stream' && c.name === name);
  return node?.type === 'stream' ? node.data : undefined;
}

function decodePropertySet(root: CfbStorage, name: string): PropertySetInfo | { error: string } | undefined {
  const data = findStream(root, name);
  if (!data) return undefined;
  try {
    return parsePropertySet(data, name);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function buildReportModels(root: CfbStorage): ReportModel[] {
  const models: ReportModel[] = [];
  const visit = (storage: CfbStorage, path: string) => {
    const contents = findStream(storage, 'Contents');
    if (contents) {
      const model: ReportModel = { storage: path };
      const errors: string[] = [];
      try {
        const decoded = decodeStream('contents', contents);
        if (decoded.kind !== 'promptManager') model.definition = buildReportDefinition(decoded.content.records);
        const promptStream = findStream(storage, 'PromptManager');
        if (promptStream && model.definition) {
          const prompts = decodeStream('promptManager', promptStream);
          if (prompts.kind === 'promptManager') {
            applyPrompts(model.definition.parameters, parsePrompts(prompts.documents.map((d) => new TextDecoder().decode(d))));
          }
        }
      } catch (err) {
        errors.push(`Contents/PromptManager: ${(err as Error).message}`);
      }
      const qe = findStream(storage, 'QESession');
      if (qe) {
        try {
          const decoded = decodeStream('qeSession', qe);
          if (decoded.kind !== 'promptManager') model.dataSource = buildDataSource(decoded.content.records);
        } catch (err) {
          errors.push(`QESession: ${(err as Error).message}`);
        }
      }
      if (errors.length > 0) model.errors = errors;
      models.push(model);
    }
    for (const child of storage.children) {
      if (child.type === 'storage') visit(child, path ? `${path}/${child.name}` : child.name);
    }
  };
  visit(root, '');
  return models;
}

export function buildMetadata(doc: CfbDocument): RptMetadata {
  const metadata: RptMetadata = { catalog: buildCatalog(doc.root), reports: buildReportModels(doc.root) };
  const summary = decodePropertySet(doc.root, '\u0005SummaryInformation');
  const docSummary = decodePropertySet(doc.root, '\u0005DocumentSummaryInformation');
  if (summary) metadata.summaryInformation = summary;
  if (docSummary) metadata.documentSummaryInformation = docSummary;
  return metadata;
}

export function documentToJson(doc: CfbDocument, options: ToJsonOptions = {}): RptJson {
  const encoding = options.encoding ?? 'base64';
  const convert = (node: CfbNode): JsonNode => {
    const base: JsonEntryBase = { name: node.name };
    if (node.clsid !== ZERO_GUID) base.clsid = node.clsid;
    if (node.stateBits !== 0) base.stateBits = node.stateBits;
    if (node.created) base.created = node.created;
    if (node.modified) base.modified = node.modified;
    if (node.type === 'storage') return { type: 'storage', ...base, children: node.children.map(convert) };
    const stream: JsonStream = { type: 'stream', ...base, size: node.data.length, sha256: sha256(node.data) };
    const kind = options.decode === false ? undefined : encryptedStreamKind(node.name);
    let decoded: JsonDecodedStream | undefined;
    if (kind) {
      try {
        decoded = decodedToJson(decodeStream(kind, node.data));
      } catch (err) {
        stream.decodeError = (err as Error).message;
      }
    }
    if (!decoded || options.keepOriginal !== false) {
      stream.encoding = encoding;
      stream.data = Buffer.from(node.data.buffer, node.data.byteOffset, node.data.byteLength).toString(encoding);
    }
    if (decoded) stream.decoded = decoded;
    return stream;
  };

  const json: RptJson = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    container: { majorVersion: doc.majorVersion, minorVersion: doc.minorVersion },
    root: convert(doc.root) as JsonStorage,
  };
  if (options.sourceBytes) {
    json.source = { size: options.sourceBytes.length, sha256: sha256(options.sourceBytes) };
    if (options.fileName) json.source = { fileName: options.fileName, ...json.source };
  }
  if (options.metadata !== false) {
    // Keep a readable key order: header fields, metadata, then the (large) entry tree.
    const { root, ...head } = json;
    return { ...head, metadata: buildMetadata(doc), root };
  }
  return json;
}

const ENCODINGS: readonly string[] = ['base64', 'hex', 'utf8', 'utf16le'];

function decodeData(text: string, encoding: DataEncoding, path: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (encoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.replace(/=+$/, '').length % 4 === 1)) {
    throw new CfbError(`${path}: data is not valid base64`);
  }
  if (encoding === 'hex' && !/^([0-9a-fA-F]{2})*$/.test(text.replace(/\s+/g, ''))) {
    throw new CfbError(`${path}: data is not valid hex`);
  }
  const clean = encoding === 'base64' || encoding === 'hex' ? text.replace(/\s+/g, '') : text;
  return new Uint8Array(Buffer.from(clean, encoding));
}

function sameContent(decoded: DecodedStream, original: Uint8Array): boolean {
  try {
    const before = decodeStream(decoded.kind, original);
    if (before.kind !== 'promptManager' && decoded.kind !== 'promptManager' && !Buffer.from(before.header).equals(Buffer.from(decoded.header))) {
      return false;
    }
    const a = logicalBytes(before);
    const b = logicalBytes(decoded);
    return a.length === b.length && a.every((bytes, i) => Buffer.from(bytes).equals(Buffer.from(b[i])));
  } catch {
    return false;
  }
}

function encodeDecoded(decoded: DecodedStream, path: string, fail: (path: string, message: string) => never): Uint8Array {
  try {
    return encodeStream(decoded);
  } catch (err) {
    return fail(`${path}.decoded`, (err as Error).message);
  }
}

export function jsonToDocument(input: unknown, options: FromJsonOptions = {}): CfbDocument {
  const verify = options.verify !== false;
  const fail = (path: string, message: string): never => {
    throw new CfbError(`${path}: ${message}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObject(input)) fail('$', 'expected a JSON object');
  const json = input as Record<string, unknown>;
  if (json.format !== FORMAT_ID) fail('$.format', `expected "${FORMAT_ID}"`);
  if (json.formatVersion !== FORMAT_VERSION) fail('$.formatVersion', `unsupported version ${String(json.formatVersion)}`);
  const container = json.container;
  if (!isObject(container)) return fail('$.container', 'missing');
  const majorVersion = container.majorVersion;
  if (majorVersion !== 3 && majorVersion !== 4) return fail('$.container.majorVersion', 'must be 3 or 4');
  const minorVersion = container.minorVersion ?? 0x3e;
  if (typeof minorVersion !== 'number' || !Number.isInteger(minorVersion) || minorVersion < 0 || minorVersion > 0xffff) {
    return fail('$.container.minorVersion', 'must be an integer 0-65535');
  }

  const convert = (value: unknown, path: string): CfbNode => {
    if (!isObject(value)) return fail(path, 'expected an object');
    const { name, type, clsid, stateBits, created, modified } = value;
    if (typeof name !== 'string') fail(`${path}.name`, 'must be a string');
    if (clsid !== undefined && typeof clsid !== 'string') fail(`${path}.clsid`, 'must be a GUID string');
    if (stateBits !== undefined && (typeof stateBits !== 'number' || !Number.isInteger(stateBits) || stateBits < 0 || stateBits > 0xffffffff)) {
      fail(`${path}.stateBits`, 'must be an integer 0-4294967295');
    }
    for (const [key, ts] of [['created', created], ['modified', modified]] as const) {
      if (ts !== undefined && ts !== null && typeof ts !== 'string') fail(`${path}.${key}`, 'must be an ISO-8601 string');
    }
    const common = {
      name: name as string,
      clsid: (clsid as string | undefined) ?? ZERO_GUID,
      stateBits: (stateBits as number | undefined) ?? 0,
      created: (created as string | undefined) ?? null,
      modified: (modified as string | undefined) ?? null,
    };

    if (type === 'storage') {
      if (!Array.isArray(value.children)) return fail(`${path}.children`, 'must be an array');
      return { type: 'storage', ...common, children: value.children.map((c, i) => convert(c, `${path}.children[${i}]`)) };
    }
    if (type !== 'stream') return fail(`${path}.type`, 'must be "storage" or "stream"');

    let original: Uint8Array | undefined;
    if (value.data !== undefined) {
      const encoding = (value.encoding ?? 'base64') as DataEncoding;
      if (!ENCODINGS.includes(encoding)) fail(`${path}.encoding`, `must be one of ${ENCODINGS.join(', ')}`);
      if (typeof value.data !== 'string') fail(`${path}.data`, 'must be a string');
      original = decodeData(value.data as string, encoding, `${path}.data`);
      if (value.size !== undefined && (typeof value.size !== 'number' || !Number.isInteger(value.size))) fail(`${path}.size`, 'must be an integer');
      if (value.sha256 !== undefined && typeof value.sha256 !== 'string') fail(`${path}.sha256`, 'must be a hex string');
      if (verify) {
        if (value.size !== undefined && value.size !== original.length) {
          fail(`${path}.size`, `declares ${String(value.size)} bytes but data decodes to ${original.length} (update or remove "size"/"sha256" after editing data)`);
        }
        if (value.sha256 !== undefined && (value.sha256 as string).toLowerCase() !== sha256(original)) {
          fail(`${path}.sha256`, 'does not match the decoded data (update or remove "size"/"sha256" after editing data)');
        }
      }
    }

    if (value.decoded !== undefined) {
      const kind = encryptedStreamKind(common.name);
      if (!kind) return fail(`${path}.decoded`, 'only encrypted report streams (Contents, QESession, PromptManager, ReportParametersStream) can be decoded');
      const decoded = jsonToDecoded(value.decoded, kind, `${path}.decoded`, fail);
      // Reuse the original bytes when the decoded content is unchanged, so untouched streams stay byte-identical.
      const unchanged = original !== undefined && sameContent(decoded, original);
      // "data" whose sha256 is gone or no longer matches was edited by hand; with a different "decoded"
      // one of the two edits would be lost, so ask which one is meant.
      const dataEdited = original !== undefined && (typeof value.sha256 !== 'string' || value.sha256.toLowerCase() !== sha256(original));
      if (!unchanged && dataEdited) {
        return fail(`${path}`, 'has both edited "data" and a "decoded" form that differs from it; keep only the one you edited (remove "decoded" to use the raw data, or "data" to use the decoded content)');
      }
      const data = unchanged ? original! : encodeDecoded(decoded, path, fail);
      return { type: 'stream', ...common, data };
    }
    if (!original) return fail(`${path}.data`, 'must be a string (or provide "decoded")');
    return { type: 'stream', ...common, data: original };
  };

  const root = convert(json.root, '$.root');
  if (root.type !== 'storage') return fail('$.root.type', 'the root must be a storage');
  return { majorVersion, minorVersion, root };
}
