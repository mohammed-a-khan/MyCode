import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataSourceInfo, ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, childElements, descendants, parseXml, textOf, type XmlElement } from '../src/ssrs/xml.ts';

const source: DataSourceInfo = {
  connections: [],
  links: [],
  tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Region', type: 'string' }, { name: 'Customer', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
};

const emptyDefinition = (): ReportDefinition => ({
  saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [], formulas: [], layout: [],
} as unknown as ReportDefinition);

const at = (x: number, width = 2880, height = 240) => ({ position: { x, y: 0 }, size: { width, height } });
const text = (name: string, value: string, x: number, extra: Partial<ReportObject> = {}): ReportObject => ({ kind: 'text', name, text: value, style: { size: 8 }, ...at(x), ...extra });
const field = (name: string, f: string, x: number): ReportObject => ({ kind: 'field', name, field: f, style: { size: 8 }, ...at(x) });

/** A grouped report: a title over the table, headings, rows of data, subtotals, a grand total under the table. */
function converted(): string {
  const definition: ReportDefinition = {
    ...emptyDefinition(),
    parameters: [{ name: 'Pm-Orders.As_Of_Date', valueType: 'dateTime' }],
    formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Region'] }],
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 360, objects: [text('Title', 'Orders by Region', 0, { style: { size: 12 }, ...at(0, 5760, 300) })] }] },
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [
        text('CustomerHeading', 'Customer', 0), text('AmountHeading', 'Amount', 2880),
        { kind: 'field', name: 'PageNo', field: 'Page Number', style: { size: 8 }, ...at(7000, 700) }] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [field('G', 'Group #1 Name', 0)] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 240, objects: [text('Sub', 'Region total', 0), field('S', 'Sum of Orders.Amount', 2880)] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 240, objects: [text('Grand', 'All regions', 0), field('GT', 'Sum of Orders.Amount', 2880)] }] },
    ],
  };
  return convertToRdl(definition, source, { reportName: 'Orders' }).rdl;
}

const conventions = readConventions(JSON.stringify({
  names: {
    rect: '{S}_Box_{n}', table: '{S}_Grid_{n}', title: '{S}_Heading_Title', heading: '{T}_{col}_Head', value: '{T}_{col}_Val',
    groupText: '{T}_{col}_Grp', subtotalText: '{T}_{col}_SubLbl', subtotal: '{T}_{col}_SubVal', totalText: '{T}_AllLbl',
    total: '{T}_{col}_AllVal', blank: '{T}_empty{n}', noData: '{T}_Empty_Message', footer: '{S}_Note', group: '{S}_g{n}', details: '{S}_g{n}',
  },
  dataset: '{S}_Rows',
  dataSource: { name: 'Shared', reference: 'Shared' },
  parameters: [
    { name: 'as_of', match: 'as.?of', prompt: 'as of', dataType: 'DateTime' },
    { name: 'book', match: 'book', prompt: 'book' },
  ],
  page: { width: '11in', height: '8.5in', margin: '0.25in', font: 'Georgia' },
  noData: 'No {title} for this period',
  documentMap: true,
  style: {
    dataset: 'Theme', commandType: 'StoredProcedure', command: 'dbo.theme_get', field: '{role}_{prop}',
    props: { FontFamily: 'font', FontSize: 'size', Color: 'ink', BackgroundColor: 'fill' },
    roles: { title: 'Title', heading: 'Head', headingFirst: 'Head1', body: 'Body', bodyFirst: 'Body1', number: 'Num', group: 'Grp', totalLabel: 'TotL', totalValue: 'TotV', footer: 'Foot', text: 'Plain' },
    rowBands: { odd: 'Odd', even: 'Even' },
  },
}));

const byName = (root: XmlElement, name: string) => descendants(root).find((e) => e.attributes.Name === name);
const valueIn = (e: XmlElement | undefined) => textOf(descendants(e ?? { name: '', attributes: {}, children: [] }).find((x) => x.name === 'Value'));

describe('conventions', () => {
  const { rdl, review, settled } = applyConventions(converted(), 'Orders', conventions);
  const root = parseXml(rdl);
  const all = descendants(root);

  it('names the table, its columns and its rows after the conventions', () => {
    const tablix = all.find((e) => e.name === 'Tablix')!;
    assert.equal(tablix.attributes.Name, 'Orders_Grid_1');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Customer_Head')), 'Customer');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Amount_Head')), 'Amount');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Customer_Val')), '=Fields!Customer.Value');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Amount_Val')), '=Fields!Amount.Value');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Region_Grp')), '=Fields!Region.Value');
    assert.equal(valueIn(byName(root, 'Orders_Grid_1_Amount_SubVal')), '=Sum(Fields!Amount.Value)');
    assert.ok(byName(root, 'Orders_Grid_1_Customer_SubLbl'), 'the subtotal label');
    const groups = all.filter((e) => e.name === 'Group').map((g) => g.attributes.Name);
    assert.deepEqual(groups, ['Orders_g1', 'Orders_g2']);
  });

  it('puts the title, a no-data row and the grand total into the table', () => {
    const tablix = all.find((e) => e.name === 'Tablix')!;
    const rows = childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow');
    const first = descendants(rows[0]!).find((e) => e.name === 'Textbox')!;
    assert.equal(first.attributes.Name, 'Orders_Heading_Title');
    assert.equal(textOf(descendants(rows[0]!).find((e) => e.name === 'ColSpan')), '2', 'the title spans every column');
    const empty = byName(root, 'Orders_Grid_1_Empty_Message');
    assert.equal(valueIn(empty), 'No Orders by Region for this period', 'plain text, readable in the designer');
    assert.ok(rdl.includes('<Hidden>=CountRows() &gt; 0</Hidden>'), 'shown only without data');
    const last = descendants(rows[rows.length - 1]!).filter((e) => e.name === 'Textbox').map((t) => t.attributes.Name);
    assert.deepEqual(last, ['Orders_Grid_1_AllLbl', 'Orders_Grid_1_Amount_AllVal']);
    assert.ok(!all.some((e) => e.name === 'Textbox' && valueIn(e) === 'Orders by Region' && child(e, 'Top')), 'no title left outside the table');
    const leaves = (m: XmlElement): number => (child(m, 'TablixMembers') ? childElements(child(m, 'TablixMembers')!, 'TablixMember').reduce((a, x) => a + leaves(x), 0) : 1);
    assert.equal(childElements(child(tablix, 'TablixRowHierarchy/TablixMembers')!, 'TablixMember').reduce((a, x) => a + leaves(x), 0), rows.length);
  });

  it('holds the body in one rectangle and drops the page header and footer', () => {
    const items = childElements(child(all.find((e) => e.name === 'Body')!, 'ReportItems')!);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.attributes.Name, 'Orders_Box_1');
    assert.equal(textOf(child(items[0]!, 'DocumentMapLabel')), 'Orders by Region');
    assert.ok(!all.some((e) => e.name === 'PageHeader' || e.name === 'PageFooter'));
    assert.ok(review.some((n) => n.item === 'Page header'));
    assert.equal(textOf(all.find((e) => e.name === 'PageWidth')), '11in');
    assert.equal(textOf(all.find((e) => e.name === 'df:DefaultFontFamily')), 'Georgia');
  });

  it('uses the shared data source, the dataset name and the standard parameters', () => {
    const ds = all.find((e) => e.name === 'DataSource')!;
    assert.equal(ds.attributes.Name, 'Shared');
    assert.equal(textOf(child(ds, 'DataSourceReference')), 'Shared');
    assert.deepEqual(settled, ['Data source']);
    const sets = all.filter((e) => e.name === 'DataSet').map((d) => d.attributes.Name);
    assert.deepEqual(sets, ['Orders_Rows', 'Theme']);
    assert.equal(textOf(all.find((e) => e.name === 'DataSetName')), 'Orders_Rows');
    const params = all.filter((e) => e.name === 'ReportParameter').map((p) => p.attributes.Name);
    assert.deepEqual(params, ['as_of', 'book']);
    assert.ok(!rdl.includes('Parameters!Pm_'), 'references follow the renamed parameter');
  });

  it('reads looks from the style dataset by role', () => {
    const head = byName(root, 'Orders_Grid_1_Amount_Head')!;
    assert.match(head && descendants(head).map((e) => `${e.name}:${textOf(e)}`).join('|'), /FontFamily:=First\(Fields!Head_font.Value, "Theme"\)/);
    const value = byName(root, 'Orders_Grid_1_Amount_Val')!;
    const fill = textOf(child(childElements(value, 'Style')[0]!, 'BackgroundColor'));
    assert.equal(fill, '=IIF(RowNumber(Nothing) Mod 2, First(Fields!Odd_fill.Value, "Theme"), First(Fields!Even_fill.Value, "Theme"))');
    assert.match(descendants(value).map((e) => `${e.name}:${textOf(e)}`).join('|'), /FontSize:=First\(Fields!Num_size.Value, "Theme"\)/);
    const theme = all.find((e) => e.name === 'DataSet' && e.attributes.Name === 'Theme')!;
    const fields = descendants(theme).filter((e) => e.name === 'Field').map((f) => f.attributes.Name);
    assert.ok(fields.includes('Head_font') && fields.includes('Odd_fill') && fields.includes('Num_size'));
    assert.equal(textOf(child(theme, 'Query/CommandText')), 'dbo.theme_get');
  });

  it('keeps every name unique and every reference resolvable', () => {
    const names = all.filter((e) => ['Textbox', 'Rectangle', 'Tablix', 'Group', 'Line', 'Image', 'Chart'].includes(e.name)).map((e) => e.attributes.Name!.toLowerCase());
    assert.equal(new Set(names).size, names.length);
    for (const m of rdl.matchAll(/ReportItems!(\w+)/g)) assert.ok(names.includes(m[1]!.toLowerCase()), `ReportItems!${m[1]} exists`);
  });

  it('keeps the title Crystal printed in the page header, and leaves a list of lines unbanded', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] }],
    };
    const box = (name: string, value: string, size: string) => `<Textbox Name="${name}"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether><Paragraphs><Paragraph><TextRuns><TextRun>`
      + `<Value>${value}</Value><Style><FontSize>${size}</FontSize></Style></TextRun></TextRuns><Style /></Paragraph></Paragraphs>`
      + `<Top>0in</Top><Left>0in</Left><Height>0.25in</Height><Width>3in</Width><Style /></Textbox>`;
    const header = `<PageHeader><Height>0.5in</Height><PrintOnFirstPage>true</PrintOnFirstPage><ReportItems>${box('Heading', 'Orders Checked', '14pt')}${box('AsOf', 'As of:', '8pt')}</ReportItems></PageHeader>`;
    const rule = '<Line Name="UnderRule"><Top>0.6in</Top><Left>0in</Left><Height>0in</Height><Width>4in</Width><Style><Border><Style>Solid</Style></Border></Style></Line>';
    let plain = convertToRdl(definition, source, { reportName: 'Lines' }).rdl.replace(/<Page>/, `<Page>${header}`);
    const tableBottom = (x: string) => {
      const t = descendants(parseXml(x)).find((e) => e.name === 'Tablix')!;
      return parseFloat(textOf(child(t, 'Top'))) + parseFloat(textOf(child(t, 'Height')));
    };
    plain = plain.replace(/<\/Tablix>/, `</Tablix>${rule.replace('0.6in', `${tableBottom(plain) + 0.05}in`)}`);
    const out = applyConventions(plain, 'Lines', conventions);
    const r = parseXml(out.rdl);
    const tablix = descendants(r).find((e) => e.name === 'Tablix')!;
    const first = descendants(childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow')[0]!).find((e) => e.name === 'Textbox')!;
    assert.equal(first.attributes.Name, 'Lines_Heading_Title');
    assert.equal(valueIn(first), 'Orders Checked');
    assert.ok(!child(first, 'Top'), 'placed by its cell');
    const under = descendants(r).find((e) => e.name === 'Line')!;
    assert.ok(parseFloat(textOf(child(under, 'Top'))) >= parseFloat(textOf(child(tablix, 'Top'))) + parseFloat(textOf(child(tablix, 'Height'))), 'the rule under the table stays under it');
    assert.ok(!out.rdl.includes('Odd_fill'), 'rows without column headings are not banded');
    assert.ok(out.review.some((n) => n.item === 'Page header' && n.message.includes('As of:')));
  });

  it('draws boxes as tall as what they hold, moving what lies under them', () => {
    const rects = all.filter((e) => e.name === 'Rectangle' && child(e, 'Height'));
    for (const rect of rects) {
      const items = childElements(child(rect, 'ReportItems') ?? { name: '', attributes: {}, children: [] });
      const inner = Math.max(0, ...items.filter((e) => child(e, 'Top')).map((e) => parseFloat(textOf(child(e, 'Top'))) + parseFloat(textOf(child(e, 'Height')))));
      assert.ok(inner <= parseFloat(textOf(child(rect, 'Height'))) + 0.001, `${rect.attributes.Name} holds what is in it`);
    }
  });

  it('leaves out datasets, parameters, code and pictures nothing reads any more', () => {
    const spare = '<DataSet Name="Spare"><Query><DataSourceName>DataSource1</DataSourceName><QueryParameters><QueryParameter Name="@spare_id">'
      + '<Value>=Parameters!spare_id.Value</Value></QueryParameter></QueryParameters><CommandText>dbo.spare</CommandText></Query>'
      + '<Fields><Field Name="x"><DataField>x</DataField><Value>=Code.Pad(Fields!x.Value)</Value></Field></Fields></DataSet>';
    let plain = converted().replace('</DataSets>', `${spare}</DataSets>`);
    plain = plain.replace('</ReportParameters>', '<ReportParameter Name="spare_id"><DataType>String</DataType><Prompt>spare</Prompt></ReportParameter></ReportParameters>');
    plain = plain.replace(/<rd:ReportUnitType>/, '<Code>Public Function Pad(a) : Return a : End Function</Code><EmbeddedImages><EmbeddedImage Name="Logo"><MIMEType>image/png</MIMEType><ImageData>iVBORw0KGgo=</ImageData></EmbeddedImage></EmbeddedImages><rd:ReportUnitType>');
    const out = applyConventions(plain, 'Orders', conventions);
    for (const gone of ['<DataSet Name="Spare"', 'Name="spare_id"', '<Code>', '<EmbeddedImage ']) assert.ok(!out.rdl.includes(gone), `${gone} left out`);
    assert.ok(out.rdl.includes('<DataSet Name="Orders_Rows"') && out.rdl.includes('<DataSet Name="Theme"'));
    assert.ok(out.review.some((n) => n.item === 'Dataset Spare'));
  });

  it('shows the team\'s message row instead of Crystal\'s blank band when there is no data', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Fake', index: 0, kind: 'formula', text: '1', referencedFields: [] },
        { name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['@Fake'] },
      ],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [text('CustomerHeading', 'Customer', 0), text('AmountHeading', 'Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] },
      ],
    } as ReportDefinition;
    const plain = convertToRdl(definition, source, { reportName: 'Band' }).rdl;
    assert.ok(plain.includes('CountRows() &gt; 0'), 'the conversion keeps a blank band for no data');
    const out = applyConventions(plain, 'Band', conventions);
    const r = parseXml(out.rdl);
    const values = descendants(r).filter((e) => e.name === 'Textbox' && valueIn(e) === '=Fields!Customer.Value');
    assert.equal(values.length, 1, 'the data row is not doubled');
    assert.ok(byName(r, 'Band_Grid_1_Empty_Message'), 'the message row');
    const tablix = descendants(r).find((e) => e.name === 'Tablix')!;
    const leaves = (m: XmlElement): number => (child(m, 'TablixMembers') ? childElements(child(m, 'TablixMembers')!, 'TablixMember').reduce((a, x) => a + leaves(x), 0) : 1);
    assert.equal(childElements(child(tablix, 'TablixRowHierarchy/TablixMembers')!, 'TablixMember').reduce((a, x) => a + leaves(x), 0), childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow').length);
  });

  it('takes a short name for the report', () => {
    const out = applyConventions(converted(), 'Orders', readConventions(JSON.stringify({ names: { table: '{S}_Grid_{n}' }, prefixes: { orders: 'Ord' } })));
    assert.ok(out.rdl.includes('<Tablix Name="Ord_Grid_1">'));
    assert.equal(applyConventions(converted(), 'Orders', conventions, 'Short').rdl.includes('Short_Grid_1'), true);
  });

  it('keeps what lies under a subreport frame drawn too short below its table', () => {
    const box = (name: string, inner: string, top: string, height: string) => `<Rectangle Name="${name}"><ReportItems>${inner}</ReportItems><KeepTogether>true</KeepTogether>`
      + `<Top>${top}</Top><Left>0in</Left><Height>${height}</Height><Width>6in</Width><Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const note = '<Textbox Name="Below"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether><Paragraphs><Paragraph><TextRuns><TextRun><Value>Below the table</Value><Style /></TextRun></TextRuns><Style /></Paragraph></Paragraphs>'
      + '<Top>0in</Top><Left>0in</Left><Height>0.2in</Height><Width>3in</Width><Style /></Textbox>';
    let plain = converted().replace(/<Tablix Name="[^"]+">[\s\S]*?<\/Tablix>/, (m) => box('FrameA', m.replace(/(<\/TablixRowHierarchy>[\s\S]*?<Top>)[^<]*(<\/Top>)/, '$10in$2'), '0in', '0.2in'));
    plain = plain.replace(/(<Rectangle Name="FrameA">[\s\S]*?<\/Rectangle>)/, `$1${box('FrameB', note, '0.25in', '0.2in')}`);
    const out = applyConventions(plain, 'Orders', conventions);
    const r = parseXml(out.rdl);
    const tablix = descendants(r).find((e) => e.name === 'Tablix')!;
    const below = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === 'Below the table')!;
    const inch = (e: XmlElement, n: string) => parseFloat(textOf(child(e, n)));
    // The frames stay (they push each other down when the report runs), the first as tall as its table, the second
    // under it.
    const frameOf = (e: XmlElement) => descendants(r).find((x) => x.name === 'Rectangle' && x !== e && descendants(x).includes(e) && child(x, 'Top') && !childElements(child(x, 'ReportItems')!).some((c) => c.name === 'Rectangle'))!;
    const a = frameOf(tablix);
    const b = frameOf(below);
    assert.ok(a && b && a !== b, 'each in its own frame');
    assert.ok(inch(a, 'Height') >= inch(tablix, 'Top') + inch(tablix, 'Height') - 0.001, 'the first frame holds its table');
    assert.ok(inch(b, 'Top') >= inch(a, 'Top') + inch(a, 'Height'), 'the second frame starts under the first');
  });

  it('rejects unknown entries', () => {
    assert.throws(() => readConventions('{"nmes": {}}'), /unknown entry "nmes"/);
    assert.throws(() => readConventions('{"names": {"tabel": "x"}}'), /unknown entry "tabel"/);
  });
});
