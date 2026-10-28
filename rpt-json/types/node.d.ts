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

type BufferEncoding2 = BufferEncoding | 'base64url';

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: BufferEncoding): Buffer;
  static from(data: ArrayLike<number> | Iterable<number>): Buffer;
  static from(data: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  toString(encoding?: BufferEncoding2, start?: number, end?: number): string;
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
  pid: number;
  platform: string;
  version: string;
  execPath: string;
  cwd(): string;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

declare class URL {
  constructor(input: string, base?: string);
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null };
}

interface TimerHandle {
  unref?(): unknown;
}
declare function setTimeout(callback: () => void, ms?: number): TimerHandle;
declare function setInterval(callback: () => void, ms?: number): TimerHandle;

interface EventSource {
  on(event: string, listener: (...args: never[]) => void): this;
  once(event: string, listener: (...args: never[]) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
}

interface WritableLike extends EventSource {
  write(chunk: string | Uint8Array): boolean;
}

declare module 'node:http' {
  export interface IncomingMessage extends EventSource, AsyncIterable<Uint8Array> {
    url?: string;
    method?: string;
    headers: Record<string, string | undefined>;
    pipe<T extends WritableLike>(target: T): T;
  }
  export interface ServerResponse {
    headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string>): this;
    end(body?: string | Uint8Array): void;
  }
  export interface Server extends EventSource {
    listen(port: number, host: string): this;
    address(): { port: number } | string | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:child_process' {
  export interface ChildProcess extends EventSource {
    stdout: EventSource;
    stderr: EventSource;
    unref(): void;
  }
  export function spawn(command: string, args: string[], options?: { windowsHide?: boolean; detached?: boolean; stdio?: string }): ChildProcess;
  export function spawnSync(command: string, args: string[], options?: { encoding?: 'utf8' }): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:module' {
  export function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform' }): string;
}

declare module 'node:fs' {
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readdirSync(path: string): string[];
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void;
  export function appendFileSync(path: string, data: string): void;
  export function copyFileSync(from: string, to: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number };
  export function createWriteStream(path: string): WritableLike;
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function readdir(path: string): Promise<string[]>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
  export function lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number }>;
  export function unlink(path: string): Promise<void>;
  export function cp(from: string, to: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function copyFile(from: string, to: string): Promise<void>;
}

declare module 'node:path' {
  export function basename(path: string, suffix?: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export const sep: string;
  export const posix: { normalize(path: string): string; join(...paths: string[]): string; dirname(path: string): string };
}

declare module 'node:zlib' {
  export interface ZlibOptions {
    level?: number;
    info?: boolean;
    maxOutputLength?: number;
  }
  export function inflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function inflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
  export function deflateRawSync(data: string | Uint8Array, options?: ZlibOptions): Buffer;
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
