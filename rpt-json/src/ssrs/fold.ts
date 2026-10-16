import type { AreaInfo, DataSourceInfo, ReportDefinition, SectionInfo, TableInfo } from '../crystal/model.ts';
import type { SubreportInfo } from './rdl.ts';

const BLOCK = 'block_no';

export function foldRepeatedSubreports(definition: ReportDefinition, subreports: Map<number, SubreportInfo>): { definition: ReportDefinition; subreports: Map<number, SubreportInfo>; folded: number[][] } | undefined {
  const layout: AreaInfo[] = [];
  const out = new Map(subreports);
  const folded: number[][] = [];
  for (const area of definition.layout) {
    const sections: SectionInfo[] = [];
    let i = 0;
    while (i < area.sections.length) {
      let j = i;
      while (j < area.sections.length && placedAlone(area.sections[j]!, subreports)) j++;
      const run = area.sections.slice(i, j);
      const joined = run.length >= 2 ? fold(run, subreports) : undefined;
      if (joined) {
        const first = run[0]!;
        const { conditions: _o, ...object } = first.objects[0]!;
        const { conditions: _, ...rest } = first;
        sections.push({ ...rest, suppressed: false, objects: [object] });
        out.set(object.subreport!.index, joined);
        for (const s of run.slice(1)) out.delete(s.objects[0]!.subreport!.index);
        folded.push(run.map((s) => s.objects[0]!.subreport!.index));
        i = j;
      } else {
        sections.push(area.sections[i]!);
        i++;
      }
    }
    layout.push({ ...area, sections });
  }
  return folded.length ? { definition: { ...definition, layout }, subreports: out, folded } : undefined;
}

function placedAlone(section: SectionInfo, subreports: Map<number, SubreportInfo>): boolean {
  if (section.suppressed && !section.conditions?.suppress) return false;
  const [object, ...others] = section.objects;
  const index = object?.kind === 'subreport' && !others.length && !object.subreport?.onDemand ? object.subreport?.index : undefined;
  const info = index !== undefined ? subreports.get(index) : undefined;
  return !!info?.definition && !!info.dataSource && !info.links.length;
}

function fold(run: SectionInfo[], subreports: Map<number, SubreportInfo>): SubreportInfo | undefined {
  const infos = run.map((s) => subreports.get(s.objects[0]!.subreport!.index)!);
  if (new Set(run.map((s) => s.objects[0]!.subreport!.index)).size !== run.length) return undefined;
  const tables = infos.map((info) => onlyTable(info.dataSource!));
  if (tables.some((t) => !t) || infos.some((info) => info.dataSource!.links.length)) return undefined;
  const columns = (t: TableInfo) => t.fields.map((f) => `${f.name}:${f.type}`).sort().join(',');
  if (new Set(tables.map((t) => columns(t!))).size !== 1) return undefined;
  const shapes = infos.map((info, k) => shape(info.definition!, tables[k]!.alias));
  if (new Set(shapes).size !== 1) return undefined;
  const lead = infos[0]!.definition!;
  const groupField = lead.groups[0];
  const formula = groupField?.startsWith('@') ? lead.formulas.find((f) => f.name.toLowerCase() === groupField.slice(1).toLowerCase()) : undefined;
  if (!formula || formula.referencedFields.length || /[{]/.test(formula.text)) return undefined;
  const wheres = infos.map((info, k) => whereOf(info.definition!.selectionFormulas.record, tables[k]!.alias));
  if (wheres.some((w) => w === undefined)) return undefined;
  if (infos.some((info) => info.definition!.selectionFormulas.group || info.definition!.sqlExpressions.length)) return undefined;

  const alias = tables[0]!.alias;
  const quote = (s: string) => `[${s.replace(/]/g, ']]')}]`;
  const names = tables[0]!.fields.map((f) => f.name);
  const sql = tables.map((t, k) => [
    `SELECT ${k + 1} AS ${quote(BLOCK)}, ${names.map((n) => `${quote(t!.alias)}.${quote(n)} AS ${quote(n)}`).join(', ')}`,
    `FROM ${t!.schema ? `${quote(t!.schema)}.` : ''}${quote(t!.name)} AS ${quote(t!.alias)}`,
    wheres[k] ? `WHERE ${wheres[k]}` : '',
  ].filter(Boolean).join('\n')).join('\nUNION ALL\n');
  const field = `${alias}.${BLOCK}`;
  const breaks = run.slice(1).some((s) => s.newPageBefore) || run.slice(0, -1).some((s) => s.newPageAfter);
  const layout = lead.layout.map((area) => /^GroupHeader/i.test(area.name) && breaks
    ? { ...area, sections: area.sections.map((s, n) => (n === 0 ? { ...s, newPageBefore: true } : s)) }
    : area);
  const definition: ReportDefinition = {
    ...lead,
    selectionFormulas: { ...lead.selectionFormulas, record: undefined },
    groups: [field, ...lead.groups.slice(1)],
    groupSorts: lead.groupSorts?.map((g, n) => (n === 0 ? { field, order: 0 } : g)),
    groupsKeptTogether: [...(lead.groupsKeptTogether ?? []), field],
    formulas: lead.formulas.map((f) => (/^Group #1 Order$/i.test(f.name) ? { ...f, referencedFields: [field] } : f)),
    layout,
  };
  emptyColumnsUnruled(definition);
  const table: TableInfo = { alias, name: alias, kind: 'command', sql, fields: [{ name: BLOCK, type: 'number' }, ...tables[0]!.fields] };
  const dataSource: DataSourceInfo = { ...infos[0]!.dataSource!, tables: [table], links: [] };
  return { ...infos[0]!, definition, dataSource };
}

function emptyColumnsUnruled(definition: ReportDefinition): void {
  const heads = definition.layout.filter((a) => /^GroupHeader/i.test(a.name)).flatMap((a) => a.sections.flatMap((s) => s.objects))
    .filter((o) => o.kind === 'field' && o.field && !o.field.startsWith('@') && o.position && o.size);
  const texts = [...(definition.formulaTexts ?? [])];
  let next = Math.max(texts.length, ...definition.formulas.map((f) => (f.index ?? 0) + 1));
  const formulas = [...definition.formulas];
  const overlap = (a: { position?: { x: number }; size?: { width: number } }, b: typeof a) => {
    const [a0, a1, b0, b1] = [a.position!.x, a.position!.x + a.size!.width, b.position!.x, b.position!.x + b.size!.width];
    return Math.min(a1, b1) - Math.max(a0, b0) > Math.min(a1 - a0, b1 - b0) / 2;
  };
  definition.layout = definition.layout.map((area) => !/^Detail/i.test(area.name) ? area : {
    ...area,
    sections: area.sections.map((section) => ({
      ...section,
      objects: section.objects.map((o) => {
        const ref = o.conditions?.topLine;
        const head = o.position && o.size ? heads.find((h) => overlap(h, o)) : undefined;
        const text = ref && (texts[ref.index] ?? formulas.find((f) => f.index === ref.index)?.text);
        if (!ref || !head || !text?.trim()) return o;
        const index = next++;
        const field = `{${head.field}}`;
        const own = `IF IsNull(${field}) or Trim(${field}) = "" THEN crNoLine ELSE (${text.trim().replace(/;\s*$/, '')})`;
        texts[index] = own;
        const lead = formulas.find((f) => f.index === ref.index);
        formulas.push({ ...(lead ?? { kind: 'conditionalFormat', name: ref.name }), index, text: own, referencedFields: [...(lead?.referencedFields ?? []), head.field!] } as typeof formulas[number]);
        return { ...o, conditions: { ...o.conditions, topLine: { ...ref, index } } };
      }),
    })),
  });
  definition.formulas = formulas;
  if (definition.formulaTexts) definition.formulaTexts = texts;
}

function onlyTable(source: DataSourceInfo): TableInfo | undefined {
  return source.tables.length === 1 && source.tables[0]!.kind === 'table' ? source.tables[0] : undefined;
}

function shape(definition: ReportDefinition, alias: string): string {
  const { selectionFormulas: _s, fileName: _f, saveInfo: _i, ...rest } = definition;
  return JSON.stringify(rest).split(`${alias}.`).join('\u0000.');
}

function whereOf(record: string | undefined, alias: string): string | undefined {
  if (!record?.trim()) return '';
  const terms = stripOuter(record.trim()).split(/\s+and\s+/i).map((t) => stripOuter(t.trim()));
  const sql: string[] = [];
  for (const term of terms) {
    const m = /^\{([^}.]+)\.([^}]+)\}\s*=\s*\{\?([^}]+)\}$/.exec(term) ?? /^\{\?([^}]+)\}\s*=\s*\{([^}.]+)\.([^}]+)\}$/.exec(term);
    if (!m) return undefined;
    const [table, column, parameter] = m.length === 4 && term.startsWith('{?') ? [m[2]!, m[3]!, m[1]!] : [m[1]!, m[2]!, m[3]!];
    if (table.toLowerCase() !== alias.toLowerCase()) return undefined;
    sql.push(`[${alias}].[${column}] = {?${parameter}}`);
  }
  return sql.join(' AND ');
}

function stripOuter(text: string): string {
  let t = text;
  while (t.startsWith('(') && t.endsWith(')') && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
