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

  it('takes two items shown one at a time in the same place as alternates, not as drawn over each other', () => {
    const box = (name: string, hidden: string) => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>x</Value></TextRun></TextRuns></Paragraph></Paragraphs><Visibility><Hidden>${hidden}</Hidden></Visibility><Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width></Textbox>`;
    const rdl = (a: string, b: string) => `<Report><ReportSections><ReportSection><Body><ReportItems>${box('Shown', a)}${box('Other', b)}</ReportItems><Height>1in</Height></Body><Width>1in</Width><Page><PageWidth>8.5in</PageWidth></Page></ReportSection></ReportSections></Report>`;
    const overlaps = (a: string, b: string) => diagnoseRdl(rdl(a, b)).filter((f) => f.kind === 'overlap').length;
    assert.equal(overlaps('=Parameters!k.Value = 1', '=Not (Parameters!k.Value = 1)'), 0);
    assert.equal(overlaps('=(Not ((Parameters!k.Value = 1)))', '=Parameters!k.Value = 1'), 0);
    assert.equal(overlaps('=Parameters!k.Value = 1', '=Parameters!k.Value = 2'), 0);
    assert.equal(overlaps('=Not ((Parameters!k.Value = 1))', '=Not ((Parameters!k.Value = 2))'), 0);
    assert.equal(overlaps('=Parameters!k.Value = 1', '=Parameters!j.Value = 1'), 1);
    assert.equal(overlaps('=Not ((Parameters!k.Value = 1))', '=Parameters!k.Value = 2'), 1);
  });

  it('takes a heading naming its column from the data as meant, and still lists one showing the column\'s own value', () => {
    const box = (name: string, value: string) => `<Textbox Name="${name}"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox>`;
    const rdl = `<Report><ReportSections><ReportSection><Body><ReportItems><Tablix Name="T"><TablixBody><TablixRows><TablixRow><TablixCells>
<TablixCell><CellContents>${box('T_a_ColTxt', '=Fields!head_a.Value')}</CellContents></TablixCell><TablixCell><CellContents>${box('T_b_ColTxt', '=Fields!b.Value')}</CellContents></TablixCell>
</TablixCells></TablixRow><TablixRow><TablixCells>
<TablixCell><CellContents>${box('T_a_ColVal', '=Fields!a.Value')}</CellContents></TablixCell><TablixCell><CellContents>${box('T_b_ColVal', '=Fields!b.Value')}</CellContents></TablixCell>
</TablixCells></TablixRow></TablixRows></TablixBody></Tablix></ReportItems></Body></ReportSection></ReportSections></Report>`;
    const listed = diagnoseRdl(rdl, true).filter((f) => f.kind === 'expression').map((f) => f.item);
    assert.deepEqual(listed, ['T_b_ColTxt']);
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
    assert.equal(textOf(child(childElements(total, 'Style')[0]!, 'PaddingTop')), '0pt', 'the total right under its rule');
    assert.equal(textOf(child(childElements(total, 'Style')[0]!, 'VerticalAlign')), 'Top');
    const totalCell = descendants(root).find((e) => e.name === 'TablixCell' && descendants(e).includes(total))!;
    assert.ok(childElements(child(totalCell, 'CellContents')!).includes(total), 'the total right in its cell');
    const totalRow = rows.findIndex((r) => descendants(r).includes(total));
    const cellsIn = (r: XmlElement) => childElements(child(r, 'TablixCells')!, 'TablixCell');
    const rule = descendants(cellsIn(rows[totalRow - 1]!)[cellsIn(rows[totalRow]!).indexOf(totalCell)]!).find((e) => e.name === 'Line');
    assert.equal(textOf(child(rule!, 'Width')), '1.389in', 'its rule on the row above, as wide as Crystal drew it');
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
    const inCell = (t: XmlElement) => descendants(root).some((e) => e.name === 'CellContents' && childElements(e).includes(t));
    assert.ok(totals.every(inCell), 'each total right in its cell, where reports are combined');
    assert.ok(totals.every((t) => /Solid/.test(textOf(child(childElements(t, 'Style')[0]!, 'TopBorder/Style')))), 'each total ruled by its own top border');
    const later = parseXml(applyConventions(out.replace(/(<Tablix Name=")([^"]+)(">[\s\S]*?<\/Tablix>)/, (m) => m + m.replace(/Name="([^"]+)"/g, 'Name="$1_b"').replace(/(<\/TablixRowHierarchy>[\s\S]*?<Top>)[^<]*(<\/Top>)/, '$15in$2')), 'Holdings', styled).rdl);
    const [first, second] = descendants(later).filter((e) => e.name === 'Tablix');
    const firstCount = childElements(child(first!, 'TablixBody/TablixColumns')!, 'TablixColumn').length;
    assert.ok(!descendants(second!).some((e) => e.name === 'ColSpan' && Number(textOf(e)) === firstCount), 'no span in a later table that the merge would take for the first table\'s width');
    const bands = descendants(root).filter((e) => e.name === 'BackgroundColor' && /Mod 2/.test(textOf(e))).map(textOf);
    assert.ok(bands.length && bands.every((b) => /RunningValue\(IIf\(\(Not IsNothing/.test(b)), `rows counted as shown: ${bands[0]}`);
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
  it('puts a first-page block of figures into the table under the title, and a message drawn over a value into that value', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Code', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Base', type: 'currency' }, { name: 'Part', type: 'currency' }, { name: 'C', type: 'number' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8, bold: true }, ...box(x, y, w, 240), ...extra });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 210), ...extra });
    const line = (name: string, y: number) => ({ kind: 'line', name, ...box(0, y, 8640, 0), border: { sides: [0, 0, 1, 0], width: 60 } });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'Empty', index: 1, kind: 'formula', text: 'if {T.C} = 0 then "NONE THIS PERIOD"', referencedFields: ['T.C'] },
        { name: 'First', index: 2, kind: 'conditionalFormat', text: 'pagenumber <> 1', referencedFields: [] }],
      layout: [
        { name: 'PageHeaderArea1', sections: [
          { name: 'PH1', height: 441, objects: [t('Title', 'Orders in Detail', 0, 0, 8640, { style: { size: 11, bold: true } }), line('Rule', 340)] },
          { name: 'PH2', height: 1150, conditions: { suppress: { name: 'First', index: 2 } }, objects: [
            t('BaseLabel', 'Base Amount:', 360, 480, 2400), f('BaseValue', 'T.Base', 3000, 480, 1440, { align: 'right' }), t('A', '(A)', 4500, 480, 360),
            t('PartLabel', 'Part Amount', 360, 840, 2400), f('PartValue', 'T.Part', 3000, 840, 1440, { align: 'right' }), t('B', '(B)', 4500, 840, 360),
            t('Way', 'METHOD', 5400, 240, 1320, { align: 'center' }), t('Share', '(B)/(A)', 5400, 840, 1320, { align: 'center' })] },
          { name: 'PH3', height: 888, objects: [line('Top', 35), t('NameHeading', 'Name', 360, 360, 2400), t('CodeHeading', 'Code', 3000, 360, 1440), t('AmountHeading', 'Amount', 5400, 360, 1440), line('Bottom', 840)] }] },
        ...['PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('N', 'T.Name', 360, 0, 2400), f('M', '@Empty', 360, 30, 3600), f('K', 'T.Code', 3000, 0, 1440), f('V', 'T.Amount', 5400, 0, 1440, { align: 'right' })] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, src, { reportName: 'Orders', formulasInQuery: true }).rdl, 'Orders', conventions).rdl);
    const tablix = descendants(root).find((e) => e.name === 'Tablix')!;
    const names = descendants(tablix).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    assert.ok(names.indexOf('Orders_SchTitle_Txt') >= 0 && names.indexOf('Orders_SchTitle_Txt') < names.findIndex((n) => /Base_HdrVal$/.test(n)), 'the title above the block');
    assert.ok(names.some((n) => /Base_HdrTxt$/.test(n)) && names.some((n) => /METHOD_HdrTxt$/.test(n)) && names.some((n) => /METHOD_HdrVal$/.test(n)));
    assert.ok(!descendants(root).some((e) => e.name === 'Rectangle' && !descendants(tablix).includes(e) && !descendants(e).includes(tablix)), 'nothing left beside the table');
    const value = descendants(tablix).find((e) => e.attributes.Name === 'Orders_Tab_1_Name_ColVal')!;
    assert.match(valueOf(value), /^=IIf\(IsNothing\(Fields!F_Empty\.Value\).*, Fields!Name\.Value, Fields!F_Empty\.Value\)$/);
    assert.ok(names.includes('Orders_Tab_1_Name_ColTxt') && names.includes('Orders_Tab_1_Code_ColTxt'));
    assert.ok(!names.some((n) => /Empty_ColVal/.test(n)), 'the message is no item of its own');
  });
  it('folds an unlabelled first column into the next, keeps a full-width message as text, and hides an empty total and its rule', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Code', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Kind', type: 'string' }, { name: 'Flag', type: 'number' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8 }, ...box(x, y, w, 240), ...extra });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 210), ...extra });
    const line = (name: string, y: number) => ({ kind: 'line', name, ...box(0, y, 8640, 0), border: { sides: [0, 0, 1, 0], width: 60 } });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@all', 'T.Kind'], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] },
        { name: 'Empty', index: 2, kind: 'formula', text: 'if {T.Flag} = 0 then "NONE THIS PERIOD"', referencedFields: ['T.Flag'] },
        { name: 'Off', index: 3, kind: 'conditionalFormat', text: '{T.Flag}=0', referencedFields: ['T.Flag'] },
        { name: 'Group #1 Order', index: 4, kind: 'internal', text: '', referencedFields: ['@all'] },
        { name: 'Group #2 Order', index: 5, kind: 'internal', text: '', referencedFields: ['T.Kind'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 900, objects: [t('Title', 'Orders in Detail', 0, 0, 8640, { align: 'center', style: { size: 11, bold: true } }), line('Rule', 300),
          t('NameHeading', 'Name', 1200, 480, 3000, { align: 'center' }), t('CodeHeading', 'Code', 4320, 480, 1440, { align: 'center' }), t('AmountHeading', 'Amount', 5760, 480, 1440, { align: 'center' }), line('Under', 800)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, objects: [] }] },
        { name: 'GroupHeaderArea2', sections: [{ name: 'GH2', height: 240, objects: [f('Kind', 'Group #2', 0, 0, 4000)] }] },
        { name: 'GroupFooterArea2', sections: [{ name: 'GF2', height: 240, objects: [t('Label', 'TOTALS:', 400, 20, 1200), f('Sum', 'Sum of T.Amount', 6200, 20, 1000, { align: 'right', border: { sides: [0, 0, 1, 0], width: 20 }, conditions: { suppress: { name: 'Off', index: 3 } } })] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 270, objects: [f('N', 'T.Name', 1200, 30, 3000), f('M', '@Empty', 300, 60, 5000), f('K', 'T.Code', 4320, 0, 1440), f('V', 'T.Amount', 5760, 0, 1440, { align: 'right' })] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, src, { reportName: 'Orders', formulasInQuery: true, rulesAsText: true }).rdl, 'Orders', conventions).rdl);
    const tablix = descendants(root).find((e) => e.name === 'Tablix')!;
    const names = descendants(tablix).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    const columns = childElements(child(tablix, 'TablixBody/TablixColumns')!, 'TablixColumn').length;
    assert.equal(columns, names.filter((n) => /_ColTxt$/.test(n)).length, 'one column per heading');
    assert.ok(names.includes('Orders_Tab_1_Name_ColTxt') && names.includes('Orders_Tab_1_Name_ColVal'));
    assert.ok(!names.some((n) => /Empty_ColVal/.test(n)), 'a message across the table is no column value');
    const rule = descendants(tablix).find((e) => e.name === 'Line' && /Amount/.test(e.attributes.Name ?? ''))!;
    assert.match(textOf(child(rule, 'Visibility/Hidden')), /Flag.*OrElse IsNothing\(Sum\(Fields!Amount\.Value\)\)/);
    assert.ok(parseFloat(textOf(child(rule, 'Style/Border/Width'))) >= 1.5, 'the rule over a total is drawn as heavy as the total\'s border prints');
    const title = descendants(tablix).find((e) => e.attributes.Name === 'Orders_SchTitle_Txt')!;
    assert.equal(textOf(child(childElements(title, 'Style')[0]!, 'PaddingBottom')), '4pt', 'room between the title and its rule');
  });
  it('gives a column to totals beyond the last value, takes page-header headings over it, and draws upright lines as cell sides', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Code', type: 'string' }, { name: 'Name', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Running', type: 'currency' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8 }, ...box(x, y, w, 240), ...extra });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 200), ...extra });
    const up = (name: string, x: number, h: number) => ({ kind: 'line', name, ...box(x, 0, 0, h), border: { sides: [1, 0, 0, 0], width: 20 } });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['T.Code'], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'Group #1 Order', index: 1, kind: 'internal', text: '', referencedFields: ['T.Code'] }],
      layout: [
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 1600, objects: [t('Title', 'Items in Detail', 300, 300, 8000, { align: 'center' }),
          { kind: 'box', name: 'Frame', ...box(250, 1150, 6400, 2000), border: { sides: [1, 1, 1, 1], width: 20 } },
          t('CodeHeading', 'Code', 300, 1200, 800, { align: 'center' }), t('NameHeading', 'Name', 1300, 1200, 2000, { align: 'center' }),
          t('AmountHeading', 'Amount', 3500, 1200, 1400, { align: 'center' }), t('RunningHeading', 'Running', 5100, 1200, 1400, { align: 'center' })] }] },
        ...['PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 240, objects: [f('CodeValue', 'T.Code', 300, 0, 900)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 240, objects: [t('Label', 'Sub Totals:', 1300, 0, 1200), f('SumAmount', 'Sum of T.Amount', 3500, 0, 1400, { align: 'right' }),
          f('SumRunning', 'Sum of T.Running', 5100, 0, 1400, { align: 'right' })] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('N', 'T.Name', 1300, 0, 2000), f('A', 'T.Amount', 3500, 0, 1400, { align: 'right' }),
          f('R', 'T.Running', 5100, 0, 1400, { align: 'right', suppressed: true }), up('L1', 1250, 240), up('L2', 3450, 240), up('L3', 5050, 240)] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, src, { reportName: 'Items', formulasInQuery: true, rulesAsText: true }).rdl, 'Items', conventions).rdl);
    const tablix = descendants(root).find((e) => e.name === 'Tablix')!;
    const names = descendants(tablix).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    assert.equal(childElements(child(tablix, 'TablixBody/TablixColumns')!, 'TablixColumn').length, 4);
    for (const col of ['Code', 'Name', 'Amount', 'Running']) assert.ok(names.includes(`Items_Tab_1_${col}_ColTxt`) && names.includes(`Items_Tab_1_${col}_ColVal`), col);
    const amount = descendants(tablix).find((e) => e.attributes.Name === 'Items_Tab_1_Amount_ColVal')!;
    assert.ok(child(childElements(amount, 'Style')[0]!, 'LeftBorder'), 'the line beside the value');
    assert.ok(!child(childElements(amount, 'Style')[0]!, 'TopBorder'), 'an upright line is no rule along the row');
    assert.ok(child(childElements(amount, 'Style')[0]!, 'RightBorder'), 'the next column\'s line also on this side, so it moves with the column');
    const running = descendants(tablix).find((e) => e.name === 'Textbox' && /Running_(Sub)?(TotVal|total)$/i.test(e.attributes.Name ?? ''))!;
    assert.ok(child(childElements(running, 'Style')[0]!, 'RightBorder'), 'the frame closes the last column');
  });
  it('folds nested groups on a constant into the table: headings named and styled, the block above them printed once', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Base', type: 'currency' }, { name: 'Other', type: 'currency' }, { name: 'BaseHeader', type: 'string' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8 }, ...box(x, y, w, 240), ...extra });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 210), ...extra });
    const all = (name: string, index: number) => ({ name, index, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] });
    const order = (n: number, ref: string) => ({ name: `Group #${n} Order`, index: 10 + n, kind: 'internal', text: '', referencedFields: [ref] });
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@a', '@b', '@c'], sortFields: [], summarizedFields: [],
      formulas: [all('a', 1), all('b', 2), all('c', 3), order(1, '@a'), order(2, '@b'), order(3, '@c')],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 288, objects: [t('Title', 'Items in Detail', 0, 0, 8640, { align: 'center' })] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, objects: [] }] },
        { name: 'GroupHeaderArea2', sections: [{ name: 'GH2', height: 800, objects: [f('BaseLabel', 'T.BaseHeader', 300, 100, 2400), f('BaseValue', 'T.Base', 3000, 100, 1440, { align: 'right' }),
          t('OtherLabel', 'Other Amount', 5000, 100, 1600), f('OtherValue', 'T.Other', 6800, 100, 1440, { align: 'right' }), t('A', '(A)', 4500, 100, 400), t('Note', 'Part Amount', 300, 450, 2400), f('Part', 'T.Amount', 3000, 450, 1440, { align: 'right' })] }] },
        { name: 'GroupFooterArea2', sections: [{ name: 'GF2', height: 0, objects: [] }] },
        { name: 'GroupHeaderArea3', sections: [{ name: 'GH3', height: 400, objects: [t('NameHeading', 'Name', 300, 80, 2400), t('AmountHeading', 'Amount', 3000, 80, 1440),
          t('BaseHeading', 'Base', 5000, 80, 1600), t('OtherHeading', 'Other', 6800, 80, 1440)] }] },
        { name: 'GroupFooterArea3', sections: [{ name: 'GF3', height: 240, objects: [t('Label', 'TOTALS:', 300, 0, 1200), f('Sum', 'Sum of T.Amount', 3000, 0, 1440, { align: 'right' })] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('N', 'T.Name', 300, 0, 2400), f('V', 'T.Amount', 3000, 0, 1440, { align: 'right' }),
          f('B', 'T.Base', 5000, 0, 1600, { align: 'right' }), f('O', 'T.Other', 6800, 0, 1440, { align: 'right' })] }] },
      ],
    } as unknown as ReportDefinition;
    const done = applyConventions(convertToRdl(definition, src, { reportName: 'Items', formulasInQuery: true, rulesAsText: true }).rdl, 'Items', conventions);
    assert.ok(done.review.some((r) => /summary label for Amount ends with a column's name/.test(r.message)), 'a label that cannot be named apart is noted');
    const root = parseXml(done.rdl);
    const tablix = descendants(root).find((e) => e.name === 'Tablix')!;
    const names = descendants(tablix).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    assert.ok(names.includes('Items_Tab_1_Name_ColTxt') && names.includes('Items_Tab_1_Amount_ColTxt'), names.join(' '));
    assert.ok(names.includes('Items_Tab_1_BaseHeader_HdrTxt') && names.includes('Items_Tab_1_BaseHeader_HdrVal'), 'a summary named apart from the columns, label and value alike');
    assert.ok(names.some((n) => /Other_HdrTxt$/.test(n)) && names.some((n) => /Other_HdrVal$/.test(n)));
    assert.ok(!descendants(tablix).some((e) => e.name === 'Group' && /grp_[23]/.test(e.attributes.Name ?? '')), 'no groups of their own for the constant ones');
    const leaves = (holder: XmlElement): XmlElement[] => childElements(holder, 'TablixMember').flatMap((m) => (child(m, 'TablixMembers') ? leaves(child(m, 'TablixMembers')!) : [m]));
    const members = leaves(child(tablix, 'TablixRowHierarchy/TablixMembers')!);
    const rows = childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow');
    const repeats = (name: RegExp) => { const i = rows.findIndex((r) => descendants(r).some((e) => name.test(e.attributes.Name ?? ''))); return textOf(child(members[i]!, 'RepeatOnNewPage')) === 'true'; };
    assert.ok(!repeats(/BaseHeader_HdrTxt$/), 'the block above the headings prints once');
    assert.ok(repeats(/Name_ColTxt$/), 'the headings print on every page');
    assert.ok(descendants(child(tablix, 'TablixRowHierarchy')!).filter((e) => e.name === 'TablixMember' && child(e, 'TablixMembers')).every((e) => child(e, 'Group')), 'repeated rows stay beside their group');
    for (const holder of descendants(child(tablix, 'TablixRowHierarchy')!).filter((e) => e.name === 'TablixMembers')) {
      const kids = childElements(holder, 'TablixMember');
      const at = kids.findIndex((m) => child(m, 'Group'));
      if (at < 0) continue;
      const before = new Set(kids.slice(0, at).map((m) => textOf(child(m, 'RepeatOnNewPage')) === 'true'));
      assert.ok(before.size <= 1, 'the rows beside a group repeat alike');
    }
  });
  it('puts totals printed at the report\'s end into the table when its one group is on a constant', () => {
    const src = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Code', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Other', type: 'currency' }, { name: 'Rows', type: 'number' }] }] } as never;
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const t = (name: string, value: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'text', name, text: value, style: { size: 8 }, ...box(x, y, w, 240), ...extra });
    const f = (name: string, fld: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: fld, style: { size: 8 }, ...box(x, y, w, 195), ...extra });
    const off = { conditions: { suppress: { name: 'None', index: 3 } } };
    const ruled = { align: 'right', border: { sides: [0, 0, 1, 0], width: 20 }, ...off };
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: ['@all'], sortFields: [], summarizedFields: [],
      formulas: [{ name: 'all', index: 1, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] }, { name: 'Group #1 Order', index: 2, kind: 'internal', text: '', referencedFields: ['@all'] },
        { name: 'None', index: 3, kind: 'conditionalFormat', text: '{T.Rows} = 0', referencedFields: ['T.Rows'] }],
      layout: [
        ...['PageHeaderArea1', 'PageFooterArea1', 'ReportHeaderArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 315, objects: [t('Label', 'TOTALS:', 600, 60, 1080, off), f('SumA', 'Sum of T.Amount', 5000, 120, 2200, ruled), f('SumO', 'Sum of T.Other', 7200, 85, 1440, ruled)] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 600, objects: [t('Title', 'Items in Detail', 0, 0, 8640, { align: 'center' }),
          t('NameHeading', 'Name', 300, 300, 2400), t('CodeHeading', 'Code', 3000, 300, 1440), t('AmountHeading', 'Amount', 5760, 300, 1440), t('OtherHeading', 'Other', 7200, 300, 1440)] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, suppressed: true, objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('N', 'T.Name', 300, 0, 2400), f('C', 'T.Code', 3000, 0, 1440), f('V', 'T.Amount', 5760, 0, 1440, { align: 'right' }), f('O', 'T.Other', 7200, 0, 1440, { align: 'right' })] }] },
      ],
    } as unknown as ReportDefinition;
    const root = parseXml(applyConventions(convertToRdl(definition, src, { reportName: 'Items', formulasInQuery: true, rulesAsText: true }).rdl, 'Items', conventions).rdl);
    const body = descendants(root).find((e) => e.name === 'Body')!;
    const tablix = descendants(body).find((e) => e.name === 'Tablix')!;
    const names = descendants(tablix).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    assert.ok(names.includes('Items_Tab_1_TotTxt') && names.includes('Items_Tab_1_Amount_TotVal') && names.includes('Items_Tab_1_Other_TotVal'), names.join(' '));
    const outside = descendants(body).filter((e) => ['Textbox', 'Rectangle', 'Line'].includes(e.name) && !descendants(tablix).includes(e) && !descendants(tablix).some((x) => descendants(x).includes(e)));
    const style = (name: string) => childElements(descendants(tablix).find((e) => e.attributes.Name === name)!, 'Style')[0]!;
    assert.equal(textOf(child(style('Items_Tab_1_Amount_TotVal'), 'PaddingRight')), textOf(child(style('Items_Tab_1_Amount_ColVal'), 'PaddingRight')), 'a total ends where the values above it end');
    assert.equal(textOf(child(style('Items_Tab_1_Name_ColVal'), 'VerticalAlign')), 'Top', 'values keep to the top of a row another value makes taller');
    assert.ok(!outside.some((e) => /Txt_\d|Rect_[2-9]|Footer/.test(e.attributes.Name ?? '')), 'nothing of the totals left beside the table');
  });
  it('makes one table of subreports that repeat one layout over tables of the same columns, one block each', () => {
    const cols = ['row_order', 'row_text', 'bold_value', 'head_1', 'amount_1', 'head_2', 'amount_2', 'head_3', 'amount_3', 'owner_key'];
    const params = [{ name: 'owner_key', type: 'number' }];
    const box = (x: number, y: number, width: number, height: number) => ({ position: { x, y }, size: { width, height } });
    const sub = (k: number, shift = 0) => {
      const T = `block_${k}`;
      const f = (name: string, col: string, x: number, y: number, w: number, extra = {}) => ({ kind: 'field', name, field: `${T}.${col}`, style: { size: 8 }, ...box(x + shift, y, w, 200), ...extra });
      const definition = {
        saveInfo: {}, sqlExpressions: [], parameters: params, groups: ['@all'], sortFields: [`${T}.row_order`], summarizedFields: [],
        selectionFormulas: { record: `{${T}.owner_key} = {?owner_key}` },
        formulas: [{ name: 'all', index: 0, kind: 'formula', text: 'WhileReadingRecords; "All"', referencedFields: [] }, { name: 'Group #1 Order', index: 1, kind: 'internal', text: '', referencedFields: ['@all'] },
          { name: 'Top_Line', index: 2, kind: 'conditionalFormat', text: `IF {${T}.bold_value} = "T" THEN crSingleLine ELSE crNoLine`, referencedFields: [`${T}.bold_value`] }],
        layout: [
          ...['ReportHeaderArea1', 'ReportFooterArea1'].map((name) => ({ name, sections: [{ name, height: 0, suppressed: true, objects: [] }] })),
          { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 300, objects: [...[1, 2, 3].map((i) => f(`H${i}`, `head_${i}`, 1440 + i * 1440, 60, 1300)), { kind: 'line', name: 'Top', ...box(0, 0, 7200, 0), border: { sides: [0, 0, 1, 0], width: 30 } }] },
            { name: 'GH2', height: 90, objects: [{ kind: 'line', name: 'Under', ...box(0, 60, 7200, 0), border: { sides: [0, 0, 1, 0], width: 30 } }] }] },
          { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, suppressed: true, objects: [] }] },
          { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [f('L', 'row_text', 60, 20, 2600), ...[1, 2, 3].map((i) => f(`V${i}`, `amount_${i}`, 1440 + i * 1440, 20, 1300, { align: 'right', conditions: { topLine: { name: 'Top_Line', index: 2 } } }))] }] },
        ],
      } as unknown as ReportDefinition;
      const dataSource = { connections: [], links: [], tables: [{ alias: T, name: T, schema: 'dbo', kind: 'table', fields: cols.map((name) => ({ name, type: /amount|order|entity/.test(name) ? 'number' : 'string' })) }] };
      return { name: `Sub${k}`, links: [], parameters: ['owner_key'], definition, dataSource } as never;
    };
    const main = (shift: number) => ({
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: params, groups: [], sortFields: [], summarizedFields: [], formulas: [],
      layout: [
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 300, objects: [{ kind: 'text', name: 'Title', text: 'Blocks Title', align: 'center', style: { size: 12, bold: true }, ...box(0, 0, 8000, 300) }] }] },
        ...['PageFooterArea1', 'ReportHeaderArea1'].map((name) => ({ name, sections: [{ name, height: 0, objects: [] }] })),
        { name: 'ReportFooterArea1', sections: [1, 2, 3].map((k) => ({ name: `RF${k}`, height: 300, newPageBefore: k > 1, objects: [{ kind: 'subreport', name: `S${k}`, subreport: { index: k + 1, onDemand: false }, ...box(0, 0, 8000, 300) }] })) },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 0, suppressed: true, objects: [] }] },
      ],
    } as unknown as ReportDefinition);
    const build = (shift: number) => {
      const subreports = new Map([1, 2, 3].map((k) => [k + 1, sub(k, k === 3 ? shift : 0)] as [number, never]));
      const converted = convertToRdl(main(shift), { connections: [], links: [], tables: [] } as never, { reportName: 'Blocks', subreports, formulasInQuery: true, rulesAsText: true } as never);
      return { converted, root: parseXml(applyConventions(converted.rdl, 'Blocks', conventions).rdl) };
    };
    const { converted, root } = build(0);
    const tables = descendants(root).filter((e) => e.name === 'Tablix');
    assert.equal(tables.length, 2, 'one table for every block, and the one beside it that moves it');
    const pad = tables[1]!;
    const members = childElements(child(pad, 'TablixColumnHierarchy/TablixMembers')!, 'TablixMember');
    assert.equal(members.length, childElements(child(tables[0]!, 'TablixColumnHierarchy/TablixMembers')!, 'TablixMember').length, 'as many columns as the table, so trimming either keeps both whole');
    assert.ok(members.slice(0, -1).every((m) => !child(m, 'Group')) && textOf(child(members.at(-1)!, 'Group/Filters/Filter/Operator')) === 'TopN', 'only its last column grows, so a merge dropping any column drops the growth');
    const grows = textOf(child(members.at(-1)!, 'Group/Filters/Filter/FilterValues/FilterValue'));
    assert.ok(/head_2/.test(grows) && grows.includes(`"${textOf(child(tables[0]!, 'DataSetName'))}"`), grows);
    assert.equal(textOf(child(tables[0]!, 'Left')), textOf(child(pad, 'Width')), 'the table starts where the one beside it ends');
    const paged = child(pad, 'TablixRowHierarchy/TablixMembers/TablixMember/Group')!;
    assert.match(textOf(child(paged, 'GroupExpressions/GroupExpression')), /block_no/);
    assert.equal(textOf(child(paged, 'PageBreak/BreakLocation')), 'Between', 'a row beside every block\'s page, so each page is moved');
    assert.ok(descendants(root).find((e) => e.name === 'ReportItems' && e.children.includes(tables[0]!))!.children.indexOf(pad) > 0, 'the table stays first for the merges');
    const names = descendants(tables[0]!).filter((e) => e.name === 'Textbox').map((e) => e.attributes.Name ?? '');
    for (const col of ['row_text', 'amount_1', 'amount_2', 'amount_3']) assert.ok(names.includes(`Blocks_Tab_1_${col}_ColTxt`) && names.includes(`Blocks_Tab_1_${col}_ColVal`), `${col} heading and value: ${names.join(' ')}`);
    const query = descendants(root).filter((e) => e.name === 'CommandText').map((e) => textOf(e)).join('\n');
    assert.equal(query.match(/UNION ALL/g)?.length, 2, 'one query reads the three tables');
    assert.match(query, /SELECT 3 AS \[block_no\][\s\S]*\[block_3\]\.\[owner_key\] = @owner_key/);
    const group = descendants(tables[0]!).find((e) => e.name === 'Group' && /block_no/.test(textOf(child(e, 'GroupExpressions/GroupExpression'))))!;
    assert.equal(textOf(child(group, 'PageBreak/BreakLocation')), 'Between', 'each block on a page of its own, as each printed');
    const rule = descendants(tables[0]!).find((e) => e.name === 'Line' && /amount_2/.test(e.attributes.Name ?? ''))!;
    assert.match(textOf(child(rule, 'Style/Border/Style')), /head_2/, 'no rule over a column the block has no heading for');
    const heading = descendants(tables[0]!).find((e) => e.attributes.Name === 'Blocks_Tab_1_amount_2_ColTxt')!;
    const sides = descendants(childElements(heading, 'Style')[0]!).filter((e) => /Border$/.test(e.name)).map((e) => textOf(child(e, 'Style'))).filter((v) => v && v !== 'None');
    assert.ok(sides.length && sides.every((v) => /head_2/.test(v)), 'the heading rules stop where the block has no heading');
    assert.equal(textOf(child(heading, 'Style/VerticalAlign')), 'Top', 'a one-line heading sits at the top beside a two-line one');
    const headRow = descendants(tables[0]!).filter((e) => e.name === 'TablixRow').find((r) => descendants(r).includes(heading))!;
    const allRows = descendants(tables[0]!).filter((e) => e.name === 'TablixRow');
    const ruleRow = allRows[allRows.indexOf(headRow) - 1]!;
    const ruled = descendants(ruleRow).filter((e) => e.name === 'BottomBorder').map((e) => textOf(child(e, 'Style')));
    assert.ok(ruled.length > 2 && ruled[0] === 'Solid' && /head_2/.test(ruled[2]!), `the rule over the headings stops where the block ends: ${ruled.join(' | ')}`);
    assert.ok(!child(heading, 'Style/TopBorder'), 'the rule is not drawn twice');
    const holder = child(tables[0]!, 'TablixRowHierarchy/TablixMembers')!;
    const before = childElements(holder, 'TablixMember').filter((m) => !child(m, 'Group'));
    assert.ok(before.length && before.every((m) => textOf(child(m, 'RepeatOnNewPage')) === 'true'), 'the title prints on every block\'s page');
    assert.ok(child(childElements(heading, 'Style')[0]!, 'BottomBorder'), 'the rule under the headings is drawn on them, with no row of its own');
    const columns = childElements(child(tables[0]!, 'TablixColumnHierarchy/TablixMembers')!, 'TablixMember').map((m) => textOf(child(m, 'Visibility/Hidden')));
    assert.ok(!columns[0] && columns.slice(1).every((v) => /^=CountRows\(\) > 0 AndAlso Max\(IIf\(.*head_\d/.test(v)), `a column no block has a heading for is left out: ${columns.join(' | ')}`);
    assert.ok(converted.review.some((r) => r.item === 'Subreports'));
    const apart = build(200).root;
    assert.equal(descendants(apart).filter((e) => e.name === 'Tablix').length, 3, 'layouts that differ stay apart');
  });
});

