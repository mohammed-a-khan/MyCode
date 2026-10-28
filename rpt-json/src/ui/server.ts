import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { main } from '../cli.ts';
import { readConventions } from '../ssrs/conventions.ts';
import { compareReports, differencesCsv, summaryHtml, summaryText, verdict } from '../pdf/compare.ts';
import { houseConventions } from './house.ts';
import { page } from './page.ts';
import { parameterChoices } from './params.ts';
import { zipFiles } from './zip.ts';

interface Job {
  id: string;
  dir: string;
  label: string;
  running: boolean;
  log: string[];
  code?: number;
  files: string[];
  savedTo?: string;
  started?: number;
  finished?: number;
}

interface RunRequest {
  job: string;
  command: string;
  inputs: string[];
  output?: string;
  options?: Record<string, unknown>;
}

const APP = 'Report Converter';
const jobs = new Map<string, Job>();
const work = join(tmpdir(), `report-converter-${process.pid}-${randomBytes(4).toString('hex')}`);
const settingsFile = join(process.env.APPDATA || join(homedir(), '.config'), APP, 'settings.json');
let queue: Promise<unknown> = Promise.resolve();
let lastPing = 0;

const isWindows = process.platform === 'win32';

function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown, status = 200) => send(res, status, JSON.stringify(value));

async function body(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request too large');
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) throw new Error('path outside the work folder');
  return full;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...await listFiles(path, base));
    else out.push(relative(base, path).split(sep).join('/'));
  }
  return out;
}

async function filesOf(input: string, pattern: RegExp): Promise<{ file: string; rel: string }[]> {
  if (!(await stat(input)).isDirectory()) return [{ file: input, rel: basename(input) }];
  return (await listFiles(input)).filter((f) => pattern.test(f)).map((f) => ({ file: join(input, ...f.split('/')), rel: f }));
}

function newJob(): Job {
  const id = randomBytes(6).toString('hex');
  const job: Job = { id, dir: join(work, id), label: 'results', running: false, log: [], files: [] };
  jobs.set(id, job);
  return job;
}

function jobOf(id: unknown): Job {
  const job = typeof id === 'string' ? jobs.get(id) : undefined;
  if (!job) throw new Error('unknown job');
  return job;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function captured(job: Job, args: string[]): Promise<{ code: number; stdout: string }> {
  const log = (...data: unknown[]) => {
    const line = data.map((d) => (typeof d === 'string' ? d : d instanceof Error ? d.message : JSON.stringify(d))).join(' ')
      .split(join(job.dir, 'out')).join(job.label).split(join(job.dir, 'picked') + sep).join('');
    job.log.push(...line.split(/\r?\n/));
  };
  const out: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, write: process.stdout.write };
  console.log = (...d: unknown[]) => out.push(`${d.map(String).join(' ')}\n`);
  console.error = log;
  console.warn = log;
  process.stdout.write = (chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const code = await main(args);
    return { code, stdout: out.join('') };
  } catch (err) {
    log(`Error: ${(err as Error).message}`);
    return { code: 2, stdout: out.join('') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
    process.stdout.write = saved.write;
  }
}

async function staged(job: Job, inputs: string[]): Promise<string> {
  if (inputs.length === 1) return inputs[0]!;
  const dir = join(job.dir, 'picked');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const used = new Set<string>();
  for (const file of inputs) {
    let name = basename(file);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${basename(file, extname(file))}_${n}${extname(file)}`;
    used.add(name.toLowerCase());
    if ((await stat(file)).isDirectory()) await cp(file, join(dir, name), { recursive: true });
    else await copyFile(file, join(dir, name));
  }
  return dir;
}

async function perFile(job: Job, input: string, pattern: RegExp, each: (file: string, rel: string) => Promise<void>): Promise<number> {
  const files = await filesOf(input, pattern);
  if (!files.length) {
    job.log.push(`No matching files in ${input}`);
    return 1;
  }
  let failed = 0;
  for (const { file, rel } of files) {
    try {
      await each(file, rel);
    } catch (err) {
      failed++;
      job.log.push(`FAIL ${rel}: ${(err as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

export function convertArgs(input: string, out: string, o: Record<string, unknown>, conventions?: string): string[] {
  const flag = (name: string, on: unknown) => (on ? [name] : []);
  const value = (name: string, v: unknown) => (text(v) ? [name, text(v)] : []);
  const section = text(o.sectionId);
  if (section && !/^-?\d+$/.test(section)) throw new Error('The section id must be a whole number.');
  const fixed = text(o.parameters).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^section_id=/i.test(l));
  return ['to-rdl', input, out,
    ...(conventions ? ['--conventions', conventions, ...value('--prefix', o.prefix)] : []),
    ...value('--shared-datasource', o.sharedDataSource),
    ...(section ? ['--parameter', `section_id=${section}`] : []),
    ...fixed.flatMap((p) => ['--parameter', p]),
    ...value('--chart-axis-format', o.chartAxisFormat),
    ...flag('--separate-subreports', o.separateSubreports), ...flag('--page-number', o.pageNumber),
    ...flag('--split-subreports', o.splitSubreports), ...(o.splitSubreports ? value('--parts-format', o.partsFormat) : []),
    ...flag('--rdl-only', o.rdlOnly)];
}

async function teamConventions(job: Job): Promise<{ path: string; parameters: string[] } | undefined> {
  const found = houseConventions();
  if (!found) {
    job.log.push('NOTE No team conventions were found (house-style/conventions.json): working without the team template.');
    return undefined;
  }
  let parameters: string[];
  try {
    parameters = readConventions(found.text).parameters.map((p) => p.name);
  } catch (err) {
    throw new Error(`the team conventions cannot be read: ${(err as Error).message}`);
  }
  const path = join(work, 'conventions.json');
  await writeFile(path, found.text);
  return { path, parameters };
}

async function runCommand(job: Job, request: RunRequest): Promise<number> {
  const o = request.options ?? {};
  const out = join(job.dir, 'out');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const inputs = (request.inputs ?? []).map(text).filter(Boolean);
  const flag = (name: string, on: unknown) => (on ? [name] : []);
  const value = (name: string, v: unknown) => (text(v) ? [name, text(v)] : []);
  const lines = (v: unknown) => text(v).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const needInput = () => {
    if (!inputs.length) throw new Error('Choose the files or folder to work on first.');
  };
  const writeOut = async (rel: string, data: string | Uint8Array) => {
    const path = inside(out, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  const swap = (rel: string, ext: string) => rel.replace(/\.[^./]+$/, '') + ext;
  switch (request.command) {
    case 'convert': {
      needInput();
      const input = await staged(job, inputs);
      const team = await teamConventions(job);
      return (await captured(job, convertArgs(input, out, o, team?.path))).code;
    }
    case 'check': {
      needInput();
      const input = await staged(job, inputs);
      const team = await teamConventions(job);
      const params = team?.parameters.join(',') ?? '';
      const { code } = await captured(job, ['check', input, join(out, 'check.txt'), ...(team ? ['--conventions'] : []), ...(params ? ['--parameters', params] : [])]);
      return code;
    }
    case 'headers': {
      needInput();
      const input = await staged(job, inputs);
      const format = o.format === 'csv' ? 'csv' : o.format === 'json' ? 'json' : 'txt';
      return (await captured(job, ['headers', input, join(out, `headers.${format}`), ...(format === 'txt' ? [] : [`--${format}`]), ...flag('--all', o.all)])).code;
    }
    case 'compare': {
      needInput();
      const original = text(o.original);
      if (!original) throw new Error('Choose the original report PDF first.');
      const files: { file: string; rel: string }[] = [];
      for (const i of inputs) files.push(...await filesOf(i, /\.pdf$/i));
      const others = files.filter((f) => resolve(f.file) !== resolve(original));
      if (!others.length) throw new Error('No converted report PDFs to compare.');
      job.log.push(`Reading ${basename(original)} and ${others.length} converted report PDF(s)...`);
      const parts = [];
      for (const f of others) parts.push({ name: f.rel, data: await readFile(f.file) });
      const { results, originalPages } = compareReports(await readFile(original), parts);
      const summary = summaryText(results, basename(original), originalPages);
      await writeOut('data-check.html', summaryHtml(results, basename(original), originalPages));
      await writeOut('data-check.csv', differencesCsv(results));
      await writeOut('data-check.txt', summary);
      for (const r of results) job.log.push(`${verdict(r) === 'MATCH' ? 'OK  ' : verdict(r) === 'NOT CHECKED' ? 'NOTE' : 'FAIL'} ${r.name}: ${r.found ? `${r.identical} of ${r.values} value(s) identical, ${r.differences.filter((d) => d.kind === 'differs' || d.kind === 'only-original' || d.kind === 'only-converted').length} difference(s); sum of amounts differs by ${r.totals.delta}` : r.note ?? ''}`);
      job.log.push(summary.trim().split('\n').pop()!);
      return results.every((r) => verdict(r) === 'MATCH') ? 0 : 1;
    }
    case 'to-json': {
      needInput();
      const input = await staged(job, inputs);
      return perFile(job, input, /\.rpt$/i, async (file, rel) => {
        const target = join(out, ...swap(rel, '.json').split('/'));
        await mkdir(dirname(target), { recursive: true });
        const { code } = await captured(job, ['to-json', file, target, ...flag('--hex', o.hex), ...flag('--no-metadata', o.noMetadata), ...flag('--no-decode', o.noDecode), ...flag('--no-original', o.noOriginal), ...flag('--compact', o.compact)]);
        if (code) throw new Error('not converted');
        job.log.push(`OK   ${rel}`);
      });
    }
    case 'to-rpt': {
      needInput();
      const input = await staged(job, inputs);
      return perFile(job, input, /\.json$/i, async (file, rel) => {
        const target = join(out, ...swap(rel, '.rpt').split('/'));
        await mkdir(dirname(target), { recursive: true });
        const { code } = await captured(job, ['to-rpt', file, target, ...flag('--no-verify', o.noVerify), ...value('--cfb-version', o.cfbVersion)]);
        if (code) throw new Error('not converted');
      });
    }
    case 'verify': {
      needInput();
      const input = await staged(job, inputs);
      return perFile(job, input, /\.rpt$/i, async (file, rel) => {
        const { code, stdout } = await captured(job, ['verify', file]);
        job.log.push(...stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split(file).join(rel)));
        if (code) throw new Error('round trip differs');
      });
    }
    case 'inspect':
    case 'charts':
    case 'check-width':
    case 'layout': {
      needInput();
      const input = await staged(job, inputs);
      const command = request.command;
      const texts = lines(o.texts);
      const scope = o.scope === 'texts' ? [] : o.scope === 'sections' ? ['--sections'] : ['--all'];
      if (command === 'layout' && !texts.length && !scope.length) throw new Error('Give at least one text to look for, or choose to show every section.');
      return perFile(job, input, command === 'check-width' ? /\.rdl$/i : /\.(rpt|json)$/i, async (file, rel) => {
        const args = command === 'layout' ? ['layout', file, ...texts, ...scope] : [command, file];
        const { code, stdout } = await captured(job, args);
        if (code) throw new Error('failed');
        await writeOut(swap(rel, command === 'inspect' ? '.inspect.json' : `.${command}.txt`), stdout);
        job.log.push(`OK   ${rel}`);
      });
    }
    default:
      throw new Error(`unknown command ${request.command}`);
  }
}

async function start(job: Job, request: RunRequest): Promise<void> {
  job.running = true;
  job.log = [];
  job.code = undefined;
  job.files = [];
  job.savedTo = undefined;
  job.started = Date.now();
  job.finished = undefined;
  job.label = text(request.output) ? resolve(text(request.output)) : 'results';
  const task = queue.then(async () => {
    try {
      job.code = await runCommand(job, request);
    } catch (err) {
      job.log.push(`Error: ${(err as Error).message}`);
      job.code = 2;
    }
    const out = join(job.dir, 'out');
    job.files = await listFiles(out);
    const target = text(request.output);
    if (target && job.files.length) {
      try {
        await mkdir(target, { recursive: true });
        await cp(out, target, { recursive: true, force: true });
        job.savedTo = resolve(target);
        job.log.push(`Saved ${job.files.length} file(s) to ${job.savedTo}`);
      } catch (err) {
        job.log.push(`Could not save to ${target}: ${(err as Error).message}`);
      }
    }
    job.running = false;
    job.finished = Date.now();
  });
  queue = task.catch(() => undefined);
}

function powershell(script: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { windowsHide: true });
    const chunks: Buffer[] = [];
    const problems: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => problems.push(c));
    child.on('error', () => done(null));
    child.on('exit', (code: number | null) => done(code === 0 && !Buffer.concat(problems).toString('utf8').trim() ? Buffer.concat(chunks).toString('utf8').trim() : null));
  });
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function pick(kind: string, filter: string, multiple: boolean, start: string): Promise<string[] | null> {
  if (!isWindows) return null;
  const owner = '$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true};';
  const at = start ? (kind === 'folder' ? `$d.SelectedPath = ${quote(start)};` : `$d.InitialDirectory = ${quote(start)};`) : '';
  const script = kind === 'folder'
    ? `Add-Type -AssemblyName System.Windows.Forms; ${owner} $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; ${at} if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }; $o.Dispose()`
    : `Add-Type -AssemblyName System.Windows.Forms; ${owner} $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Filter = ${quote(filter || 'All files (*.*)|*.*')}; $d.Multiselect = $${multiple ? 'true' : 'false'}; ${at} if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write(($d.FileNames -join '|')) }; $o.Dispose()`;
  const picked = await powershell(script);
  if (picked === null) return null;
  return picked ? picked.split('|').filter(Boolean) : [];
}

function openPath(path: string): void {
  const child = isWindows ? (/^https?:/.test(path) ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', path], { detached: true, stdio: 'ignore' }) : spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function shutdown(code = 0): Promise<never> {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  process.exit(code);
}

const TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.vb': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.rdl': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

async function handle(req: IncomingMessage, res: ServerResponse, token: string, port: number): Promise<void> {
  const url = new URL(req.url ?? '/', 'http:\/\/127.0.0.1');
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'Forbidden', 'text/plain');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (url.searchParams.get('t') !== token) return send(res, 403, `Open ${APP} from its launcher.`, 'text/plain; charset=utf-8');
    return send(res, 200, page(token, isWindows), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" });
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
  const given = req.headers['x-token'] ?? url.searchParams.get('t');
  if (given !== token) return send(res, 403, 'Forbidden', 'text/plain');
  lastPing = Date.now();
  const route = url.pathname.slice(5);
  try {
    if (route === 'ping') return json(res, { ok: true });
    if (route === 'quit' && req.method === 'POST') {
      json(res, { ok: true });
      setTimeout(() => void shutdown(0), 200);
      return;
    }
    if (route === 'job' && req.method === 'POST') return json(res, { id: newJob().id, home: homedir() });
    if (route === 'job') {
      const job = jobOf(url.searchParams.get('id'));
      const from = Number(url.searchParams.get('from') ?? 0) || 0;
      return json(res, { running: job.running, code: job.code, log: job.log.slice(from), total: job.log.length, files: job.running ? [] : job.files, savedTo: job.savedTo, seconds: job.started ? Math.round(((job.finished ?? Date.now()) - job.started) / 100) / 10 : 0 });
    }
    if (route === 'run' && req.method === 'POST') {
      const request = JSON.parse((await body(req)).toString('utf8')) as RunRequest;
      const job = jobOf(request.job);
      if (job.running) throw new Error('this job is still running');
      await start(job, request);
      return json(res, { ok: true });
    }
    if (route === 'parameters' && req.method === 'POST') {
      const { paths } = JSON.parse((await body(req)).toString('utf8')) as { paths: string[] };
      const files: string[] = [];
      for (const p of paths ?? []) files.push(...(await filesOf(p, /\.(rpt|json)$/i).catch(() => [])).map((f) => f.file));
      return json(res, { parameters: await parameterChoices(files), files: files.length });
    }
    if (route === 'upload' && req.method === 'PUT') {
      const job = jobOf(url.searchParams.get('job'));
      const area = url.searchParams.get('area') === 'opt' ? 'opt' : 'in';
      const rel = (url.searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel) throw new Error('no file name');
      const root = join(job.dir, area);
      const target = inside(root, rel);
      await mkdir(dirname(target), { recursive: true });
      await new Promise<void>((done, fail) => {
        const stream = createWriteStream(target);
        stream.on('finish', () => done());
        stream.on('error', fail);
        req.on('error', fail);
        req.pipe(stream);
      });
      return json(res, { root, file: target });
    }
    if (route === 'reset-uploads' && req.method === 'POST') {
      const { job: id, area } = JSON.parse((await body(req)).toString('utf8')) as { job: string; area: string };
      const job = jobOf(id);
      await rm(join(job.dir, area === 'opt' ? 'opt' : 'in'), { recursive: true, force: true });
      return json(res, { ok: true });
    }
    if (route === 'file') {
      const job = jobOf(url.searchParams.get('job'));
      const path = inside(join(job.dir, 'out'), url.searchParams.get('path') ?? '');
      const data = await readFile(path);
      const download = url.searchParams.get('download') === '1';
      const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
      return send(res, 200, data, download ? 'application/octet-stream' : type,
        download ? { 'Content-Disposition': `attachment; filename="${basename(path).replace(/"/g, '')}"` } : type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {});
    }
    if (route === 'zip') {
      const job = jobOf(url.searchParams.get('job'));
      const out = join(job.dir, 'out');
      const entries = [];
      for (const f of await listFiles(out)) entries.push({ name: f, data: await readFile(join(out, ...f.split('/'))) });
      return send(res, 200, zipFiles(entries), 'application/zip', { 'Content-Disposition': `attachment; filename="${(url.searchParams.get('name') || 'converted').replace(/[^\w.-]+/g, '_')}.zip"` });
    }
    if (route === 'pick' && req.method === 'POST') {
      const { kind, filter, multiple, start: from } = JSON.parse((await body(req)).toString('utf8')) as { kind: string; filter?: string; multiple?: boolean; start?: string };
      const picked = await pick(kind, filter ?? '', !!multiple, text(from));
      return json(res, picked === null ? { unsupported: true } : { paths: picked });
    }
    if (route === 'open' && req.method === 'POST') {
      const { path } = JSON.parse((await body(req)).toString('utf8')) as { path: string };
      await stat(path);
      openPath(path);
      return json(res, { ok: true });
    }
    if (route === 'exists' && req.method === 'POST') {
      const { paths } = JSON.parse((await body(req)).toString('utf8')) as { paths: string[] };
      const found: Record<string, string> = {};
      for (const p of paths ?? []) found[p] = await stat(p).then((s) => (s.isDirectory() ? 'folder' : 'file'), () => 'missing');
      return json(res, found);
    }
    if (route === 'settings' && req.method === 'GET') return json(res, await readSettings());
    if (route === 'settings' && req.method === 'POST') {
      const value = JSON.parse((await body(req)).toString('utf8')) as Record<string, unknown>;
      await mkdir(dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, JSON.stringify(value, null, 2));
      return json(res, { ok: true });
    }
    return send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    return json(res, { error: (err as Error).message }, 400);
  }
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (err: Error & { code?: string }) => {
      server.removeListener('listening', onListening);
      fail(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startUi(options: { open?: boolean; port?: number } = {}): Promise<string> {
  const token = randomBytes(18).toString('base64url');
  let port = 0;
  const server = createServer((req, res) => {
    handle(req, res, token, port).catch((err: Error) => {
      if (!res.headersSent) json(res, { error: err.message }, 500);
    });
  });
  const first = options.port ?? 47815;
  for (let p = first; p < first + 20 && !port; p++) {
    try {
      port = await listen(server, p);
    } catch {
      port = 0;
    }
  }
  if (!port) port = await listen(server, 0);
  await mkdir(work, { recursive: true });
  const address = `http:\/\/127.0.0.1:${port}/?t=${token}`;
  lastPing = Date.now();
  const timer = setInterval(() => {
    const busy = [...jobs.values()].some((j) => j.running);
    if (!busy && Date.now() - lastPing > 6 * 60 * 1000) void shutdown(0);
  }, 30 * 1000);
  timer.unref?.();
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  if (options.open !== false) openPath(address);
  return address;
}
