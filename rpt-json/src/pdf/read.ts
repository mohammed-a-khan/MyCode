import { inflateRawSync, inflateSync } from 'node:zlib';

type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfValue[] | PdfDict | PdfStream | PdfOp;

interface PdfName { kind: 'name'; name: string }
interface PdfString { kind: 'string'; bytes: Uint8Array }
interface PdfRef { kind: 'ref'; num: number }
interface PdfOp { kind: 'op'; op: string }
interface PdfDict { kind: 'dict'; map: Map<string, PdfValue> }
interface PdfStream { kind: 'stream'; dict: PdfDict; raw: Uint8Array }

export interface TextRun {
  x: number;
  y: number;
  end: number;
  size: number;
  text: string;
}

export interface PdfPage {
  number: number;
  width: number;
  height: number;
  runs: TextRun[];
  images: { x: number; y: number; width: number; height: number }[];
}

const isName = (v: PdfValue | undefined, name?: string): v is PdfName => !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'name' && (name === undefined || v.name === name);
const isDict = (v: PdfValue | undefined): v is PdfDict => !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'dict';
const isStream = (v: PdfValue | undefined): v is PdfStream => !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'stream';
const isRef = (v: PdfValue | undefined): v is PdfRef => !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'ref';
const isString = (v: PdfValue | undefined): v is PdfString => !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'string';

const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

class Lexer {
  pos = 0;
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  skip(): void {
    const d = this.data;
    while (this.pos < d.length) {
      const c = d[this.pos]!;
      if (WHITE.has(c)) { this.pos++; continue; }
      if (c === 37) { while (this.pos < d.length && d[this.pos] !== 10 && d[this.pos] !== 13) this.pos++; continue; }
      break;
    }
  }

  word(): string {
    const d = this.data;
    const start = this.pos;
    while (this.pos < d.length && !WHITE.has(d[this.pos]!) && !DELIM.has(d[this.pos]!)) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(d[i]!);
    return s;
  }

  value(content = false): PdfValue | undefined {
    this.skip();
    const d = this.data;
    if (this.pos >= d.length) return undefined;
    const c = d[this.pos]!;
    if (c === 47) {
      this.pos++;
      const raw = this.word();
      return { kind: 'name', name: raw.replace(/#([0-9a-fA-F]{2})/g, (_: string, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 40) return this.literal();
    if (c === 60) {
      if (d[this.pos + 1] === 60) {
        this.pos += 2;
        const map = new Map<string, PdfValue>();
        for (;;) {
          this.skip();
          if (this.pos >= d.length) break;
          if (d[this.pos] === 62 && d[this.pos + 1] === 62) { this.pos += 2; break; }
          const key = this.value(content);
          if (!isName(key)) { if (key === undefined) break; continue; }
          const v = this.value(content);
          if (v !== undefined) map.set(key.name, v);
        }
        return { kind: 'dict', map };
      }
      this.pos++;
      let hex = '';
      while (this.pos < d.length && d[this.pos] !== 62) {
        const h = d[this.pos++]!;
        if (!WHITE.has(h)) hex += String.fromCharCode(h);
      }
      this.pos++;
      if (hex.length % 2) hex += '0';
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
      return { kind: 'string', bytes };
    }
    if (c === 91) {
      this.pos++;
      const items: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.pos >= d.length) break;
        if (d[this.pos] === 93) { this.pos++; break; }
        const v = this.value(content);
        if (v === undefined) break;
        items.push(v);
      }
      return items;
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      this.pos++;
      return { kind: 'op', op: String.fromCharCode(c) };
    }
    const w = this.word();
    if (!w) { this.pos++; return { kind: 'op', op: '' }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (!content && /^\d+$/.test(w)) {
        const save = this.pos;
        this.skip();
        const g = this.word();
        if (/^\d+$/.test(g)) {
          this.skip();
          if (this.data[this.pos] === 82 && (this.pos + 1 >= d.length || WHITE.has(d[this.pos + 1]!) || DELIM.has(d[this.pos + 1]!))) {
            this.pos++;
            return { kind: 'ref', num: n };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return { kind: 'op', op: w };
  }

  literal(): PdfString {
    const d = this.data;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < d.length) {
      const c = d[this.pos++]!;
      if (c === 92) {
        const e = d[this.pos++]!;
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e === 13) { if (d[this.pos] === 10) this.pos++; }
        else if (e === 10) { void 0; }
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && d[this.pos]! >= 48 && d[this.pos]! <= 55; k++) v = v * 8 + d[this.pos++]! - 48;
          out.push(v & 255);
        } else out.push(e);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) break;
      out.push(c);
    }
    return { kind: 'string', bytes: Uint8Array.from(out) };
  }
}

function lzw(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); };
  reset();
  let width = 9;
  let bits = 0;
  let buffer = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < data.length; i++) {
    buffer = (buffer << 8) | data[i]!;
    bits += 8;
    while (bits >= width) {
      const code = (buffer >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) { reset(); width = 9; prev = null; continue; }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else if (prev) entry = [...prev, prev[0]!];
      else return Uint8Array.from(out);
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length + 1 >= 1 << width && width < 12) width++;
    }
  }
  return Uint8Array.from(out);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  for (const c of data) {
    if (c === 126) break;
    if (WHITE.has(c)) continue;
    if (c === 122 && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = parms?.map.get('Predictor');
  if (typeof predictor !== 'number' || predictor < 10) return data;
  const columns = (parms!.map.get('Columns') as number) || 1;
  const colors = (parms!.map.get('Colors') as number) || 1;
  const bpc = (parms!.map.get('BitsPerComponent') as number) || 8;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((columns * colors * bpc) / 8);
  const out = new Uint8Array(Math.floor(data.length / (row + 1)) * row);
  let prior = new Uint8Array(row);
  for (let r = 0, at = 0; at + row < data.length + 1 && r * row < out.length; r++, at += row + 1) {
    const type = data[at]!;
    const line = data.slice(at + 1, at + 1 + row);
    for (let i = 0; i < row; i++) {
      const left = i >= bpp ? line[i - bpp]! : 0;
      const up = prior[i]!;
      const ul = i >= bpp ? prior[i - bpp]! : 0;
      let v = line[i]!;
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += Math.floor((left + up) / 2);
      else if (type === 4) { const p = left + up - ul; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      line[i] = v & 255;
    }
    out.set(line, r * row);
    prior = line;
  }
  return out;
}

export class PdfDocument {
  private readonly objects = new Map<number, PdfValue>();
  private readonly offsets = new Map<number, number>();
  private readonly text: string;
  readonly encrypted: boolean;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    let s = '';
    for (let i = 0; i < data.length; i += 65536) s += String.fromCharCode(...data.subarray(i, i + 65536));
    this.text = s;
    for (const m of s.matchAll(/(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g)) this.offsets.set(Number(m[1]), m.index! + m[0].length);
    this.encrypted = /\/Encrypt\s/.test(s.slice(Math.max(0, s.length - 4096))) || /trailer[\s\S]{0,400}\/Encrypt/.test(s);
    for (const num of [...this.offsets.keys()]) {
      const v = this.get(num);
      if (isStream(v) && isName(v.dict.map.get('Type'), 'ObjStm')) this.unpack(v);
    }
  }

  private unpack(stream: PdfStream): void {
    const data = this.decode(stream);
    const count = (this.resolve(stream.dict.map.get('N')) as number) || 0;
    const first = (this.resolve(stream.dict.map.get('First')) as number) || 0;
    const lex = new Lexer(data);
    const pairs: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const num = lex.value(true);
      const off = lex.value(true);
      if (typeof num !== 'number' || typeof off !== 'number') break;
      pairs.push([num, off]);
    }
    for (const [num, off] of pairs) {
      if (this.offsets.has(num)) continue;
      const inner = new Lexer(data);
      inner.pos = first + off;
      const v = inner.value();
      if (v !== undefined) this.objects.set(num, v);
    }
  }

  get(num: number): PdfValue {
    if (this.objects.has(num)) return this.objects.get(num)!;
    const at = this.offsets.get(num);
    if (at === undefined) return null;
    this.objects.set(num, null);
    const lex = new Lexer(this.data);
    lex.pos = at;
    let v = lex.value() ?? null;
    if (isDict(v)) {
      const save = lex.pos;
      lex.skip();
      if (this.text.startsWith('stream', lex.pos)) {
        let start = lex.pos + 6;
        if (this.data[start] === 13) start++;
        if (this.data[start] === 10) start++;
        const length = v.map.get('Length');
        let len = typeof length === 'number' ? length : isRef(length) ? this.resolveNumber(length) : -1;
        const endAt = this.text.indexOf('endstream', start);
        if (len < 0 || start + len > this.data.length || (endAt >= 0 && Math.abs(endAt - (start + len)) > 4 && !this.text.startsWith('endstream', start + len))) len = endAt >= 0 ? endAt - start : this.data.length - start;
        let end = start + len;
        while (end > start && (this.data[end - 1] === 10 || this.data[end - 1] === 13) && endAt === end) end--;
        v = { kind: 'stream', dict: v, raw: this.data.subarray(start, end) };
      } else lex.pos = save;
    }
    this.objects.set(num, v);
    return v;
  }

  private resolveNumber(ref: PdfRef): number {
    const v = this.get(ref.num);
    return typeof v === 'number' ? v : -1;
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let guard = 0;
    while (isRef(v) && guard++ < 32) v = this.get(v.num);
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | undefined {
    const r = this.resolve(v);
    return isDict(r) ? r : isStream(r) ? r.dict : undefined;
  }

  decode(stream: PdfStream): Uint8Array {
    let data = stream.raw;
    const filters = this.resolve(stream.dict.map.get('Filter'));
    const parms = this.resolve(stream.dict.map.get('DecodeParms'));
    const list = Array.isArray(filters) ? filters.map((f) => this.resolve(f)) : filters ? [filters] : [];
    const parmList = Array.isArray(parms) ? parms.map((p) => this.dict(p)) : [this.dict(parms ?? undefined)];
    list.forEach((f, k) => {
      if (!isName(f)) return;
      if (f.name === 'FlateDecode' || f.name === 'Fl') {
        try { data = inflateSync(data); } catch { try { data = inflateRawSync(data.subarray(2)); } catch { data = new Uint8Array(0); } }
        data = unpredict(data, parmList[k]);
      } else if (f.name === 'LZWDecode' || f.name === 'LZW') data = unpredict(lzw(data), parmList[k]);
      else if (f.name === 'ASCII85Decode' || f.name === 'A85') data = ascii85(data);
      else if (f.name === 'ASCIIHexDecode' || f.name === 'AHx') {
        const hex = String.fromCharCode(...data).replace(/[^0-9a-fA-F]/g, '');
        data = Uint8Array.from((hex.length % 2 ? hex + '0' : hex).match(/../g) ?? [], (h) => parseInt(h, 16));
      }
    });
    return data;
  }

  catalog(): PdfDict | undefined {
    const trailers = [...this.text.matchAll(/trailer\s*<</g)];
    for (const t of trailers.reverse()) {
      const lex = new Lexer(this.data);
      lex.pos = t.index! + 7;
      const d = lex.value();
      if (isDict(d)) {
        const root = this.dict(d.map.get('Root'));
        if (root) return root;
      }
    }
    for (const num of [...this.offsets.keys(), ...this.objects.keys()].reverse()) {
      const v = this.get(num);
      const d = isStream(v) ? v.dict : isDict(v) ? v : undefined;
      if (d && isName(d.map.get('Type'), 'XRef')) { const root = this.dict(d.map.get('Root')); if (root) return root; }
      if (d && isName(d.map.get('Type'), 'Catalog')) return d;
    }
    return undefined;
  }

  pages(): { dict: PdfDict; resources?: PdfDict; box: number[] }[] {
    const out: { dict: PdfDict; resources?: PdfDict; box: number[] }[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, resources: PdfDict | undefined, box: number[]) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const res = this.dict(node.map.get('Resources')) ?? resources;
      const mb = this.resolve(node.map.get('MediaBox'));
      const b = Array.isArray(mb) && mb.length === 4 ? mb.map((x) => Number(this.resolve(x)) || 0) : box;
      const kids = this.resolve(node.map.get('Kids'));
      if (Array.isArray(kids)) for (const k of kids) walk(this.dict(k), res, b);
      else out.push({ dict: node, resources: res, box: b });
    };
    walk(this.dict(this.catalog()?.map.get('Pages')), undefined, [0, 0, 612, 792]);
    return out;
  }
}

const WIN_ANSI: Record<number, string> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž',
  145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', endash: '–', emdash: '—', bullet: '•', sterling: '£', yen: '¥', Euro: '€', euro: '€', cent: '¢',
  degree: '°', section: '§', paragraph: '¶', copyright: '©', registered: '®', trademark: '™', ellipsis: '…', nbspace: ' ', uni00A0: ' ',
};

function glyphText(name: string): string {
  if (GLYPHS[name] !== undefined) return GLYPHS[name]!;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16));
  return '';
}

interface FontInfo {
  twoByte: boolean;
  map: Map<number, string>;
  widths: Map<number, number>;
  defaultWidth: number;
  fallback: (code: number) => string;
}

function parseCMap(text: string, map: Map<number, string>): number {
  let bytes = 1;
  const hexToText = (hex: string) => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  };
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const first = /<([0-9A-Fa-f]+)>/.exec(m[1]!);
    if (first) bytes = Math.max(1, first[1]!.length / 2);
  }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(p[1]!, 16), hexToText(p[2]!));
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1]!, 16);
      const hi = parseInt(p[2]!, 16);
      if (hi - lo > 65535) continue;
      if (p[3]!.startsWith('[')) {
        const items = [...p[3]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToText(x[1]!));
        items.forEach((t, k) => map.set(lo + k, t));
      } else {
        const hex = p[3]!.slice(1, -1);
        const base = hexToText(hex);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      }
    }
  }
  return bytes;
}

function fontInfo(doc: PdfDocument, font: PdfDict | undefined, cache: Map<PdfDict, FontInfo>): FontInfo {
  const plainInfo: FontInfo = { twoByte: false, map: new Map(), widths: new Map(), defaultWidth: 500, fallback: (c) => WIN_ANSI[c] ?? String.fromCharCode(c) };
  if (!font) return plainInfo;
  const known = cache.get(font);
  if (known) return known;
  const subtype = doc.resolve(font.map.get('Subtype'));
  const info: FontInfo = { ...plainInfo, map: new Map(), widths: new Map() };
  const encoding = doc.resolve(font.map.get('Encoding'));
  if (isName(subtype, 'Type0')) {
    info.twoByte = !(isName(encoding) && !/^Ident|UCS2|UTF16|-H$|-V$/.test(encoding.name));
    info.defaultWidth = 1000;
    info.fallback = () => '';
    const desc = doc.resolve(font.map.get('DescendantFonts'));
    const cid = doc.dict(Array.isArray(desc) ? desc[0] : undefined);
    if (cid) {
      const dw = doc.resolve(cid.map.get('DW'));
      if (typeof dw === 'number') info.defaultWidth = dw;
      const w = doc.resolve(cid.map.get('W'));
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length;) {
          const a = Number(doc.resolve(w[i]));
          const b = doc.resolve(w[i + 1]);
          if (Array.isArray(b)) { b.forEach((x, k) => info.widths.set(a + k, Number(doc.resolve(x)) || 0)); i += 2; }
          else { const last = Number(b); const width = Number(doc.resolve(w[i + 2])) || 0; for (let c = a; c <= last && c - a < 65536; c++) info.widths.set(c, width); i += 3; }
        }
      }
    }
  } else {
    const first = Number(doc.resolve(font.map.get('FirstChar'))) || 0;
    const widths = doc.resolve(font.map.get('Widths'));
    if (Array.isArray(widths)) widths.forEach((x, k) => info.widths.set(first + k, Number(doc.resolve(x)) || 0));
    const enc = isDict(encoding) ? encoding : undefined;
    const base = isName(encoding) ? encoding.name : enc && isName(doc.resolve(enc.map.get('BaseEncoding'))) ? (doc.resolve(enc.map.get('BaseEncoding')) as PdfName).name : 'WinAnsiEncoding';
    info.fallback = base === 'MacRomanEncoding' ? (c) => String.fromCharCode(c) : (c) => WIN_ANSI[c] ?? String.fromCharCode(c);
    const diffs = enc ? doc.resolve(enc.map.get('Differences')) : undefined;
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const d of diffs) {
        const v = doc.resolve(d);
        if (typeof v === 'number') code = v;
        else if (isName(v)) { const t = glyphText(v.name); if (t) info.map.set(code, t); code++; }
      }
    }
  }
  const toUnicode = doc.resolve(font.map.get('ToUnicode'));
  if (isStream(toUnicode)) {
    const cmap = String.fromCharCode(...doc.decode(toUnicode));
    const bytes = parseCMap(cmap, info.map);
    if (isName(subtype, 'Type0')) info.twoByte = bytes !== 1;
  }
  cache.set(font, info);
  return info;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

function contentOf(doc: PdfDocument, contents: PdfValue | undefined): Uint8Array {
  const v = doc.resolve(contents);
  const parts = Array.isArray(v) ? v.map((x) => doc.resolve(x)) : [v];
  const chunks = parts.filter(isStream).map((s) => doc.decode(s));
  const total = chunks.reduce((n, c) => n + c.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; out[at++] = 10; }
  return out;
}

function interpret(doc: PdfDocument, data: Uint8Array, resources: PdfDict | undefined, start: Matrix, page: PdfPage, fonts: Map<PdfDict, FontInfo>, depth: number): void {
  const lex = new Lexer(data);
  const operands: PdfValue[] = [];
  let ctm: Matrix = start;
  const stack: { ctm: Matrix; font?: FontInfo; size: number; tc: number; tw: number; th: number; tl: number; rise: number }[] = [];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let font: FontInfo | undefined;
  let size = 12;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let rise = 0;
  const fontDict = (name: string) => doc.dict(doc.dict(resources?.map.get('Font'))?.map.get(name));
  const show = (s: PdfString) => {
    const f = font ?? fontInfo(doc, undefined, fonts);
    const bytes = s.bytes;
    const trm = multiply(tm, ctm);
    const scale = Math.sqrt(Math.abs(trm[0] * trm[3] - trm[1] * trm[2])) || 1;
    const x0 = trm[4];
    const y0 = trm[5];
    let text = '';
    let advance = 0;
    for (let i = 0; i < bytes.length;) {
      const code = f.twoByte && i + 1 < bytes.length ? (bytes[i]! << 8) | bytes[i + 1]! : bytes[i]!;
      i += f.twoByte && i + 1 < bytes.length ? 2 : 1;
      text += f.map.get(code) ?? f.fallback(code);
      const w = (f.widths.get(code) ?? f.defaultWidth) / 1000;
      advance += (w * size + tc + (!f.twoByte && code === 32 ? tw : 0)) * th;
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
    const rotated = Math.abs(trm[1]) > 0.01 * scale || Math.abs(trm[2]) > 0.01 * scale || trm[0] < 0;
    if (!rotated && text) page.runs.push({ x: x0, y: y0 + rise * scale, end: x0 + advance * trm[0], size: size * scale, text });
  };
  for (;;) {
    const v = lex.value(true);
    if (v === undefined) break;
    if (!(v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'op')) { operands.push(v); continue; }
    const op = v.op;
    const num = (k: number) => Number(operands[operands.length - k]) || 0;
    switch (op) {
      case 'q': stack.push({ ctm, font, size, tc, tw, th, tl, rise }); break;
      case 'Q': { const s = stack.pop(); if (s) ({ ctm, font, size, tc, tw, th, tl, rise } = s); break; }
      case 'cm': ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': { const n = operands[operands.length - 2]; size = num(1); font = isName(n) ? fontInfo(doc, fontDict(n.name), fonts) : undefined; break; }
      case 'Tc': tc = num(1); break;
      case 'Tw': tw = num(1); break;
      case 'Tz': th = num(1) / 100; break;
      case 'TL': tl = num(1); break;
      case 'Ts': rise = num(1); break;
      case 'Td': tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
      case 'TD': tl = -num(1); tlm = multiply([1, 0, 0, 1, num(2), num(1)], tlm); tm = tlm; break;
      case 'Tm': tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tm = tlm; break;
      case 'T*': tlm = multiply([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
      case 'Tj': { const s = operands[operands.length - 1]; if (isString(s)) show(s); break; }
      case "'": { tlm = multiply([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; const s = operands[operands.length - 1]; if (isString(s)) show(s); break; }
      case '"': { tw = num(3); tc = num(2); tlm = multiply([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; const s = operands[operands.length - 1]; if (isString(s)) show(s); break; }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (isString(item)) show(item);
            else if (typeof item === 'number') {
              const shift = (-item / 1000) * size * th;
              if (item < -250 && page.runs.length) {
                const last = page.runs[page.runs.length - 1]!;
                if (!last.text.endsWith(' ')) last.text += ' ';
              }
              tm = multiply([1, 0, 0, 1, shift, 0], tm);
            }
          }
        }
        break;
      }
      case 'Do': {
        const n = operands[operands.length - 1];
        const xo = isName(n) ? doc.resolve(doc.dict(resources?.map.get('XObject'))?.map.get(n.name)) : undefined;
        if (isStream(xo)) {
          const sub = doc.resolve(xo.dict.map.get('Subtype'));
          if (isName(sub, 'Image')) page.images.push({ x: ctm[4], y: ctm[5], width: Math.abs(ctm[0]) + Math.abs(ctm[2]), height: Math.abs(ctm[1]) + Math.abs(ctm[3]) });
          else if (isName(sub, 'Form') && depth < 8) {
            const fm = doc.resolve(xo.dict.map.get('Matrix'));
            const m: Matrix = Array.isArray(fm) && fm.length === 6 ? (fm.map((x) => Number(doc.resolve(x)) || 0) as Matrix) : [1, 0, 0, 1, 0, 0];
            interpret(doc, doc.decode(xo), doc.dict(xo.dict.map.get('Resources')) ?? resources, multiply(m, ctm), page, fonts, depth + 1);
          }
        }
        break;
      }
      default: break;
    }
    operands.length = 0;
  }
}

export function readPdf(data: Uint8Array): PdfPage[] {
  if (String.fromCharCode(...data.subarray(0, 1024)).indexOf('%PDF') < 0) throw new Error('not a PDF file');
  const doc = new PdfDocument(data);
  if (doc.encrypted) throw new Error('the PDF is protected (encrypted); save it again without protection and retry');
  const fonts = new Map<PdfDict, FontInfo>();
  const pages = doc.pages();
  if (!pages.length) throw new Error('no pages found in the PDF');
  return pages.map((p, k) => {
    const page: PdfPage = { number: k + 1, width: (p.box[2] ?? 612) - (p.box[0] ?? 0), height: (p.box[3] ?? 792) - (p.box[1] ?? 0), runs: [], images: [] };
    const rotate = Number(doc.resolve(p.dict.map.get('Rotate'))) || 0;
    const start: Matrix = rotate % 360 === 90 ? [0, -1, 1, 0, 0, page.width] : rotate % 360 === 270 ? [0, 1, -1, 0, page.height, 0] : [1, 0, 0, 1, -(p.box[0] ?? 0), -(p.box[1] ?? 0)];
    if (rotate % 180 === 90) [page.width, page.height] = [page.height, page.width];
    interpret(doc, contentOf(doc, p.dict.map.get('Contents')), p.resources, start, page, fonts, 0);
    return page;
  });
}

export interface TextLine {
  page: number;
  y: number;
  cells: { x: number; end: number; text: string }[];
  text: string;
}

export function pageLines(page: PdfPage): TextLine[] {
  const runs = page.runs.filter((r) => r.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextRun[][] = [];
  for (const run of runs) {
    const row = rows.find((r) => Math.abs(r[0]!.y - run.y) <= Math.max(1.5, Math.min(r[0]!.size, run.size) * 0.4));
    if (row) row.push(run);
    else rows.push([run]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    const cells: { x: number; end: number; text: string }[] = [];
    for (const run of row) {
      const last = cells[cells.length - 1];
      const gap = last ? run.x - last.end : Infinity;
      if (last && gap < Math.max(2, run.size * 0.9)) {
        last.text += (gap > run.size * 0.15 && !last.text.endsWith(' ') && !run.text.startsWith(' ') ? ' ' : '') + run.text;
        last.end = Math.max(last.end, run.end);
      } else cells.push({ x: run.x, end: run.end, text: run.text });
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
    const kept = cells.filter((c) => c.text);
    return { page: page.number, y: row[0]!.y, cells: kept, text: kept.map((c) => c.text).join('  ') };
  }).filter((l) => l.cells.length);
}
