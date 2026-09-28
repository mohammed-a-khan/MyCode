/** Serialises a CfbDocument tree into a Compound File Binary (MS-CFB) container. */

import {
  BYTE_ORDER_MARK,
  COLOR_BLACK,
  COLOR_RED,
  DIFSECT,
  DIR_ENTRY_SIZE,
  ENDOFCHAIN,
  FATSECT,
  FREESECT,
  HEADER_DIFAT_COUNT,
  HEADER_SIZE,
  MAX_NAME_LENGTH,
  MINI_SECTOR_SIZE,
  MINI_STREAM_CUTOFF,
  NOSTREAM,
  OBJ_ROOT,
  OBJ_STORAGE,
  OBJ_STREAM,
  SIGNATURE,
} from './constants.ts';
import { compareNames, isoToFiletime, parseGuid, ZERO_GUID } from './encoding.ts';
import { CfbError, type CfbDocument, type CfbNode, type CfbStorage, type CfbStream } from './types.ts';

interface DirEntry {
  node: CfbNode;
  objectType: number;
  left: number;
  right: number;
  child: number;
  color: number;
  startSector: number;
  size: number;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

function validateName(name: string, path: string): void {
  if (name.length === 0) throw new CfbError(`Empty entry name at ${path}`);
  if (name.length > MAX_NAME_LENGTH) throw new CfbError(`Entry name "${name}" exceeds ${MAX_NAME_LENGTH} characters`);
  if (/[/\\:!]/.test(name)) throw new CfbError(`Entry name "${name}" contains an illegal character (/ \\ : !)`);
}

/**
 * Flattens the tree into directory entries. Each storage's children become a balanced
 * binary search tree coloured to satisfy the red-black invariants required by MS-CFB.
 */
function buildDirectory(root: CfbStorage): DirEntry[] {
  const entries: DirEntry[] = [];
  const add = (node: CfbNode, objectType: number): number => {
    entries.push({ node, objectType, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, color: COLOR_BLACK, startSector: ENDOFCHAIN, size: 0 });
    return entries.length - 1;
  };

  const addChildren = (storageId: number, storage: CfbStorage, path: string): void => {
    const sorted = [...storage.children].sort((a, b) => compareNames(a.name, b.name));
    for (let i = 0; i < sorted.length; i++) {
      validateName(sorted[i].name, path);
      if (i > 0 && compareNames(sorted[i - 1].name, sorted[i].name) === 0) {
        throw new CfbError(`Duplicate entry name "${sorted[i].name}" in ${path} (names are case-insensitive)`);
      }
    }
    const ids = sorted.map((child) => add(child, child.type === 'storage' ? OBJ_STORAGE : OBJ_STREAM));

    const depths = new Map<number, number>();
    const build = (lo: number, hi: number, depth: number): number => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >>> 1;
      const id = ids[mid];
      depths.set(id, depth);
      entries[id].left = build(lo, mid - 1, depth + 1);
      entries[id].right = build(mid + 1, hi, depth + 1);
      return id;
    };
    entries[storageId].child = build(0, ids.length - 1, 0);
    // A midpoint-split tree has all empty slots on its last two levels, so colouring
    // the deepest level red (and everything else black) gives equal black heights.
    const maxDepth = Math.max(0, ...depths.values());
    for (const [id, depth] of depths) entries[id].color = maxDepth > 0 && depth === maxDepth ? COLOR_RED : COLOR_BLACK;

    sorted.forEach((child, i) => {
      if (child.type === 'storage') addChildren(ids[i], child, `${path}/${child.name}`);
    });
  };

  add(root, OBJ_ROOT);
  addChildren(0, root, '');
  return entries;
}

export interface CfbWriteOptions {
  /** Container version to write. Defaults to the document's version. 3 = 512-byte sectors, 4 = 4096-byte sectors. */
  majorVersion?: 3 | 4;
}

export function writeCfb(doc: CfbDocument, options: CfbWriteOptions = {}): Uint8Array {
  const majorVersion = options.majorVersion ?? doc.majorVersion;
  if (majorVersion !== 3 && majorVersion !== 4) throw new CfbError(`Unsupported major version ${majorVersion}`);
  const sectorShift = majorVersion === 4 ? 12 : 9;
  const sectorSize = 1 << sectorShift;
  const idsPerSector = sectorSize / 4;

  const entries = buildDirectory(doc.root);
  const streams = entries.filter((e) => e.objectType === OBJ_STREAM);
  for (const e of streams) {
    e.size = (e.node as CfbStream).data.length;
    if (majorVersion === 3 && e.size > 0xffffffff) throw new CfbError(`Stream "${e.node.name}" is too large for a version 3 file`);
  }
  const miniStreams = streams.filter((e) => e.size > 0 && e.size < MINI_STREAM_CUTOFF);
  const bigStreams = streams.filter((e) => e.size >= MINI_STREAM_CUTOFF);

  // Mini stream layout (64-byte mini sectors).
  const miniFat: number[] = [];
  for (const e of miniStreams) {
    const count = ceilDiv(e.size, MINI_SECTOR_SIZE);
    e.startSector = miniFat.length;
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? ENDOFCHAIN : miniFat.length + 1);
  }
  const miniStreamSize = miniFat.length * MINI_SECTOR_SIZE;

  // Sector counts per region. The FAT must also describe its own sectors and the DIFAT's.
  const dirSectors = ceilDiv(entries.length * DIR_ENTRY_SIZE, sectorSize);
  const miniFatSectors = ceilDiv(miniFat.length * 4, sectorSize);
  const miniStreamSectors = ceilDiv(miniStreamSize, sectorSize);
  const bigSectors = bigStreams.reduce((sum, e) => sum + ceilDiv(e.size, sectorSize), 0);
  const contentSectors = dirSectors + miniFatSectors + miniStreamSectors + bigSectors;
  let fatSectors = 0;
  let difatSectors = 0;
  for (;;) {
    const neededFat = ceilDiv(contentSectors + fatSectors + difatSectors, idsPerSector);
    const neededDifat = neededFat > HEADER_DIFAT_COUNT ? ceilDiv(neededFat - HEADER_DIFAT_COUNT, idsPerSector - 1) : 0;
    if (neededFat === fatSectors && neededDifat === difatSectors) break;
    fatSectors = neededFat;
    difatSectors = neededDifat;
  }
  const totalSectors = fatSectors + difatSectors + contentSectors;

  // Allocate sectors in order: FAT, DIFAT, directory, mini FAT, mini stream, big streams.
  const fat = new Array<number>(fatSectors * idsPerSector).fill(FREESECT);
  let next = 0;
  const allocate = (count: number, marker?: number): number => {
    if (count === 0) return ENDOFCHAIN;
    const start = next;
    for (let i = 0; i < count; i++) fat[start + i] = marker ?? (i === count - 1 ? ENDOFCHAIN : start + i + 1);
    next += count;
    return start;
  };
  const fatStart = allocate(fatSectors, FATSECT);
  const difatStart = allocate(difatSectors, DIFSECT);
  const dirStart = allocate(dirSectors);
  const miniFatStart = allocate(miniFatSectors);
  const miniStreamStart = allocate(miniStreamSectors);
  for (const e of bigStreams) e.startSector = allocate(ceilDiv(e.size, sectorSize));
  if (next !== totalSectors) throw new CfbError('Internal error: sector allocation mismatch');

  entries[0].startSector = miniStreamStart;
  entries[0].size = miniStreamSize;

  const headerBytes = majorVersion === 4 ? sectorSize : HEADER_SIZE;
  const out = new Uint8Array(headerBytes + totalSectors * sectorSize);
  const view = new DataView(out.buffer);
  const sectorOffset = (id: number) => headerBytes + id * sectorSize;
  const writeIds = (offset: number, ids: number[]) => ids.forEach((id, i) => view.setUint32(offset + i * 4, id, true));

  // Header
  out.set(SIGNATURE, 0);
  view.setUint16(0x18, doc.minorVersion, true);
  view.setUint16(0x1a, majorVersion, true);
  view.setUint16(0x1c, BYTE_ORDER_MARK, true);
  view.setUint16(0x1e, sectorShift, true);
  view.setUint16(0x20, 6, true);
  view.setUint32(0x28, majorVersion === 4 ? dirSectors : 0, true);
  view.setUint32(0x2c, fatSectors, true);
  view.setUint32(0x30, dirStart, true);
  view.setUint32(0x38, MINI_STREAM_CUTOFF, true);
  view.setUint32(0x3c, miniFatStart, true);
  view.setUint32(0x40, miniFatSectors, true);
  view.setUint32(0x44, difatSectors > 0 ? difatStart : ENDOFCHAIN, true);
  view.setUint32(0x48, difatSectors, true);
  const fatIds = Array.from({ length: fatSectors }, (_, i) => fatStart + i);
  writeIds(0x4c, Array.from({ length: HEADER_DIFAT_COUNT }, (_, i) => fatIds[i] ?? FREESECT));

  // DIFAT sectors: idsPerSector-1 FAT locations followed by the next DIFAT sector.
  for (let d = 0; d < difatSectors; d++) {
    const first = HEADER_DIFAT_COUNT + d * (idsPerSector - 1);
    const ids = Array.from({ length: idsPerSector - 1 }, (_, i) => fatIds[first + i] ?? FREESECT);
    ids.push(d === difatSectors - 1 ? ENDOFCHAIN : difatStart + d + 1);
    writeIds(sectorOffset(difatStart + d), ids);
  }

  writeIds(sectorOffset(fatStart), fat);

  // Directory; unused slots in the last sector stay as empty (unallocated) entries.
  const dirOffset = sectorOffset(dirStart);
  for (let i = 0; i < dirSectors * (sectorSize / DIR_ENTRY_SIZE); i++) {
    const off = dirOffset + i * DIR_ENTRY_SIZE;
    const e = entries[i];
    if (!e) {
      view.setUint32(off + 68, NOSTREAM, true);
      view.setUint32(off + 72, NOSTREAM, true);
      view.setUint32(off + 76, NOSTREAM, true);
      continue;
    }
    const { name } = e.node;
    for (let c = 0; c < name.length; c++) view.setUint16(off + c * 2, name.charCodeAt(c), true);
    view.setUint16(off + 64, (name.length + 1) * 2, true);
    view.setUint8(off + 66, e.objectType);
    view.setUint8(off + 67, e.color);
    view.setUint32(off + 68, e.left, true);
    view.setUint32(off + 72, e.right, true);
    view.setUint32(off + 76, e.child, true);
    parseGuid(e.node.clsid || ZERO_GUID, out, off + 80);
    view.setUint32(off + 96, e.node.stateBits >>> 0, true);
    view.setBigUint64(off + 100, isoToFiletime(e.node.created), true);
    view.setBigUint64(off + 108, isoToFiletime(e.node.modified), true);
    view.setUint32(off + 116, e.size === 0 && e.objectType !== OBJ_ROOT ? ENDOFCHAIN : e.startSector, true);
    view.setUint32(off + 120, e.size % 2 ** 32, true);
    view.setUint32(off + 124, Math.floor(e.size / 2 ** 32), true);
  }

  if (miniFatSectors > 0) {
    writeIds(sectorOffset(miniFatStart), [...miniFat, ...new Array<number>(miniFatSectors * idsPerSector - miniFat.length).fill(FREESECT)]);
  }
  for (const e of miniStreams) {
    out.set((e.node as CfbStream).data, sectorOffset(miniStreamStart) + e.startSector * MINI_SECTOR_SIZE);
  }
  for (const e of bigStreams) out.set((e.node as CfbStream).data, sectorOffset(e.startSector));

  return out;
}
