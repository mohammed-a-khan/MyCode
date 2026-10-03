/**
 * The layout of chosen reports, one short line per section and object, with names and text replaced by
 * placeholders: for working out how a report is laid out without sharing its names or data.
 */

import type { CfbDocument } from '../cfb/types.ts';
import { buildMetadata } from '../json.ts';
import { classifyAreas } from './areas.ts';
import { allGroupRecords, groupRecords, textRecords, type FormulaRef, type ReportDefinition, type ReportObject, type SectionInfo } from './model.ts';

/** Object names Crystal generates (kept: they say nothing about the report). */
const GENERIC_NAME = /^((Text|Field|Line|Box|Graph|Chart|Subreport|Picture|Drawing|CrossTab|Map|OLAP)\d*|(Page|Report|Group)(Header|Footer)\d*(Area\d*)?(Section\d*)?|Detail(Area\d*)?(Section\d*)?|TSection\d+|Section\d+)$/i;
/** Crystal's own field names (kept). */
const SPECIAL_FIELD = /^(Page Number|Total Page Count|Page N of M|Record Number|Group Number|Print Date|Print Time|Data Date|Report Title|Group #\d+ Name)$/i;
/** Words of Crystal's formula language (kept); any other word is a name and is hidden. */
const FORMULA_WORDS = new Set(('if then else and or not in to step do while for select case default true false ' +
  'whileprintingrecords whilereadingrecords beforereadingrecords shared global local stringvar numbervar booleanvar ' +
  'currencyvar datevar datetimevar timevar pagenumber totalpagecount count sum average maximum minimum distinctcount ' +
  'isnull totext cstr cdbl tonumber len length trim left right mid instr instrrev replace split uppercase lowercase ' +
  'onfirstrecord onlastrecord previous next round truncate abs chr crred crblack crgreen crblue crnocolor defaultattribute ' +
  'currentfieldvalue date year month day today currentdate function exit nothing ' +
  'datetime datetimevalue datevalue cdate cdatetime ctime time timevalue dateserial timeserial dateadd datediff datepart dayofweek weekday ' +
  'hour minute second currentdatetime currenttime hasvalue isdate istime isdatetime tonumber cdbl ccur int fix ceiling floor ' +
  'monthname weekdayname dtstodate maximum minimum lastfullmonth lastfullweek monthtodate yeartodate calendar1stqtr ' +
  'aged0to30days aged31to60days aged61to90days over90days lastyearmtd lastyearytd next30days last7days').split(' '));

export function layoutSummary(doc: CfbDocument, find: string[]): string {
  const reports = (buildMetadata(doc).reports ?? []).filter((r) => r.definition);
  if (find.includes('--sections')) return sectionList(reports.find((r) => !r.storage)?.definition);
  const placeholders = new Map<string, string>();
  const hide = (text: string, prefix = 'S'): string => {
    let id = placeholders.get(text);
    if (!id) {
      id = `${prefix}${placeholders.size + 1}`;
      placeholders.set(text, id);
    }
    return id;
  };
  // Spaces and line breaks count alike (a heading may be split over lines).
  const words = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const terms = find.filter((f) => !/^#\d+$/.test(f.trim())).map(words).filter(Boolean);
  const matched = (text: string) => terms.find((t) => words(text).includes(t));
  const shownText = (text: string) => {
    const term = matched(text);
    return term ? `[${term}]` : `"${hide(text)}"`;
  };
  const shownName = (name: string) => (GENERIC_NAME.test(name) ? name : hide(name, 'N'));
  const shownField = (ref: string): string => {
    if (SPECIAL_FIELD.test(ref)) return ref;
    // A group's name by its field: the wrapper is Crystal's own, the field is hidden like any other.
    const groupName = /^GroupName\s*\(\s*\{?([^{}]+?)\}?\s*\)$/i.exec(ref);
    if (groupName) return `GroupName ({${shownField(groupName[1].trim())}})`;
    const prefix = /^[@?#]/.test(ref) ? ref[0] : '';
    const rest = prefix ? ref.slice(1) : ref;
    return `${prefix}${hide(rest, prefix === '@' ? 'F' : prefix === '?' ? 'P' : '#' === prefix ? 'R' : 'D')}`;
  };
  const shownFormula = (text: string) => text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"[^"]*"|'[^']*'/g, (s) => `"${hide(s.slice(1, -1))}"`)
    .replace(/\{([^}]*)\}/g, (_, ref: string) => `{${shownField(ref)}}`)
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word, offset: number, all: string) => {
      // Placeholders made above, and Crystal's own words, stay.
      if (/^[SFPRDN]\d+$/.test(word) || FORMULA_WORDS.has(word.toLowerCase())) return word;
      if (all[offset - 1] === '{' || all[offset - 1] === '@' || all[offset - 1] === '?') return word;
      return hide(word, 'V');
    })
    .replace(/\s+/g, ' ')
    .trim();

  const lines: string[] = [];
  const selections = (definition: ReportDefinition) => [
    ...Object.entries(definition.selectionFormulas ?? {})
      .filter(([, text]) => text)
      .map(([kind, text]) => `  ${kind} selection: {${shownFormula(text!)}}`),
    // Crystal's "Group #n Order" formulas (which field each group level uses, and how).
    ...definition.formulas.filter((f) => /^Group #\d+ Order$/i.test(f.name)).map((f) => `  ${f.name}: {${shownFormula(f.text ?? '')}}`),
    // Each group: its field, then its records (sort order, named groups and their conditions; text masked).
    ...definition.groups.map((g, i) => `  group ${i + 1} {${shownField(g)}}: ${groupRecords.get(definition)?.[i] ?? '?'}`),
  ];
  const formulaOf = (definition: ReportDefinition, ref: FormulaRef) =>
    definition.formulaTexts?.[ref.index] ?? definition.formulas.find((f) => f.index === ref.index)?.text ?? '';
  const conditions = (definition: ReportDefinition, c: Record<string, FormulaRef> | undefined) =>
    Object.entries(c ?? {}).map(([kind, ref]) => ` ${kind}{${shownFormula(formulaOf(definition, ref))}}`).join('');
  const objectLine = (definition: ReportDefinition, o: ReportObject) => {
    const p = o.position ?? { x: 0, y: 0 };
    const parts = [`${o.kind} ${shownName(o.name)} x=${p.x} y=${p.y} w=${o.size?.width ?? '?'} h=${o.size?.height ?? '?'}`];
    if (o.text !== undefined) parts.push(shownText(o.text.trim()));
    if (o.field) {
      const formula = o.field.startsWith('@') ? definition.formulas.find((f) => f.name.toLowerCase() === o.field!.slice(1).toLowerCase()) : undefined;
      parts.push(`field=${shownField(o.field)}${formula?.valueType ? `:${formula.valueType}` : ''}`);
      // The formula's logic, with its names and texts hidden like everything else.
      if (formula?.text) parts.push(`= {${shownFormula(formula.text)}}`);
    }
    if (o.border) parts.push(`border=${o.border.sides.join('')}${o.border.width ? `/${o.border.width}` : ''}`);
    if (o.subreport) parts.push(`-> Subdocument ${o.subreport.index}`);
    if (o.chart) parts.push(`chart family=${o.chart.family} type=${o.chart.graphType} values=${o.chart.values.length} category=${o.chart.onChangeOf ? 'yes' : 'no'} series=${o.chart.series ? 'yes' : 'no'}`);
    if (o.suppressed) parts.push('SUPPRESSED');
    const line = `    ${parts.join(' ')}${conditions(definition, o.conditions)}`;
    if (o.kind !== 'text' || !o.text || !matched(o.text)) return line;
    // A searched text, fully: alignment, font size, its shape (letters x, digits 9, spaces and breaks kept) and records.
    const shape = (o.runs ?? [{ text: o.text }]).map((r) => ('text' in r ? r.text : '{field}')).join('')
      .replace(/[A-Za-z]/g, 'x').replace(/\d/g, '9').replace(/[^\x20-\x7e]/g, (c) => `<${c.charCodeAt(0).toString(16)}>`);
    return [line,
      `      align=${o.align ?? '-'} paragraphs=${(o.paragraphAligns ?? []).map((a) => a ?? '-').join(',')} size=${o.style?.size ?? '?'}pt`,
      `      shape=|${shape}|`,
      `      records ${(textRecords.get(o) ?? []).join(' ')}`].join('\n');
  };
  const sectionLines = (definition: ReportDefinition, label: string, sections: SectionInfo[]) => {
    for (const s of sections) {
      lines.push(`  ${label} ${shownName(s.name)} h=${s.height ?? '?'}${s.suppressed ? ' SUPPRESSED' : ''}${s.formatFlags ? ` flags=${s.formatFlags}` : ''}${conditions(definition, s.conditions)}`);
      for (const o of s.objects) lines.push(objectLine(definition, o));
    }
  };
  const describe = (definition: ReportDefinition, subreport: boolean) => {
    const { unrecognised, groupHeaders, groupFooters, ...a } = classifyAreas(definition.layout, subreport);
    sectionLines(definition, 'PH', a.pageHeader);
    sectionLines(definition, 'RH', a.reportHeader);
    for (const [level, s] of groupHeaders) sectionLines(definition, `GH${level}`, s);
    sectionLines(definition, 'D', a.detail);
    for (const [level, s] of [...groupFooters].reverse()) sectionLines(definition, `GF${level}`, s);
    sectionLines(definition, 'RF', a.reportFooter);
    sectionLines(definition, 'PF', a.pageFooter);
    for (const area of unrecognised) sectionLines(definition, `?${shownName(area.name)}`, area.sections);
  };
  const texts = (definition: ReportDefinition) => definition.layout.flatMap((a) => a.sections.flatMap((s) => s.objects.map((o) => o.text ?? '')));

  const main = reports.find((r) => !r.storage);
  // --all: the whole main report, its groups and every group record (text masked).
  if (find.includes('--all') && main?.definition) {
    lines.push('== main report');
    describe(main.definition, false);
    lines.push(...selections(main.definition));
    const sorts = main.definition.sorts ?? [];
    if (sorts.length) lines.push(`  sorts: ${sorts.map((s) => `${shownField(s.field)}${s.descending ? ' desc' : ' asc'}${s.bySummary ? ' (by summary)' : ''}`).join(', ')}`);
    (allGroupRecords.get(main.definition) ?? []).forEach((g, i) => lines.push(`  group record ${i + 1}: ${g}`));
    return `${lines.join('\n')}\n\n(Positions and sizes in twips; names and text are replaced by S1, N1, F1, ...; <tN> is N characters of text.)\n`;
  }
  // "#339" asks for Subdocument 339 by number.
  const numbers = new Set(find.map((f) => /^#(\d+)$/.exec(f.trim())?.[1]).filter((n): n is string => !!n).map(Number));
  // Main-report sections showing a searched text, with what is placed around them.
  if (main?.definition) {
    for (const area of main.definition.layout) {
      for (const section of area.sections) {
        if (!section.objects.some((o) => o.text && matched(o.text))) continue;
        lines.push('', `== main report: ${shownName(area.name)}/${shownName(section.name)} h=${section.height ?? '?'}${section.suppressed ? ' SUPPRESSED' : ''}${conditions(main.definition, section.conditions)}`);
        for (const o of section.objects) lines.push(objectLine(main.definition, o));
      }
    }
  }
  for (const report of reports) {
    const number = Number(/(\d+)$/.exec(report.storage)?.[1]);
    if (!report.storage || !(numbers.has(number) || texts(report.definition!).some((t) => matched(t)))) continue;
    const index = Number(/(\d+)$/.exec(report.storage)?.[1]);
    lines.push('', `== ${report.storage}`);
    // Where the main report places it, and what hides it there.
    for (const area of main?.definition?.layout ?? []) {
      for (const section of area.sections) {
        const holder = section.objects.find((o) => o.subreport?.index === index);
        if (holder) {
          lines.push(`  placed in ${shownName(area.name)}/${shownName(section.name)} h=${section.height ?? '?'}${section.suppressed ? ' SUPPRESSED' : ''}${section.formatFlags ? ` flags=${section.formatFlags}` : ''}${conditions(main!.definition!, section.conditions)}`);
          // Everything placed around it in that section (boxes and lines framing it, other subreports).
          for (const o of section.objects) lines.push(`${o === holder ? '  >' : '   '}${objectLine(main!.definition!, o).slice(3)}`);
        }
      }
    }
    describe(report.definition!, true);
    // How its records are sorted (record sorts, then group sorts / Top N by summary).
    const sorts = report.definition!.sorts ?? report.definition!.sortFields.map((field) => ({ field, descending: false, bySummary: false }));
    if (sorts.length) lines.push(`  sorts: ${sorts.map((s) => `${shownField(s.field)}${s.descending ? ' desc' : ' asc'}${s.bySummary ? ' (by summary)' : ''}`).join(', ')}`);
    if (report.definition!.groups.length) lines.push(`  groups: ${report.definition!.groups.map((g) => shownField(g)).join(', ')}`);
    lines.push(...selections(report.definition!));
    // Its parameters, and the main-report field each linked one takes its value from.
    const params = report.definition!.parameters.map((p) => `?${hide(p.name, 'P')}${p.linkedField ? ` <- {${shownField(p.linkedField)}}` : ''}`);
    if (params.length) lines.push(`  parameters: ${params.join(', ')}`);
  }
  // The main report's record and group selection and its groups (what decides which rows are shown, and how).
  if (main?.definition && lines.length) {
    lines.push('', '== main report selection and groups', ...selections(main.definition));
    const sorts = main.definition.sorts ?? [];
    if (sorts.length) lines.push(`  sorts: ${sorts.map((s) => `${shownField(s.field)}${s.descending ? ' desc' : ' asc'}${s.bySummary ? ' (by summary)' : ''}`).join(', ')}`);
  }
  if (!lines.length) return `No report or subreport contains ${find.map((f) => `"${f}"`).join(' or ')}.\n`;
  return `${lines.join('\n').trim()}\n\n(Positions and sizes in twips; names and text are replaced by S1, N1, F1, ...; [text] is a text you searched for.)\n`;
}

/** Every main-report section on one line: height, format flags, conditions named, and the subreports it holds. */
function sectionList(definition: ReportDefinition | undefined): string {
  if (!definition) return 'No main report.\n';
  const lines: string[] = [];
  for (const area of definition.layout) {
    for (const section of area.sections) {
      const subs = section.objects.filter((o) => o.subreport).map((o) => `#${o.subreport!.index}`);
      const kinds = [...new Set(section.objects.filter((o) => !o.subreport).map((o) => o.kind))];
      lines.push(`${GENERIC_NAME.test(area.name) ? area.name : 'Area'}/${GENERIC_NAME.test(section.name) ? section.name : 'Section'} h=${section.height ?? '?'}` +
        `${section.suppressed ? ' SUPPRESSED' : ''} flags=${section.formatFlags ?? '?'}` +
        `${section.conditions ? ` conditions=${Object.keys(section.conditions).join(',')}` : ''}` +
        `${subs.length ? ` subreports=${subs.join(',')}` : ''}${kinds.length ? ` objects=${kinds.join(',')}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
