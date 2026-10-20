import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { standaloneParts } from '../src/ssrs/convert.ts';
import { diagnoseRdl } from '../src/ssrs/diagnose.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, childElements, descendants, parseXml, textOf, type XmlElement } from '../src/ssrs/xml.ts';
import { alignToRules } from '../src/ssrs/align.ts';

const conventions = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt', heading: '{T}_{col}_ColTxt', value: '{T}_{col}_ColVal', blank: '{T}_blnk{n}', group: '{S}_grp_{n}' } }));
const styled = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt' }, style: { dataset: 'Theme', command: 'theme_get',
  props: { FontFamily: 'font', FontSize: 'size', Color: 'color', BackgroundColor: 'fill' }, roles: { title: 'Head', heading: 'Col_Head', chartTitle: 'Plot_Head' }, chart: { text: 'Plot', palette: ['Pal_A', 'Pal_B'] } } }));
const empty = { saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [], formulas: [] };
const params = [{ name: 'owner_key', type: 'number' }];
const box = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { width: w, height: h } });
const field = (name: string, f: string, x: number, y: number, w: number, h: number, extra = {}) => ({ kind: 'field', name, field: f, style: { size: 8 }, ...box(x, y, w, h), ...extra });
const text = (name: string, value: string, x: number, y: number, w: number, h: number) => ({ kind: 'text', name, text: value, style: { size: 8, bold: true }, ...box(x, y, w, h) });
const table = (name: string, kind: string, fields: string[]) => ({ connections: [], links: [], tables: [{ alias: name, name, schema: 'dbo', kind, fields: fields.map((n) => ({ name: n, type: /amount|par/.test(n) ? 'number' : 'string' })) }] });
const sub = (definition: object, source: object, n: number) => ({ name: `Part_${n}`, links: [], parameters: ['owner_key'], definition, dataSource: source });
const build = (subs: object[], placed: object[], conv = conventions) => {
  const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
    { name: 'ReportFooterArea1', sections: placed.map((objects, i) => ({ name: `RF${i + 1}`, height: 2000, objects })) }] };
  const converted = convertToRdl(main as never, { connections: [], links: [], tables: [] } as never, { reportName: 'Parts', subreports: new Map(subs.map((s, i) => [i + 2, s] as [number, never])), formulasInQuery: true, rulesAsText: true } as never);
  return applyConventions(converted.rdl, 'Parts', conv).rdl;
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
    assert.deepEqual(cells(above).slice(2, 6), ['Latest', 'Latest', 'Latest', 'Run'], 'a heading over two columns is spread over them, word by word');
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

  it('writes a part as it designs itself, or as the report prints it in its frame', () => {
    const fields = ['name', 'owner_key'];
    const framed = { kind: 'box', name: 'Frame', position: { x: 100, y: 0 }, size: { width: 7000, height: 1900 }, border: { sides: [1, 1, 1, 1], width: 20 } };
    const heading = text('Above', 'Frame heading', 200, 60, 6800, 260);
    const placed = { ...subreport(1), position: { x: 200, y: 400 }, size: { width: 4000, height: 300 }, border: { sides: [1, 1, 1, 1], width: 20 } };
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 2000, objects: [framed, heading, placed] }] }] };
    const models = [{ storage: '', definition: main }, { storage: 'Subdocument 2', definition: listing('first'), dataSource: table('first', 'table', fields) }];
    const write = (format: 'standalone' | 'report') => parseXml(standaloneParts(models as never, 'Parts', { formulasInQuery: true, rulesAsText: true, partsFormat: format, reshape: (rdl, name, extra) => applyConventions(rdl, name, conventions, extra?.prefix, { sqlFunctions: extra?.sqlFunctions }) })[0]!.rdl);
    const alone = write('standalone');
    const inFrame = write('report');
    const shows = (doc: ReturnType<typeof parseXml>, value: string) => descendants(doc).some((e) => e.name === 'Value' && textOf(e) === value);
    assert.ok(!shows(alone, 'Frame heading'));
    assert.ok(shows(inFrame, 'Frame heading'));
    const boxed = (doc: ReturnType<typeof parseXml>) => descendants(doc).filter((e) => e.name === 'Rectangle' && /Solid/.test(textOf(child(e, 'Style/Border/Style')))).length;
    assert.ok(boxed(inFrame) >= 1);
    assert.equal(boxed(alone), 0);
    for (const doc of [alone, inFrame]) assert.ok(descendants(doc).some((e) => e.name === 'Tablix' && descendants(e).some((v) => v.name === 'Value' && /Fields!name\.Value/.test(textOf(v)))));
  });

  it('frames a part sharing its panel with another only around its own content', () => {
    const fields = ['name', 'owner_key'];
    const panel = { kind: 'box', name: 'Panel', position: { x: 0, y: 0 }, size: { width: 15000, height: 1200 }, border: { sides: [1, 1, 1, 1], width: 20 } };
    const heading = text('Above', 'Panel heading', 0, 40, 15000, 260);
    const whole = (n: number, y: number) => ({ ...subreport(n), position: { x: 0, y }, size: { width: 15000, height: 300 } });
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 1000, objects: [panel, heading, whole(1, 400), whole(2, 420)] }] }] };
    const right = listing('second');
    const moved = { ...right, layout: right.layout.map((a) => ({ ...a, sections: a.sections.map((x) => ({ ...x, objects: (x.objects as { position: { x: number; y: number } }[]).map((o) => ({ ...o, position: { x: o.position.x + 8000, y: o.position.y } })) })) })) };
    const models = [{ storage: '', definition: main }, { storage: 'Subdocument 2', definition: listing('first'), dataSource: table('first', 'table', fields) },
      { storage: 'Subdocument 3', definition: moved, dataSource: table('second', 'table', fields) }];
    const parts = standaloneParts(models as never, 'Parts', { formulasInQuery: true, rulesAsText: true, partsFormat: 'report', reshape: (rdl, name, extra) => applyConventions(rdl, name, conventions, extra?.prefix, { sqlFunctions: extra?.sqlFunctions }) });
    assert.equal(parts.length, 2);
    for (const p of parts) {
      const doc = parseXml(p.rdl);
      const inch = (e: XmlElement, name: string) => parseFloat(textOf(child(e, name)));
      const framed = descendants(doc).filter((e) => e.name === 'Rectangle' && /Solid/.test(textOf(child(e, 'Style/Border/Style'))));
      assert.equal(framed.length, 1);
      assert.ok(inch(framed[0]!, 'Width') < 7, `width ${inch(framed[0]!, 'Width')}`);
      assert.ok(descendants(framed[0]!).some((e) => e.name === 'Tablix'));
      const title = descendants(framed[0]!).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === 'Panel heading'))!;
      assert.ok(inch(title, 'Left') + inch(title, 'Width') <= inch(framed[0]!, 'Width') + 0.001);
    }
  });

  it('writes each part a report prints as a report of its own, in print order, named and laid out as the template asks', () => {
    const fields = ['name', 'owner_key'];
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [
        { name: 'RF1', height: 2000, objects: [{ ...subreport(2), position: { x: 0, y: 900 } }, subreport(1, 6200)] },
        { name: 'RF2', height: 0, suppressed: true, objects: [subreport(3)] }] }] };
    const part = (T: string) => ({ definition: listing(T), dataSource: table(T, 'table', fields) });
    const models = [{ storage: '', definition: main }, { storage: 'Subdocument 2', ...part('first') }, { storage: 'Subdocument 3', ...part('second') }, { storage: 'Subdocument 4', ...part('third') }];
    const named = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt' }, dataset: '{S}_Data' }));
    const parts = standaloneParts(models as never, 'Parts', { formulasInQuery: true, rulesAsText: true, reshape: (rdl, name, extra) => applyConventions(rdl, name, named, extra?.prefix, { sqlFunctions: extra?.sqlFunctions }) });
    assert.deepEqual(parts.map((p) => p.fileName), ['Parts_01_first_title.rdl', 'Parts_02_second_title.rdl']);
    for (const [k, p] of parts.entries()) {
      const doc = parseXml(p.rdl);
      const items = descendants(doc);
      assert.ok(!items.some((e) => e.name === 'Subreport'), p.fileName);
      assert.equal(textOf(items.find((e) => e.name === 'PageWidth')), '11in');
      const first = items.find((e) => e.name === 'Rectangle')!;
      assert.ok(first.attributes.Name?.startsWith(`Parts_0${k + 1}_`), first.attributes.Name);
      assert.ok(items.some((e) => e.name === 'Tablix' && e.attributes.Name === `Parts_0${k + 1}_Tab_1`));
      assert.ok(items.some((e) => e.name === 'ReportParameter' && e.attributes.Name === 'owner_key'));
      assert.ok(!diagnoseRdl(p.rdl, true).some((f) => f.kind === 'merge' || f.kind === 'overlap'), p.fileName);
    }
    const names = parts.flatMap((p) => descendants(parseXml(p.rdl)).filter((e) => e.attributes.Name && ['Textbox', 'Tablix', 'Rectangle', 'DataSet'].includes(e.name) && e.attributes.Name !== 'Report_CSS').map((e) => e.attributes.Name!));
    assert.equal(new Set(names).size, names.length, names.filter((n, i) => names.indexOf(n) !== i).join(', '));
  });

  it('names a label printed beside the values of a record as a text, never as a value', () => {
    const fields = ['contact', 'phone', 'due', 'owner_key'];
    const part = { ...empty, parameters: params, selectionFormulas: { record: '{head.owner_key} = {?owner_key}' }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 700, objects: [
        text('L1', 'Contact:', 0, 0, 1500, 200), field('V1', 'head.contact', 1600, 0, 2000, 200),
        text('L2', 'Phone:', 0, 250, 1500, 200), field('V2', 'head.phone', 1600, 250, 2000, 200),
        text('L3', 'Due:', 4000, 0, 1500, 200), field('V3', 'head.due', 5600, 0, 1500, 200)] }] }] };
    const rdl = build([sub(part, table('head', 'table', fields), 1)], [[subreport(1)]]);
    const values = descendants(parseXml(rdl)).filter((e) => e.name === 'Textbox' && /_ColVal$/.test(e.attributes.Name ?? ''));
    assert.ok(values.length >= 3);
    for (const v of values) assert.match(textOf(descendants(v).find((e) => e.name === 'Value')), /!\w+\./, v.attributes.Name);
  });

  it('writes one part for a design placed many times, none for the page bands, each named after its heading', () => {
    const fields = ['name', 'owner_key'];
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 400, objects: [subreport(3)] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [
        { name: 'RF1', height: 2000, objects: [text('Band', 'Band heading', 0, 100, 5000, 250), { ...subreport(1), position: { x: 0, y: 400 } }, { ...subreport(4), position: { x: 0, y: 1200 } }, field('Band2', '@Band2', 0, 1450, 5000, 200), { ...subreport(5), position: { x: 0, y: 1700 } }] }] }], formulas: [{ kind: 'formula', name: 'Band2', index: 1, text: '"Second band"', referencedFields: [] }] };
    const picked = (n: number) => ({ ...listing('first'), selectionFormulas: { record: `{first.owner_key} = ${n}` } });
    const models = [{ storage: '', definition: main },
      { storage: 'Subdocument 2', definition: picked(1), dataSource: table('first', 'table', fields) },
      { storage: 'Subdocument 4', definition: listing('second'), dataSource: table('second', 'table', fields) },
      { storage: 'Subdocument 5', definition: picked(2), dataSource: table('first', 'table', fields) },
      { storage: 'Subdocument 6', definition: listing('third'), dataSource: table('third', 'table', fields) }];
    const parts = standaloneParts(models as never, 'Parts', { formulasInQuery: true, rulesAsText: true, reshape: (rdl, name, extra) => applyConventions(rdl, name, conventions, extra?.prefix, { sqlFunctions: extra?.sqlFunctions }) });
    assert.deepEqual(parts.map((p) => p.fileName), ['Parts_01_Band_heading.rdl', 'Parts_02_Second_band.rdl']);
    assert.match(parts[0]!.review.map((n) => n.message).join(' '), /1 more part/);
  });

  it('gives a bold date at the far side of the body the room up to the page edge', () => {
    const box = (name: string, value: string, left: number, width: number, format = '') => `<Textbox Name="${name}"><CanGrow>false</CanGrow><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>7pt</FontSize><FontWeight>Bold</FontWeight>${format ? `<Format>${format}</Format>` : ''}</Style></TextRun></TextRuns></Paragraph></Paragraphs><Top>0.4in</Top><Left>${left}in</Left><Height>0.19in</Height><Width>${width}in</Width><Style><PaddingLeft>0pt</PaddingLeft><PaddingRight>0pt</PaddingRight></Style></Textbox>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems>${box('Owner', '=Parameters!who.Value', 0, 4.4)}${box('Label', 'As at:', 9.3, 0.35)}${box('Stamp', '=Parameters!run_date.Value', 9.734, 0.52, "MM'/'dd'/'yyyy")}</ReportItems><Height>0.6in</Height></Body><Width>10.6in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = parseXml(applyConventions(rdl, 'Parts', conventions).rdl);
    const stamp = descendants(out).find((e) => e.name === 'Textbox' && /=Parameters!run_date/.test(descendants(e).filter((v) => v.name === 'Value').map(textOf).join('')))!;
    const inch = (name: string) => parseFloat(textOf(child(stamp, name)));
    assert.ok(inch('Width') > 0.55, `width ${inch('Width')}`);
    assert.ok(inch('Left') >= 9.65 - 0.001 && inch('Left') + inch('Width') <= 10.6 + 0.001, `left ${inch('Left')}`);
  });

  it('keeps a chart\'s foot in place when the text above it grows', () => {
    const chart = `<Chart Name="Plot"><ChartCategoryHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartCategoryHierarchy><ChartSeriesHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartSeriesHierarchy><ChartData><ChartSeriesCollection><ChartSeries Name="S"><ChartDataPoints><ChartDataPoint><ChartDataPointValues><Y>=1</Y></ChartDataPointValues></ChartDataPoint></ChartDataPoints></ChartSeries></ChartSeriesCollection></ChartData><ChartAreas><ChartArea Name="Default" /></ChartAreas><Top>0.208in</Top><Left>0in</Left><Height>2.052in</Height><Width>2.75in</Width></Chart>`;
    const title = `<Textbox Name="Caption"><Paragraphs><Paragraph><TextRuns><TextRun><Value>Spread by kind</Value><Style><FontSize>8pt</FontSize></Style></TextRun></TextRuns></Paragraph></Paragraphs><Top>0.052in</Top><Left>0.02in</Left><Height>0.156in</Height><Width>2.7in</Width></Textbox>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems><Rectangle Name="Frame"><ReportItems>${chart}${title}</ReportItems><Top>0in</Top><Left>0in</Left><Height>2.26in</Height><Width>2.76in</Width><Style><Border><Style>Solid</Style></Border></Style></Rectangle></ReportItems><Height>2.3in</Height></Body><Width>3in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = parseXml(applyConventions(rdl, 'Parts', styled).rdl);
    const plot = descendants(out).find((e) => e.name === 'Chart')!;
    const frame = descendants(out).find((e) => e.name === 'Rectangle' && descendants(e).includes(plot) && /Solid/.test(textOf(child(e, 'Style/Border/Style'))))!;
    const foot = parseFloat(textOf(child(plot, 'Top'))) + parseFloat(textOf(child(plot, 'Height')));
    assert.ok(Math.abs(foot - 2.26) < 0.002, `chart ends ${foot}`);
    assert.ok(Math.abs(parseFloat(textOf(child(frame, 'Height'))) - 2.26) < 0.002, `frame ${textOf(child(frame, 'Height'))}`);
  });

  it('puts a value on its label\'s line when it sits a hair lower', () => {
    const box = (name: string, value: string, top: number, left: number) => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>${top}in</Top><Left>${left}in</Left><Height>0.16in</Height><Width>1.2in</Width></Textbox>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems><Rectangle Name="Pairs"><ReportItems>${box('First', 'Starts:', 0.1, 0)}${box('FirstValue', '=Parameters!a.Value', 0.112, 1.3)}${box('Second', 'Ends:', 0.4, 0)}${box('SecondValue', '=Parameters!b.Value', 0.46, 1.3)}</ReportItems><Top>0in</Top><Left>0in</Left><Height>0.7in</Height><Width>3in</Width></Rectangle></ReportItems><Height>0.7in</Height></Body><Width>3in</Width><Page /></ReportSection></ReportSections></Report>`;
    const out = parseXml(applyConventions(rdl, 'Parts', conventions).rdl);
    const topOf = (value: string) => parseFloat(textOf(child(descendants(out).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === value))!, 'Top')));
    assert.equal(topOf('=Parameters!a.Value'), topOf('Starts:'));
    assert.ok(Math.abs(topOf('=Parameters!b.Value') - topOf('Ends:') - 0.06) < 0.001);
  });

  it('trims a box running a hair into the one under it back to touch it', () => {
    const inner = (name: string, height: number) => `<Rectangle Name="${name}"><ReportItems><Textbox Name="${name}_T"><Paragraphs><Paragraph><TextRuns><TextRun><Value>x</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Textbox></ReportItems><Top>0in</Top><Left>0in</Left><Height>${height}in</Height><Width>5in</Width><Style><Border><Style>Solid</Style></Border></Style></Rectangle>`;
    const row = (name: string, top: number, height: number, content: number) => `<Rectangle Name="${name}"><ReportItems>${inner(`${name}_In`, content)}</ReportItems><Top>${top}in</Top><Left>0in</Left><Height>${height}in</Height><Width>5in</Width></Rectangle>`;
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems>${row('Upper', 0, 1.761, 1.76)}${row('Lower', 1.76, 1.8, 1.8)}</ReportItems><Height>3.6in</Height></Body><Width>5in</Width><Page /></ReportSection></ReportSections></Report>`;
    const { rdl: out, review } = applyConventions(rdl, 'Parts', conventions);
    const doc = parseXml(out);
    const holder = descendants(doc).find((e) => e.name === 'ReportItems' && descendants(e).filter((c) => c.name === 'Rectangle' && e.children.includes(c)).length === 2)!;
    const [upper, lower] = descendants(holder).filter((c) => c.name === 'Rectangle' && holder.children.includes(c));
    const top = (e: typeof upper) => parseFloat(textOf(child(e, 'Top')));
    const reach = (e: typeof upper) => top(e) + parseFloat(textOf(child(e, 'Height')));
    assert.ok(reach(upper!) <= top(lower!) + 0.0001, `upper ends ${reach(upper!)}, lower starts ${top(lower!)}`);
    assert.ok(!review.some((n) => /drawn over each other/.test(n.message)));
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

  it('styles charts, their colours and their titles from the style dataset', () => {
    const T = 'chart_rows';
    const def = { ...empty, parameters: params, groups: [`${T}.label`], formulas: [{ kind: 'internal', name: 'Group #1 Order', index: 2, text: `if IsNull ({${T}.label}) then 2 else 2`, referencedFields: [`${T}.label`] },
      { kind: 'conditionalFormat', name: 'None', index: 3, text: `Count ({${T}.amount}) = 0`, referencedFields: [`${T}.amount`] }],
      layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: 3200, objects: [
        { kind: 'chart', name: 'Bars', ...box(0, 15, 4000, 3000), chart: { family: 0, graphType: 0, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label` } },
        field('Heading', '@Head', 30, 75, 3900, 225, { conditions: { suppress: { name: 'None', index: 3 } } })] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] }] };
    def.formulas.push({ kind: 'formula', name: 'Head', index: 4, text: '"Spread by label"', referencedFields: [] } as never);
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 300, objects: [{ ...subreport(1, 180), ...box(180, 40, 3970, 210), border: { sides: [1, 1, 1, 1], width: 20 } }] }] }] };
    const converted = convertToRdl(main as never, { connections: [], links: [], tables: [] } as never, { reportName: 'Parts', subreports: new Map([[2, sub(def, table('chart_rows_get', 'storedProcedure', ['label', 'amount']), 1)]] as [number, never][]), formulasInQuery: true, rulesAsText: true } as never);
    const out = applyConventions(converted.rdl, 'Parts', styled).rdl;
    const doc = parseXml(out);
    const colors = descendants(doc).filter((e) => e.name === 'ChartCustomPaletteColor').map(textOf);
    assert.deepEqual(colors, ['=First(Fields!Pal_A_fill.Value, "Theme")', '=First(Fields!Pal_B_fill.Value, "Theme")']);
    assert.match(out, /<Color>=Choose\(\(RunningValue\(Fields!label\.Value, CountDistinct, Nothing\) - 1\) Mod 2 \+ 1, First\(Fields!Pal_A_fill\.Value, "Theme"\), First\(Fields!Pal_B_fill\.Value, "Theme"\)\)</);
    const axis = descendants(doc).find((e) => e.name === 'ChartAxis')!;
    assert.equal(textOf(child(axis, 'Style/FontFamily')), '=First(Fields!Plot_font.Value, "Theme")');
    const heading = descendants(doc).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && /Spread by label/.test(textOf(v))))!;
    assert.equal(textOf(child(heading, 'Style/BackgroundColor')), '=First(Fields!Plot_Head_fill.Value, "Theme")');
    assert.match(textOf(child(heading, 'Visibility/Hidden')), /CountRows\("[^"]+"\) = 0/);
    assert.ok(!/Count\(Fields!amount/.test(textOf(child(heading, 'Visibility/Hidden'))));
    const chart = descendants(doc).find((e) => e.name === 'Chart')!;
    const len = (e: typeof chart, n: string) => Number(textOf(child(e, n)).replace('in', ''));
    assert.ok(len(chart, 'Top') >= len(heading, 'Top') + len(heading, 'Height') - 0.001, 'the chart starts under its title band');
    assert.ok(!diagnoseRdl(out, true).some((f) => f.kind === 'overlap'), JSON.stringify(diagnoseRdl(out, true).filter((f) => f.kind === 'overlap')));
  });

  it('paints a chart title band only while its chart is shown', () => {
    const T = 'chart_rows';
    const def = { ...empty, parameters: params, groups: [`${T}.label`], formulas: [{ kind: 'internal', name: 'Group #1 Order', index: 2, text: `if IsNull ({${T}.label}) then 2 else 2`, referencedFields: [`${T}.label`] }],
      layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: 3200, objects: [
        { kind: 'chart', name: 'Bars', ...box(0, 15, 4000, 3000), chart: { family: 0, graphType: 0, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label` } },
        field('Heading', `${T}.label`, 30, 75, 3900, 225)] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] }] };
    const main = { ...empty, parameters: params, page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 300, objects: [{ ...subreport(1, 180), ...box(180, 40, 3970, 210), border: { sides: [1, 1, 1, 1], width: 20 } }] }] }] };
    const converted = convertToRdl(main as never, { connections: [], links: [], tables: [] } as never, { reportName: 'Parts', subreports: new Map([[2, sub(def, table('chart_rows_get', 'storedProcedure', ['label', 'amount']), 1)]] as [number, never][]), formulasInQuery: true, rulesAsText: true } as never);
    const doc = parseXml(applyConventions(converted.rdl, 'Parts', styled).rdl);
    const chart = descendants(doc).find((e) => e.name === 'Chart')!;
    const heading = descendants(doc).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && /Fields!label/.test(textOf(v))))!;
    const hide = textOf(child(chart, 'Visibility/Hidden'));
    assert.match(hide, /CountRows/);
    assert.equal(textOf(child(heading, 'Style/BackgroundColor')), `=IIf(${hide.slice(1)}, "White", First(Fields!Plot_Head_fill.Value, "Theme"))`);
    const holder = descendants(doc).filter((e) => e.name === 'Rectangle' && childElements(child(e, 'ReportItems') ?? e).includes(heading))[0]!;
    assert.ok(Math.abs(Number(textOf(child(heading, 'Width')).replace('in', '')) - Number(textOf(child(holder, 'Width')).replace('in', ''))) < 0.001, `${textOf(child(heading, 'Width'))} ${textOf(child(holder, 'Width'))}`);
  });

  it('keeps a heading written as two text objects one over the other to its two lines', () => {
    const T = 'notes';
    const heads = [text('Upper', 'Expected Amount Owing', 2200, 40, 1665, 240), text('Lower', 'by the Following Date', 2200, 235, 1620, 240), text('Plain', 'Balance', 4000, 115, 1300, 240)];
    const def = listing(T, [], heads, [field('V2', `${T}.amount`, 2200, 0, 1620, 180), field('V3', `${T}.par`, 4000, 0, 1300, 180)]);
    const rdl = build([sub(def, table(T, 'table', ['name', 'amount', 'par', 'owner_key']), 1)], [[subreport(1)]], styled);
    const row = descendants(parseXml(rdl)).find((e) => e.name === 'TablixRow' && descendants(e).some((v) => v.name === 'Value' && /Expected/.test(textOf(v))))!;
    assert.ok(Number(textOf(child(row, 'Height')).replace('in', '')) < 0.5, textOf(child(row, 'Height')));
  });

  it('stacks two framed parts shown together under one choice beside the part shown otherwise, as one row of frames', () => {
    const chartPart = (T: string, rh: number) => ({ ...empty, parameters: params, groups: [`${T}.label`],
      formulas: [{ kind: 'internal', name: 'Group #1 Order', index: 2, text: `if IsNull ({${T}.label}) then 2 else 2`, referencedFields: [`${T}.label`] }],
      layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH1', height: rh, objects: [{ kind: 'chart', name: 'Bars', ...box(15, 15, 3945, rh - 30), chart: { family: 0, graphType: 0, values: [`Sum of ${T}.amount`], onChangeOf: `${T}.label` } }] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] }] });
    const framed = (n: number, x: number, y: number, rule: number) => ({ kind: 'subreport', name: `Sub${n}`, subreport: { index: n + 1, onDemand: false }, ...box(x, y, 6745, 200), border: { sides: [1, 1, 1, 1], width: 20 }, conditions: { suppress: { name: `S${rule}`, index: 10 + rule } } });
    const main = { ...empty, parameters: params, formulas: [0, 1].map((k) => ({ kind: 'conditionalFormat', name: `S${k}`, index: 10 + k, text: `if {head.flag} <> ${k} then true`, referencedFields: ['head.flag'] })), page: { orientation: 'landscape', paperSize: 1 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF1', height: 2070, objects: [framed(1, 0, 40, 0), framed(2, 0, 40, 1), framed(3, 0, 1815, 1),
        { kind: 'subreport', name: 'Sub4', subreport: { index: 5, onDemand: false }, ...box(6800, 40, 3900, 200), border: { sides: [1, 1, 1, 1], width: 20 } }] }] }] };
    const parts = [chartPart('one_rows', 3240), chartPart('two_rows', 1710), chartPart('three_rows', 1710), chartPart('four_rows', 3240)]
      .map((d, i) => sub(d, table(['one_rows', 'two_rows', 'three_rows', 'four_rows'][i]!, 'table', ['label', 'amount', 'owner_key']), i + 1));
    const converted = convertToRdl(main as never, table('head', 'table', ['flag', 'owner_key']) as never, { reportName: 'Parts', subreports: new Map(parts.map((p, i) => [i + 2, p] as [number, never])), formulasInQuery: true, rulesAsText: true } as never);
    const rdl = applyConventions(converted.rdl, 'Parts', conventions).rdl;
    assert.ok(!diagnoseRdl(rdl, true).some((f) => f.kind === 'overlap'), JSON.stringify(diagnoseRdl(rdl, true).filter((f) => f.kind === 'overlap')));
    const frames = descendants(parseXml(rdl)).filter((e) => e.name === 'Rectangle' && descendants(e).some((c) => c.name === 'Chart') && /flag/.test(textOf(child(e, 'Visibility/Hidden'))));
    const at = (e: typeof frames[number], n: string) => Number(textOf(child(e, n)).replace('in', ''));
    const shownTogether = frames.filter((e) => /<> 1/.test(textOf(child(e, 'Visibility/Hidden')))).sort((a, b) => at(a, 'Top') - at(b, 'Top'));
    assert.equal(shownTogether.length, 2);
    assert.ok(at(shownTogether[1]!, 'Top') >= at(shownTogether[0]!, 'Top') + at(shownTogether[0]!, 'Height') - 0.001, 'the second sits under the first');
    const otherwise = frames.find((e) => !shownTogether.includes(e))!;
    assert.ok(at(shownTogether[1]!, 'Top') - at(shownTogether[0]!, 'Top') - at(shownTogether[0]!, 'Height') < 0.3, 'and stays right under it');
    assert.ok(at(shownTogether[0]!, 'Top') >= at(otherwise, 'Top') + at(otherwise, 'Height') - 0.001 || at(otherwise, 'Top') >= at(shownTogether[1]!, 'Top') + at(shownTogether[1]!, 'Height') - 0.001, 'the frame shown otherwise drawn clear of them');
  });

  it('settles the notes about a page header it leaves out', () => {
    const rdl = `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems><Textbox Name="T"><Paragraphs><Paragraph><TextRuns><TextRun><Value>x</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Textbox></ReportItems><Height>0.2in</Height></Body><Width>1in</Width><Page><PageHeader><Height>0.3in</Height><PrintOnFirstPage>true</PrintOnFirstPage><PrintOnLastPage>true</PrintOnLastPage><ReportItems><Textbox Name="H"><Paragraphs><Paragraph><TextRuns><TextRun><Value>Head</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Textbox></ReportItems></PageHeader></Page></ReportSection></ReportSections></Report>`;
    const { settles } = applyConventions(rdl, 'Parts', conventions);
    assert.ok(settles?.test('Page header') && settles!.test('subreport object "Part" in Page Header (page 1)'));
    assert.ok(!settles!.test('subreport object "Part" in Report Footer'));
  });

  it('keeps a short row that only carries the column rules down tall enough to find in the designer', () => {
    const T = 'tests';
    const up = (name: string, x: number) => ({ kind: 'line', name, ...box(x, 360, 0, 1543), border: { sides: [1, 0, 0, 0], width: 20 } });
    const def = listing(T, [], [up('L1', 2100), up('L2', 4100)], [field('V2', `${T}.amount`, 2200, 0, 1800, 180)]);
    def.layout[0]!.sections = [{ name: 'RH1', height: 0, suppressed: true, objects: [] }] as never;
    def.layout[2]!.sections[0] = { name: 'GH1', height: 915, objects: [{ kind: 'box', name: 'Frame', ...box(45, 25, 6000, 1895), border: { sides: [1, 1, 1, 1], width: 20 } }, text('H1', 'Name', 120, 480, 1900, 210), text('H2', 'Amount', 2200, 480, 1800, 210), up('L1', 2100), up('L2', 4100)] } as never;
    def.layout[3]!.sections[0] = { name: 'GF1', height: 100, objects: [] } as never;
    const rdl = build([sub(def, table(T, 'table', ['name', 'amount', 'owner_key']), 1)], [[subreport(1)]]);
    assert.ok(!diagnoseRdl(rdl, true).some((f) => f.kind === 'empty row'), JSON.stringify(diagnoseRdl(rdl, true).filter((f) => f.kind === 'empty row')));
  });
});


describe('edges lined up', () => {
  const doc = (items: string) => `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems><Line Name="Rule"><Top>0in</Top><Left>0in</Left><Height>0in</Height><Width>10in</Width><Style><Border><Style>Solid</Style></Border></Style></Line>${items}</ReportItems><Height>4in</Height></Body><Width>10in</Width><Page /></ReportSection></ReportSections></Report>`;
  const box = (name: string, left: number, top: number, width: number, height: number, inner = '', border = 'Solid', extra = '') => `<Rectangle Name="${name}"><ReportItems>${inner}</ReportItems><Top>${top}in</Top><Left>${left}in</Left><Height>${height}in</Height><Width>${width}in</Width>${extra}<Style><Border><Style>${border}</Style></Border></Style></Rectangle>`;
  const cell = (name: string) => `<TablixCell><CellContents><Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${name}</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell>`;
  const table = (name: string, widths: number[]) => `<Tablix Name="${name}"><TablixBody><TablixColumns>${widths.map((w) => `<TablixColumn><Width>${w}in</Width></TablixColumn>`).join('')}</TablixColumns><TablixRows><TablixRow><Height>0.2in</Height><TablixCells>${widths.map((_, k) => cell(`${name}_${k}`)).join('')}</TablixCells></TablixRow></TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers>${widths.map(() => '<TablixMember />').join('')}</TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember /></TablixMembers></TablixRowHierarchy><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>${widths.reduce((a, b) => a + b, 0)}in</Width></Tablix>`;
  const at = (out: ReturnType<typeof parseXml>, name: string) => descendants(out).find((e) => e.attributes.Name === name)!;
  const num = (e: ReturnType<typeof parseXml>, prop: string) => parseFloat(textOf(child(e, prop)));

  it('takes a table and a ruled title in a frame to the frame\'s right side, the table a border short of it', () => {
    const ruled = `<Textbox Name="Heading"><Paragraphs><Paragraph><TextRuns><TextRun><Value>Heading</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>9.7in</Width><Style><BottomBorder><Style>Solid</Style></BottomBorder></Style></Textbox>`;
    const out = parseXml(doc(box('Frame', 0, 0.1, 10, 2, ruled + box('Holder', 6, 0.3, 3.6, 1, table('Grid', [1.5, 2, 0.01]), 'None'))));
    alignToRules(out);
    assert.equal(num(at(out, 'Heading'), 'Width'), 10);
    const widths = childElements(child(at(out, 'Grid'), 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => num(c, 'Width'));
    assert.equal(widths[2], 0.01);
    assert.ok(Math.abs(6 + widths.reduce((a, b) => a + b, 0) - (10 - 1 / 72)) < 0.002, widths.join(' '));
  });

  it('starts a row of frames at the rule\'s left end, a frame in the same place moving with its twin', () => {
    const hidden = '<Visibility><Hidden>=Parameters!k.Value = 1</Hidden></Visibility>';
    const out = parseXml(doc(box('Row', 0.12, 0.2, 9.88, 2, box('First', 0, 0, 3, 2) + box('FirstEmpty', 0, 0, 3, 2, '', 'Solid', hidden) + box('Second', 3, 0, 6.88, 2), 'None')));
    alignToRules(out);
    assert.ok(num(at(out, 'Row'), 'Left') < 0.001);
    assert.ok(Math.abs(num(at(out, 'First'), 'Width') - 3.12) < 0.002);
    assert.equal(textOf(child(at(out, 'FirstEmpty'), 'Width')), textOf(child(at(out, 'First'), 'Width')));
    assert.equal(textOf(child(at(out, 'FirstEmpty'), 'Left')), textOf(child(at(out, 'First'), 'Left')));
    assert.ok(Math.abs(num(at(out, 'Row'), 'Left') + num(at(out, 'Second'), 'Left') - 3.12) < 0.002);
  });
});

describe('spacing and edges in the template', () => {
  const doc = (items: string, height = 3) => `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><ReportSections><ReportSection><Body><ReportItems>${items}</ReportItems><Height>${height}in</Height></Body><Width>10.5in</Width><Page /></ReportSection></ReportSections></Report>`;
  const text = (name: string, value: string, left: number, top: number, width: number, height: number, style = '') => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>8pt</FontSize></Style></TextRun></TextRuns></Paragraph></Paragraphs><Top>${top}in</Top><Left>${left}in</Left><Height>${height}in</Height><Width>${width}in</Width><Style>${style}</Style></Textbox>`;
  const box = (name: string, left: number, top: number, width: number, height: number, inner: string, style = '<Border><Style>None</Style></Border>') => `<Rectangle Name="${name}"><ReportItems>${inner}</ReportItems><Top>${top}in</Top><Left>${left}in</Left><Height>${height}in</Height><Width>${width}in</Width><Style>${style}</Style></Rectangle>`;
  const valued = (out: ReturnType<typeof parseXml>, value: string) => descendants(out).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === value))!;
  const holderOf = (out: ReturnType<typeof parseXml>, inner: ReturnType<typeof parseXml>) => descendants(out).filter((e) => e.name === 'Rectangle' && descendants(e).includes(inner)).pop()!;
  const num = (e: ReturnType<typeof parseXml>, prop: string) => parseFloat(textOf(child(e, prop)));

  it('keeps lines placed one under another at their own spacing, each grown to a line', () => {
    const lines = [0.75, 0.917, 1.083].map((top, k) => text(`Line${k}`, `=Parameters!line${k}.Value`, 0.1, top, 4.4, 0.125)).join('');
    const out = parseXml(applyConventions(doc(lines), 'Parts', styled).rdl);
    const tops = [0, 1, 2].map((k) => { const tb = valued(out, `=Parameters!line${k}.Value`); return { top: descendants(out).filter((e) => e.name === 'Rectangle' && descendants(e).includes(tb)).reduce((a, r) => a + num(r, 'Top'), 0) + num(tb, 'Top'), height: num(tb, 'Height') }; });
    assert.ok(Math.abs(tops[1]!.top - tops[0]!.top - 0.167) < 0.003 && Math.abs(tops[2]!.top - tops[1]!.top - 0.166) < 0.003, JSON.stringify(tops));
    assert.ok(tops.every((t) => t.height >= 0.159), JSON.stringify(tops));
  });

  it('starts a side border drawn as a divider at the rule above it', () => {
    const title = text('Heading', 'Heading', 0, 0, 10, 0.233, '<BottomBorder><Style>Solid</Style></BottomBorder>');
    const parted = box('Parted', 0, 0.035, 6, 1, text('Note', 'Note', 0, 0, 2, 0.2), '<Border><Style>None</Style></Border><RightBorder><Style>Solid</Style></RightBorder>');
    const out = parseXml(applyConventions(doc(box('Frame', 0, 0, 10.4, 1.4, title + box('Inner', 0, 0.233, 10, 1.1, parted), '<Border><Style>Solid</Style></Border>')), 'Parts', styled).rdl);
    const note = valued(out, 'Note');
    const side = descendants(out).find((e) => e.name === 'Rectangle' && /Solid/.test(textOf(child(e, 'Style/RightBorder/Style'))) && descendants(e).includes(note))!;
    assert.ok(num(side, 'Top') < 0.001, textOf(child(side, 'Top')));
    assert.ok(num(note, 'Top') >= 0.034, textOf(child(note, 'Top')));
  });

  const grid = (name: string, widths: number[], right = -1) => {
    const cells = widths.map((_, k) => `<TablixCell><CellContents><Textbox Name="${name}_${k}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${k < widths.length - 2 ? `=Fields!f${k}.Value` : ''}</Value></TextRun></TextRuns></Paragraph></Paragraphs><Style>${k === right ? '<RightBorder><Style>Solid</Style></RightBorder>' : ''}</Style></Textbox></CellContents></TablixCell>`).join('');
    return `<Tablix Name="${name}"><TablixBody><TablixColumns>${widths.map((w) => `<TablixColumn><Width>${w}in</Width></TablixColumn>`).join('')}</TablixColumns><TablixRows><TablixRow><Height>0.2in</Height><TablixCells>${cells}</TablixCells></TablixRow></TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers>${widths.map(() => '<TablixMember />').join('')}</TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember><Group Name="${name}_Rows" /></TablixMember></TablixMembers></TablixRowHierarchy><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>${widths.reduce((a, w) => a + w, 0)}in</Width></Tablix>`;
  };

  it('starts a table column a little clear of a rule drawn down over its first letters', () => {
    const line = '<Line Name="Divider"><Top>0in</Top><Left>3.12in</Left><Height>1.5in</Height><Width>0in</Width><Style><Border><Style>Solid</Style></Border></Style></Line>';
    const out = parseXml(applyConventions(doc(box('Holder', 0, 0, 10, 1.6, line + box('Part', 0, 0, 6.3, 1.5, grid('Facts', [1.3, 1.786, 1.5, 0.01, 0.01])))), 'Parts', styled).rdl);
    const t = descendants(out).find((e) => e.name === 'Tablix')!;
    const widths = childElements(child(t, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => num(c, 'Width'));
    assert.ok(widths[0]! + widths[1]! >= 3.12 + 0.059, widths.join(' '));
  });

  it('draws a table\'s right border at its edge, past its thin spare columns, so its bands end there', () => {
    const fields = ['name', 'owner_key'];
    const framed = listing('second', [], [], []);
    const detail = framed.layout.find((a) => a.name === 'DetailArea1')!.sections[0]!;
    detail.objects = [field('V1', 'second.name', 0, 0, 2000, 180, { border: { sides: [1, 1, 1, 1], width: 20 } })];
    const wide = listing('first', [], [{ kind: 'text', name: 'H2', text: 'Amount', style: { size: 8, bold: true }, position: { x: 2200, y: 200 }, size: { width: 1800, height: 200 } }], [field('V2', 'first.amount', 2200, 0, 1800, 180)]);
    const rdl = build([sub(wide, table('first', 'table', ['name', 'amount', 'owner_key']), 1), sub(framed, table('second', 'table', fields), 2)], [[subreport(1)], [subreport(2)]], styled);
    const second = descendants(parseXml(rdl)).filter((e) => e.name === 'Tablix')[1]!;
    const widths = childElements(child(second, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => parseFloat(textOf(child(c, 'Width'))));
    assert.ok(widths[widths.length - 1]! < 0.011, widths.join(' '));
    const row = descendants(second).filter((e) => e.name === 'TablixRow').find((r) => descendants(r).some((e) => e.name === 'Value' && /second|name/.test(textOf(e))))!;
    const cells = descendants(row).filter((e) => e.name === 'TablixCell');
    const style = (c: ReturnType<typeof parseXml>) => descendants(c).find((e) => e.name === 'Textbox' && child(e, 'Style')) && child(descendants(c).find((e) => e.name === 'Textbox')!, 'Style');
    assert.match(textOf(child(style(cells[cells.length - 1]!) ?? parseXml('<x/>'), 'RightBorder/Style')), /Solid/);
    assert.match(textOf(child(style(cells[0]!) ?? parseXml('<x/>'), 'RightBorder/Style')), /None/);
  });

  it('gives a short heading of a few words the room to print on one line', () => {
    const T = 'tests';
    const head = (name: string, value: string, x: number) => ({ kind: 'text', name, text: value, style: { size: 8, bold: true }, position: { x, y: 200 }, size: { width: 600, height: 200 } });
    const def = listing(T, [], [head('H2', 'Current Report', 3200), head('H3', 'Grade', 3900)], [field('V2', `${T}.score`, 3200, 0, 600, 180), field('V3', `${T}.grade`, 3900, 0, 600, 180)]);
    const rdl = build([sub(def, table(T, 'table', ['name', 'score', 'grade', 'owner_key']), 1)], [[subreport(1)]], styled);
    const t = descendants(parseXml(rdl)).find((e) => e.name === 'Tablix')!;
    const heading = descendants(t).find((e) => e.name === 'Textbox' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === 'Current Report'))!;
    const row = descendants(t).filter((e) => e.name === 'TablixRow').find((r) => descendants(r).includes(heading))!;
    const cells = descendants(row).filter((e) => e.name === 'TablixCell');
    const k = cells.findIndex((c) => descendants(c).includes(heading));
    const widths = childElements(child(t, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => num(c, 'Width'));
    assert.ok(widths[k]! >= 0.85, widths.join(' '));
  });

  it('keeps a date grown towards its label a little apart from it', () => {
    const label = text('Label', 'As at:', 9.3, 0.4, 0.35, 0.19, '<PaddingLeft>0pt</PaddingLeft><PaddingRight>0pt</PaddingRight>');
    const stamp = text('Stamp', '=Parameters!run_date.Value', 9.7, 0.4, 0.5, 0.19, '<PaddingLeft>0pt</PaddingLeft><PaddingRight>0pt</PaddingRight>').replace('<FontSize>8pt</FontSize>', "<FontSize>8pt</FontSize><Format>MM'/'dd'/'yyyy</Format>");
    const report = doc(box('Head', 0, 0, 10.2, 0.6, label + stamp)).replace('<Width>10.5in</Width>', '<Width>10.2in</Width>');
    const out = parseXml(applyConventions(report, 'Parts', conventions).rdl);
    assert.ok(num(valued(out, '=Parameters!run_date.Value'), 'Left') >= 9.689, textOf(child(valued(out, '=Parameters!run_date.Value'), 'Left')));
  });

  it('notes charts left in their own colours when the conventions give charts no style', () => {
    const chart = `<Chart Name="Plot"><ChartCategoryHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartCategoryHierarchy><ChartSeriesHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartSeriesHierarchy><ChartData><ChartSeriesCollection><ChartSeries Name="S"><ChartDataPoints><ChartDataPoint><ChartDataPointValues><Y>=1</Y></ChartDataPointValues></ChartDataPoint></ChartDataPoints></ChartSeries></ChartSeriesCollection></ChartData><ChartAreas><ChartArea Name="Default" /></ChartAreas><Top>0in</Top><Left>0in</Left><Height>2in</Height><Width>3in</Width></Chart>`;
    const plain = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt' }, style: { dataset: 'Theme', command: 'theme_get', props: { BackgroundColor: 'fill' }, roles: { title: 'Head' } } }));
    assert.ok(applyConventions(doc(chart), 'Parts', plain).review.some((n) => /Charts \(1\)/.test(n.item) && /style\.chart/.test(n.message)));
    assert.ok(!applyConventions(doc(chart), 'Parts', styled).review.some((n) => /Charts \(/.test(n.item)));
  });

  it('lines up a framed box with the framed box just over it', () => {
    const upper = box('Upper', 0, 0, 4.716, 1.41, text('A', 'Upper text', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>');
    const lower = box('Lower', 0.042, 1.41, 4.674, 1.2, text('B', 'Lower text', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>');
    const out = parseXml(applyConventions(doc(box('Column', 0.2, 0.2, 4.8, 2.7, upper + lower)), 'Parts', styled).rdl);
    const a = holderOf(out, valued(out, 'Upper text'));
    const b = holderOf(out, valued(out, 'Lower text'));
    assert.equal(textOf(child(b, 'Left')), textOf(child(a, 'Left')));
    assert.equal(textOf(child(b, 'Width')), textOf(child(a, 'Width')));
  });

  it('draws boxes shown one at a time one under another in a box of their own, what lay under them moving down', () => {
    const hide = (n: number) => `<Visibility><Hidden>=Parameters!pick.Value = ${n}</Hidden></Visibility>`;
    const one = box('One', 2, 0, 4, 2, text('A', 'First choice', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>').replace('</ReportItems>', `</ReportItems>${hide(1)}`);
    const two = box('Two', 2, 0, 4, 1.5, text('B', 'Second choice', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>').replace('</ReportItems>', `</ReportItems>${hide(2)}`);
    const side = box('Side', 0, 0, 1.9, 2, text('C', 'Beside', 0.1, 0.1, 1.5, 0.2), '<Border><Style>Solid</Style></Border>');
    const under = box('Under', 0, 2.1, 6, 0.5, text('D', 'Below', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>');
    const out = parseXml(applyConventions(doc(box('Area', 0, 0, 6.2, 2.7, one + two + side + under), 3), 'Parts', styled).rdl);
    const a = holderOf(out, valued(out, 'First choice'));
    const b = holderOf(out, valued(out, 'Second choice'));
    const set = descendants(out).find((e) => e.name === 'Rectangle' && childElements(child(e, 'ReportItems') ?? e).includes(a))!;
    assert.ok(childElements(child(set, 'ReportItems')!).includes(b));
    assert.ok(Math.abs(num(b, 'Top') - num(a, 'Top') - num(a, 'Height')) < 0.002, `${textOf(child(a, 'Height'))} ${textOf(child(b, 'Top'))}`);
    assert.ok(!child(set, 'Visibility'));
    const low = holderOf(out, valued(out, 'Below'));
    assert.ok(num(low, 'Top') >= num(set, 'Top') + num(set, 'Height') - 0.001, `${textOf(child(low, 'Top'))} ${textOf(child(set, 'Height'))}`);
    assert.ok(Math.abs(num(holderOf(out, valued(out, 'Beside')), 'Top') - num(set, 'Top')) < 0.002);
  });

  it('splits a one-record table at a divider drawn through it, so the divider is a side that grows with the list beside it', () => {
    const title = text('Heading', 'Heading', 0, 0, 10, 0.233, '<BottomBorder><Style>Solid</Style></BottomBorder>');
    const cells = ['=Fields!f0.Value', '=Fields!f1.Value', '=Fields!f2.Value'].map((v, k) => `<TablixCell><CellContents><Textbox Name="Pair_${k}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${v}</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell>`).join('');
    const pair = `<Tablix Name="Pair"><TablixBody><TablixColumns>${[1.5, 1.5, 2].map((w) => `<TablixColumn><Width>${w}in</Width></TablixColumn>`).join('')}</TablixColumns><TablixRows><TablixRow><Height>1in</Height><TablixCells>${cells}</TablixCells></TablixRow></TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers><TablixMember /><TablixMember /><TablixMember /></TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember><Group Name="Pair_Rows" /></TablixMember></TablixMembers></TablixRowHierarchy><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>1in</Height><Width>5in</Width></Tablix>`;
    const rule = '<Line Name="Upright"><Top>0in</Top><Left>2.95in</Left><Height>1.2in</Height><Width>0in</Width><Style><Border><Style>Solid</Style></Border></Style></Line>';
    const listed = box('Listed', 5.01, 0, 4.9, 0.6, grid('Entries', [2, 1.5]), '<Border><Style>None</Style></Border><LeftBorder><Style>Solid</Style></LeftBorder>');
    const out = parseXml(applyConventions(doc(box('Frame', 0, 0, 10.4, 1.733, title + box('Inner', 0, 0.233, 10, 1.5, rule + box('Left', 0, 0, 5, 1.5, pair) + listed), '<Border><Style>Solid</Style></Border>')), 'Parts', styled).rdl);
    assert.ok(!descendants(out).some((e) => e.name === 'Line' && num(e, 'Height') > 0.5), 'the divider is no longer a line of fixed length');
    const tables = descendants(out).filter((e) => e.name === 'Tablix' && descendants(e).some((d) => d.name === 'Value' && /Fields!f\d/.test(textOf(d))));
    assert.equal(tables.length, 2, 'the table is cut in two at the divider');
    const right = tables.find((e) => descendants(e).some((d) => d.name === 'Value' && textOf(d) === '=Fields!f2.Value'))!;
    const side = descendants(out).filter((e) => e.name === 'Rectangle' && descendants(e).includes(right)).pop()!;
    assert.match(textOf(child(side, 'Style/LeftBorder/Style')), /Solid/, 'its right part sits in a box whose left side is the divider');
    assert.equal(descendants(side).filter((e) => e.name === 'Tablix').length, 2, 'with the list beside it');
    assert.equal(new Set(descendants(out).filter((e) => e.name === 'Group').map((e) => e.attributes.Name)).size, descendants(out).filter((e) => e.name === 'Group').length);
  });

  it('starts a chart frame on a new page after a table that starts its own page, not after one that does not', () => {
    type XmlNode = ReturnType<typeof parseXml>;
    const chart = (n: string) => `<Chart Name="${n}"><ChartCategoryHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartCategoryHierarchy><ChartSeriesHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartSeriesHierarchy><ChartData><ChartSeriesCollection><ChartSeries Name="S"><ChartDataPoints><ChartDataPoint><ChartDataPointValues><Y>=Sum(Fields!v.Value)</Y></ChartDataPointValues></ChartDataPoint></ChartDataPoints></ChartSeries></ChartSeriesCollection></ChartData><ChartAreas><ChartArea Name="Default" /></ChartAreas><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>1.5in</Height><Width>10in</Width></Chart>`;
    const framed = (name: string, top: number, inner: string, extra = '') => `<Rectangle Name="${name}"><ReportItems>${inner}</ReportItems>${extra}<Top>${top}in</Top><Left>0in</Left><Height>1.5in</Height><Width>10in</Width><Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const own = framed('Own', 0, grid('Listed', [5, 5]), '<PageBreak><BreakLocation>Start</BreakLocation></PageBreak>');
    const shared = framed('Shared', 3, grid('Other', [5, 5]));
    const out = parseXml(applyConventions(doc(own + framed('After', 1.5, chart('Plot')) + shared + framed('Beside', 4.5, chart('Plot2')), 6), 'Parts', styled).rdl);
    const charts = descendants(out).filter((e) => e.name === 'Chart');
    const breaksOf = (chart: XmlNode) => descendants(out).filter((e) => e.name === 'Rectangle' && descendants(e).includes(chart) && textOf(child(e, 'PageBreak/BreakLocation')) === 'Start');
    assert.equal(breaksOf(charts[0]!).length, 1);
    assert.equal(breaksOf(charts[1]!).length, 0);
    const section = `<Rectangle Name="Sec"><ReportItems>${framed('Own2', 0, grid('Listed2', [5, 5]))}${framed('After2', 1.5, chart('Plot3'))}</ReportItems><PageBreak><BreakLocation>Start</BreakLocation></PageBreak><Top>1.5in</Top><Left>0in</Left><Height>3in</Height><Width>10in</Width><Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const joint = parseXml(applyConventions(doc(framed('Lead', 0, grid('First', [5, 5])) + section, 5), 'Parts', styled).rdl);
    const plot = descendants(joint).find((e) => e.name === 'Chart')!;
    const holders = descendants(joint).filter((e) => e.name === 'Rectangle' && descendants(e).includes(plot) && textOf(child(e, 'PageBreak/BreakLocation')) === 'Start');
    assert.ok(holders.some((e) => !descendants(e).some((d) => d.name === 'Tablix')), 'the chart, sharing a box that starts a page with the table above it, starts the next page');
  });

  it('stretches a chart title band across its bordered panel through a box between them', () => {
    const plot = `<Chart Name="Plot"><ChartCategoryHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartCategoryHierarchy><ChartSeriesHierarchy><ChartMembers><ChartMember><Label /></ChartMember></ChartMembers></ChartSeriesHierarchy><ChartData><ChartSeriesCollection><ChartSeries Name="S"><ChartDataPoints><ChartDataPoint><ChartDataPointValues><Y>=Sum(Fields!v.Value)</Y></ChartDataPointValues></ChartDataPoint></ChartDataPoints></ChartSeries></ChartSeriesCollection></ChartData><ChartAreas><ChartArea Name="Default" /></ChartAreas><DataSetName>Rows</DataSetName><Top>0.226in</Top><Left>0in</Left><Height>2in</Height><Width>2.75in</Width></Chart>`;
    const inner = box('Inner', 0.06, 0.02, 2.75, 2.25, text('Head', 'Spread by kind', 0.021, 0.032, 2.708, 0.194) + plot);
    const out = parseXml(applyConventions(doc(box('Panel', 0, 0, 2.879, 2.3, inner, '<Border><Style>Solid</Style></Border>')), 'Parts', styled).rdl);
    const head = valued(out, 'Spread by kind');
    const panel = descendants(out).filter((e) => e.name === 'Rectangle' && /Solid/.test(textOf(child(e, 'Style/Border/Style'))) && descendants(e).includes(head)).pop()!;
    let left = num(head, 'Left');
    for (let e = holderOf(out, head), k = 0; e && e !== panel && k < 5; e = holderOf(out, e), k++) left += num(e, 'Left');
    assert.ok(left < 0.001, String(left));
    assert.ok(Math.abs(left + num(head, 'Width') - num(panel, 'Width')) < 0.001, `${num(head, 'Width')} ${num(panel, 'Width')}`);
  });

  it('keeps the column lines of a table through a heading row that names one group', () => {
    const tb = (n: string, v: string, side = '') => `<Textbox Name="${n}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${v}</Value></TextRun></TextRuns></Paragraph></Paragraphs><Style>${side}</Style></Textbox>`;
    const ruled = '<LeftBorder><Style>Solid</Style></LeftBorder>';
    const cell = (inner: string, span = 1) => `<TablixCell><CellContents>${inner}${span > 1 ? `<ColSpan>${span}</ColSpan>` : ''}</CellContents></TablixCell>`;
    const rect = (n: string, side = '') => `<Rectangle Name="${n}"><ReportItems /><Style><Border><Style>None</Style></Border>${side}</Style></Rectangle>`;
    const group = `<Rectangle Name="G"><ReportItems>${tb('GT', '=Fields!g.Value').replace('<Style>', '<Top>0in</Top><Left>0.05in</Left><Height>0.18in</Height><Width>1.5in</Width><Style>')}</ReportItems><Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const rows = `<TablixRow><Height>0.2in</Height><TablixCells>${cell(group, 2)}<TablixCell />${cell(rect('R3', ruled))}</TablixCells></TablixRow><TablixRow><Height>0.2in</Height><TablixCells>${cell(tb('V1', '=Fields!a.Value'))}${cell(tb('V2', '=Fields!b.Value'))}${cell(tb('V3', '=Fields!c.Value', ruled))}</TablixCells></TablixRow>`;
    const table = `<Tablix Name="Ruled"><TablixBody><TablixColumns>${'<TablixColumn><Width>2in</Width></TablixColumn>'.repeat(3)}</TablixColumns><TablixRows>${rows}</TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers>${'<TablixMember />'.repeat(3)}</TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember><Group Name="Ruled_G"><GroupExpressions><GroupExpression>=Fields!g.Value</GroupExpression></GroupExpressions></Group><TablixMembers><TablixMember><KeepWithGroup>After</KeepWithGroup></TablixMember><TablixMember><Group Name="Ruled_D" /></TablixMember></TablixMembers></TablixMember></TablixMembers></TablixRowHierarchy><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>0.4in</Height><Width>6in</Width></Tablix>`;
    const out = parseXml(applyConventions(doc(table), 'Parts', styled).rdl);
    const named = descendants(out).find((e) => e.name === 'TablixRow' && descendants(e).some((v) => v.name === 'Value' && textOf(v) === '=Fields!g.Value'))!;
    const cells = childElements(child(named, 'TablixCells')!, 'TablixCell');
    assert.ok(!cells.some((c) => Number(textOf(child(c, 'CellContents/ColSpan')) || 1) > 1), 'the group name keeps to its own column');
    assert.ok(cells.some((c) => descendants(c).some((e) => e.name === 'LeftBorder' && /Solid/.test(textOf(child(e, 'Style'))))), 'the column line crosses the row');
  });

  it('keeps the two lines of a two-line heading together, one line high each', () => {
    const cell = (name: string, v: string) => `<TablixCell><CellContents><Textbox Name="${name}"><CanGrow>true</CanGrow><Paragraphs><Paragraph><TextRuns><TextRun><Value>${v}</Value><Style><FontSize>8pt</FontSize><FontWeight>Bold</FontWeight></Style></TextRun></TextRuns><Style><TextAlign>Center</TextAlign></Style></Paragraph></Paragraphs><Style><PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom></Style></Textbox></CellContents></TablixCell>`;
    const row = (h: number, cells: string[]) => `<TablixRow><Height>${h}in</Height><TablixCells>${cells.join('')}</TablixCells></TablixRow>`;
    const rows = [row(0.17, [cell('U1', 'Current'), cell('U2', 'Current'), cell('U3', 'Effective Date')]), row(0.17, [cell('L1', 'Numerator'), cell('L2', 'Denominator'), cell('L3', 'Result')]),
      row(0.17, [cell('V1', '=Fields!n.Value'), cell('V2', '=Fields!d.Value'), cell('V3', '=Fields!r.Value')])];
    const table = `<Tablix Name="Lines"><TablixBody><TablixColumns>${'<TablixColumn><Width>0.85in</Width></TablixColumn>'.repeat(3)}</TablixColumns><TablixRows>${rows.join('')}</TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers>${'<TablixMember />'.repeat(3)}</TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember><KeepWithGroup>After</KeepWithGroup></TablixMember><TablixMember><KeepWithGroup>After</KeepWithGroup></TablixMember><TablixMember><Group Name="Lines_Rows" /></TablixMember></TablixMembers></TablixRowHierarchy><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>0.51in</Height><Width>2.55in</Width></Tablix>`;
    const out = parseXml(applyConventions(doc(table), 'Parts', styled).rdl);
    const tablix = descendants(out).find((e) => e.name === 'Tablix')!;
    const heads = childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow');
    const upper = heads.find((r) => descendants(r).some((e) => e.name === 'Value' && textOf(e) === 'Effective Date'))!;
    const lower = heads.find((r) => descendants(r).some((e) => e.name === 'Value' && textOf(e) === 'Numerator'))!;
    assert.ok(num(upper, 'Height') < 0.3, textOf(child(upper, 'Height')));
    for (const tb of descendants(upper).filter((e) => e.name === 'Textbox')) assert.equal(textOf(child(tb, 'Style/VerticalAlign')), 'Bottom', tb.attributes.Name);
    for (const tb of descendants(lower).filter((e) => e.name === 'Textbox')) assert.equal(textOf(child(tb, 'Style/VerticalAlign')), 'Top', tb.attributes.Name);
  });

  it('names a box of labels in a table cell after the field it shows, not after a label', () => {
    const tb = (name: string, v: string, top: number) => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${v}</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>${top}in</Top><Left>0in</Left><Height>0.2in</Height><Width>1.4in</Width></Textbox>`;
    const holder = (name: string, inner: string) => `<TablixCell><CellContents><Rectangle Name="${name}"><ReportItems>${inner}</ReportItems><Top>0in</Top><Left>0in</Left><Height>1in</Height><Width>1.5in</Width></Rectangle></CellContents></TablixCell>`;
    const cells = holder('Text3', tb('Text3', 'Reached at:', 0.3) + tb('Lead', '=Fields!lead_label.Value', 0)) + holder('Values', tb('Who', '=Fields!lead_name.Value', 0) + tb('Where', '=Fields!lead_place.Value', 0.3));
    const pair = `<Tablix Name="Pair"><TablixBody><TablixColumns>${[1.5, 1.5].map((w) => `<TablixColumn><Width>${w}in</Width></TablixColumn>`).join('')}</TablixColumns><TablixRows><TablixRow><Height>1in</Height><TablixCells>${cells}</TablixCells></TablixRow></TablixRows></TablixBody><TablixColumnHierarchy><TablixMembers><TablixMember /><TablixMember /></TablixMembers></TablixColumnHierarchy><TablixRowHierarchy><TablixMembers><TablixMember><Group Name="Pair_Rows" /></TablixMember></TablixMembers></TablixRowHierarchy><DataSetName>Rows</DataSetName><Top>0in</Top><Left>0in</Left><Height>1in</Height><Width>3in</Width></Tablix>`;
    const out = parseXml(applyConventions(doc(box('Frame', 0, 0, 3, 1, pair)), 'Parts', styled).rdl);
    const labels = holderOf(out, valued(out, 'Reached at:'));
    assert.match(labels.attributes.Name ?? '', /lead_label/, labels.attributes.Name);
    assert.ok(!/Text/.test(labels.attributes.Name ?? ''), labels.attributes.Name);
  });

  it('lists the items of each box in the order they print, numbered in that order', () => {
    const lower = box('Lower', 0, 2, 4, 0.5, text('B', 'Second', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>');
    const upper = box('Upper', 0, 0.5, 4, 0.5, text('A', 'First', 0.1, 0.1, 2, 0.2), '<Border><Style>Solid</Style></Border>');
    const out = parseXml(applyConventions(doc(lower + upper), 'Parts', styled).rdl);
    const boxes = descendants(out).filter((e) => e.name === 'Rectangle');
    const first = holderOf(out, valued(out, 'First'));
    const second = holderOf(out, valued(out, 'Second'));
    assert.ok(boxes.indexOf(first) < boxes.indexOf(second));
    const number = (e: ReturnType<typeof parseXml>) => Number(/(\d+)$/.exec(e.attributes.Name ?? '')?.[1]);
    assert.ok(number(first) < number(second), `${first.attributes.Name} ${second.attributes.Name}`);
    assert.equal(number(boxes[0]!), 1);
  });

  it('runs dividers down to the frame\'s foot, the one beside a growing table drawn as that table\'s own side', () => {
    const title = text('Heading', 'Heading', 0, 0, 10, 0.233, '<BottomBorder><Style>Solid</Style></BottomBorder>');
    const rule = '<Line Name="Upright"><Top>0in</Top><Left>3in</Left><Height>1.2in</Height><Width>0in</Width><Style><Border><Style>Solid</Style></Border></Style></Line>';
    const parted = box('Parted', 0, 0, 6, 1.5, text('Note', 'Note', 0, 0, 2, 0.2) + text('Other', 'Other', 3.2, 0, 2, 0.2), '<Border><Style>None</Style></Border><RightBorder><Style>Solid</Style></RightBorder>');
    const grown = box('Grown', 6.01, 0.014, 3.9, 0.6, grid('Listed', [2, 1.5]));
    const out = parseXml(applyConventions(doc(box('Frame', 0, 0, 10.4, 1.733, title + box('Inner', 0, 0.233, 10, 1.5, rule + parted + grown), '<Border><Style>Solid</Style></Border>')), 'Parts', styled).rdl);
    const inner = holderOf(out, valued(out, 'Note'));
    const holder = descendants(out).filter((e) => e.name === 'Rectangle' && childElements(child(e, 'ReportItems') ?? e).includes(inner))[0] ?? inner;
    const line = descendants(out).find((e) => e.name === 'Line' && num(e, 'Height') > 0.5)!;
    assert.ok(Math.abs(num(line, 'Top') + num(line, 'Height') - num(holder, 'Height')) < 0.002, `${textOf(child(line, 'Height'))} ${textOf(child(holder, 'Height'))}`);
    const table = descendants(out).find((e) => e.name === 'Tablix')!;
    const side = descendants(out).filter((e) => e.name === 'Rectangle' && descendants(e).includes(table)).pop()!;
    assert.match(textOf(child(side, 'Style/LeftBorder/Style')), /Solid/);
    assert.ok(Math.abs(num(side, 'Top') + num(side, 'Height') - num(holder, 'Height')) < 0.002, `${textOf(child(side, 'Height'))}`);
    assert.ok(!descendants(out).some((e) => e.name === 'Rectangle' && /Solid/.test(textOf(child(e, 'Style/RightBorder/Style'))) && descendants(e).includes(valued(out, 'Note'))));
  });
});
