/** Reads a Compound File Binary (MS-CFB) container into a CfbDocument tree. */

import {
  BYTE_ORDER_MARK,
  DIR_ENTRY_SIZE,
  ENDOFCHAIN,
  FREESECT,
  HEADER_DIFAT_COUNT,
  HEADER_SIZE,
  MAXREGSECT,
  MINI_SECTOR_SIZE,
  NOSTREAM,
  OBJ_ROOT,
  OBJ_STORAGE,
  OBJ_STREAM,
  SIGNATURE,
} from './constants.ts';
import { filetimeToIso, formatGuid } from './encoding.ts';
import { CfbError, type CfbDocument, type CfbNode, type CfbStorage } from './types.ts';

interface RawEntry {
  name: string;
  objectType: number;
  left: number;
  right: number;
  child: number;
  clsid: string;
  stateBits: number;
  created: string | null;
  modified: string | null;
  startSector: number;
  size: number;
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= SIGNATURE.length && SIGNATURE.every((b, i) => bytes[i] === b);
}

export function readCfb(bytes: Uint8Array): CfbDocument {
  if (bytes.length < HEADER_SIZE || !isCompoundFile(bytes)) {
    throw new CfbError('Not a Compound File (bad signature). A Crystal Reports .rpt file starts with D0 CF 11 E0 A1 B1 1A E1.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);

  const minorVersion = u16(0x18);
  const majorVersion = u16(0x1a);
  if (u16(0x1c) !== BYTE_ORDER_MARK) throw new CfbError('Invalid byte order mark in header');
  if (majorVersion !== 3 && majorVersion !== 4) throw new CfbError(`Unsupported major version ${majorVersion}`);
  const sectorShift = u16(0x1e);
  if (sectorShift !== 9 && sectorShift !== 12) throw new CfbError(`Unsupported sector shift ${sectorShift}`);
  const miniSectorShift = u16(0x20);
  if (1 << miniSectorShift !== MINI_SECTOR_SIZE) throw new CfbError(`Unsupported mini sector shift ${miniSectorShift}`);

  const sectorSize = 1 << sectorShift;
  const idsPerSector = sectorSize / 4;
  const numFatSectors = u32(0x2c);
  const firstDirSector = u32(0x30);
  const miniStreamCutoff = u32(0x38);
  const firstMiniFatSector = u32(0x3c);
  const firstDifatSector = u32(0x44);
  const numDifatSectors = u32(0x48);

  // Returns a sector's bytes; a short final sector (truncated file) is zero padded.
  const sector = (id: number): Uint8Array => {
    const start = (id + 1) * sectorSize;
    if (start >= bytes.length) throw new CfbError(`Sector ${id} lies beyond end of file`);
    const end = start + sectorSize;
    if (end <= bytes.length) return bytes.subarray(start, end);
    const padded = new Uint8Array(sectorSize);
    padded.set(bytes.subarray(start));
    return padded;
  };
  const sectorIds = (s: Uint8Array): number[] => {
    const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
    return Array.from({ length: s.length / 4 }, (_, i) => v.getUint32(i * 4, true));
  };

  // 1. Locate the FAT sectors via the DIFAT (109 in the header, the rest in a chain).
  const fatSectorIds: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_COUNT; i++) {
    const id = u32(0x4c + i * 4);
    if (id <= MAXREGSECT) fatSectorIds.push(id);
  }
  const seenDifat = new Set<number>();
  for (let id = firstDifatSector, n = 0; id <= MAXREGSECT && n < numDifatSectors; n++) {
    if (seenDifat.has(id)) throw new CfbError('Loop detected in DIFAT chain');
    seenDifat.add(id);
    const ids = sectorIds(sector(id));
    for (const fatId of ids.slice(0, idsPerSector - 1)) if (fatId <= MAXREGSECT) fatSectorIds.push(fatId);
    id = ids[idsPerSector - 1];
  }
  if (numFatSectors > 0 && fatSectorIds.length > numFatSectors) fatSectorIds.length = numFatSectors;
  const fat = fatSectorIds.flatMap((id) => sectorIds(sector(id)));

  const chain = (start: number, table: number[], what: string): number[] => {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (let id = start; id !== ENDOFCHAIN && id !== FREESECT; id = table[id]) {
      if (id > MAXREGSECT || id >= table.length) throw new CfbError(`Broken sector chain in ${what} (sector ${id})`);
      if (seen.has(id)) throw new CfbError(`Loop detected in sector chain of ${what}`);
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  const readChain = (start: number, what: string): Uint8Array => {
    const ids = chain(start, fat, what);
    const out = new Uint8Array(ids.length * sectorSize);
    ids.forEach((id, i) => out.set(sector(id), i * sectorSize));
    return out;
  };

  // 2. Directory entries.
  const dirBytes = readChain(firstDirSector, 'directory');
  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries: RawEntry[] = [];
  for (let off = 0; off + DIR_ENTRY_SIZE <= dirBytes.length; off += DIR_ENTRY_SIZE) {
    const nameBytes = Math.min(dirView.getUint16(off + 64, true), 64);
    const nameChars = Math.max(0, nameBytes / 2 - 1);
    let name = '';
    for (let i = 0; i < nameChars; i++) name += String.fromCharCode(dirView.getUint16(off + i * 2, true));
    const sizeLow = dirView.getUint32(off + 120, true);
    const sizeHigh = dirView.getUint32(off + 124, true);
    // Version 3 files must ignore the high 32 bits (older writers left garbage there).
    const size = majorVersion === 3 ? sizeLow : sizeHigh * 2 ** 32 + sizeLow;
    if (!Number.isSafeInteger(size)) throw new CfbError(`Stream "${name}" is too large`);
    entries.push({
      name,
      objectType: dirView.getUint8(off + 66),
      left: dirView.getUint32(off + 68, true),
      right: dirView.getUint32(off + 72, true),
      child: dirView.getUint32(off + 76, true),
      clsid: formatGuid(dirBytes, off + 80),
      stateBits: dirView.getUint32(off + 96, true),
      created: filetimeToIso(dirView.getBigUint64(off + 100, true)),
      modified: filetimeToIso(dirView.getBigUint64(off + 108, true)),
      startSector: dirView.getUint32(off + 116, true),
      size,
    });
  }
  const rootEntry = entries[0];
  if (!rootEntry || rootEntry.objectType !== OBJ_ROOT) throw new CfbError('Missing root directory entry');

  // 3. Mini stream (lives in the root entry's chain) and its allocation table.
  const miniFat = firstMiniFatSector <= MAXREGSECT ? sectorIds(readChain(firstMiniFatSector, 'mini FAT')) : [];
  const miniStream = readChain(rootEntry.startSector, 'mini stream').subarray(0, rootEntry.size);

  const streamData = (entry: RawEntry): Uint8Array => {
    if (entry.size === 0) return new Uint8Array(0);
    let data: Uint8Array;
    if (entry.size < miniStreamCutoff) {
      const ids = chain(entry.startSector, miniFat, `stream "${entry.name}"`);
      data = new Uint8Array(ids.length * MINI_SECTOR_SIZE);
      ids.forEach((id, i) => {
        const start = id * MINI_SECTOR_SIZE;
        if (start >= miniStream.length) {
          throw new CfbError(`Mini sector ${id} of stream "${entry.name}" lies beyond the mini stream`);
        }
        data.set(miniStream.subarray(start, start + MINI_SECTOR_SIZE), i * MINI_SECTOR_SIZE);
      });
    } else {
      data = readChain(entry.startSector, `stream "${entry.name}"`);
    }
    if (data.length < entry.size) throw new CfbError(`Stream "${entry.name}" is truncated (${data.length} of ${entry.size} bytes)`);
    return data.slice(0, entry.size);
  };

  // 4. Rebuild the storage tree. Siblings form a binary tree; an in-order walk yields sorted order.
  const visited = new Set<number>([0]);
  const childrenOf = (entry: RawEntry): CfbNode[] => {
    const result: CfbNode[] = [];
    const walk = (id: number): void => {
      if (id === NOSTREAM) return;
      if (id >= entries.length) throw new CfbError(`Directory entry ${id} out of range`);
      if (visited.has(id)) throw new CfbError('Loop detected in directory tree');
      visited.add(id);
      const e = entries[id];
      walk(e.left);
      const common = { name: e.name, clsid: e.clsid, stateBits: e.stateBits, created: e.created, modified: e.modified };
      if (e.objectType === OBJ_STORAGE) result.push({ type: 'storage', ...common, children: childrenOf(e) });
      else if (e.objectType === OBJ_STREAM) result.push({ type: 'stream', ...common, data: streamData(e) });
      walk(e.right);
    };
    walk(entry.child);
    return result;
  };

  const root: CfbStorage = {
    type: 'storage',
    name: rootEntry.name,
    clsid: rootEntry.clsid,
    stateBits: rootEntry.stateBits,
    created: rootEntry.created,
    modified: rootEntry.modified,
    children: childrenOf(rootEntry),
  };
  return { majorVersion, minorVersion, root };
}
