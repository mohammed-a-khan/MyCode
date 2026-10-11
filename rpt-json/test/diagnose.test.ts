import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { diagnoseRdl, diagnosisLine } from '../src/ssrs/diagnose.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { childElements, descendants, parseXml, textOf } from '../src/ssrs/xml.ts';

const source = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Kind', type: 'string' }, { name: 'Amount', type: 'currency' }] }] } as never;
const at = (x: number, width = 2880, height = 240) => ({ position: { x, y: 0 }, size: { width, height } });
const text = (name: string, value: string, x: number, height = 240): ReportObject => ({ kind: 'text', name, text: value, style: { size: 8 }, ...at(x, 2880, height) });
const field = (name: string, f: string, x: number): ReportObject => ({ kind: 'field', name, field: f, style: { size: 8 }, ...at(x) });
const conventions = readConventions(JSON.stringify({ names: { table: '{S}_Tab_{n}', heading: '{T}_{col}_ColTxt', value: '{T}_{col}_ColVal', blank: '{T}_blnk{n}' } }));

/** A grouped report with a heading of two lines and an empty group header a few points high. */
function template(): string {
  const definition = {
    saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
    formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['T.Kind'] }],
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 480, objects: [text('KindHeading', 'Security\nType', 0, 480), text('AmountHeading', 'Amount', 2880)] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 40, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('K', 'T.Kind', 0), field('A', 'T.Amount', 2880)] }] },
    ],
  } as unknown as ReportDefinition;
  return applyConventions(convertToRdl(definition, source, { reportName: 'Holdings' }).rdl, 'Holdings', conventions).rdl;
}

describe('a check of the finished report', () => {
  it('writes a heading of fixed lines as text, one paragraph a line, and leaves out an empty sliver of a row', () => {
    const rdl = template();
    const heading = descendants(parseXml(rdl)).find((e) => e.attributes.Name === 'Holdings_Tab_1_Kind_ColTxt')!;
    const lines = childElements(descendants(heading).find((e) => e.name === 'Paragraphs')!, 'Paragraph').map((p) => textOf(descendants(p).find((e) => e.name === 'Value')));
    assert.deepEqual(lines, ['Security', 'Type']);
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
