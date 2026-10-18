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

  it('starts a chart under the title drawn over its top', () => {
    const T = 'chart_rows';
    const def = { ...empty, parameters: params, groups: [`${T}.label`], formulas: [{ kind: 'internal', name: 'Group #1 Order', index: 2, text: `if IsNull ({${T}.label}) then 2 else 2`, referencedFields: [`${T}.label`] }],
      layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: 3200, objects: [
        text('Heading', 'Spread by label', 0, 0, 4000, 280),
        { kind: 'chart', name: 'Bars', ...box(0, 135, 4000, 3000), chart: { family: 0, graphType: 0, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label` } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] }] };
    const rdl = build([sub(def, table('chart_rows_get', 'storedProcedure', ['label', 'amount']), 1)], [[subreport(1)]]);
    assert.ok(!diagnoseRdl(rdl, true).some((f) => f.kind === 'overlap'), JSON.stringify(diagnoseRdl(rdl, true).filter((f) => f.kind === 'overlap')));
  });

  it('keeps headings over two lines in the heading band, each column under its own heading', () => {
    const T = 'scores';
    const centred = (name: string, value: string, x: number, y: number, w: number) => ({ ...text(name, value, x, y, w, 210), align: 'center' });
    const heads = [
      centred('L1', 'Name', 120, 480, 4000), centred('L2', 'Limit', 4200, 480, 800),
      centred('L3', 'Latest', 5100, 375, 1100), centred('L4', 'Latest', 6300, 375, 1000), centred('L5', 'Latest Run', 7400, 390, 1500),
      field('L6', `${T}.run_date`, 9000, 375, 1100, 210), centred('L7', 'Final', 10200, 375, 1100),
      centred('L8', 'Low', 5100, 600, 1100), centred('L9', 'High', 6300, 600, 1000), centred('L10', 'Score', 7400, 600, 800), centred('L11', 'Grade', 8250, 600, 650),
      centred('L12', 'Score', 9000, 600, 1100), centred('L13', 'Score', 10200, 600, 1100)];
    const values = [field('V2', `${T}.limit_value`, 4200, 0, 800, 180), field('V3', `${T}.low_value`, 5100, 0, 1100, 180), field('V4', `${T}.high_value`, 6300, 0, 1000, 180),
      field('V5', `${T}.score`, 7400, 0, 800, 180), field('V6', `${T}.grade`, 8250, 0, 650, 180), field('V7', `${T}.prior_score`, 9000, 0, 1100, 180), field('V8', `${T}.final_score`, 10200, 0, 1100, 180)];
    const def = listing(T, [], [], values);
    def.layout[2] = { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 900, objects: heads }] };
    const rdl = build([sub(def, table(T, 'table', ['name', 'limit_value', 'low_value', 'high_value', 'score', 'grade', 'prior_score', 'final_score', 'run_date', 'owner_key']), 1)], [[subreport(1)]]);
    const doc = parseXml(rdl);
    const tablix = descendants(doc).find((e) => e.name === 'Tablix')!;
    const rows = descendants(tablix).filter((e) => e.name === 'TablixRow');
    const cells = (row: typeof rows[number]) => descendants(row).filter((e) => e.name === 'TablixCell').map((c) => descendants(c).filter((e) => e.name === 'Value').map(textOf).join(''));
    const band = rows.find((r) => cells(r).includes('Name'))!;
    assert.deepEqual(cells(band), ['Name', 'Limit', 'Low', 'High', 'Score', 'Grade', 'Score', 'Score']);
    const above = rows[rows.indexOf(band) - 1]!;
    assert.deepEqual(cells(above).slice(2, 5), ['Latest', 'Latest', 'Latest Run']);
    const background = (row: typeof rows[number]) => textOf(descendants(row).find((e) => e.name === 'BackgroundColor')!);
    assert.equal(background(above).replace(/_First/, ''), background(band).replace(/_First/, ''));
    assert.ok(!descendants(tablix).some((e) => e.name === 'GroupExpression' && textOf(e) === '=1'), 'the heading rows repeat on each page with the band');
  });

  it('calls each procedure of a report as it is', () => {
    const fields = ['name', 'owner_key'];
    const rdl = build([sub(listing('first_rows'), table('first_rows_get', 'storedProcedure', fields), 1), sub(listing('second_rows'), table('second_rows_get', 'storedProcedure', fields), 2)], [[subreport(1)], [subreport(2)]]);
    const queries = descendants(parseXml(rdl)).filter((e) => e.name === 'Query' && /_rows_get/.test(textOf(child(e, 'CommandText'))));
    assert.equal(queries.length, 2);
    for (const q of queries) {
      assert.equal(textOf(child(q, 'CommandType')), 'StoredProcedure');
      assert.match(textOf(child(q, 'CommandText')), /^dbo\.\w+_rows_get$/);
    }
  });

  it('leaves out a hidden field that only sets a variable nothing reads', () => {
    const T = 'rows';
    const setter = { kind: 'formula', name: 'Counted', index: 3, text: `WhilePrintingRecords; shared numbervar counted; counted := 0; counted := {${T}.amount}; counted;`, referencedFields: [`${T}.amount`], valueType: 'number' };
    const def = listing(T, [setter], [], [field('Hidden', '@Counted', 2200, 0, 300, 150, { suppressed: true })]);
    const rdl = build([sub(def, table(T, 'table', ['name', 'amount', 'owner_key']), 1)], [[subreport(1)]]);
    assert.ok(!/<Code>/.test(rdl) && !/Counted/.test(rdl));
  });

  it('gives a date too narrow for its box the room beside it', () => {
    const box = (name: string, value: string, left: number, width: number, format = '') => `<Textbox Name="${name}"><CanGrow>true</CanGrow><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>8pt</FontSize>${format ? `<Format>${format}</Format>` : ''}</Style></TextRun></TextRuns></Paragraph></Paragraphs><Top>0.4in</Top><Left>${left}in</Left><Height>0.19in</Height><Width>${width}in</Width><Style><PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight></Style></Textbox>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems><Rectangle Name="Head"><ReportItems>${box('Label', 'As at:', 9.3, 0.35)}${box('Stamp', '=Parameters!run_date.Value', 9.74, 0.578, "MM'/'dd'/'yyyy")}</ReportItems><Top>0in</Top><Left>0in</Left><Height>0.6in</Height><Width>10.5in</Width></Rectangle></ReportItems><Height>0.6in</Height></Body><Width>10.5in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = parseXml(applyConventions(rdl, 'Parts', conventions).rdl);
    const stamp = descendants(out).find((e) => e.name === 'Textbox' && /=Parameters!run_date/.test(descendants(e).filter((v) => v.name === 'Value').map(textOf).join('')))!;
    const inch = (name: string) => parseFloat(textOf(child(stamp, name)));
    assert.ok(inch('Width') > 0.6, `width ${inch('Width')}`);
    assert.ok(inch('Left') >= 9.65 - 0.001 && inch('Left') + inch('Width') <= 10.5 + 0.001, `left ${inch('Left')}`);
  });

  it('starts text in a cell clear of a rule drawn down over the cell', () => {
    const T = 'facts';
    const def = { ...listing(T), groups: [], formulas: [], layout: [
      { name: 'DetailArea1', sections: [{ name: 'D', height: 1000, objects: [
        text('L1', 'Name:', 0, 120, 1825, 189), field('V1', `${T}.name`, 1870, 120, 2515, 180), text('L2', 'Kind:', 0, 295, 1825, 189), field('V2', `${T}.kind`, 1885, 295, 2515, 180),
        text('R1', 'Opening Amount:', 4530, 120, 2110, 189), field('W1', `${T}.opening`, 6705, 120, 1835, 180),
        text('R2', 'Closing Amount:', 4535, 477, 2110, 189), field('W2', `${T}.closing`, 7755, 477, 795, 180)] }] }] };
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 630, objects: [
        { kind: 'line', name: 'Rule', ...box(4740, 375, 0, 390), border: { sides: [1, 0, 0, 0], width: 20 } },
        { kind: 'subreport', name: 'Sub1', subreport: { index: 2, onDemand: false }, ...box(170, 425, 9040, 205) }] }] }] };
    const converted = convertToRdl(main as never, { connections: [], links: [], tables: [] } as never, { reportName: 'Parts', subreports: new Map([[2, sub(def, table(T, 'table', ['name', 'kind', 'opening', 'closing', 'owner_key']), 1)] as [number, never]]), formulasInQuery: true, rulesAsText: true } as never);
    const doc = parseXml(applyConventions(converted.rdl, 'Parts', conventions).rdl);
    const inches = (e: ReturnType<typeof parseXml>, name: string) => parseFloat(textOf(child(e, name)) || '0');
    let rule = 0;
    const walk = (e: ReturnType<typeof parseXml>, x: number): void => {
      for (const c of e.children) {
        if (typeof c !== 'object' || c === null) continue;
        const k = c as ReturnType<typeof parseXml>;
        if (k.name === 'Line') rule = x + inches(k, 'Left');
        walk(k, ['Rectangle', 'Tablix'].includes(k.name) ? x + inches(k, 'Left') : x);
      }
    };
    walk(descendants(doc).find((e) => e.name === 'Body')!, 0);
    const tablix = descendants(doc).find((e) => e.name === 'Tablix')!;
    let left = 0;
    let parent = descendants(doc).find((e) => e.name === 'ReportItems' && e.children.includes(tablix));
    for (let p = parent && descendants(doc).find((e) => e.name === 'Rectangle' && child(e, 'ReportItems') === parent); p; p = descendants(doc).find((e) => e.name === 'Rectangle' && child(e, 'ReportItems') === parent)) {
      left += inches(p, 'Left');
      parent = descendants(doc).find((e) => e.name === 'ReportItems' && e.children.includes(p!));
    }
    const widths = descendants(tablix).filter((e) => e.name === 'TablixColumn').map((c) => inches(c, 'Width'));
    const label = descendants(tablix).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === 'Opening Amount:'))!;
    const cell = descendants(tablix).filter((e) => e.name === 'TablixCell').findIndex((c) => descendants(c).includes(label));
    const at = left + inches(tablix, 'Left') + widths.slice(0, cell).reduce((a, b) => a + b, 0) + inches(label, 'Left');
    assert.ok(rule > 0 && at > rule, `text at ${at.toFixed(3)}in, rule at ${rule.toFixed(3)}in`);
  });

  it('puts a hairline rule above the text it was drawn over, and boxes a hair over each other side by side', () => {
    const place = (top: number, left: number, height: number, width: number) => `<Top>${top}in</Top><Left>${left}in</Left><Height>${height}in</Height><Width>${width}in</Width>`;
    const box = (name: string, value: string, at: string) => `<Textbox Name="${name}"><CanGrow>true</CanGrow><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>8pt</FontSize></Style></TextRun></TextRuns></Paragraph></Paragraphs>${at}<Style><PaddingLeft>2pt</PaddingLeft></Style></Textbox>`;
    const rule = (name: string, at: string) => `<Rectangle Name="${name}">${at}<Style><Border><Style>None</Style></Border><TopBorder><Style>Solid</Style></TopBorder></Style></Rectangle>`;
    const frame = (name: string, at: string, inner: string) => `<Rectangle Name="${name}"><ReportItems>${inner}</ReportItems>${at}<Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems>${frame('Head', place(0, 0, 3, 10.5), [
      box('Label', 'Stated', place(0.406, 9.3, 0.194, 0.35)),
      rule('Over', place(0.406, 9.3, 0.01, 0.35)),
      frame('Left', place(1, 2.757, 1.5, 4.726), box('In1', 'Left side', place(0, 0, 0.2, 2))),
      frame('Right', place(1, 7.473, 1.5, 2.8), box('In2', 'Right side', place(0, 0.2, 0.2, 2))),
    ].join(''))}</ReportItems><Height>3in</Height></Body><Width>10.5in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = applyConventions(rdl, 'Parts', conventions).rdl;
    assert.ok(!diagnoseRdl(out, true).some((f) => f.kind === 'overlap'), JSON.stringify(diagnoseRdl(out, true).filter((f) => f.kind === 'overlap')));
    assert.match(out, /Stated/);
  });

  it('shows one of the frames drawn in the same place for each value, and draws rules and title bands without overlap', () => {
    const place = (top: number, left: number, height: number, width: number) => `<Top>${top}in</Top><Left>${left}in</Left><Height>${height}in</Height><Width>${width}in</Width>`;
    const hide = (rule: string) => `<Visibility><Hidden>${rule.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Hidden></Visibility>`;
    const guard = (k: number) => `=(CountRows("Rows") > 0) AndAlso (Not IsNothing(Last(Fields!kind.Value, "Rows"))) AndAlso (IIf((Last(Fields!kind.Value, "Rows") <> ${k}), True, False))`;
    const solid = '<Style><Border><Style>Solid</Style></Border></Style>';
    const text = (name: string, value: string, at: string) => `<Textbox Name="${name}"><CanGrow>true</CanGrow><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>8pt</FontSize></Style></TextRun></TextRuns><Style><TextAlign>Center</TextAlign></Style></Paragraph></Paragraphs>${at}</Textbox>`;
    const frame = (name: string, at: string, rule: string, inner = '') => `<Rectangle Name="${name}">${inner ? `<ReportItems>${inner}</ReportItems>` : ''}${at}${rule ? hide(rule) : ''}${solid}</Rectangle>`;
    const items = [
      frame('First', place(0, 2.757, 2.277, 4.716), guard(0), text('T1', 'First view', place(0, 0.1, 0.2, 4.5))),
      `<Rectangle Name="Rule">${place(0, 2.757, 0.01, 4.716)}${hide(`=Not (${guard(1).slice(1)})`)}<Style><Border><Style>None</Style></Border><TopBorder><Style>Solid</Style></TopBorder></Style></Rectangle>`,
      frame('Second', place(0, 2.757, 2.26, 4.716), guard(1), text('T2', 'Second view', place(0, 0.1, 0.2, 4.5))),
      frame('Side', place(0, 7.473, 2.26, 2.822), '', text('T3', 'Beside', place(0, 0.1, 0.2, 2))),
      frame('Whole', place(2.4, 0, 2.25, 10.571), guard(2), text('Title', 'Spread', place(0, 0.073, 0.194, 10.167))),
      frame('Band', place(2.4, 0, 0.163, 10.571), guard(2)),
    ].join('');
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems>${frame('Page', place(0, 0, 5, 10.6), '', items)}</ReportItems><Height>5in</Height></Body><Width>10.6in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = applyConventions(rdl, 'Parts', conventions).rdl;
    assert.ok(!diagnoseRdl(out, true).some((f) => f.kind === 'overlap'), JSON.stringify(diagnoseRdl(out, true).filter((f) => f.kind === 'overlap')));
    const second = descendants(parseXml(out)).filter((e) => e.name === 'Rectangle' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === 'Second view')).pop()!;
    assert.match(textOf(child(second, 'Visibility/Hidden')), /OrElse Not \(\(CountRows/);
    assert.ok(descendants(parseXml(out)).some((e) => e.name === 'Line'), 'the rule is a line');
  });

  it('drops a text box that is always hidden, and the code only it called', () => {
    const box = (name: string, value: string, hidden?: string) => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value></TextRun></TextRuns></Paragraph></Paragraphs>${hidden ? `<Visibility><Hidden>${hidden}</Hidden></Visibility>` : ''}<Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Textbox>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><Code>Public Function Counted() As Object\nReturn 1\nEnd Function</Code><ReportSections><ReportSection><Body><ReportItems><Rectangle Name="Box"><ReportItems>${box('Shown', 'Total')}${box('Never', '=Code.Counted()', '=True')}</ReportItems><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Rectangle></ReportItems><Height>0.2in</Height></Body><Width>1in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = applyConventions(rdl, 'Parts', conventions).rdl;
    assert.ok(!/Counted/.test(out), out);
    assert.match(out, />Total</);
  });
});

