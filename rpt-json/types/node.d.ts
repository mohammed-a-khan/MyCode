/**
 * Type declarations for the Node.js built-ins this project uses.
 *
 * The project installs no packages, so instead of a type-definition package these declarations describe
 * just the parts of Node's built-in modules the code and tests call. They are only for the editor and the
 * type checker; at run time Node provides the real implementations.
 */

interface ImportMeta {
  /** Directory of the current module (Node 20.11+). */
  dirname: string;
  filename: string;
}

type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'latin1' | 'binary' | 'ascii' | 'utf16le';

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: BufferEncoding): Buffer;
  static from(data: ArrayLike<number> | Iterable<number>): Buffer;
  static from(data: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
  equals(other: Uint8Array): boolean;
  readUInt32BE(offset?: number): number;
}

// Globals Node shares with browsers (the project's "lib" setting has no DOM).
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  decode(input?: Uint8Array | ArrayBufferLike): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const console: {
  log(...data: unknown[]): void;
  error(...data: unknown[]): void;
  warn(...data: unknown[]): void;
};

declare function structuredClone<T>(value: T): T;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  stdout: { write(text: string | Uint8Array): boolean };
  getBuiltinModule(id: string): unknown;
};

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
  export function lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
}

declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:zlib' {
  export interface ZlibOptions {
    level?: number;
    info?: boolean;
    maxOutputLength?: number;
  }
  export function inflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex' | 'base64'): string;
  }
  export interface Cipher {
    setAutoPadding(autoPadding?: boolean): Cipher;
    update(data: Uint8Array): Buffer;
    final(): Buffer;
  }
  export function createHash(algorithm: string): Hash;
  export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array | null): Cipher;
  export function randomBytes(size: number): Buffer;
}

declare module 'node:test' {
  export interface TestOptions {
    skip?: boolean | string;
    only?: boolean;
    timeout?: number;
  }
  type Body = () => void | Promise<void>;
  export function describe(name: string, body: Body): void;
  export function describe(name: string, options: TestOptions, body: Body): void;
  export function it(name: string, body: Body): void;
  export function it(name: string, options: TestOptions, body: Body): void;
}

declare module 'node:assert/strict' {
  type ErrorMatcher = RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean);
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(block: () => unknown, error?: ErrorMatcher, message?: string): void;
    doesNotThrow(block: () => unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
