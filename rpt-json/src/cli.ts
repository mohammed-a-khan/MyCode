#!/usr/bin/env node
/** Command line entry point: rpt2json, json2rpt, inspect and verify. */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { buildMetadata, jsonToRpt, readCfb, rptToJson, type RptJson } from './index.ts';
import { jsonToDocument, sha256 } from './json.ts';
import { convertDocumentsWithTemplate, convertDocumentToSsrs, reviewMarkdown } from './ssrs/convert.ts';
import { readHouseTemplate, type HouseTemplate } from './ssrs/house.ts';
import { chartStructure } from './crystal/chartinfo.ts';
import { extractHeaders, formatHeadersCsv, formatHeadersText, type HeaderText } from './crystal/headers.ts';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const USAGE = `Crystal Reports .rpt <-> JSON converter

Usage:
  rpt-json to-json <input.rpt> [output.json] [--hex] [--no-metadata] [--no-decode] [--no-original] [--compact]
  rpt-json to-rpt  <input.json> <output.rpt> [--no-verify] [--cfb-version 3|4]
  rpt-json to-rdl  <input.rpt|input.json|folder> [output-dir] [--connection "<connection string>"]
                   [--shared-datasource <name>] [--template <house.rdl>] [--separate-subreports]
                                            Convert to SSRS .rdl files (+ subreports) and a review checklist;
                                            --template lays each report out in the style of an existing .rdl
  rpt-json to-rdl  --template <house.rdl> --combine <output.rdl> <input.rpt|folder>...
                                            Combine several reports into one .rdl, one block per report
  rpt-json headers <input.rpt|input.json|folder> [output-file] [--json | --csv] [--all]
                                            List header text: report/page/group headers, column headings,
                                            chart titles (--all adds footers, details and field objects)
  rpt-json inspect <input.rpt>              Print decoded metadata (no stream data)
  rpt-json charts  <input.rpt>              Print how each chart is stored, with all names and text hidden
                                            (safe to share when a chart does not convert)
  rpt-json verify  <input.rpt>              Round-trip rpt -> json -> rpt and compare every stream,
                                            then again with every encrypted stream re-encrypted

Without an output path, to-json writes to stdout.`;

/**
 * The positional arguments left after a command's options were taken. An argument starting with "--" is an
 * unknown or mistyped option (it would otherwise be used as a file name), and extra arguments are errors too.
 */
function positionals(args: string[], command: string, max: number): string[] {
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new Error(`${command}: unknown option ${unknown} (see --help)`);
  if (args.length > max) throw new Error(`${command}: unexpected argument "${args[max]}"`);
  return args;
}

/** Refuses to write an output over its own input. */
function differentFiles(input: string, output: string | undefined): void {
  if (output && resolve(input).toLowerCase() === resolve(output).toLowerCase()) throw new Error(`the output ${output} would overwrite the input`);
}

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], option: string): string | undefined {
  const i = args.indexOf(option);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  if (value === undefined) throw new Error(`${option} needs a value`);
  return value;
}

/** The root tree without the parts that legitimately change when a stream is re-encrypted. */
function comparableTree(json: RptJson): string {
  return JSON.stringify(json.root, (key, value) =>
    value && typeof value === 'object' && 'decoded' in value ? { ...value, size: undefined, sha256: undefined, data: undefined } : value,
  );
}

/** Flattens the stream tree to "path -> sha256" for comparison. */
function streamDigests(json: RptJson): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: RptJson['root'], prefix: string) => {
    for (const child of node.children) {
      const path = prefix + child.name;
      if (child.type === 'storage') walk(child, `${path}/`);
      else out.set(path, child.sha256 ?? '');
    }
  };
  walk(json.root, '');
  return out;
}

async function main(argv: string[]): Promise<number> {
  // "--option=value" is the same as "--option value".
  const args = argv.flatMap((a) => (/^--[\w-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
  const command = args.shift();
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'to-json') {
    const hex = takeFlag(args, '--hex');
    const noMetadata = takeFlag(args, '--no-metadata');
    const compact = takeFlag(args, '--compact');
    const noDecode = takeFlag(args, '--no-decode');
    const noOriginal = takeFlag(args, '--no-original');
    const [input, output] = positionals(args, 'to-json', 2);
    if (!input) throw new Error('to-json needs an input .rpt path');
    differentFiles(input, output);
    const json = rptToJson(await readFile(input), {
      encoding: hex ? 'hex' : 'base64',
      metadata: !noMetadata,
      decode: !noDecode,
      keepOriginal: !noOriginal,
      fileName: basename(input),
    });
    const text = JSON.stringify(json, null, compact ? undefined : 2) + '\n';
    if (output) await writeFile(output, text);
    else process.stdout.write(text);
    return 0;
  }

  if (command === 'to-rpt') {
    const noVerify = takeFlag(args, '--no-verify');
    const version = takeOption(args, '--cfb-version');
    const [input, output] = positionals(args, 'to-rpt', 2);
    if (!input || !output) throw new Error('to-rpt needs <input.json> <output.rpt>');
    differentFiles(input, output);
    if (version !== undefined && version !== '3' && version !== '4') throw new Error('--cfb-version must be 3 or 4');
    const bytes = jsonToRpt(await readFile(input, 'utf8'), {
      verify: !noVerify,
      majorVersion: version === undefined ? undefined : (Number(version) as 3 | 4),
    });
    await writeFile(output, bytes);
    console.error(`Wrote ${output} (${bytes.length} bytes)`);
    return 0;
  }

  if (command === 'to-rdl') {
    const connectionString = takeOption(args, '--connection');
    const sharedDataSource = takeOption(args, '--shared-datasource');
    const separateSubreports = takeFlag(args, '--separate-subreports');
    const templatePath = takeOption(args, '--template');
    const combine = takeOption(args, '--combine');
    let template: HouseTemplate | undefined;
    if (templatePath) {
      try {
        template = readHouseTemplate((await readFile(templatePath)).toString('utf8'));
      } catch (err) {
        throw new Error(`template ${templatePath}: ${(err as Error).message}`);
      }
      if (connectionString || sharedDataSource) console.error('NOTE --connection and --shared-datasource are ignored with --template: the template\'s data source is used');
    }
    const expand = async (path: string) => ((await stat(path)).isDirectory()
      ? (await readdir(path)).filter((f) => /\.rpt$/i.test(f)).sort().map((f) => join(path, f))
      : [path]);
    const load = async (file: string) => {
      const raw = await readFile(file);
      return file.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
    };

    if (combine) {
      if (!template) throw new Error('to-rdl: --combine needs --template');
      const unknown = args.find((a) => a.startsWith('--'));
      if (unknown) throw new Error(`to-rdl: unknown option ${unknown} (see --help)`);
      if (!args.length) throw new Error('to-rdl --combine needs the .rpt files (or folders) to combine');
      const files = (await Promise.all(args.map(expand))).flat();
      if (!files.length) throw new Error('no .rpt files to combine');
      const output = /\.rdl$/i.test(combine) ? combine : `${combine}.rdl`;
      for (const file of files) differentFiles(file, output);
      const documents = [];
      for (const file of files) documents.push({ doc: await load(file), name: basename(file).replace(/\.(rpt|json)$/i, '') });
      const report = convertDocumentsWithTemplate(template, documents, basename(output).replace(/\.rdl$/i, ''));
      const outputDir = resolve(output, '..');
      await mkdir(outputDir, { recursive: true });
      await writeFile(output, report.rdl);
      await writeFile(output.replace(/\.rdl$/i, '.review.md'), reviewMarkdown(files.map((f) => basename(f)).join(', '), [{ ...report, fileName: basename(output) }]));
      console.error(`OK   ${output}: ${documents.length} report(s) combined, ${report.review.length} review item(s)`);
      return 0;
    }

    const [input, outputDir = '.'] = positionals(args, 'to-rdl', 2);
    if (!input) throw new Error('to-rdl needs an input .rpt/.json file or a folder of .rpt files');
    const inputs = await expand(input);
    if (inputs.length === 0) throw new Error(`no .rpt files in ${input}`);
    await mkdir(outputDir, { recursive: true });
    let failures = 0;
    // Output names already written in this run (Windows file names ignore case).
    const written = new Set<string>();
    for (const file of inputs) {
      try {
        const doc = await load(file);
        const original = basename(file).replace(/\.(rpt|json)$/i, '');
        let base = original;
        const convert = (name: string) => (template
          ? [convertDocumentsWithTemplate(template, [{ doc, name: original }], name)]
          : convertDocumentToSsrs(doc, name, { connectionString, sharedDataSource, separateSubreports }));
        let reports = convert(base);
        // Two inputs whose names clean up to the same file name ("A B" and "A_B") get a numbered suffix.
        for (let n = 2; reports.some((r) => written.has(r.fileName.toLowerCase())); n++) {
          base = `${original}_${n}`;
          reports = convert(base);
        }
        if (base !== original) console.error(`NOTE ${file}: written as ${reports[0]?.fileName} (another report already produced that name)`);
        for (const r of reports) written.add(r.fileName.toLowerCase());
        for (const report of reports) {
          if (report.rdl) await writeFile(join(outputDir, report.fileName), report.rdl);
        }
        const reviewPath = join(outputDir, `${reports[0]?.fileName.replace(/\.rdl$/, '') ?? base}.review.md`);
        await writeFile(reviewPath, reviewMarkdown(basename(file), reports));
        const items = reports.reduce((n, r) => n + r.review.length, 0);
        console.error(`OK   ${file}: ${reports.filter((r) => r.rdl).length} report(s), ${items} review item(s)`);
      } catch (err) {
        failures++;
        console.error(`FAIL ${file}: ${(err as Error).message}`);
      }
    }
    return failures > 0 ? 1 : 0;
  }

  if (command === 'charts') {
    const [input] = positionals(args, 'charts', 1);
    if (!input) throw new Error('charts needs an input .rpt file');
    const raw = await readFile(input);
    const doc = input.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
    process.stdout.write(chartStructure(doc));
    return 0;
  }

  if (command === 'headers') {
    const asJson = takeFlag(args, '--json');
    const asCsv = takeFlag(args, '--csv');
    const all = takeFlag(args, '--all');
    const [input, output] = positionals(args, 'headers', 2);
    if (!input) throw new Error('headers needs an input .rpt/.json file or a folder of .rpt files');
    if (asJson && asCsv) throw new Error('headers: choose either --json or --csv');
    differentFiles(input, output);
    const folder = (await stat(input)).isDirectory();
    const inputs = folder
      ? (await readdir(input)).filter((f) => /\.rpt$/i.test(f)).sort().map((f) => join(input, f))
      : [input];
    if (inputs.length === 0) throw new Error(`no .rpt files in ${input}`);
    const items: HeaderText[] = [];
    let failures = 0;
    for (const file of inputs) {
      try {
        const raw = await readFile(file);
        const doc = file.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
        items.push(...extractHeaders(buildMetadata(doc).reports ?? [], { all, file: folder ? basename(file) : undefined }));
      } catch (err) {
        failures++;
        console.error(`FAIL ${file}: ${(err as Error).message}`);
      }
    }
    const text = asJson ? `${JSON.stringify(items, null, 2)}\n` : asCsv ? formatHeadersCsv(items) : formatHeadersText(items);
    if (output) {
      await writeFile(output, text);
      console.error(`Wrote ${output} (${items.length} header text item(s))`);
    } else {
      process.stdout.write(text);
    }
    return failures > 0 ? 1 : 0;
  }

  if (command === 'inspect') {
    const [input] = positionals(args, 'inspect', 1);
    if (!input) throw new Error('inspect needs an input .rpt path');
    const doc = readCfb(await readFile(input));
    console.log(JSON.stringify({ container: { majorVersion: doc.majorVersion, minorVersion: doc.minorVersion }, ...buildMetadata(doc) }, null, 2));
    return 0;
  }

  if (command === 'verify') {
    const [input] = positionals(args, 'verify', 1);
    if (!input) throw new Error('verify needs an input .rpt path');
    const original = await readFile(input);
    const json = rptToJson(original, { metadata: false });
    const rebuilt = jsonToRpt(JSON.parse(JSON.stringify(json)) as RptJson);
    const again = rptToJson(rebuilt, { metadata: false });
    const before = streamDigests(json);
    const after = streamDigests(again);
    const problems = [...before].filter(([path, digest]) => after.get(path) !== digest).map(([path]) => path);
    problems.push(...[...after.keys()].filter((path) => !before.has(path)));
    if (JSON.stringify(json.root) !== JSON.stringify(again.root)) problems.push('(directory attributes differ)');
    // Second pass: drop the original bytes so every encrypted stream is re-compressed and re-encrypted.
    const decodedOnly = rptToJson(original, { metadata: false, keepOriginal: false });
    const reencoded = rptToJson(jsonToRpt(JSON.parse(JSON.stringify(decodedOnly)) as RptJson), { metadata: false, keepOriginal: false });
    if (comparableTree(decodedOnly) !== comparableTree(reencoded)) problems.push('(re-encrypted streams decode differently)');
    if (problems.length > 0) {
      console.error(`FAIL ${input}: ${problems.join(', ')}`);
      return 1;
    }
    console.log(`OK   ${input}: ${before.size} streams identical, re-encryption verified (original ${original.length} bytes, rebuilt ${rebuilt.length} bytes, sha256 ${sha256(rebuilt).slice(0, 12)})`);
    return 0;
  }

  console.error(`Unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
