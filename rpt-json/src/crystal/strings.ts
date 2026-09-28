/**
 * Length-prefixed strings inside record content: a 4-byte big-endian byte count that includes a
 * trailing NUL, then UTF-8 bytes, then the NUL.
 */

export type Token = { text: string } | { bytes: Uint8Array };

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Returns the string starting at `pos` and its encoded length, if the bytes there form one exactly. */
export function stringAt(bytes: Uint8Array, pos: number): { text: string; length: number } | undefined {
  if (pos + 5 > bytes.length) return undefined;
  const count = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
  const end = pos + 4 + count;
  if (count < 1 || end > bytes.length || bytes[end - 1] !== 0) return undefined;
  const raw = bytes.subarray(pos + 4, end - 1);
  if (raw.includes(0)) return undefined;
  let text: string;
  try {
    text = decoder.decode(raw);
  } catch {
    return undefined;
  }
  // Only accept text that re-encodes to exactly the same bytes, so tokenising stays lossless.
  if (CONTROL_CHARS.test(text) || encoder.encode(text).length !== raw.length) return undefined;
  return { text, length: 4 + count };
}

export function encodeString(text: string): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(4 + body.length + 1);
  new DataView(out.buffer).setUint32(0, body.length + 1);
  out.set(body, 4);
  return out;
}

/** An empty string's 5 bytes can overlap the length prefix of a real string that starts just after it. */
function overlapsLongerString(bytes: Uint8Array, pos: number): boolean {
  for (let k = 1; k <= 4; k++) {
    const next = stringAt(bytes, pos + k);
    if (next && next.text !== '') return true;
  }
  return false;
}

/** Splits bytes into strings and binary runs. Concatenating the encoded tokens gives the input back. */
export function tokenize(bytes: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let runStart = 0;
  let pos = 0;
  while (pos < bytes.length) {
    const s = stringAt(bytes, pos);
    if (!s || (s.text === '' && overlapsLongerString(bytes, pos))) {
      pos++;
      continue;
    }
    if (pos > runStart) tokens.push({ bytes: bytes.slice(runStart, pos) });
    tokens.push({ text: s.text });
    pos += s.length;
    runStart = pos;
  }
  if (pos > runStart) tokens.push({ bytes: bytes.slice(runStart, pos) });
  return tokens;
}

/** All strings found in the given bytes, in order. */
export function stringsIn(bytes: Uint8Array): string[] {
  return tokenize(bytes).flatMap((t) => ('text' in t ? [t.text] : []));
}
