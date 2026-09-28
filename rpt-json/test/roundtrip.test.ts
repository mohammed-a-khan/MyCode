import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareNames, filetimeToIso, formatGuid, isoToFiletime, parseGuid } from '../src/cfb/encoding.ts';
import { readStreamHeader } from '../src/crystal/catalog.ts';
import {
  CfbError,
  jsonToRpt,
  readCfb,
  rptToJson,
  writeCfb,
  type CfbDocument,
  type CfbNode,
  type CfbStorage,
  type RptJson,
} from '../src/index.ts';

const ZERO = '00000000-0000-0000-0000-000000000000';

function stream(name: string, data: Uint8Array | string): CfbNode {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return { type: 'stream', name, clsid: ZERO, stateBits: 0, created: null, modified: null, data: bytes };
}

function storage(name: string, children: CfbNode[], extra: Partial<CfbStorage> = {}): CfbStorage {
  return { type: 'storage', name, clsid: ZERO, stateBits: 0, created: null, modified: null, children, ...extra };
}

function doc(children: CfbNode[], majorVersion: 3 | 4 = 3): CfbDocument {
  return { majorVersion, minorVersion: 0x3e, root: storage('Root Entry', children) };
}

function pattern(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** Normalises a tree to comparable plain data (children sorted the way the directory stores them). */
function canonical(node: CfbNode): unknown {
  if (node.type === 'stream') return { ...node, data: Buffer.from(node.data).toString('hex') };
  return { ...node, children: [...node.children].sort((a, b) => compareNames(a.name, b.name)).map(canonical) };
}

function assertRoundTrip(original: CfbDocument, options?: { majorVersion?: 3 | 4 }): Uint8Array {
  const bytes = writeCfb(original, options);
  const reread = readCfb(bytes);
  assert.equal(reread.majorVersion, options?.majorVersion ?? original.majorVersion);
  assert.deepEqual(canonical(reread.root), canonical(original.root));
  return bytes;
}

/** Minimal independent directory reader used to check the red-black tree invariants. */
function rawDirectory(bytes: Uint8Array): { left: number; right: number; child: number; color: number; type: number; name: string }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const fatSectors: number[] = [];
  for (let i = 0; i < Math.min(109, view.getUint32(0x2c, true)); i++) fatSectors.push(view.getUint32(0x4c + i * 4, true));
  const fat: number[] = [];
  for (const s of fatSectors) for (let i = 0; i < sectorSize / 4; i++) fat.push(view.getUint32((s + 1) * sectorSize + i * 4, true));
  const entries = [];
  for (let s = view.getUint32(0x30, true); s !== 0xfffffffe; s = fat[s]) {
    for (let off = (s + 1) * sectorSize; off < (s + 2) * sectorSize; off += 128) {
      const nameLen = view.getUint16(off + 64, true);
      entries.push({
        name: new TextDecoder('utf-16le').decode(bytes.subarray(off, off + Math.max(0, nameLen - 2))),
        type: view.getUint8(off + 66),
        color: view.getUint8(off + 67),
        left: view.getUint32(off + 68, true),
        right: view.getUint32(off + 72, true),
        child: view.getUint32(off + 76, true),
      });
    }
  }
  return entries;
}

function assertValidRedBlackTrees(bytes: Uint8Array): void {
  const entries = rawDirectory(bytes);
  const NONE = 0xffffffff;
  // Returns the black height of a subtree, asserting ordering and colour rules on the way.
  const check = (id: number, parentRed: boolean, lo: string | null, hi: string | null): number => {
    if (id === NONE) return 1;
    const e = entries[id];
    const red = e.color === 0;
    assert.ok(!(red && parentRed), `red node "${e.name}" has a red parent`);
    if (lo !== null) assert.ok(compareNames(lo, e.name) < 0, `"${e.name}" out of order`);
    if (hi !== null) assert.ok(compareNames(e.name, hi) < 0, `"${e.name}" out of order`);
    const l = check(e.left, red, lo, e.name);
    const r = check(e.right, red, e.name, hi);
    assert.equal(l, r, `unequal black heights under "${e.name}"`);
    if (e.child !== NONE) checkTree(e.child);
    return l + (red ? 0 : 1);
  };
  const checkTree = (rootId: number) => {
    assert.equal(entries[rootId].color, 1, 'tree root must be black');
    check(rootId, false, null, null);
  };
  if (entries[0].child !== NONE) checkTree(entries[0].child);
}

describe('encoding helpers', () => {
  it('round-trips FILETIME values with 100ns precision', () => {
    for (const ticks of [1n, 116444736000000000n, 130000000000000001n, 0x01d8_0000_1234_5678n, 0xffff_ffff_ffff_ffffn]) {
      assert.equal(isoToFiletime(filetimeToIso(ticks)), ticks);
    }
    assert.equal(filetimeToIso(0n), null);
    assert.equal(isoToFiletime(null), 0n);
    assert.equal(filetimeToIso(116444736000000000n), '1970-01-01T00:00:00.0000000Z');
    assert.equal(isoToFiletime('1970-01-01T00:00:01Z'), 116444736010000000n);
    assert.throws(() => isoToFiletime('yesterday'), CfbError);
  });

  it('formats GUIDs with Windows byte order', () => {
    const bytes = new Uint8Array(16);
    parseGuid('{F29F85E0-4FF9-1068-AB91-08002B27B3D9}', bytes, 0);
    assert.equal(Buffer.from(bytes).toString('hex'), 'e0859ff2f94f6810ab9108002b27b3d9');
    assert.equal(formatGuid(bytes), 'F29F85E0-4FF9-1068-AB91-08002B27B3D9');
  });

  it('orders names shortest first, then case-insensitively', () => {
    const names = ['Contents', 'b', 'QESession', 'A', 'ReportInfo', 'zz'];
    assert.deepEqual([...names].sort(compareNames), ['A', 'b', 'zz', 'Contents', 'QESession', 'ReportInfo']);
    assert.equal(compareNames('abc', 'ABC'), 0);
  });
});

describe('compound file writer/reader', () => {
  it('handles empty, mini and regular streams around the 4096-byte cutoff', () => {
    const sizes = [0, 1, 63, 64, 65, 4095, 4096, 4097, 70000];
    assertRoundTrip(doc(sizes.map((size, i) => stream(`s${size}`, pattern(size, i + 1)))));
  });

  it('writes version 4 (4096-byte sector) files and converts between versions', () => {
    const d = doc([stream('Contents', pattern(10000)), stream('small', 'hello')], 4);
    const v4 = assertRoundTrip(d);
    assert.equal(v4.length % 4096, 0);
    assertRoundTrip(d, { majorVersion: 3 });
    assertRoundTrip(doc(d.root.children, 3), { majorVersion: 4 });
  });

  it('preserves nested storages, CLSIDs, state bits and timestamps', () => {
    const d = doc([
      stream('Contents', pattern(5000)),
      storage('Subdocument 1', [stream('Contents', pattern(300)), storage('Embedding 1', [stream('\u0001CompObj', pattern(106))])], {
        clsid: '00020906-0000-0000-C000-000000000046',
        stateBits: 7,
        created: '2012-09-23T19:21:30.9880001Z',
        modified: '2024-02-29T23:59:59.9999999Z',
      }),
    ]);
    assertRoundTrip(d);
  });

  it('builds valid red-black directory trees for any number of siblings', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 100, 257]) {
      const children = Array.from({ length: count }, (_, i) => stream(`Stream ${i}`, pattern(i % 7)));
      const bytes = assertRoundTrip(doc([storage('Sub', children), ...children.slice(0, 3)]));
      assertValidRedBlackTrees(bytes);
    }
  });

  it('uses DIFAT sectors when more than 109 FAT sectors are needed', () => {
    // 109 FAT sectors cover 109 * 128 * 512 bytes (~7 MB) in a version 3 file.
    const big = pattern(8 * 1024 * 1024, 7);
    const bytes = assertRoundTrip(doc([stream('Big', big), stream('Small', 'x')]));
    assert.ok(new DataView(bytes.buffer).getUint32(0x48, true) > 0, 'expected DIFAT sectors');
  });

  it('rejects invalid input', () => {
    assert.throws(() => readCfb(new Uint8Array(1024)), /Not a Compound File/);
    assert.throws(() => writeCfb(doc([stream('a', 'x'), stream('A', 'y')])), /Duplicate entry name/);
    assert.throws(() => writeCfb(doc([stream('x'.repeat(32), 'x')])), /exceeds 31/);
    assert.throws(() => writeCfb(doc([stream('a/b', 'x')])), /illegal character/);
  });

  it('detects a truncated file', () => {
    const bytes = writeCfb(doc([stream('Contents', pattern(20000))]));
    assert.throws(() => readCfb(bytes.subarray(0, bytes.length - 8192)), CfbError);
  });
});

describe('JSON conversion', () => {
  const sample = doc([
    stream('Contents', pattern(6000)),
    stream('ReportInfo', pattern(58)),
    storage('Subdocument 1', [stream('Contents', pattern(100))]),
  ]);
  const rpt = writeCfb(sample);

  it('round-trips rpt -> json -> rpt with identical content', () => {
    const json = rptToJson(rpt, { fileName: 'sample.rpt' });
    assert.equal(json.format, 'crystal-rpt-json');
    assert.equal(json.source?.fileName, 'sample.rpt');
    const rebuilt = jsonToRpt(JSON.stringify(json));
    assert.deepEqual(rptToJson(rebuilt, { metadata: false }).root, rptToJson(rpt, { metadata: false }).root);
  });

  it('supports hex output and hand-written text streams', () => {
    const json = rptToJson(rpt, { encoding: 'hex', metadata: false });
    const edited = structuredClone(json);
    edited.root.children.push({ type: 'stream', name: 'Notes', encoding: 'utf8', data: 'héllo' });
    const reread = readCfb(jsonToRpt(edited));
    const notes = reread.root.children.find((c) => c.name === 'Notes');
    assert.equal(notes?.type === 'stream' && new TextDecoder().decode(notes.data), 'héllo');
  });

  it('verifies size and sha256 unless disabled', () => {
    const json = rptToJson(rpt, { metadata: false });
    const tampered = structuredClone(json) as RptJson;
    const target = tampered.root.children.find((c) => c.name === 'ReportInfo');
    assert.ok(target?.type === 'stream');
    target.data = Buffer.from('changed').toString('base64');
    assert.throws(() => jsonToRpt(tampered), /size/);
    assert.doesNotThrow(() => jsonToRpt(tampered, { verify: false }));
  });

  it('reports schema errors with a JSON path', () => {
    const json = rptToJson(rpt, { metadata: false }) as unknown as Record<string, any>;
    assert.throws(() => jsonToRpt({ ...json, format: 'other' } as unknown as RptJson), /\$\.format/);
    const bad = structuredClone(json);
    bad.root.children[0].type = 'folder';
    assert.throws(() => jsonToRpt(bad as RptJson), /\$\.root\.children\[0\]\.type/);
    const badData = structuredClone(json);
    badData.root.children[0].data = '***';
    assert.throws(() => jsonToRpt(badData as RptJson, { verify: false }), /not valid base64/);
  });
});

describe('Crystal stream header', () => {
  it('decodes masked and unmasked 0xFFFF header records', () => {
    const iv = '00112233445566778899aabbccddeeff';
    const body = Buffer.from(`0001010000 01${iv}0000`.replace(/ /g, ''), 'hex');
    const unmasked = Buffer.concat([Buffer.from('d400ffff00000018', 'hex'), body]);
    const masked = Buffer.concat([Buffer.from('fc00ffff070000000018', 'hex'), body.map((b) => b ^ 0xff)]);
    for (const data of [unmasked, masked]) {
      assert.deepEqual(readStreamHeader(data), { encrypted: true, version: 256, initializationVector: iv });
    }
    assert.equal(readStreamHeader(Buffer.from('QENG')), undefined);
  });
});

// Optional: run against real reports with RPT_SAMPLES_DIR=/path/to/rpt/files npm test
const samplesDir = process.env.RPT_SAMPLES_DIR;
describe('real .rpt samples', { skip: !samplesDir && 'set RPT_SAMPLES_DIR to enable' }, () => {
  const files = samplesDir ? readdirSync(samplesDir).filter((f) => f.toLowerCase().endsWith('.rpt')) : [];
  for (const file of files) {
    it(file, () => {
      const original = readFileSync(join(samplesDir!, file));
      const json = rptToJson(original);
      const rebuilt = jsonToRpt(JSON.parse(JSON.stringify(json)) as RptJson);
      assert.deepEqual(rptToJson(rebuilt, { metadata: false }).root, rptToJson(original, { metadata: false }).root);
      assertValidRedBlackTrees(rebuilt);
      assert.ok(!json.metadata?.reports?.some((r) => r.errors), 'every report decodes');
      // Re-encrypt every encrypted stream from its decoded form; the decoded content must survive.
      const strip = (j: RptJson) => JSON.stringify(j.root, (_k, v) => (v && typeof v === 'object' && 'decoded' in v ? { ...v, size: 0, sha256: '', data: '' } : v));
      const decodedOnly = rptToJson(original, { metadata: false, keepOriginal: false });
      assert.equal(strip(rptToJson(jsonToRpt(decodedOnly), { metadata: false, keepOriginal: false })), strip(decodedOnly));
    });
  }
});
