/** Low-level encoders/decoders shared by the reader and writer. */

import { CfbError } from './types.ts';

const HEX = '0123456789ABCDEF';
export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** Formats 16 bytes as a GUID (first three groups little-endian, as in Windows). */
export function formatGuid(bytes: Uint8Array, offset = 0): string {
  const order = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
  let out = '';
  for (const i of order) {
    if (i < 0) {
      out += '-';
    } else {
      const b = bytes[offset + i];
      out += HEX[b >> 4] + HEX[b & 15];
    }
  }
  return out;
}

const GUID_RE = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i;

export function parseGuid(text: string, target: Uint8Array, offset: number): void {
  const m = GUID_RE.exec(text);
  if (!m) throw new CfbError(`Invalid GUID "${text}"`);
  const hex = (s: string) => Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
  const bytes = [...hex(m[1]).reverse(), ...hex(m[2]).reverse(), ...hex(m[3]).reverse(), ...hex(m[4]), ...hex(m[5])];
  target.set(bytes, offset);
}

// 100ns ticks between 1601-01-01 and 1970-01-01
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const ISO_RE = /^([+-]\d{6}|\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,7}))?Z$/;

/** Converts a FILETIME (100ns ticks since 1601) to ISO-8601 with 7 fractional digits, losslessly. */
export function filetimeToIso(ticks: bigint): string | null {
  if (ticks === 0n) return null;
  const unixTicks = ticks - FILETIME_UNIX_EPOCH;
  let ms = unixTicks / 10000n;
  let rest = unixTicks % 10000n;
  if (rest < 0n) {
    ms -= 1n;
    rest += 10000n;
  }
  const iso = new Date(Number(ms)).toISOString(); // ...ss.mmmZ
  return `${iso.slice(0, -1)}${rest.toString().padStart(4, '0')}Z`;
}

export function isoToFiletime(iso: string | null | undefined): bigint {
  if (iso === null || iso === undefined) return 0n;
  const m = ISO_RE.exec(iso);
  if (!m) throw new CfbError(`Invalid timestamp "${iso}" (expected ISO-8601 UTC, e.g. 2020-01-31T12:00:00.0000000Z)`);
  const fraction = (m[7] ?? '').padEnd(7, '0');
  const base = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${fraction.slice(0, 3)}Z`);
  if (Number.isNaN(base)) throw new CfbError(`Invalid timestamp "${iso}"`);
  return BigInt(base) * 10000n + BigInt(fraction.slice(3)) + FILETIME_UNIX_EPOCH;
}

/** Upper-cases one UTF-16 code unit the way CFB name comparison expects. */
function upperUnit(code: number): number {
  const upper = String.fromCharCode(code).toUpperCase();
  return upper.length === 1 ? upper.charCodeAt(0) : code;
}

/** Directory sibling ordering from [MS-CFB] 2.6.4: shorter names first, then case-insensitive by code unit. */
export function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = upperUnit(a.charCodeAt(i)) - upperUnit(b.charCodeAt(i));
    if (d !== 0) return d;
  }
  return 0;
}
