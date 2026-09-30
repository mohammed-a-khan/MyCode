/**
 * Read-only decoder for OLE property set streams ([MS-OLEPS]), such as
 * "\u0005SummaryInformation" and "\u0005DocumentSummaryInformation".
 * The decoded values are informational; the raw stream bytes remain the source of truth.
 */

import { filetimeToIso, formatGuid } from './encoding.ts';

export const FMTID_SUMMARY_INFORMATION = 'F29F85E0-4FF9-1068-AB91-08002B27B3D9';
export const FMTID_DOC_SUMMARY_INFORMATION = 'D5CDD502-2E9C-101B-9397-08002B2CF9AE';
export const FMTID_USER_DEFINED_PROPERTIES = 'D5CDD505-2E9C-101B-9397-08002B2CF9AE';

const SUMMARY_NAMES: Record<number, string> = {
  2: 'title', 3: 'subject', 4: 'author', 5: 'keywords', 6: 'comments', 7: 'template', 8: 'lastAuthor',
  9: 'revisionNumber', 10: 'totalEditTime', 11: 'lastPrinted', 12: 'created', 13: 'lastSaved', 14: 'pageCount',
  15: 'wordCount', 16: 'characterCount', 17: 'thumbnail', 18: 'applicationName', 19: 'security',
};

const DOC_SUMMARY_NAMES: Record<number, string> = {
  2: 'category', 3: 'presentationFormat', 4: 'byteCount', 5: 'lineCount', 6: 'paragraphCount', 7: 'slideCount',
  8: 'noteCount', 9: 'hiddenCount', 10: 'multimediaClipCount', 11: 'scaleCrop', 12: 'headingPairs', 13: 'titlesOfParts',
  14: 'manager', 15: 'company', 16: 'linksUpToDate',
};

// Variant types
const VT_EMPTY = 0, VT_NULL = 1, VT_I2 = 2, VT_I4 = 3, VT_R4 = 4, VT_R8 = 5, VT_BSTR = 8, VT_BOOL = 11, VT_VARIANT = 12;
const VT_I1 = 16, VT_UI1 = 17, VT_UI2 = 18, VT_UI4 = 19, VT_I8 = 20, VT_UI8 = 21, VT_INT = 22, VT_UINT = 23;
const VT_LPSTR = 30, VT_LPWSTR = 31, VT_FILETIME = 64, VT_BLOB = 65, VT_CF = 71, VT_CLSID = 72, VT_VECTOR = 0x1000;

const CODEPAGE_UTF16 = 1200;
const PID_DICTIONARY = 0;
const PID_CODEPAGE = 1;

export type PropertyValue = string | number | boolean | null | PropertyValue[] | { binary: number };

export interface PropertySection {
  fmtid: string;
  codepage?: number;
  properties: Record<string, PropertyValue>;
}

export interface PropertySetInfo {
  sections: PropertySection[];
}

function decoderFor(codepage: number): TextDecoder {
  const label = codepage === 65001 ? 'utf-8' : codepage === CODEPAGE_UTF16 ? 'utf-16le' : `windows-${codepage}`;
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('latin1');
  }
}

const stripNul = (s: string) => s.replace(/\0+$/, '');

export function parsePropertySet(bytes: Uint8Array, streamName: string): PropertySetInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28 || view.getUint16(0, true) !== 0xfffe) throw new Error('not an OLE property set');
  const sectionCount = view.getUint32(24, true);
  const sections: PropertySection[] = [];

  for (let s = 0; s < sectionCount; s++) {
    const headerOff = 28 + s * 20;
    const fmtid = formatGuid(bytes, headerOff);
    const base = view.getUint32(headerOff + 16, true);
    const propCount = view.getUint32(base + 4, true);
    const offsets = new Map<number, number>();
    for (let i = 0; i < propCount; i++) {
      offsets.set(view.getUint32(base + 8 + i * 8, true), base + view.getUint32(base + 12 + i * 8, true));
    }

    const codepageOff = offsets.get(PID_CODEPAGE);
    const codepage = codepageOff !== undefined ? view.getUint16(codepageOff + 4, true) : 1252;
    const decoder = decoderFor(codepage);
    const names: Record<number, string> =
      fmtid === FMTID_SUMMARY_INFORMATION ? SUMMARY_NAMES : fmtid === FMTID_DOC_SUMMARY_INFORMATION ? DOC_SUMMARY_NAMES : {};

    // Reads a codepage string with a 32-bit length prefix; returns [value, bytes consumed].
    const readString = (off: number, wide: boolean): [string, number] => {
      const len = view.getUint32(off, true);
      const byteLen = wide ? len * 2 : len;
      const raw = bytes.subarray(off + 4, off + 4 + byteLen);
      const text = wide ? new TextDecoder('utf-16le').decode(raw) : decoder.decode(raw);
      return [stripNul(text), 4 + Math.ceil(byteLen / 4) * 4];
    };

    // Reads a typed value; returns [value, bytes consumed including padding].
    const readValue = (off: number, vt: number): [PropertyValue, number] => {
      if (vt & VT_VECTOR) {
        const count = view.getUint32(off, true);
        // Every item takes at least one byte, except empty ones: a count beyond the data is corrupt.
        if (count > bytes.length - off - 4) throw new Error(`property vector of ${count} items exceeds the property data`);
        const items: PropertyValue[] = [];
        let pos = off + 4;
        for (let i = 0; i < count; i++) {
          const itemVt = vt & ~VT_VECTOR;
          const [item, used] = itemVt === VT_VARIANT ? readTyped(pos) : readValue(pos, itemVt);
          items.push(item);
          pos += used;
        }
        return [items, pos - off];
      }
      switch (vt) {
        case VT_EMPTY: case VT_NULL: return [null, 0];
        case VT_I2: return [view.getInt16(off, true), 4];
        case VT_UI2: return [view.getUint16(off, true), 4];
        case VT_I1: return [view.getInt8(off), 4];
        case VT_UI1: return [view.getUint8(off), 4];
        case VT_BOOL: return [view.getInt16(off, true) !== 0, 4];
        case VT_I4: case VT_INT: return [view.getInt32(off, true), 4];
        case VT_UI4: case VT_UINT: return [view.getUint32(off, true), 4];
        case VT_R4: return [view.getFloat32(off, true), 4];
        case VT_R8: return [view.getFloat64(off, true), 8];
        case VT_I8: return [Number(view.getBigInt64(off, true)), 8];
        case VT_UI8: return [Number(view.getBigUint64(off, true)), 8];
        case VT_LPSTR: case VT_BSTR: return readString(off, codepage === CODEPAGE_UTF16);
        case VT_LPWSTR: return readString(off, true);
        case VT_CLSID: return [formatGuid(bytes, off), 16];
        case VT_FILETIME: return [filetimeToIso(view.getBigUint64(off, true)), 8];
        case VT_BLOB: case VT_CF: {
          const len = view.getUint32(off, true);
          return [{ binary: len }, 4 + Math.ceil(len / 4) * 4];
        }
        default: throw new Error(`unsupported property type 0x${vt.toString(16)}`);
      }
    };
    const readTyped = (off: number): [PropertyValue, number] => {
      const [value, used] = readValue(off + 4, view.getUint16(off, true));
      return [value, used + 4];
    };

    // Optional dictionary (user-defined property names).
    const dictionary = new Map<number, string>();
    const dictOff = offsets.get(PID_DICTIONARY);
    if (dictOff !== undefined) {
      const count = view.getUint32(dictOff, true);
      let pos = dictOff + 4;
      for (let i = 0; i < count; i++) {
        const id = view.getUint32(pos, true);
        const len = view.getUint32(pos + 4, true);
        const wide = codepage === CODEPAGE_UTF16;
        const raw = bytes.subarray(pos + 8, pos + 8 + (wide ? len * 2 : len));
        dictionary.set(id, stripNul(wide ? new TextDecoder('utf-16le').decode(raw) : decoder.decode(raw)));
        pos += 8 + (wide ? Math.ceil((len * 2) / 4) * 4 : len);
      }
    }

    const properties: Record<string, PropertyValue> = {};
    for (const [id, off] of [...offsets].sort((a, b) => a[0] - b[0])) {
      if (id === PID_DICTIONARY || id === PID_CODEPAGE) continue;
      const key = dictionary.get(id) ?? names[id] ?? `property${id}`;
      try {
        properties[key] = readTyped(off)[0];
      } catch (err) {
        properties[key] = `<undecoded: ${(err as Error).message}>`;
      }
    }
    // Edit time is a duration stored as a FILETIME; report it in seconds rather than as a date.
    if (fmtid === FMTID_SUMMARY_INFORMATION && offsets.has(10) && view.getUint16(offsets.get(10)!, true) === VT_FILETIME) {
      properties.totalEditTime = Number(view.getBigUint64(offsets.get(10)! + 4, true) / 10000000n);
    }
    sections.push({ fmtid, codepage, properties });
  }
  if (sections.length === 0) throw new Error(`property set ${JSON.stringify(streamName)} has no sections`);
  return { sections };
}
