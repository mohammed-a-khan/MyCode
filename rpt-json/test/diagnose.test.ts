import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { diagnoseRdl, diagnosisLine } from '../src/ssrs/diagnose.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, childElements, descendants, parseXml, textOf } from '../src/ssrs/xml.ts';

const source = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Kind', type: 'string' }, { name: 'Amount', type: 'currency' }] }] } as never;
const at = (x: number, width = 2880, height = 240) => ({ position: { x, y: 0 }, size: { width, height } });
const text = (name: string, value: string, x: number, height = 240): ReportObject => ({ kind: 'text', name, text: value, style: { size: 8 }, ...at(x, 2880, height) });
const field = (name: string, f: string, x: number): ReportObject => ({ kind: 'field', name, field: f, style: { size: 8 }, ...at(x) });
const conventions = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', title: '{S}_SchTitle_Txt', heading: '{T}_{col}_ColTxt', value: '{T}_{col}_ColVal', blank: '{T}_blnk{n}' } }));

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
});
