import { readFile } from 'node:fs/promises';
import { buildMetadata, readCfb } from '../index.ts';
import { jsonToDocument } from '../json.ts';

export interface ParameterChoice {
  name: string;
  prompt?: string;
  type?: string;
  values: string[];
  reports: number;
}

const key = (name: string) => name.trim().replace(/^[@?]+/, '').replace(/^pm-\??/i, '').toLowerCase();

function literal(text: string): string | undefined {
  const t = text.trim();
  if (/^"[^"]*"$/.test(t) || /^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true' ? 'True' : 'False';
  return undefined;
}

export function valuesTested(text: string, name: string): string[] {
  const found: string[] = [];
  const target = key(name);
  const lit = String.raw`"[^"\n]*"|'[^'\n]*'|-?\d+(?:\.\d+)?|true|false`;
  const param = String.raw`\{\?(?:pm-\??)?([^}]+)\}`;
  const forward = new RegExp(`${param}\\s*(?:=|<>|<=|>=|<|>)\\s*(${lit})`, 'gi');
  const backward = new RegExp(`(${lit})\\s*(?:=|<>|<=|>=|<|>)\\s*${param}`, 'gi');
  const list = new RegExp(`${param}\\s+in\\s+\\[([^\\]]*)\\]`, 'gi');
  for (const m of text.matchAll(forward)) if (key(m[1]!) === target) { const v = literal(m[2]!); if (v !== undefined) found.push(v); }
  for (const m of text.matchAll(backward)) if (key(m[2]!) === target) { const v = literal(m[1]!); if (v !== undefined) found.push(v); }
  for (const m of text.matchAll(list)) {
    if (key(m[1]!) !== target) continue;
    for (const item of m[2]!.split(',')) { const v = literal(item); if (v !== undefined) found.push(v); }
  }
  const bare = new RegExp(`(?:\\bif\\s+(?:not\\s+)?|\\b(?:and|or)\\s+(?:not\\s+)?)${param}\\s*(?:then|and|or|\\)|$)`, 'gi');
  for (const m of text.matchAll(bare)) if (key(m[1]!) === target) found.push('True', 'False');
  return found;
}

export async function parameterChoices(files: string[]): Promise<ParameterChoice[]> {
  const byName = new Map<string, ParameterChoice & { seen: Set<string> }>();
  for (const file of files.slice(0, 300)) {
    let reports;
    try {
      const raw = await readFile(file);
      const doc = file.toLowerCase().endsWith('.json') ? jsonToDocument(JSON.parse(raw.toString('utf8'))) : readCfb(raw);
      reports = buildMetadata(doc).reports ?? [];
    } catch {
      continue;
    }
    const counted = new Set<string>();
    for (const report of reports) {
      const def = report.definition;
      if (!def) continue;
      const texts = [...(def.formulaTexts ?? []), ...def.formulas.map((f) => f.text ?? ''), def.selectionFormulas?.record ?? '', def.selectionFormulas?.group ?? ''].filter(Boolean);
      for (const p of def.parameters) {
        if (/^pm-/i.test(p.name) || key(p.name) === 'section_id') continue;
        const k = key(p.name);
        const values = texts.flatMap((t) => valuesTested(t, p.name));
        const entry = byName.get(k) ?? { name: p.name.replace(/^[@?]+/, ''), prompt: p.prompt, type: p.valueType, values: [], reports: 0, seen: new Set<string>() };
        for (const v of values) if (!entry.seen.has(v.toLowerCase())) { entry.seen.add(v.toLowerCase()); entry.values.push(v); }
        if (!counted.has(k)) { counted.add(k); entry.reports++; }
        byName.set(k, entry);
      }
    }
  }
  return [...byName.values()].filter((e) => e.values.length).map(({ seen: _s, ...e }) => ({ ...e, values: e.values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) })).sort((a, b) => a.name.localeCompare(b.name));
}
