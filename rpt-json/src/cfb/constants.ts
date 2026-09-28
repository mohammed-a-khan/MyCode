/**
 * Constants from the [MS-CFB] Compound File Binary File Format specification.
 * Crystal Reports .rpt files are stored in this container format.
 */

export const SIGNATURE = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

export const HEADER_SIZE = 512;
export const HEADER_DIFAT_COUNT = 109;
export const DIR_ENTRY_SIZE = 128;
export const MINI_SECTOR_SIZE = 64;
export const MINI_STREAM_CUTOFF = 4096;
export const BYTE_ORDER_MARK = 0xfffe;
export const DEFAULT_MINOR_VERSION = 0x003e;

// Special sector numbers
export const MAXREGSECT = 0xfffffffa;
export const DIFSECT = 0xfffffffc;
export const FATSECT = 0xfffffffd;
export const ENDOFCHAIN = 0xfffffffe;
export const FREESECT = 0xffffffff;
export const NOSTREAM = 0xffffffff;

// Directory entry object types
export const OBJ_UNALLOCATED = 0;
export const OBJ_STORAGE = 1;
export const OBJ_STREAM = 2;
export const OBJ_ROOT = 5;

// Red-black tree colours used by the directory
export const COLOR_RED = 0;
export const COLOR_BLACK = 1;

export const ROOT_ENTRY_NAME = 'Root Entry';
export const MAX_NAME_LENGTH = 31;
