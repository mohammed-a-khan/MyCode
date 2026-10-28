import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { zipFiles } from '../src/ui/zip.ts';

const APP = 'Report Converter';
const root = resolve(import.meta.dirname, '..');
const entry = 'src/app.ts';
const windows = process.platform === 'win32';
const outDir = resolve(root, 'dist', APP);
const keep = process.argv.includes('--keep-bundle');
const plain = process.argv.includes('--plain');
const withoutConventions = process.argv.includes('--no-conventions');

function fail(message: string): never {
  console.error(`\nBuild failed: ${message}`);
  process.exit(1);
}

function minify(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  let prev = '';
  const frames: number[] = [];
  let depth = 0;
  const word = /[A-Za-z0-9_$]/;
  const beforeRegex = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'else', 'do', 'yield', 'await']);
  let pendingSpace = '';
  const emit = (text: string, kind: string) => {
    if (pendingSpace) {
      const a = out[out.length - 1] ?? '';
      const b = text[0] ?? '';
      if (pendingSpace === '\n') out += '\n';
      else if ((word.test(a) && word.test(b)) || (a === b && (a === '+' || a === '-')) || (a === '/' && b === '/')) out += ' ';
      pendingSpace = '';
    }
    out += text;
    prev = kind;
  };
  const template = () => {
    let s = '';
    while (i < n) {
      const c = code[i]!;
      if (c === '\\') { s += code.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { s += c; i++; emit(s, 'value'); return; }
      if (c === '$' && code[i + 1] === '{') { s += '${'; i += 2; emit(s, 'punct'); frames.push(depth); depth = 0; return; }
      s += c;
      i++;
    }
    fail('unterminated template literal');
  };
  while (i < n) {
    const c = code[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
      let nl = false;
      while (i < n && /[\s\u00a0\ufeff]/.test(code[i]!)) { if (code[i] === '\n') nl = true; i++; }
      if (out) pendingSpace = nl || pendingSpace === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*' + '/', i + 2);
      if (end < 0) fail('unterminated block comment');
      if (code.slice(i, end).includes('\n')) pendingSpace = '\n';
      else if (!pendingSpace) pendingSpace = ' ';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c) { if (code[j] === '\\') j++; if (code[j] === '\n') fail('line break in a string'); j++; }
      emit(code.slice(i, j + 1), 'value');
      i = j + 1;
      continue;
    }
    if (c === '`') {
      i++;
      emit('', prev);
      out += '`';
      template();
      continue;
    }
    if (c === '/') {
      const regex = prev === '' || prev === 'punct' || (prev.startsWith('word:') && beforeRegex.has(prev.slice(5)));
      if (regex) {
        let j = i + 1;
        let cls = false;
        while (j < n) {
          const d = code[j]!;
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') fail('line break in a regular expression');
          if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(code[j]!)) j++;
        emit(code.slice(i, j), 'value');
        i = j;
        continue;
      }
    }
    if (word.test(c) || c === '#' || c > '\u007f') {
      let j = i + 1;
      while (j < n && (word.test(code[j]!) || code[j]! > '\u007f' || (/[0-9]/.test(c) && /[.eE]/.test(code[j]!)) || (/[0-9]/.test(c) && /[+-]/.test(code[j]!) && /[eE]/.test(code[j - 1]!)))) j++;
      const w = code.slice(i, j);
      emit(w, /^[0-9.]/.test(w) ? 'value' : `word:${w}`);
      i = j;
      continue;
    }
    if (c === '{') { depth++; emit(c, 'punct'); i++; continue; }
    if (c === '}') {
      if (frames.length && depth === 0) {
        depth = frames.pop()!;
        i++;
        emit('}', 'punct');
        template();
        continue;
      }
      depth--;
      emit(c, 'value');
      i++;
      continue;
    }
    if (c === ')' || c === ']') { emit(c, 'value'); i++; continue; }
    if (c === '.' && /[0-9]/.test(code[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9eE]/.test(code[j]!)) j++;
      emit(code.slice(i, j), 'value');
      i = j;
      continue;
    }
    if ((c === '+' || c === '-') && code[i + 1] === c) { emit(c + c, prev === 'value' || prev.startsWith('word:') ? 'value' : 'punct'); i += 2; continue; }
    emit(c, 'punct');
    i++;
  }
  return out;
}

interface Module {
  file: string;
  code: string;
}

function resolveFrom(file: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(file), spec));
}

function transform(file: string, source: string): { code: string; deps: string[] } {
  let code = stripTypeScriptTypes(source.replace(/^#!.*/, ''), { mode: 'strip' });
  const deps = new Set<string>();
  const exported: string[] = [];
  const reexported: string[] = [];
  const names = (list: string) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(s);
    if (!m) fail(`${file}: cannot read the names "${s}"`);
    return { from: m[1]!, to: m[2] ?? m[1]! };
  });
  const local = (spec: string) => {
    const dep = resolveFrom(file, spec);
    deps.add(dep);
    return JSON.stringify(dep);
  };
  code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?/gm, (_: string, list: string, spec: string) => {
    const parts = names(list);
    if (spec.startsWith('node:')) return parts.length ? `const { ${parts.map((p) => (p.from === p.to ? p.from : `${p.from}: ${p.to}`)).join(', ')} } = require(${JSON.stringify(spec)});` : '';
    if (!parts.length) return `__imp(${local(spec)}, function () {});`;
    return `let ${parts.map((p) => p.to).join(', ')}; __imp(${local(spec)}, function (m) { ${parts.map((p) => `${p.to} = m.${p.from};`).join(' ')} });`;
  });
  code = code.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s*'([^']+)';?/gm, (_: string, name: string, spec: string) =>
    spec.startsWith('node:') ? `const ${name} = require(${JSON.stringify(spec)});` : `let ${name}; __imp(${local(spec)}, function (m) { ${name} = m; });`);
  code = code.replace(/^import\s+(\w+)\s+from\s*'([^']+)';?/gm, (_: string, name: string, spec: string) =>
    spec.startsWith('node:') ? `const ${name} = require(${JSON.stringify(spec)});` : `let ${name}; __imp(${local(spec)}, function (m) { ${name} = m.default; });`);
  code = code.replace(/^import\s*'([^']+)';?/gm, (_: string, spec: string) => (spec.startsWith('node:') ? `require(${JSON.stringify(spec)});` : `__imp(${local(spec)}, function () {});`));
  code = code.replace(/^export\s+((?:async\s+)?function\*?|class|const|let|var)\s+([\w$]+)/gm, (_: string, kind: string, name: string) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  code = code.replace(/^export\s*\{([^}]*)\}\s*from\s*'([^']+)';?/gm, (_: string, list: string, spec: string) => {
    const dep = local(spec);
    for (const p of names(list)) reexported.push(`${JSON.stringify(p.to)}: function () { return __req(${dep}).${p.from}; }`);
    return '';
  });
  code = code.replace(/^export\s*\{([^}]*)\};?/gm, (_: string, list: string) => {
    for (const p of names(list)) reexported.push(`${JSON.stringify(p.to)}: function () { return ${p.from}; }`);
    return '';
  });
  code = code.replace(/\bawait\s+import\(/g, '__dyn(').replace(/\bimport\(/g, '__dynP(');
  const left = /^\s*(import|export)\b.*$/m.exec(code);
  if (left) fail(`${file}: cannot bundle the line "${left[0].trim()}"`);
  for (const m of source.matchAll(/'(\.{1,2}\/[^']+\.ts)'/g)) {
    const dep = resolveFrom(file, m[1]!);
    if (existsSync(join(root, dep))) deps.add(dep);
  }
  const getters = [...exported.map((name) => `${JSON.stringify(name)}: function () { return ${name}; }`), ...reexported];
  const head = getters.length ? `__exp(exports, { ${getters.join(', ')} });\n` : '';
  return { code: head + code, deps: [...deps] };
}

function bundle(): string {
  const modules: Module[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const path = join(root, file);
    if (!existsSync(path)) fail(`missing module ${file}`);
    const { code, deps } = transform(file, readFileSync(path, 'utf8'));
    modules.push({ file, code });
    queue.push(...deps);
  }
  const runtime = `
var __defs = {}, __mods = {};
function __exp(target, getters) { for (var k in getters) Object.defineProperty(target, k, { enumerable: true, get: getters[k] }); }
function __load(file) {
  var rec = __mods[file];
  if (rec) return rec;
  if (!__defs[file]) throw new Error('module not bundled: ' + file);
  rec = __mods[file] = { exports: {}, done: false, wait: [] };
  __defs[file](rec.exports, function (dep, cb) { var r = __load(dep); if (r.done) cb(r.exports); else r.wait.push(cb); }, function (spec) { return __dynamic(spec, file); }, function (spec) { return Promise.resolve().then(function () { return __dynamic(spec, file); }); });
  rec.done = true;
  rec.wait.splice(0).forEach(function (cb) { cb(rec.exports); });
  return rec;
}
function __req(file) { return __load(file).exports; }
function __dynamic(spec, from) {
  if (/^node:/.test(spec)) return require(spec);
  var parts = from.split('/'); parts.pop();
  spec.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
  return __req(parts.join('/'));
}
`;
  const body = modules.map((m) => `__defs[${JSON.stringify(m.file)}] = function (exports, __imp, __dyn, __dynP) {\n${m.code}\n};`).join('\n');
  const house = conventions ? `globalThis.houseConventions = ${JSON.stringify(conventions)};\n` : '';
  return `(function (require) {\n'use strict';\n${house}${runtime}\n${body}\n__req(${JSON.stringify(entry)});\n})`;
}

function icon(): Uint8Array {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  const set = (x: number, y: number, rgb: [number, number, number]) => {
    const row = size - 1 - y;
    const at = (row * size + x) * 4;
    pixels[at] = rgb[2]; pixels[at + 1] = rgb[1]; pixels[at + 2] = rgb[0]; pixels[at + 3] = 255;
  };
  for (let y = 2; y < 30; y++) for (let x = 5; x < 27; x++) set(x, y, [31, 111, 235]);
  for (const line of [9, 14, 19, 24]) for (let x = 9; x < (line === 24 ? 18 : 23); x++) { set(x, line, [255, 255, 255]); set(x, line + 1, [255, 255, 255]); }
  const mask = new Uint8Array(size * 4);
  const header = new Uint8Array(40);
  const h = new DataView(header.buffer);
  h.setUint32(0, 40, true); h.setInt32(4, size, true); h.setInt32(8, size * 2, true); h.setUint16(12, 1, true); h.setUint16(14, 32, true);
  h.setUint32(20, pixels.length + mask.length, true);
  const image = new Uint8Array(header.length + pixels.length + mask.length);
  image.set(header); image.set(pixels, 40); image.set(mask, 40 + pixels.length);
  const dir = new Uint8Array(22);
  const d = new DataView(dir.buffer);
  d.setUint16(2, 1, true); d.setUint16(4, 1, true);
  dir[6] = size; dir[7] = size;
  d.setUint16(10, 1, true); d.setUint16(12, 32, true); d.setUint32(14, image.length, true); d.setUint32(18, 22, true);
  const out = new Uint8Array(dir.length + image.length);
  out.set(dir); out.set(image, 22);
  return out;
}

const LAUNCHER = `using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    [STAThread]
    static void Main(string[] args)
    {
        string title = "${APP}";
        string home = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(home, "runtime", "node.exe");
        string app = Path.Combine(home, "runtime", "app.cjs");
        if (!File.Exists(node) || !File.Exists(app))
        {
            MessageBox.Show("Some files of " + title + " are missing. Unzip the whole folder, then start it again.", title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        string log = Path.Combine(Path.GetTempPath(), "report-converter.log");
        try
        {
            if (File.Exists(log)) File.Delete(log);
        }
        catch (Exception) { }
        ProcessStartInfo info = new ProcessStartInfo(node, "\\"" + app + "\\"");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WorkingDirectory = home;
        try
        {
            Process p = Process.Start(info);
            if (p.WaitForExit(8000) && p.ExitCode != 0)
            {
                string detail = File.Exists(log) ? File.ReadAllText(log) : "";
                MessageBox.Show(title + " could not start.\\n\\n" + detail, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        catch (Exception e)
        {
            MessageBox.Show(title + " could not start: " + e.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
`;

function findCsc(): string | undefined {
  const base = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const dir = join(base, 'Microsoft.NET', fw);
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir).filter((v) => /^v4\./.test(v)).sort().reverse();
    for (const v of versions) {
      const csc = join(dir, v, 'csc.exe');
      if (existsSync(csc)) return csc;
    }
  }
  return undefined;
}

function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, base));
    else out.push(path.slice(base.length + 1));
  }
  return out;
}

if (typeof stripTypeScriptTypes !== 'function') fail(`Node ${process.version} is too old to build the app: use Node 22.13 or newer.`);
console.log(`Building ${APP} with Node ${process.version}`);
const conventionsFile = [join(root, 'house-style', 'conventions.json'), join(root, '..', 'house-style', 'conventions.json')].find((f) => existsSync(f));
let conventions: string | undefined;
if (conventionsFile && !withoutConventions) {
  conventions = readFileSync(conventionsFile, 'utf8');
  try {
    JSON.parse(conventions);
  } catch (err) {
    fail(`${conventionsFile} is not valid JSON: ${(err as Error).message}`);
  }
  console.log(`  conventions ${conventionsFile} (packed inside the app)`);
} else if (!withoutConventions) {
  fail('house-style/conventions.json was not found in the project folder. Put the team conventions there, or build with --no-conventions.');
}
const code = plain ? bundle() : minify(bundle());
const key = randomBytes(32);
const packed = deflateRawSync(Buffer.from(code, 'utf8'), { level: 9 });
for (let k = 0; k < packed.length; k++) packed[k] = packed[k]! ^ key[k % key.length]!;
const loader = `'use strict';const f=require('fs'),z=require('zlib'),v=require('vm'),p=require('path');const k=Buffer.from('${key.toString('base64')}','base64');const b=f.readFileSync(p.join(__dirname,'app.dat'));for(let i=0;i<b.length;i++)b[i]^=k[i%k.length];new v.Script(z.inflateRawSync(b).toString('utf8'),{filename:'app'}).runInThisContext()(require);\n`;

rmSync(outDir, { recursive: true, force: true });
const runtime = join(outDir, 'runtime');
mkdirSync(runtime, { recursive: true });
const nodeName = windows ? 'node.exe' : 'node';
console.log(`  runtime    ${process.execPath}`);
copyFileSync(process.execPath, join(runtime, nodeName));
writeFileSync(join(runtime, 'app.dat'), packed);
writeFileSync(join(runtime, 'app.cjs'), loader);
if (keep) writeFileSync(resolve(root, 'dist', 'bundle.js'), code);

const check = spawnSync(join(runtime, nodeName), [join(runtime, 'app.cjs'), '--help'], { encoding: 'utf8' });
if (check.status !== 0 || !/to-rdl/.test(check.stdout ?? '')) fail(`the packed app does not run:\n${check.stderr || check.stdout}`);
console.log('  self-test  the packed app runs');

if (windows) {
  writeFileSync(join(outDir, `Start ${APP} (if the .exe is blocked).cmd`), `@echo off\r\ntitle ${APP}\r\n"%~dp0runtime\\node.exe" "%~dp0runtime\\app.cjs" %*\r\n`);
  const csc = findCsc();
  if (csc) {
    const work = resolve(root, 'dist', 'launcher');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'Launcher.cs'), LAUNCHER);
    writeFileSync(join(work, 'app.ico'), icon());
    const compile = (withIcon: boolean) => spawnSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${join(outDir, `${APP}.exe`)}`, ...(withIcon ? [`/win32icon:${join(work, 'app.ico')}`] : []), '/r:System.Windows.Forms.dll', join(work, 'Launcher.cs')], { encoding: 'utf8' });
    let built = compile(true);
    if (built.status !== 0) built = compile(false);
    rmSync(work, { recursive: true, force: true });
    if (built.status === 0) console.log(`  launcher   ${APP}.exe`);
    else console.log(`  launcher   not built (${(built.stdout || built.stderr || '').trim()}); use the .cmd file to start it`);
  } else {
    console.log('  launcher   the C# compiler of .NET Framework 4 was not found; use the .cmd file to start it');
  }
} else {
  writeFileSync(join(outDir, 'start.sh'), `#!/bin/sh\nexec "$(dirname "$0")/runtime/node" "$(dirname "$0")/runtime/app.cjs" "$@"\n`, { mode: 0o755 });
}

writeFileSync(join(outDir, 'README.txt'), [
  `${APP}`,
  '',
  `Start: double-click "${APP}.exe". A page opens in your web browser.`,
  `If the .exe is blocked on your computer, double-click "Start ${APP} (if the .exe is blocked).cmd" instead.`,
  '',
  'Everything runs on this computer only: nothing is sent anywhere and nothing needs to be installed.',
  'Use Quit at the top right of the page to stop it. It also stops by itself a few minutes after its page is left.',
  '',
  'Keep the files of this folder together: the runtime folder is needed.',
  '',
].join('\r\n'));

const entries = filesUnder(outDir).map((rel) => ({ name: `${APP}/${rel.split(/[\\/]/).join('/')}`, data: readFileSync(join(outDir, rel)) }));
const zipPath = resolve(root, 'dist', `${APP}.zip`);
writeFileSync(zipPath, zipFiles(entries));
console.log(`\nDone:\n  folder  ${outDir}\n  zip     ${zipPath} (${Math.round(statSync(zipPath).size / 1048576)} MB)\nShare the zip: people unzip it and start ${APP}.`);
