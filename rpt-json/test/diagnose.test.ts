import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { diagnoseRdl, diagnosisLine } from '../src/ssrs/diagnose.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, childElements, descendants, parseXml, textOf, type XmlElement } from '../src/ssrs/xml.ts';

const source = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Kind', type: 'string' }, { name: 'Amount', type: 'currency' }] }] } as never;
const at = (x: number, width = 2880, height = 240) => ({ position: { x, y: 0 }, size: { width, height } });
const text = (name: string, value: string, x: number, height = 240): ReportObject => ({ kind: 'text', name, text: value, style: { size: 8 }, ...at(x, 2880, height) });
const field = (name: string, f: string, x: number): ReportObject => ({ kind: 'field', name, field: f, style: { size: 8 }, ...at(x) });
const valueOf = (e: XmlElement) => descendants(e).filter((x) => x.name === 'Value').map(textOf).join('');
const conventions = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt', heading: '{T}_{col}_ColTxt', value: '{T}_{col}_ColVal', blank: '{T}_blnk{n}', totalText: '{T}_TotTxt', total: '{T}_{col}_TotVal', footer: '{S}_Footer_Txt' } }));

/** A grouped report with a heading of two lines and an empty group header a few points high. */
function template(): string {
  const definition = {
    saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
    formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['T.Kind'] }],
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 480, objects: [text('KindHeading', 'Order\nDate', 0, 480), text('AmountHeading', 'Amount', 2880)] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 40, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('K', 'T.Kind', 0), field('A', 'T.Amount', 2880)] }] },
    ],
  } as unknown as ReportDefinition;
  return applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', conventions).rdl;
}

/** A report over one group of everything, its header holding the title, a heavy rule and the column headings. */
function titledInGroup(): string {
  const line = (name: string, y: number) => ({ kind: 'line', name, ...at(0, 8640, 0), position: { x: 0, y }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 60 } });
  const definition = {
    saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
    formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
      { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] }],
    layout: [
      ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 1015, objects: [
        { ...text('Title', 'Holdings in Detail', 0, 300), ...at(0, 8640, 300) },
        line('Rule', 320),
        { ...text('NameHeading', 'Name', 0, 240), position: { x: 0, y: 565 } },
        { ...text('KindHeading', 'Order Status', 2880, 240), position: { x: 2880, y: 565 }, size: { width: 645, height: 240 } },
        { ...text('AmountHeading', 'Amount', 4320, 240), position: { x: 4320, y: 565 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('N', 'T.Kind', 0), { ...field('K', 'T.Kind', 2880), size: { width: 1440, height: 240 } }, field('A', 'T.Amount', 4320)] }] },
    ],
  } as unknown as ReportDefinition;
  return applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', { ...conventions, style: { dataset: 'Theme', commandType: 'StoredProcedure', command: 'dbo.theme_get', field: '{role}_{prop}', props: { FontSize: 'size' }, roles: { title: 'Title', heading: 'Head' } } } as never).rdl;
}

describe('a check of the finished report', () => {
  it('takes a title printed in the table\'s own header as its title, with the rule under it', () => {
    const root = parseXml(titledInGroup());
    const title = descendants(root).find((e) => e.attributes.Name === 'Holdings_SchTitle_Txt');
    assert.ok(title, 'the title is named as the title, not a column heading');
    assert.equal(textOf(descendants(title!).find((e) => e.name === 'Value')), 'Holdings in Detail');
    assert.match(textOf(child(descendants(title!).find((e) => e.name === 'BottomBorder')!, 'Style')), /Solid/);
    assert.ok(!descendants(root).some((e) => /in_Detail_ColTxt|Holdings_in_Detail/i.test(e.attributes.Name ?? '')));
  });

  it('keeps a heading\'s words whole, closer to the cell\'s edges, and its row as tall as its lines', () => {
    const root = parseXml(titledInGroup());
    const heading = descendants(root).find((e) => /Order_Status|Kind_ColTxt/.test(e.attributes.Name ?? '') && e.name === 'Textbox')!;
    assert.ok(heading, 'the heading');
    const row = descendants(root).find((e) => e.name === 'TablixRow' && descendants(e).includes(heading))!;
    // (Two lines of the designer's 10pt, bold where the house styles it, and the padding over them.)
    assert.ok(parseFloat(textOf(childElements(row, 'Height')[0])) >= 0.38, textOf(childElements(row, 'Height')[0]));
  });

  it('writes a heading of fixed lines as text, one paragraph a line, and leaves out an empty sliver of a row', () => {
    const rdl = template();
    const heading = descendants(parseXml(rdl)).find((e) => e.attributes.Name === 'Holdings_Tab_1_Kind_ColTxt')!;
    const lines = childElements(descendants(heading).find((e) => e.name === 'Paragraphs')!, 'Paragraph').map((p) => textOf(descendants(p).find((e) => e.name === 'Value')));
    assert.deepEqual(lines, ['Order', 'Date']);
    const heights = descendants(parseXml(rdl)).filter((e) => e.name === 'TablixRow').map((r) => textOf(childElements(r, 'Height')[0]));
    assert.ok(heights.every((h) => parseFloat(h) >= 0.1), `rows ${heights.join(' ')}`);
    assert.equal(diagnosisLine(diagnoseRdl(rdl, true)), 'clean');
  });

  it('lists custom code, items over each other or past their box, headings shown as «Expr» and default names', () => {
    const box = (name: string, left: number, value = 'x') => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value></TextRun></TextRuns></Paragraph></Paragraphs><Top>0in</Top><Left>${left}in</Left><Height>0.2in</Height><Width>1in</Width></Textbox>`;
    const rdl = `<Report><Code>Public Function F(x) As String
Return x
End Function</Code><ReportSections><ReportSection><Body><ReportItems>
<Rectangle Name="Rectangle3"><ReportItems>${box('A_ColTxt', 0, '="Due" &amp; vbCrLf &amp; Fields!Kind.Value')}${box('B', 0.5, '=Code.F(1)')}</ReportItems><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Rectangle>
</ReportItems><Height>1in</Height></Body><Width>1in</Width><Page><PageWidth>8.5in</PageWidth></Page></ReportSection></ReportSections></Report>`;
    const kinds = diagnoseRdl(rdl, true).map((f) => `${f.kind}: ${f.item}`);
    assert.deepEqual(kinds.sort(), ['code: B', 'code: Report', 'cut off: B', 'expression: A_ColTxt', 'name: Rectangle3', 'overlap: A_ColTxt / B'].sort());
  });

  it('lists parameters the base report does not have, which the merge does not copy', () => {
    const rdl = `<Report><DataSets><DataSet Name="A"><Query><QueryParameters><QueryParameter Name="@extra"><Value>=Parameters!extra.Value</Value></QueryParameter></QueryParameters></Query></DataSet></DataSets>
<ReportParameters><ReportParameter Name="one"/><ReportParameter Name="extra"/><ReportParameter Name="unread"/></ReportParameters></Report>`;
    const merge = diagnoseRdl(rdl, true, ['one']).filter((f) => f.kind === 'merge').map((f) => `${f.item}: ${/will not publish/.test(f.message) ? 'blocks' : 'dropped'}`);
    assert.deepEqual(merge.sort(), ['Parameter extra: blocks', 'Parameter unread: dropped']);
    assert.equal(diagnoseRdl(rdl, true).filter((f) => f.kind === 'merge').length, 0);
  });

  it('starts the table at its first column, keeps the space under a rule, puts totals under their rule and names a footnote as the footer', () => {
    const line = (name: string, y: number) => ({ kind: 'line', name, ...at(45, 8900, 0), position: { x: 45, y }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 60 } });
    const ruled = { border: { sides: [0, 0, 1, 0], color: '#000000', width: 20 } };
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] },
        { name: 'note', index: 3, kind: 'formula', text: '"Figures as reported"', referencedFields: [] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 240, objects: [{ ...field('Note', '@note', 300), size: { width: 8600, height: 240 } }] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 700, objects: [
          { ...text('Title', 'Holdings in Detail', 0, 300), ...at(0, 8900, 300) }, line('Rule1', 320),
          { ...text('KindHeading', 'Kind', 300, 240), position: { x: 300, y: 400 } },
          { ...text('AmountHeading', 'Amount', 4320, 240), position: { x: 4320, y: 400 } }, line('Rule2', 640)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 300, objects: [{ ...text('TotalLabel', 'Total:', 300, 200), position: { x: 300, y: 60 } },
          { ...field('Sum', 'Sum of T.Amount', 4320), position: { x: 4320, y: 60 }, size: { width: 2000, height: 200 }, ...ruled }] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('K', 'T.Kind', 300), field('A', 'T.Amount', 4320)] }] },
      ],
    } as unknown as ReportDefinition;
    const rdl = applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', conventions).rdl;
    const root = parseXml(rdl);
    const table = descendants(root).find((e) => e.name === 'Tablix')!;
    const rows = descendants(table).filter((e) => e.name === 'TablixRow');
    const names = (row: XmlElement) => descendants(row).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name);
    const headingRow = rows.findIndex((r) => names(r).includes('Holdings_Tab_1_Kind_ColTxt'));
    assert.equal(names(rows[headingRow]!)[0], 'Holdings_Tab_1_Kind_ColTxt', 'the first column is the first heading');
    const gap = rows[headingRow + 1]!;
    assert.ok(parseFloat(textOf(childElements(gap, 'Height')[0])) < 0.1 && names(gap).every((n) => /blnk/.test(n ?? '')), 'the space under the rule stays');
    const total = descendants(root).find((e) => e.attributes.Name === 'Holdings_Tab_1_Amount_TotVal')!;
    assert.equal(textOf(child(childElements(total, 'Style')[0]!, 'PaddingTop')), '2pt');
    assert.equal(textOf(child(childElements(total, 'Style')[0]!, 'VerticalAlign')), 'Top');
    const totalCell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(total))!;
    assert.equal(childElements(child(totalCell, 'CellContents')!).find((e) => e.name !== 'ColSpan')!.name, 'Rectangle', 'the rule keeps its own width');
    assert.equal(textOf(child(total, 'Width')), '1.389in');
    const label = descendants(root).find((e) => e.attributes.Name === 'Holdings_Tab_1_TotTxt')!;
    const labelCell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(label))!;
    assert.ok(!descendants(labelCell).some((e) => e.name === 'ColSpan'), 'the label in its own column, as the merge reads a totals row');
    assert.ok(descendants(root).some((e) => e.attributes.Name === 'Holdings_Footer_Txt'), names(rows[rows.length - 1]!).join(' '));
    assert.ok(!descendants(root).some((e) => /in_Detail/i.test(e.attributes.Name ?? '')));
  });

  it('draws a frame Crystal put round a heading as the heading\'s own border, the heading in its cell', () => {
    const box = { kind: 'box', name: 'Frame', position: { x: 60, y: 60 }, size: { width: 2900, height: 320 }, border: { sides: [1, 1, 1, 1], color: '#000000', width: 20 } };
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 600, objects: [{ ...text('H1', 'Holding Name', 120, 240), position: { x: 120, y: 100 }, size: { width: 2800, height: 240 } }, box,
          { ...text('H2', 'Amount', 3100, 240), position: { x: 3100, y: 100 }, size: { width: 1200, height: 240 } }] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 0, objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ ...field('N', 'T.Kind', 120), size: { width: 2800, height: 221 } }, { ...field('A', 'T.Amount', 3100), size: { width: 1200, height: 221 } }] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', conventions).rdl);
    const heading = descendants(root).find((e) => e.attributes.Name === 'Holdings_Tab_1_Kind_ColTxt')!;
    const cell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(heading))!;
    assert.equal(childElements(child(cell, 'CellContents')!)[0], heading, 'the heading straight in its cell');
    assert.match(textOf(child(childElements(heading, 'Style')[0]!, 'Border/Style')), /Solid/);
  });

  it('shows two texts Crystal put over each other, one hidden while the other has a value, as one text', () => {
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'dash', index: 1, kind: 'formula', text: '"--"', referencedFields: [] },
        { name: 'Object_Visibility', index: 2, kind: 'conditionalFormat', text: 'isnull({T.Amount})=false', referencedFields: [] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 400, objects: [text('H1', 'Kind', 0), text('H2', 'Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('K', 'T.Kind', 0), field('A', 'T.Amount', 2880),
          { ...field('Dash', '@dash', 3000), size: { width: 1500, height: 240 }, conditions: { suppress: { name: 'Object_Visibility', index: 2 } } }] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', conventions).rdl);
    const value = descendants(root).find((e) => e.attributes.Name === 'Holdings_Tab_1_Amount_ColVal')!;
    assert.ok(value, 'one text, named after its field');
    assert.match(textOf(descendants(value).find((e) => e.name === 'Value')), /^=IIf\(.*IsNothing\(Fields!Amount\.Value\).*, Fields!Amount\.Value, \(?"--"\)?\)$/);
    const cell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(value))!;
    assert.equal(descendants(cell).filter((e) => e.name === 'Textbox').length, 1);
  });

  it('numbers a second total of a column before its type, as the merge reads what follows the type as a column', () => {
    const rdl = `<Report><ReportSections><ReportSection><Body><ReportItems><Textbox Name="A_amount_SubTotVal_2"><Paragraphs/></Textbox></ReportItems></Body></ReportSection></ReportSections></Report>`;
    assert.ok(diagnoseRdl(rdl, true).some((f) => f.kind === 'merge' && f.item === 'A_amount_SubTotVal_2'));
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'Group #1 Order', index: 1, kind: 'internal', text: '', referencedFields: ['T.Kind'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [text('H1', 'Kind', 0), text('H2', 'Amount', 2880)] }] },
        { name: 'GroupFooterArea1', sections: [
          { name: 'GFa', height: 240, objects: [field('S1', 'Sum of T.Amount', 2880)] },
          { name: 'GFb', height: 240, objects: [field('S2', 'Sum of T.Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('K', 'T.Kind', 0), field('A', 'T.Amount', 2880)] }] },
      ],
    } as unknown as ReportDefinition;
    const named = { ...conventions, names: { ...conventions.names, subtotal: '{T}_{col}_SubTotVal' } } as never;
    const out = applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', named).rdl;
    assert.ok(!/_SubTotVal_\d/.test(out), out.match(/Name="[^"]*SubTotVal[^"]*"/g)?.join(' '));
  });

  it('moves columns placed by formulas into a table titled over them, with no column for a hidden field and every total ruled alike', () => {
    const fields = [{ name: 'Name', type: 'string' }, { name: 'G', type: 'string' }, { name: 'Max', type: 'number' }, ...[1, 2, 3].flatMap((i) => [{ name: `H${i}`, type: 'string' }, { name: `P${i}`, type: 'number' }, { name: `B${i}`, type: 'number' }, { name: `S${i}`, type: 'number' }])];
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields }] } as never;
    const formulas: { name: string; index: number; kind: string; text: string; referencedFields: string[] }[] = [
      { name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
      { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] }];
    const moved = (i: number) => {
      formulas.push({ name: 'DeltaX_Value_Formula', index: formulas.length + 1, kind: 'conditionalFormat', text: `{T.P${i}} * 1440`, referencedFields: [] });
      return { deltaX: { name: 'DeltaX_Value_Formula', index: formulas.length } };
    };
    const at2 = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const hideZero = () => {
      formulas.push({ name: 'Section_Visibility', index: formulas.length + 1, kind: 'conditionalFormat', text: 'if {T.B1} = 0 and {T.B2} = 0 then true', referencedFields: [] });
      return { name: 'Section_Visibility', index: formulas.length };
    };
    const f = (name: string, ref: string, x: number, y: number, width: number, height: number, extra = {}) => ({ kind: 'field', name, field: ref, style: { size: 8 }, ...at2(x, y, width, height), ...extra });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@all'], sortFields: [], summarizedFields: [], formulas,
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 1200, objects: [
          { kind: 'text', name: 'Title', text: 'Balances by Kind', style: { size: 10 }, ...at2(0, 0, 10080, 288) },
          { kind: 'line', name: 'Rule', ...at2(30, 290, 10050, 0), border: { sides: [0, 0, 1, 0], width: 60 } },
          { kind: 'text', name: 'NameHead', text: 'Name', style: { size: 8 }, ...at2(50, 400, 3000, 200) },
          f('MaxHead', 'T.Max', 9300, 400, 700, 200, { suppressed: true }),
          ...[1, 2, 3].map((i) => f(`Head${i}`, `T.H${i}`, 30, 400, 1155, 600, { conditions: moved(i) })),
          { kind: 'line', name: 'Rule2', ...at2(30, 1100, 10050, 0), border: { sides: [0, 0, 1, 0], width: 60 } }] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 220, conditions: { suppress: hideZero() }, objects: [f('Name', 'T.Name', 50, 0, 3000, 210), f('MaxVal', 'T.Max', 9300, 0, 700, 210, { suppressed: true }),
          ...[1, 2, 3].map((i) => f(`Bal${i}`, `T.B${i}`, 30, 0, 1155, 210, { conditions: moved(i) }))] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 260, objects: [{ kind: 'text', name: 'Totals', text: 'Totals:', style: { size: 8 }, ...at2(100, 0, 1000, 240) },
          ...[1, 2, 3].map((i) => f(`Sum${i}`, `T.S${i}`, 0, 40, 1185, 166, { conditions: moved(i), border: { sides: [0, 0, 1, 0], width: 20 } }))] }] },
      ],
    } as unknown as ReportDefinition;
    const styled = { ...conventions, style: { dataset: 'Theme', commandType: 'StoredProcedure', command: 'dbo.theme_get', field: '{role}_{prop}', props: { BackgroundColor: 'fill' }, roles: { title: 'Title', heading: 'Head', body: 'Body', bodyFirst: 'Body', number: 'Body' }, rowBands: { odd: 'Odd', even: 'Even' } } } as never;
    const out = applyConventions(convertToRdl(definition, src, { reportName: 'Holdings', formulasInQuery: true, rulesAsText: true }).rdl, 'Holdings', styled).rdl;
    const root = parseXml(out);
    assert.ok(descendants(root).some((e) => e.attributes.Name === 'Holdings_SchTitle_Txt'), out.match(/Name="[^"]*"/g)!.join(' '));
    assert.ok(!/Name="[^"]*Max[^"]*"/.test(out), 'no column for the hidden field');
    const totals = descendants(root).filter((e) => e.name === 'Textbox' && /_S\d_SubtotalLabel$/.test(e.attributes.Name ?? ''));
    assert.equal(totals.length, 3, out.match(/Name="[^"]*S\d[^"]*"/g)?.join(" "));
    assert.ok(totals.every((t) => !!child(t, 'Width')), 'each total in a box of its own, the last too');
    assert.ok(totals.every((t) => parseFloat(textOf(child(t, 'Top'))) >= 0.02), 'each total\'s rule drawn inside its cell, not on its edge');
    const later = parseXml(applyConventions(out.replace(/(<Tablix Name=")([^"]+)(">[\s\S]*?<\/Tablix>)/, (m) => m + m.replace(/Name="([^"]+)"/g, 'Name="$1_b"').replace(/(<\/TablixRowHierarchy>[\s\S]*?<Top>)[^<]*(<\/Top>)/, '$15in$2')), 'Holdings', styled).rdl);
    const [first, second] = descendants(later).filter((e) => e.name === 'Tablix');
    const firstCount = childElements(child(first!, 'TablixBody/TablixColumns')!, 'TablixColumn').length;
    assert.ok(!descendants(second!).some((e) => e.name === 'ColSpan' && Number(textOf(e)) === firstCount), 'no span in a later table that the merge would take for the first table\'s width');
    const bands = descendants(root).filter((e) => e.name === 'BackgroundColor' && /Mod 2/.test(textOf(e))).map(textOf);
    assert.ok(bands.length && bands.every((b) => b.startsWith('=IIF(RunningValue(')), `rows counted as shown: ${bands[0]}`);
  });

  it('puts a box drawn under a total on a row of its own, gives each heading its own cell and a total room for its digits', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Code', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Kind', type: 'string' }, { name: 'Rank', type: 'string' }, { name: 'G', type: 'string' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, width: number, height: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8 }, ...box(x, y, width, height), ...extra });
    const f = (name: string, ref: string, x: number, y: number, width: number, height: number, extra = {}) => ({ kind: 'field', name, field: ref, style: { size: 8 }, ...box(x, y, width, height), ...extra });
    const rule = { border: { sides: [0, 0, 1, 0], width: 20 }, align: 'right' };
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@all', 'T.G'], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] },
        { name: 'Group #2 Order', index: 3, kind: 'internal', text: '', referencedFields: ['T.G'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 900, objects: [
          t('Title', 'Holdings by Rank', 0, 0, 8640, 300, { align: 'center' }),
          { kind: 'line', name: 'TitleRule', ...box(0, 320, 8640, 0), border: { sides: [0, 0, 1, 0], width: 60 } },
          t('NameHead', 'Name', 100, 560, 2800, 225), t('CodeHead', 'Code', 3000, 560, 1000, 225),
          t('AmountHead', 'Amount', 4100, 500, 1000, 400), t('KindHead', 'Kind Classification', 5200, 420, 653, 450), t('RankHead', 'Rank Differential', 5897, 500, 788, 400)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 1195, objects: [
          t('TotalLabel', 'Total:', 100, 120, 1755, 225), f('Total', 'Sum of T.Amount', 3980, 120, 1253, 180, rule),
          t('Legend', 'A note on the marks', 5200, 500, 2500, 655, { border: { sides: [1, 1, 1, 1], width: 20 } })] }] },
        { name: 'GroupHeaderArea2', sections: [{ name: 'GH2', height: 0, suppressed: true, objects: [] }] },
        { name: 'GroupFooterArea2', sections: [{ name: 'GF2', height: 300, objects: [f('Sub', 'Sum of T.Amount', 4100, 40, 1000, 180, rule)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 210, objects: [f('N', 'T.Name', 100, 0, 2800, 195), f('C', 'T.Code', 3000, 0, 1000, 180),
          f('A', 'T.Amount', 4100, 0, 1000, 180, { align: 'right' }), f('K', 'T.Kind', 5223, 0, 690, 180), f('R', 'T.Rank', 6063, 0, 615, 180)] }] },
      ],
    } as unknown as ReportDefinition;
    const out = applyConventions(convertToRdl(definition, src, { reportName: 'Holdings', formulasInQuery: true, rulesAsText: true }).rdl, 'Holdings', conventions).rdl;
    const root = parseXml(out);
    const tablix = descendants(root).find((e) => e.name === 'Tablix')!;
    const rows = childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow');
    const rowOf = (name: string) => rows.findIndex((r) => descendants(r).some((e) => e.attributes.Name === name));
    const total = descendants(tablix).find((e) => e.name === 'Textbox' && /^=Sum/.test(valueOf(e)) && rows[rowOf(e.attributes.Name!)] && descendants(rows[rowOf(e.attributes.Name!)]!).some((x) => x.name === 'Value' && textOf(x) === 'Total:'))!;
    const legend = descendants(tablix).find((e) => e.name === 'Textbox' && valueOf(e).includes('A note'))!;
    assert.ok(total && legend, 'the total and the note');
    assert.equal(rowOf(legend.attributes.Name!), rowOf(total.attributes.Name!) + 1, 'the note on the row under the total');
    assert.ok(!descendants(rows[rowOf(total.attributes.Name!)]!).some((e) => e.name === 'ColSpan'), 'the total\'s row spans nothing, so it is reordered with the columns');
    assert.ok(!/TotTxt|TotVal/.test(legend.attributes.Name!), legend.attributes.Name);
    const headings = descendants(tablix).filter((e) => e.name === 'Textbox' && /_ColTxt$/.test(e.attributes.Name ?? ''));
    assert.ok(headings.some((e) => valueOf(e) === 'Kind Classification') && headings.some((e) => valueOf(e) === 'Rank Differential'), headings.map((e) => valueOf(e)).join(' | '));
    assert.ok(headings.every((e) => !textOf(child(childElements(e, 'Style')[0]!, 'PaddingTop')) || /^0(\.0+)?pt$/.test(textOf(child(childElements(e, 'Style')[0]!, 'PaddingTop')))), 'headings on one level');
    const widths = childElements(child(tablix, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => parseFloat(textOf(child(c, 'Width'))));
    const cells = childElements(child(rows[rowOf(total.attributes.Name!)]!, 'TablixCells')!, 'TablixCell');
    const at = cells.findIndex((c) => descendants(c).includes(total));
    assert.ok(widths[at]! >= 1253 / 1440 - 0.005, `the total's column as wide as Crystal drew the total: ${widths[at]}`);
    const diffAt = childElements(child(rows.find((r) => descendants(r).some((e) => e.name === 'Value' && textOf(e) === 'Rank Differential'))!, 'TablixCells')!, 'TablixCell').findIndex((c) => descendants(c).some((e) => e.name === 'Value' && textOf(e) === 'Rank Differential'));
    const diffBox = descendants(tablix).find((e) => e.name === 'Textbox' && valueOf(e) === 'Rank Differential')!;
    const drawn = descendants(diffBox).filter((e) => e.name === 'FontSize').map(textOf);
    const capped = drawn.some((v) => /IIf\(Val\(/.test(v) || parseFloat(v) < 8);
    assert.ok(widths[diffAt]! >= 0.75 || capped, `a heading's longest word fits its column, or its font is capped to fit: ${widths[diffAt]} ${drawn}`);
    assert.ok(widths[0]! >= 0.85 * (2800 / 1440) - 0.01, `the name column keeps its width: ${widths[0]}`);
    assert.deepEqual(diagnoseRdl(out, true).filter((x) => x.kind === 'overlap' || x.kind === 'cut off' || x.kind === 'empty row'), []);
  });

  it('lists a box holding more than one column heading', () => {
    const rdl = `<Report><ReportSections><ReportSection><Body><ReportItems><Rectangle Name="A_x_Rect"><ReportItems><Textbox Name="A_x_ColTxt"><Paragraphs/></Textbox><Textbox Name="A_x_2_ColTxt"><Paragraphs/></Textbox></ReportItems></Rectangle></ReportItems></Body></ReportSection></ReportSections></Report>`;
    assert.ok(diagnoseRdl(rdl, true).some((f) => f.kind === 'merge' && f.item === 'A_x_Rect'));
  });

  it('puts the lowest line of a grouped heading in a row of its own, a heading per column named after its field', () => {
    const names = ['Name', 'NowRating', 'NowWatch', 'WasRating', 'WasWatch'];
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: names.map((name) => ({ name, type: 'string' })) }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, width: number, height = 230) => ({ kind: 'text', name, text: value, style: { size: 8 }, align: 'center', ...box(x, y, width, height) });
    const rule = (name: string, x: number, y: number, width: number, height: number) => ({ kind: 'line', name, ...box(x, y, width, height), border: { sides: height ? [1, 0, 0, 0] : [0, 0, 1, 0], width: 20 } });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@all'], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 1100, objects: [
          t('Title', 'Ratings by Name', 0, 0, 8000, 288), { ...rule('TitleRule', 0, 300, 8000, 0), border: { sides: [0, 0, 1, 0], width: 60 } }, t('NameHead', 'Name', 100, 600, 2800),
          t('Group', 'Ratings', 3000, 360, 2880), t('Now', 'Now', 3000, 600, 1440), t('Was', 'Before', 4440, 600, 1440),
          t('H1', 'Rating', 3000, 840, 720), t('H2', 'Watch', 3720, 840, 720), t('H3', 'Rating', 4440, 840, 720), t('H4', 'Watch', 5160, 840, 720),
          rule('Under', 3000, 590, 2880, 0), rule('Middle', 4440, 360, 0, 720), rule('Left', 3000, 360, 0, 720)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 0, objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 230, objects: [
          { kind: 'field', name: 'N', field: 'T.Name', style: { size: 8 }, ...box(100, 0, 2800, 210) },
          ...names.slice(1).map((f, i) => ({ kind: 'field', name: f, field: `T.${f}`, style: { size: 8 }, ...box(3000 + i * 720, 0, 720, 210) }))] }] },
      ],
    } as unknown as ReportDefinition;
    const styled = { ...conventions, style: { dataset: 'Theme', commandType: 'StoredProcedure', command: 'dbo.theme_get', field: '{role}_{prop}', props: { Color: 'ink' }, roles: { title: 'Title', heading: 'Head' } } } as never;
    const out = applyConventions(convertToRdl(definition, src, { reportName: 'Holdings', formulasInQuery: true, rulesAsText: true }).rdl, 'Holdings', styled).rdl;
    const root = parseXml(out);
    const headings = descendants(root).filter((e) => e.name === 'Textbox' && /_ColTxt$/.test(e.attributes.Name ?? '')).map((e) => e.attributes.Name);
    for (const f of names) assert.ok(headings.includes(`Holdings_Tab_1_${f}_ColTxt`), `${f}: ${headings.join(' ')}`);
    const headRow = descendants(root).filter((e) => e.name === 'TablixRow').find((r) => descendants(r).some((e) => e.attributes.Name === 'Holdings_Tab_1_Name_ColTxt'))!;
    assert.ok(names.every((f) => descendants(headRow).some((e) => e.attributes.Name === `Holdings_Tab_1_${f}_ColTxt`)), 'every heading on one row');
    assert.ok(!descendants(headRow).some((e) => e.name === 'ColSpan'), 'which spans nothing, so the merge reorders it');
    assert.ok(!diagnoseRdl(out, true).some((f) => f.kind === 'merge' || f.kind === 'overlap'), diagnosisLine(diagnoseRdl(out, true)));
    assert.ok(!descendants(root).some((e) => e.name === 'Line'), 'the heading\'s rules drawn as the cells\' borders');
    const rules = descendants(root).filter((e) => e.name === 'LeftBorder');
    assert.ok(rules.length && rules.every((r) => /Head_ink/.test(textOf(child(r, 'Color')))), 'in the heading\'s colour');
  });
  it('keeps the band behind a value shown by condition and a subtotal label in its own column', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: ['D', 'S', 'P', 'N', 'A'].map((name) => ({ name, type: name === 'A' ? 'currency' : 'string' })) }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 210), ...extra });
    const t = (name: string, value: string, x: number, y: number, w: number) => ({ kind: 'text', name, text: value, style: { size: 8, bold: true }, ...box(x, y, w, 210) });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] },
        { name: 'plan', index: 3, kind: 'conditionalFormat', text: '{T.P}="N"', referencedFields: ['T.P'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 700, objects: [{ ...t('Title', 'Orders', 0, 0, 7200), style: { size: 11, bold: true } },
          t('DH', 'Order Date', 180, 375, 1065), t('SH', 'Ship Date', 1230, 375, 1110), t('PH', 'Plan', 2340, 375, 810), t('NH', 'Name', 3150, 375, 2500), t('AH', 'Amount', 5700, 375, 1400)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 300, objects: [t('Label', 'Subtotals:', 1680, 60, 1140), f('Sum', 'Sum of T.A', 5700, 60, 1400, { align: 'right' })] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('Dv', 'T.D', 180, 0, 1065), f('Sv', 'T.S', 1245, 0, 1005), f('Pv', 'T.P', 2535, 0, 450, { conditions: { suppress: { name: 'plan', index: 3 } } }), f('Nv', 'T.N', 3150, 0, 2500), f('Av', 'T.A', 5700, 0, 1400)] }] },
      ],
    } as unknown as ReportDefinition;
    const styled = { ...conventions, names: { ...conventions.names, subtotalText: '{T}_{col}_SubTotTxt' }, style: { dataset: 'Theme', commandType: 'StoredProcedure', command: 'dbo.theme_get', field: '{role}_{prop}', props: { BackgroundColor: 'fill' }, roles: { title: 'Title', heading: 'Head', body: 'Body', bodyFirst: 'Body', number: 'Body' }, rowBands: { odd: 'Odd', even: 'Even' } } } as never;
    const root = parseXml(applyConventions(convertToRdl(definition, src, { reportName: 'Orders', formulasInQuery: true, rulesAsText: true }).rdl, 'Orders', styled).rdl);
    const plan = descendants(root).find((e) => e.name === 'Textbox' && /_P_ColVal$/.test(e.attributes.Name ?? ''))!;
    assert.ok(!child(plan, 'Visibility'), 'shown or not, the cell keeps its band');
    assert.match(valueOf(plan), /^=IIf\(.*"N".*, Nothing, Fields!P\.Value\)$/);
    assert.match(textOf(child(childElements(plan, 'Style')[0]!, 'BackgroundColor')), /Mod 2/);
    const label = descendants(root).find((e) => e.name === 'Textbox' && valueOf(e) === 'Subtotals:')!;
    const cell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(label))!;
    assert.ok(!descendants(cell).some((e) => e.name === 'ColSpan'), 'the label in one column, so the merge moves its row with the columns');
    const members = descendants(root).filter((e) => e.name === 'TablixMember' && textOf(child(e, 'KeepWithGroup')) === 'Before');
    assert.equal(textOf(child(members[members.length - 1]!, 'Visibility/Hidden')), '=CountRows() = 0', 'no totals without records, as no group prints');
  });
});
