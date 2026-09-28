/** JSON representation of decoded (decrypted and decompressed) Crystal Reports streams. */

import type { RecordNode, RecordPart } from './records.ts';
import type { DecodedStream, EncryptedStreamKind } from './streams.ts';
import { encodeString, tokenize } from './strings.ts';

/** Names of record types identified so far (informational; ignored when writing). */
const REPORT_RECORD_NAMES: Record<number, string> = {
  0x0008: 'font',
  0x0029: 'sortField',
  0x0064: 'reportRoot',
  0x0071: 'namedValue',
  0x0073: 'fieldDefinition',
  0x0076: 'formula',
  0x007a: 'parameter',
  0x007e: 'summary',
  0x0081: 'sqlExpression',
  0x008a: 'area',
  0x008c: 'section',
  0x009e: 'objectName',
  0x009f: 'fieldObject',
  0x00a3: 'subreportObject',
  0x00a5: 'textObject',
  0x00a9: 'lineOrBoxObject',
  0x00ae: 'graphicObject',
  0x00b8: 'crossTabObject',
  0x00be: 'objectPosition',
  0x00c2: 'textContent',
  0x00c4: 'textEmbeddedField',
  0x00e5: 'group',
  0x0178: 'saveInfo',
};

const QUERY_RECORD_NAMES: Record<number, string> = {
  0x0002: 'connection',
  0x0003: 'table',
  0x0004: 'field',
  0x0009: 'connectionProperty',
  0x000a: 'tableLink',
};

export type JsonRecordPart = { text: string } | { hex: string } | JsonRecord;

export interface JsonRecord {
  type: string;
  /** Informational label for known record types. */
  name?: string;
  schema: string | null;
  flags: string;
  typeByte?: string;
  content: JsonRecordPart[];
}

export type JsonDecodedStream =
  | { kind: 'contents' | 'reportParameters' | 'qeSession'; header: string; encrypted: boolean; records: JsonRecord[]; trailing?: string }
  | { kind: 'promptManager'; documents: ({ text: string } | { hex: string })[] };

const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, '0')}`;
const toHex = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');

function partsToJson(parts: RecordPart[], names: Record<number, string>): JsonRecordPart[] {
  const out: JsonRecordPart[] = [];
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      out.push(recordToJson(part, names));
      continue;
    }
    for (const token of tokenize(part)) out.push('text' in token ? { text: token.text } : { hex: toHex(token.bytes) });
  }
  return out;
}

function recordToJson(node: RecordNode, names: Record<number, string>): JsonRecord {
  return {
    type: hex(node.type, 4),
    ...(names[node.type] ? { name: names[node.type] } : {}),
    schema: node.schema === null ? null : hex(node.schema, 4),
    flags: hex(node.flags, 2),
    ...(node.typeByte !== undefined ? { typeByte: hex(node.typeByte, 2) } : {}),
    content: partsToJson(node.parts, names),
  };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function decodedToJson(stream: DecodedStream): JsonDecodedStream {
  if (stream.kind === 'promptManager') {
    return {
      kind: 'promptManager',
      documents: stream.documents.map((doc) => {
        try {
          const text = utf8.decode(doc);
          if (Buffer.from(text, 'utf8').equals(Buffer.from(doc))) return { text };
        } catch {
          // fall through to hex
        }
        return { hex: toHex(doc) };
      }),
    };
  }
  const names = stream.kind === 'qeSession' ? QUERY_RECORD_NAMES : REPORT_RECORD_NAMES;
  const json: JsonDecodedStream = {
    kind: stream.kind,
    header: toHex(stream.header),
    encrypted: stream.encrypted,
    records: stream.content.records.map((r) => recordToJson(r, names)),
  };
  if (stream.content.trailing.length > 0) json.trailing = toHex(stream.content.trailing);
  return json;
}

// ---- JSON -> decoded stream -------------------------------------------------------------

type Fail = (path: string, message: string) => never;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseHexBytes(value: unknown, path: string, fail: Fail): Uint8Array {
  if (typeof value !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(value.replace(/\s+/g, ''))) fail(path, 'must be a hex string');
  return new Uint8Array(Buffer.from((value as string).replace(/\s+/g, ''), 'hex'));
}

function parseNumber(value: unknown, max: number, path: string, fail: Fail): number {
  const n = typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? parseInt(value, 16) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) fail(path, `must be an integer 0-${max} (number or "0x.." string)`);
  return n as number;
}

function jsonToRecord(value: unknown, path: string, fail: Fail): RecordNode {
  if (!isObject(value)) return fail(path, 'expected a record object');
  const node: RecordNode = {
    type: parseNumber(value.type, 0xffff, `${path}.type`, fail),
    flags: parseNumber(value.flags, 0xff, `${path}.flags`, fail),
    schema: value.schema === null || value.schema === undefined ? null : parseNumber(value.schema, 0xffff, `${path}.schema`, fail),
    parts: [],
  };
  if (value.typeByte !== undefined) node.typeByte = parseNumber(value.typeByte, 0xff, `${path}.typeByte`, fail);
  if (!Array.isArray(value.content)) return fail(`${path}.content`, 'must be an array');
  const pending: Uint8Array[] = [];
  const flush = () => {
    if (pending.length > 0) node.parts.push(Buffer.concat(pending.splice(0)));
  };
  value.content.forEach((part, i) => {
    const partPath = `${path}.content[${i}]`;
    if (isObject(part) && typeof part.text === 'string' && part.type === undefined) pending.push(encodeString(part.text));
    else if (isObject(part) && part.hex !== undefined && part.type === undefined) pending.push(parseHexBytes(part.hex, `${partPath}.hex`, fail));
    else {
      flush();
      node.parts.push(jsonToRecord(part, partPath, fail));
    }
  });
  flush();
  return node;
}

export function jsonToDecoded(value: unknown, kind: EncryptedStreamKind, path: string, fail: Fail): DecodedStream {
  if (!isObject(value)) return fail(path, 'expected an object');
  if (value.kind !== kind) fail(`${path}.kind`, `expected "${kind}" for this stream`);
  if (kind === 'promptManager') {
    if (!Array.isArray(value.documents)) return fail(`${path}.documents`, 'must be an array');
    const documents = value.documents.map((doc, i) => {
      if (isObject(doc) && typeof doc.text === 'string') return new Uint8Array(Buffer.from(doc.text, 'utf8'));
      if (isObject(doc) && doc.hex !== undefined) return parseHexBytes(doc.hex, `${path}.documents[${i}].hex`, fail);
      return fail(`${path}.documents[${i}]`, 'expected {"text": ...} or {"hex": ...}');
    });
    return { kind, documents };
  }
  if (!Array.isArray(value.records)) return fail(`${path}.records`, 'must be an array');
  return {
    kind,
    header: parseHexBytes(value.header, `${path}.header`, fail),
    encrypted: value.encrypted !== false,
    content: {
      records: value.records.map((r, i) => jsonToRecord(r, `${path}.records[${i}]`, fail)),
      trailing: value.trailing === undefined ? new Uint8Array(0) : parseHexBytes(value.trailing, `${path}.trailing`, fail),
    },
  };
}
