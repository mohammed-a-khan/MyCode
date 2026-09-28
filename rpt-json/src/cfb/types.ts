/** In-memory model of a Compound File (the container used by .rpt files). */

interface CfbEntryBase {
  name: string;
  /** Class id as an uppercase GUID string (all zeros when unset). */
  clsid: string;
  stateBits: number;
  /** ISO-8601 timestamp with 100ns precision, or null when the FILETIME is zero. */
  created: string | null;
  modified: string | null;
}

export interface CfbStorage extends CfbEntryBase {
  type: 'storage';
  children: CfbNode[];
}

export interface CfbStream extends CfbEntryBase {
  type: 'stream';
  data: Uint8Array;
}

export type CfbNode = CfbStorage | CfbStream;

export interface CfbDocument {
  majorVersion: 3 | 4;
  minorVersion: number;
  /** The root storage ("Root Entry"). */
  root: CfbStorage;
}

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfbError';
  }
}
