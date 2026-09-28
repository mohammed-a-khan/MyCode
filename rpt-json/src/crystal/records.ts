/**
 * Record framing inside decrypted Crystal Reports streams.
 *
 * A decrypted stream is a sequence of records. Each record header is:
 *   flags(1)  typeLow(1)  [typeWord(2, LE) if flags&0x04]  [schema(2, BE) if flags&0x20]  [length(0/1/2/4, BE)]
 * Flag bits: 7-6 length width (0,1,2,4 bytes), 5 schema present, 4 length-prefixed strings,
 * 3 content is XOR-masked, 2 extended type word, 1-0 high bits of an inline type.
 *
 * Content bytes are XOR-masked with the low bytes of the types of every enclosing record,
 * so a record's children (and their headers) are read under the parent's running mask.
 *
 * parse() and serialize() are exact inverses: whatever the parser decides is a nested record
 * or plain field bytes, serialising the result reproduces the input byte-for-byte.
 */

export type Dialect = 'report' | 'query';

export interface RecordNode {
  /** Raw flag byte (includes the high bits of an inline type). */
  flags: number;
  type: number;
  /** Second header byte when an extended type word is used (otherwise derived from type). */
  typeByte?: number;
  schema: number | null;
  /** Unmasked content: plain field bytes interleaved with nested records, in file order. */
  parts: RecordPart[];
}

export type RecordPart = Uint8Array | RecordNode;

export interface ParsedRecords {
  records: RecordNode[];
  /** Bytes after the last complete top-level record (normally empty). */
  trailing: Uint8Array;
}

const FLAG_EXTENDED_TYPE = 0x04;
const FLAG_MASKED = 0x08;
const FLAG_ENHANCED_STRINGS = 0x10;
const FLAG_SCHEMA = 0x20;
const LENGTH_WIDTHS = [0, 1, 2, 4];
const MAX_DEPTH = 32;

/** Schema high byte observed on every nested record of each stream; used to recognise headers. */
const SCHEMA_PREFIX: Record<Dialect, number> = { report: 0x07, query: 0x09 };

export interface Header {
  node: RecordNode;
  headerLength: number;
  contentLength: number;
}

export function readHeader(data: Uint8Array, pos: number, mask: number, limit: number): Header | undefined {
  const at = (i: number) => (pos + i < limit ? data[pos + i] ^ mask : -1);
  const flags = at(0);
  const second = at(1);
  if (flags < 0 || second < 0) return undefined;
  let len = 2;
  let type = ((flags & 0x03) << 8) | second;
  let typeByte: number | undefined;
  if (flags & FLAG_EXTENDED_TYPE) {
    const lo = at(2);
    const hi = at(3);
    if (lo < 0 || hi < 0) return undefined;
    type = lo | (hi << 8);
    typeByte = second;
    len += 2;
  }
  let schema: number | null = null;
  if (flags & FLAG_SCHEMA) {
    const hi = at(len);
    const lo = at(len + 1);
    if (hi < 0 || lo < 0) return undefined;
    schema = (hi << 8) | lo;
    len += 2;
  }
  const width = LENGTH_WIDTHS[flags >> 6];
  let contentLength = 0;
  for (let i = 0; i < width; i++) {
    const b = at(len + i);
    if (b < 0) return undefined;
    contentLength = contentLength * 256 + b;
  }
  len += width;
  if (pos + len + contentLength > limit) return undefined;
  const node: RecordNode = { flags, type, schema, parts: [] };
  if (typeByte !== undefined) node.typeByte = typeByte;
  return { node, headerLength: len, contentLength };
}

/**
 * Whether a header found while scanning a record's content is plausibly a nested record rather
 * than field bytes: nested records always carry the masked and length-prefixed-string flags,
 * state a schema in the stream's series, and either have a 4-byte length or (report streams
 * only) are empty end markers.
 */
function isNestedHeader(h: Header, dialect: Dialect): boolean {
  const { flags, schema } = h.node;
  if (!(flags & FLAG_MASKED) || !(flags & FLAG_ENHANCED_STRINGS) || schema === null) return false;
  if (schema >> 8 !== SCHEMA_PREFIX[dialect]) return false;
  const width = LENGTH_WIDTHS[flags >> 6];
  return width === 4 || (width === 0 && dialect === 'report');
}

function parseContent(data: Uint8Array, start: number, end: number, mask: number, dialect: Dialect, depth: number): RecordPart[] {
  const parts: RecordPart[] = [];
  let runStart = start;
  const flushRun = (upTo: number) => {
    if (upTo > runStart) parts.push(data.slice(runStart, upTo).map((b) => b ^ mask));
  };
  let pos = start;
  while (pos < end) {
    const h = depth < MAX_DEPTH ? readHeader(data, pos, mask, end) : undefined;
    if (!h || !isNestedHeader(h, dialect)) {
      pos++;
      continue;
    }
    flushRun(pos);
    const contentStart = pos + h.headerLength;
    const contentEnd = contentStart + h.contentLength;
    h.node.parts = parseContent(data, contentStart, contentEnd, mask ^ (h.node.type & 0xff), dialect, depth + 1);
    parts.push(h.node);
    pos = runStart = contentEnd;
  }
  flushRun(end);
  return parts;
}

/** Splits a decrypted, inflated stream into its top-level records and parses their contents. */
export function parseRecords(data: Uint8Array, dialect: Dialect): ParsedRecords {
  const records: RecordNode[] = [];
  let pos = 0;
  while (pos < data.length) {
    // Top-level headers are unmasked and follow each other back to back.
    const h = readHeader(data, pos, 0, data.length);
    if (!h) break;
    const contentStart = pos + h.headerLength;
    const contentEnd = contentStart + h.contentLength;
    h.node.parts = parseContent(data, contentStart, contentEnd, h.node.type & 0xff, dialect, 1);
    records.push(h.node);
    pos = contentEnd;
  }
  return { records, trailing: data.slice(pos) };
}

function contentLength(parts: RecordPart[]): number {
  let total = 0;
  for (const part of parts) total += part instanceof Uint8Array ? part.length : encodedLength(part);
  return total;
}

function headerBytes(node: RecordNode, length: number): number[] {
  const { flags, type, schema } = node;
  const out = [flags];
  if (flags & FLAG_EXTENDED_TYPE) {
    out.push(node.typeByte ?? 0, type & 0xff, type >> 8);
  } else {
    if (type >> 8 !== (flags & 0x03)) throw new Error(`Record type 0x${type.toString(16)} does not match its flag byte 0x${flags.toString(16)}`);
    out.push(type & 0xff);
  }
  if (flags & FLAG_SCHEMA) {
    if (schema === null) throw new Error(`Record type 0x${type.toString(16)}: flag byte declares a schema but none is set`);
    out.push(schema >> 8, schema & 0xff);
  }
  const width = LENGTH_WIDTHS[flags >> 6];
  if (length >= 2 ** (8 * width)) {
    throw new Error(`Record type 0x${type.toString(16)}: content of ${length} bytes does not fit its ${width}-byte length field`);
  }
  for (let i = width - 1; i >= 0; i--) out.push(Math.floor(length / 2 ** (8 * i)) & 0xff);
  return out;
}

function encodedLength(node: RecordNode): number {
  const length = contentLength(node.parts);
  return headerBytes(node, length).length + length;
}

function writeParts(parts: RecordPart[], mask: number, out: number[]): void {
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      for (const b of part) out.push(b ^ mask);
    } else {
      for (const b of headerBytes(part, contentLength(part.parts))) out.push(b ^ mask);
      writeParts(part.parts, mask ^ (part.type & 0xff), out);
    }
  }
}

export function serializeRecords(parsed: ParsedRecords): Uint8Array {
  const out: number[] = [];
  for (const record of parsed.records) {
    for (const b of headerBytes(record, contentLength(record.parts))) out.push(b);
    writeParts(record.parts, record.type & 0xff, out);
  }
  for (const b of parsed.trailing) out.push(b);
  return Uint8Array.from(out);
}
