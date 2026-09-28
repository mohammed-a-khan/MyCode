/**
 * Decoding and re-encoding of the encrypted Crystal Reports streams.
 *
 *   Contents, ReportParametersStream   plaintext header record (type 0xFFFF, carries the IV),
 *                                      then AES-CFB encrypted zlib data holding report records
 *   QESession                          38-byte "QENG" header (IV at 0x16), then AES-CFB encrypted
 *                                      zlib data holding query-engine records
 *   PromptManager                      one or more blocks, each AES-CFB encrypted from a zero IV,
 *                                      each a zlib-compressed <CRMetaObjects> XML document
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { queryCipher, reportCipher } from './crypto.ts';
import { parseRecords, readHeader, serializeRecords, type Dialect, type ParsedRecords } from './records.ts';

export type EncryptedStreamKind = 'contents' | 'reportParameters' | 'qeSession' | 'promptManager';

export interface RecordStream {
  kind: 'contents' | 'reportParameters' | 'qeSession';
  /** Plaintext bytes preceding the encrypted payload (kept verbatim; they hold the IV). */
  header: Uint8Array;
  encrypted: boolean;
  content: ParsedRecords;
}

export interface PromptManagerStream {
  kind: 'promptManager';
  documents: Uint8Array[];
}

export type DecodedStream = RecordStream | PromptManagerStream;

const QE_MAGIC = 'QENG';
const QE_IV_OFFSET = 0x16;
const QE_HEADER_LENGTH = 0x26;
const ZERO_IV = new Uint8Array(16);

export function encryptedStreamKind(name: string): EncryptedStreamKind | undefined {
  const base = name.replace(/ \d+\w?$/, '');
  if (base === 'Contents') return 'contents';
  if (base === 'ReportParametersStream') return 'reportParameters';
  if (base === 'QESession') return 'qeSession';
  if (base === 'PromptManager') return 'promptManager';
  return undefined;
}

const dialectOf = (kind: RecordStream['kind']): Dialect => (kind === 'qeSession' ? 'query' : 'report');

/** Inflates a zlib stream and reports how many input bytes it used. */
function inflateCounted(data: Uint8Array): { output: Uint8Array; used: number } {
  const result = inflateSync(data, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { output: new Uint8Array(result.buffer), used: result.engine.bytesWritten };
}

interface HeaderLayout {
  end: number;
  encrypted: boolean;
  iv: Uint8Array;
}

/** Locates the plaintext 0xFFFF header record and reads its encryption flag and IV. */
function reportHeaderLayout(raw: Uint8Array): HeaderLayout {
  const h = readHeader(raw, 0, 0, raw.length);
  if (!h || h.node.type !== 0xffff || h.contentLength < 6) throw new Error('missing stream header record');
  const start = h.headerLength;
  const mask = h.node.flags & 0x08 ? 0xff : 0;
  const content = raw.slice(start, start + h.contentLength).map((b) => b ^ mask);
  const encrypted = ((content[0] << 8) | content[1]) !== 0;
  if (encrypted && content.length < 22) throw new Error('stream header too short to hold an IV');
  return { end: start + h.contentLength, encrypted, iv: encrypted ? content.slice(6, 22) : ZERO_IV };
}

function qeHeaderLayout(raw: Uint8Array): HeaderLayout {
  if (raw.length < QE_HEADER_LENGTH || String.fromCharCode(...raw.subarray(0, 4)) !== QE_MAGIC) {
    throw new Error('missing QENG header');
  }
  return { end: QE_HEADER_LENGTH, encrypted: true, iv: raw.slice(QE_IV_OFFSET, QE_HEADER_LENGTH) };
}

export function decodeStream(kind: EncryptedStreamKind, raw: Uint8Array): DecodedStream {
  if (kind === 'promptManager') {
    const documents: Uint8Array[] = [];
    for (let pos = 0; pos < raw.length; ) {
      const { output, used } = inflateCounted(reportCipher.decrypt(ZERO_IV, raw.subarray(pos)));
      if (used === 0) throw new Error('empty PromptManager block');
      documents.push(output);
      pos += used;
    }
    return { kind, documents };
  }
  const layout = kind === 'qeSession' ? qeHeaderLayout(raw) : reportHeaderLayout(raw);
  const cipher = kind === 'qeSession' ? queryCipher : reportCipher;
  const payload = raw.subarray(layout.end);
  const compressed = layout.encrypted ? cipher.decrypt(layout.iv, payload) : payload;
  const { output, used } = inflateCounted(compressed);
  if (used !== compressed.length) throw new Error(`${compressed.length - used} unexpected bytes after the compressed payload`);
  return { kind, header: raw.slice(0, layout.end), encrypted: layout.encrypted, content: parseRecords(output, dialectOf(kind)) };
}

/** The decompressed bytes a decoded stream represents. */
export function logicalBytes(stream: DecodedStream): Uint8Array[] {
  return stream.kind === 'promptManager' ? stream.documents : [serializeRecords(stream.content)];
}

export function encodeStream(stream: DecodedStream): Uint8Array {
  if (stream.kind === 'promptManager') {
    const blocks = stream.documents.map((doc) => reportCipher.encrypt(ZERO_IV, deflateSync(doc)));
    return Buffer.concat(blocks);
  }
  const layout = stream.kind === 'qeSession' ? qeHeaderLayout(stream.header) : reportHeaderLayout(stream.header);
  if (layout.end !== stream.header.length) throw new Error('stream header has unexpected trailing bytes');
  const cipher = stream.kind === 'qeSession' ? queryCipher : reportCipher;
  const compressed = deflateSync(serializeRecords(stream.content));
  const payload = layout.encrypted ? cipher.encrypt(layout.iv, compressed) : compressed;
  return Buffer.concat([stream.header, payload]);
}
