#!/usr/bin/env node
/** Command line entry point: rpt2json, json2rpt, inspect and verify. */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { buildMetadata, jsonToRpt, readCfb, rptToJson, type RptJson } from './index.ts';
import { jsonToDocument, sha256 } from './json.ts';
import { convertDocumentsWithTemplate, convertDocumentToSsrs, reviewMarkdown } from './ssrs/convert.ts';
import { readHouseTemplate, type HouseTemplate } from './ssrs/house.ts';
import { chartStructure } from './crystal/chartinfo.ts';
import { layoutSummary } from './crystal/layoutinfo.ts';
import { checkRdlWidths } from './ssrs/widthcheck.ts';
import { extractHeaders, formatHeadersCsv, formatHeadersText, type HeaderText } from './crystal/headers.ts';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Every .rpt in a folder and its subfolders, in name order, each with its subfolder relative to the top ("" for the
 * top itself). Links to folders are not followed (a link back up the tree would never end).
 */
async function findReports(top: string, folder = ''): Promise<{ file: string; folder: string }[]> {
  const found: { file: string; folder: string }[] = [];
  const dir = folder ? join(top, folder) : top;
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isDirectory()) found.push(...await findReports(top, folder ? join(folder, name) : name));
    else if (/\.rpt$/i.test(name) && (info.isFile() || (info.isSymbolicLink() && (await stat(path)).isFile()))) found.push({ file: path, folder });
  }
  return found;
}

const USAGE = `Crystal Reports .rpt <-> JSON converter

Usage:
  rpt-json to-json <input.rpt> [output.json] [--hex] [--no-metadata] [--no-decode] [--no-original] [--compact]
  rpt-json to-rpt  <input.json> <output.rpt> [--no-verify] [--cfb-version 3|4]
  rpt-json to-rdl  <input.rpt|input.json|folder> [output-dir] [--connection "<connection string>"]
                   [--shared-datasource <name>] [--template <house.rdl>] [--separate-subreports]
                   [--page-number] [--parameter name=value]... [--chart-axis-format <format>] [--house <style.json>]
                   [--conventions <conventions.json> [--prefix <short name>]]
                                            Convert to SSRS .rdl files (+ subreports) and a review checklist;
                                            a folder converts every .rpt in it and its subfolders, each written
                                            to the same subfolder of the output folder;
                                            --template lays each report out in the style of an existing .rdl;
                                            --page-number adds "Page N" at the right of the page footer;
                                            --parameter converts for that parameter value: what its suppress
                                            formulas hide is left out (repeat for more parameters);
                                            --chart-axis-format sets the value-axis format of charts whose
                                            format the .rpt does not show, e.g. "0.00%";
                                            --house keeps the Crystal layout in a house style: fonts, title and
                                            heading bands, border and chart colours from a JSON file;
                                            --conventions reshapes each report as a team's template: their
                                            names, title and totals as table rows, a no-data row, their data
                                            source and parameters, looks read from their style dataset;
                                            --prefix gives the report's items a short name of their own
  rpt-json to-rdl  --template <house.rdl> --combine <output.rdl> <input.rpt|folder>...
                                            Combine several reports into one .rdl, one block per report
  rpt-json headers <input.rpt|input.json|folder> [output-file] [--json | --csv] [--all]
                                            List header text: report/page/group headers, column headings,
                                            chart titles (--all adds footers, details and field objects);
                                            a folder lists every .rpt in it and its subfolders
  rpt-json inspect <input.rpt>              Print decoded metadata (no stream data)
  rpt-json charts  <input.rpt>              Print how each chart is stored, with all names and text hidden
  rpt-json layout  <input.rpt> <text>...    Print the layout of each subreport showing one of the texts (or "#N" for
                                            Subdocument N) and of main-report sections showing them, one line per
                                            section and object, with all other names and text hidden
                                            (safe to share when a chart does not convert)
  rpt-json check-width <input.rdl>          List what in a converted .rdl reaches past the printable page or past
                                            what holds it (the cause of blank pages after every page)
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
    const pageNumber = takeFlag(args, '--page-number');
    const chartAxisFormat = takeOption(args, '--chart-axis-format');
    let parameterValues: Record<string, string> | undefined;
    for (let p = takeOption(args, '--parameter'); p !== undefined; p = takeOption(args, '--parameter')) {
      const eq = p.indexOf('=');
      if (eq < 1) throw new Error('--parameter needs name=value');
      parameterValues = { ...parameterValues, [p.slice(0, eq).trim()]: p.slice(eq + 1) };
    }
    const housePath = takeOption(args, '--house');
    let restyle: ((rdl: string) => string) | undefined;
    if (housePath) {
      // The house style module is optional: loaded only where it is installed.
      const modulePath = './ssrs/brand.ts';
      let house: { readHouseStyle(json: string): unknown; applyHouseStyle(rdl: string, style: unknown): string };
      try {
        house = await import(modulePath);
      } catch {
        throw new Error('to-rdl: --house needs the house style module (src/ssrs/brand.ts), which is not installed');
      }
      let style: unknown;
      try {
        style = house.readHouseStyle((await readFile(housePath)).toString('utf8'));
      } catch (err) {
        throw new Error(`house style ${housePath}: ${(err as Error).message}`);
      }
      restyle = (rdl) => house.applyHouseStyle(rdl, style);
    }
    const conventionsPath = takeOption(args, '--conventions');
    const prefix = takeOption(args, '--prefix');
    let reshape: ((rdl: string, name: string) => { rdl: string; review: { item: string; message: string }[]; settled: string[] }) | undefined;
    if (conventionsPath) {
      const { readConventions, applyConventions } = await import('./ssrs/conventions.ts');
      let conv: ReturnType<typeof readConventions>;
      try {
        conv = readConventions((await readFile(conventionsPath)).toString('utf8'));
      } catch (err) {
        throw new Error(`conventions ${conventionsPath}: ${(err as Error).message}`);
      }
      reshape = (rdl, name) => applyConventions(rdl, name, conv, prefix);
      // The house style step's layout work (tables, bands and frames reaching the page's rules), without its looks:
      // the team's looks come from their style dataset.
      if (!restyle) {
        try {
          const house: { applyHouseStyle(rdl: string, style: object): string } = await import('./ssrs/brand.ts');
          restyle = (rdl) => house.applyHouseStyle(rdl, {});
        } catch {
          // (The house style module is optional.)
        }
      }
    }
    if (prefix && !conventionsPath) throw new Error('to-rdl: --prefix goes with --conventions');
    const templatePath = takeOption(args, '--template');
    if (conventionsPath && templatePath) throw new Error('to-rdl: --conventions reshapes the converted layout and --template replaces it; use one or the other');
    if (housePath && templatePath) throw new Error('to-rdl: --house keeps the Crystal layout and --template replaces it; use one or the other');
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
    // A folder: every .rpt in it and its subfolders.
    const expandAll = async (path: string) => ((await stat(path)).isDirectory() ? findReports(path) : [{ file: path, folder: '' }]);
    const expand = async (path: string) => (await expandAll(path)).map((f) => f.file);
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
    if (!input) throw new Error('to-rdl needs an input .rpt/.json file or a folder of .rpt files (subfolders included)');
    const inputs = await expandAll(input);
    if (inputs.length === 0) throw new Error(`no .rpt files in ${input} or its subfolders`);
    await mkdir(outputDir, { recursive: true });
    let failures = 0;
    // Output names already written in this run, per output folder (Windows file names ignore case).
    const writtenIn = new Map<string, Set<string>>();
    for (const { file, folder } of inputs) {
      // Reports in subfolders are written to the same subfolders of the output folder.
      const targetDir = folder ? join(outputDir, folder) : outputDir;
      const written = writtenIn.get(targetDir.toLowerCase()) ?? new Set<string>();
      writtenIn.set(targetDir.toLowerCase(), written);
      try {
        if (folder) await mkdir(targetDir, { recursive: true });
        const doc = await load(file);
        const original = basename(file).replace(/\.(rpt|json)$/i, '');
        let base = original;
        const convert = (name: string) => (template
          ? [convertDocumentsWithTemplate(template, [{ doc, name: original }], name)]
          : convertDocumentToSsrs(doc, name, { connectionString, sharedDataSource, separateSubreports, pageNumber, parameterValues, chartAxisFormat, restyle, reshape }));
        let reports = convert(base);
        // Two inputs whose names clean up to the same file name ("A B" and "A_B") get a numbered suffix.
        for (let n = 2; reports.some((r) => written.has(r.fileName.toLowerCase())); n++) {
          base = `${original}_${n}`;
          reports = convert(base);
        }
        if (base !== original) console.error(`NOTE ${file}: written as ${reports[0]?.fileName} (another report already produced that name)`);
        for (const r of reports) written.add(r.fileName.toLowerCase());
        for (const report of reports) {
          if (report.rdl) await writeFile(join(targetDir, report.fileName), report.rdl);
        }
        const reviewPath = join(targetDir, `${reports[0]?.fileName.replace(/\.rdl$/, '') ?? base}.review.md`);
        await writeFile(reviewPath, reviewMarkdown(basename(file), reports));
        const items = reports.reduce((n, r) => n + r.review.length, 0);
        console.error(`OK   ${file}: ${reports.filter((r) => r.rdl).length} report(s), ${items} review item(s)`);
      } catch (err) {
        failures++;
        console.error(`FAIL ${file}: ${(err as Error).message}`);
      }
    }
    if (inputs.length > 1) console.error(`${inputs.length - failures} of ${inputs.length} report(s) converted${failures ? `, ${failures} failed` : ''}`);
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

  if (command === 'check-width') {
    const [input] = positionals(args, 'check-width', 1);
    if (!input) throw new Error('check-width needs an input .rdl file');
    process.stdout.write(checkRdlWidths((await readFile(input)).toString('utf8')));
    return 0;
  }

  if (command === 'layout') {
    const sections = args.includes('--sections') || args.includes('--all');
    const [input, ...texts] = args.filter((a) => !a.startsWith('--'));
    if (!input || (texts.length === 0 && !sections)) {
      throw new Error(`layout needs an input .rpt file and at least one text to look for (or --sections, or "#N" for subreport N); it was given: ${args.map((a) => JSON.stringify(a)).join(' ') || 'nothing'}`);
    }
    if (sections) texts.push(args.includes('--all') ? '--all' : '--sections');
    const raw = await readFile(input);
    const doc = input.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
    process.stdout.write(layoutSummary(doc, texts));
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
    const inputs = folder ? await findReports(input) : [{ file: input, folder: '' }];
    if (inputs.length === 0) throw new Error(`no .rpt files in ${input} or its subfolders`);
    const items: HeaderText[] = [];
    let failures = 0;
    for (const { file, folder: sub } of inputs) {
      try {
        const raw = await readFile(file);
        const doc = file.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
        items.push(...extractHeaders(buildMetadata(doc).reports ?? [], { all, file: folder ? (sub ? join(sub, basename(file)) : basename(file)) : undefined }));
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
