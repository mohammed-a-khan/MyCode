import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { diagnoseRdl } from '../src/ssrs/diagnose.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, descendants, parseXml, textOf } from '../src/ssrs/xml.ts';

const conventions = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt', heading: '{T}_{col}_ColTxt', value: '{T}_{col}_ColVal', blank: '{T}_blnk{n}', group: '{S}_grp_{n}' } }));
const empty = { saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [], formulas: [] };
const params = [{ name: 'owner_key', type: 'number' }];
const box = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { width: w, height: h } });
const field = (name: string, f: string, x: number, y: number, w: number, h: number, extra = {}) => ({ kind: 'field', name, field: f, style: { size: 8 }, ...box(x, y, w, h), ...extra });
const text = (name: string, value: string, x: number, y: number, w: number, h: number) => ({ kind: 'text', name, text: value, style: { size: 8, bold: true }, ...box(x, y, w, h) });
const table = (name: string, kind: string, fields: string[]) => ({ connections: [], links: [], tables: [{ alias: name, name, schema: 'dbo', kind, fields: fields.map((n) => ({ name: n, type: /amount|par/.test(n) ? 'number' : 'string' })) }] });
const sub = (definition: object, source: object, n: number) => ({ name: `Part_${n}`, links: [], parameters: ['owner_key'], definition, dataSource: source });
const build = (subs: object[], placed: object[]) => {
  const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
    { name: 'ReportFooterArea1', sections: placed.map((objects, i) => ({ name: `RF${i + 1}`, height: 2000, objects })) }] };
  const converted = convertToRdl(main as never, { connections: [], links: [], tables: [] } as never, { reportName: 'Parts', subreports: new Map(subs.map((s, i) => [i + 2, s] as [number, never])), formulasInQuery: true, rulesAsText: true } as never);
  return applyConventions(converted.rdl, 'Parts', conventions).rdl;
};
const subreport = (n: number, x = 0) => ({ kind: 'subreport', name: `Sub${n}`, subreport: { index: n + 1, onDemand: false }, ...box(x, 0, 6000, 300) });
const listing = (T: string, extraFormulas: object[] = [], extraHeads: object[] = [], extraDetail: object[] = []) => ({ ...empty, parameters: params, groups: ['@G'],
  selectionFormulas: { record: `{${T}.owner_key} = {?owner_key}` },
  formulas: [{ kind: 'formula', name: 'G', index: 1, text: 'WhileReadingRecords; "X"', referencedFields: [] }, { kind: 'internal', name: 'Group #1 Order', index: 2, text: 'if IsNull ({@G}) then 2 else 2', referencedFields: ['@G'] }, ...extraFormulas],
  layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: 300, objects: [text('Title', `${T} title`, 0, 0, 6000, 280)] }, { name: 'RH2', height: 300, objects: [text('Lone', 'Printed once', 0, 0, 6000, 280)] }] },
    { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 0, suppressed: true, objects: [] }] },
    { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 450, objects: [text('H1', 'Name', 0, 200, 2000, 200), ...extraHeads] }] },
    { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 30, objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 200, objects: [field('V1', `${T}.name`, 0, 0, 2000, 180), ...extraDetail] }] }] });

describe('sections of a report made of many parts', () => {
  it('names every group of every table apart, as SSRS requires', () => {
    const fields = ['name', 'owner_key'];
    const rdl = build([sub(listing('first'), table('first', 'table', fields), 1), sub(listing('second'), table('second', 'table', fields), 2)], [[subreport(1)], [subreport(2)]]);
    const groups = descendants(parseXml(rdl)).filter((e) => e.name === 'Group').map((e) => e.attributes.Name);
    assert.equal(new Set(groups).size, groups.length, groups.join(', '));
    assert.ok(!diagnoseRdl(rdl, true).some((f) => /more than one/.test(f.message)));
  });

  it('makes one heading of a heading printed on two lines, so each column has one heading', () => {
    const T = 'ratings';
    const heads = [text('Top', 'Original', 2200, 120, 1800, 150), field('Under', '@Agency', 2200, 280, 1800, 150, { style: { size: 8, bold: true } })];
    const def = listing(T, [{ kind: 'formula', name: 'Agency', index: 3, text: `if {${T}.flag} = "Y" then "Agency A" else "Agency B"`, referencedFields: [`${T}.flag`], valueType: 'string' }],
      heads, [field('V2', `${T}.rating`, 2200, 0, 1800, 180)]);
    const rdl = build([sub(def, table(T, 'table', ['name', 'rating', 'flag', 'owner_key']), 1)], [[subreport(1)]]);
    const headings = descendants(parseXml(rdl)).filter((e) => e.name === 'Textbox' && /_ColTxt$/.test(e.attributes.Name ?? ''));
    assert.equal(headings.length, 2, headings.map((h) => h.attributes.Name).join(', '));
    assert.match(textOf(descendants(headings[1]!).find((e) => e.name === 'Value')!), /^="Original" & vbCrLf & \(/);
    assert.ok(!diagnoseRdl(rdl, true).some((f) => f.kind === 'merge'));
  });

  it('draws a chart over a procedure without custom code', () => {
    const T = 'chart_rows';
    const def = { ...empty, parameters: params, groups: [`${T}.label`], formulas: [{ kind: 'internal', name: 'Group #1 Order', index: 2, text: `if IsNull ({${T}.label}) then 2 else 2`, referencedFields: [`${T}.label`] }],
      layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: 3200, objects: [
        { kind: 'chart', name: 'Bars', ...box(0, 0, 4000, 3000), chart: { family: 0, graphType: 0, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label` } },
        { kind: 'chart', name: 'Lines', ...box(4000, 0, 4000, 3000), chart: { family: 1, graphType: 13, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label`, series: `${T}.kind` } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] }] };
    const rdl = build([sub(def, table('chart_rows_get', 'storedProcedure', ['label', 'kind', 'amount']), 1)], [[subreport(1)]]);
    assert.ok(!/Code\./.test(rdl) && !/<Code>/.test(rdl), 'no custom code');
    assert.match(rdl, /<Color>=Choose\(\(RunningValue\(Fields!label\.Value, CountDistinct, Nothing\)/);
    assert.match(rdl, /<TextWrapThreshold>20</);
  });

  it('leaves out a hidden field that only sets a variable nothing reads', () => {
    const T = 'rows';
    const setter = { kind: 'formula', name: 'Counted', index: 3, text: `WhilePrintingRecords; shared numbervar counted; counted := 0; counted := {${T}.amount}; counted;`, referencedFields: [`${T}.amount`], valueType: 'number' };
    const def = listing(T, [setter], [], [field('Hidden', '@Counted', 2200, 0, 300, 150, { suppressed: true })]);
    const rdl = build([sub(def, table(T, 'table', ['name', 'amount', 'owner_key']), 1)], [[subreport(1)]]);
    assert.ok(!/<Code>/.test(rdl) && !/Counted/.test(rdl));
  });
});
