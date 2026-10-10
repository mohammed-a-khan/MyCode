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

  it('draws rows tall enough for text at the designer\'s default size, a rule along the text moving with it', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Bottom_Line_Style', index: 1, kind: 'conditionalFormat', text: 'if {Orders.Region} = "Total" then crSingleLine else crNoLine', referencedFields: [] },
        { name: 'DeltaX_Value_Formula', index: 2, kind: 'conditionalFormat', text: '(if IsNull({Orders.Amount}) then 0 else 1) * 1.15 * 1440', referencedFields: [] },
      ],
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [
        { kind: 'field', name: 'Name', field: 'Orders.Customer', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 7000, height: 200 } },
        { kind: 'field', name: 'Amt', field: 'Orders.Amount', style: { size: 8 }, position: { x: 7751, y: 0 }, size: { width: 2000, height: 200 }, align: 'right',
          conditions: { bottomLine: { name: 'Bottom_Line_Style', index: 1 }, deltaX: { name: 'DeltaX_Value_Formula', index: 2 } } },
        { kind: 'field', name: 'Tag', field: 'Orders.Region', style: { size: 8 }, position: { x: 13327, y: 0 }, size: { width: 650, height: 200 } },
      ] }] }],
    } as ReportDefinition;
    const out = applyConventions(convertToRdl(definition, source, { reportName: 'Lines' }).rdl, 'Lines', conventions);
    const r = parseXml(out.rdl);
    const inch = (e: XmlElement, n: string) => parseFloat(textOf(child(e, n)));
    const tablix = descendants(r).find((e) => e.name === 'Tablix')!;
    // (10pt drawn by the designer where the size comes from the style dataset: about 0.19in a line.)
    for (const row of childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow')) {
      if (descendants(row).some((e) => e.name === 'Textbox' && valueIn(e).startsWith('=Fields!'))) assert.ok(inch(row, 'Height') >= 0.19, 'a row of text fits a line of it');
    }
    const amount = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === '=Fields!Amount.Value')!;
    assert.ok(inch(amount, 'Height') >= 0.19, 'the text in its cell\'s box fits too');
    const lines = descendants(r).filter((e) => e.name === 'Line');
    assert.ok(lines.length > 1);
    for (const line of lines) assert.ok(inch(line, 'Top') >= inch(amount, 'Height') - 0.02, 'its rule stays along the bottom of the text');
    // A table of lines with no headings of its own gets no message row (Crystal prints nothing there then).
    assert.ok(!out.rdl.includes('Empty_Message'));
  });

  it('keeps items from lying over each other: a frame holds what it is drawn round, a text stops at its neighbour', () => {
    const tb = (name: string, value: string, l: number, t: number, w: number, h: number, extra = '', align = 'Left') => `<Textbox Name="${name}"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether>`
      + `<Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value><Style><FontSize>8pt</FontSize></Style></TextRun></TextRuns><Style><TextAlign>${align}</TextAlign></Style></Paragraph></Paragraphs>`
      + `<Top>${t}in</Top><Left>${l}in</Left><Height>${h}in</Height><Width>${w}in</Width><Style><Border><Style>None</Style></Border>${extra}<PaddingTop>0pt</PaddingTop><PaddingBottom>0pt</PaddingBottom></Style></Textbox>`;
    const frame = '<Rectangle Name="Frame"><KeepTogether>true</KeepTogether><Top>4in</Top><Left>0in</Left><Height>0.6in</Height><Width>6in</Width><Style><Border><Style>Solid</Style></Border></Style></Rectangle>';
    const extra = frame + tb('Inside', 'Printed', 0.2, 4.1, 3, 0.2)
      + tb('Band', '', 0, 5, 2, 0.3, '<BackgroundColor>Navy</BackgroundColor>') + tb('OnBand', 'Order ID', 0.1, 5.02, 1, 0.2)
      + tb('Long', '=Fields!Customer.Value', 0, 6, 5, 0.2) + tb('Next', 'Amount', 3, 6, 1, 0.2)
      + tb('Lone', 'Centred', 0, 7, 6, 0.2, '', 'Center') + '<Image Name="Logo"><Source>Embedded</Source><Value>Logo</Value><Top>7in</Top><Left>0in</Left><Height>0.3in</Height><Width>1in</Width><Style /></Image>';
    const plain = converted().replace(/<Body>\s*<ReportItems>/, (m) => m + extra).replace('</ReportSections>', '</ReportSections><EmbeddedImages><EmbeddedImage Name="Logo"><MIMEType>image/png</MIMEType><ImageData>iVBORw0KGgo=</ImageData></EmbeddedImage></EmbeddedImages>');
    const out = applyConventions(plain, 'Orders', conventions);
    const r = parseXml(out.rdl);
    const find = (v: string) => descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === v)!;
    const parentOf = (e: XmlElement) => descendants(r).find((x) => x.name === 'Rectangle' && childElements(child(x, 'ReportItems') ?? { name: '', attributes: {}, children: [] }).includes(e));
    const inch = (e: XmlElement, n: string) => parseFloat(textOf(child(e, n)));
    assert.ok(parentOf(find('Printed'))?.attributes.Name?.length, 'the frame holds the text drawn in it');
    assert.equal(inch(find('Printed'), 'Top'), 0.1, 'placed within the frame');
    const band = parentOf(find('Order ID'))!;
    assert.ok(band && textOf(child(band, 'Style/BackgroundColor')) === 'Navy', 'a filled band is a box holding its text');
    assert.equal(inch(find('=Fields!Customer.Value'), 'Width'), 3, 'a text stops where its neighbour starts');
    const centred = find('Centred');
    assert.equal(inch(centred, 'Left'), 1);
    assert.equal(inch(centred, 'Width'), 4, 'centred text is cut equally at both ends, staying centred');
  });

  it('keeps what reports combined into one need: datasets named after the report, headings found by name', () => {
    const extra = '<DataSet Name="DataSet9"><Query><DataSourceName>DataSource1</DataSourceName><CommandText>dbo.note_get</CommandText></Query>'
      + '<Fields><Field Name="note"><DataField>note</DataField></Field></Fields></DataSet>';
    const note = '<Textbox Name="Note"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Code.Tidy(First(Fields!note.Value, "DataSet9"))</Value><Style /></TextRun></TextRuns><Style /></Paragraph></Paragraphs>'
      + '<Top>9in</Top><Left>0in</Left><Height>0.2in</Height><Width>3in</Width><Style /></Textbox>';
    const plain = converted().replace('</DataSets>', `${extra}</DataSets>`).replace(/<Body>\s*<ReportItems>/, (m) => m + note)
      .replace(/<rd:ReportUnitType>/, '<Code>Public Function Tidy(a) : Return a : End Function</Code><rd:ReportUnitType>');
    const out = applyConventions(plain, 'Orders', conventions);
    assert.ok(out.rdl.includes('<DataSet Name="Orders_2_Rows">') && out.rdl.includes('"Orders_2_Rows")'), 'a dataset read by name is named after the report');
    assert.ok(!out.rdl.includes('DataSet9'));
    assert.ok(out.review.some((n) => n.item === 'Custom code' && n.message.includes('Tidy')), 'the functions to carry over are named');

    // Headings Crystal printed in a group's header are named as headings.
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Region'] }],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [text('CustomerHeading', 'Customer', 0), text('AmountHeading', 'Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] },
      ],
    } as ReportDefinition;
    const grouped = applyConventions(convertToRdl(definition, source, { reportName: 'Heads' }).rdl, 'Heads', conventions).rdl;
    assert.ok(grouped.includes('Name="Heads_Grid_1_Customer_Head"') && grouped.includes('Name="Heads_Grid_1_Amount_Head"'), 'headings by name');
  });

  it('rejects unknown entries', () => {
    assert.throws(() => readConventions('{"nmes": {}}'), /unknown entry "nmes"/);
    assert.throws(() => readConventions('{"names": {"tabel": "x"}}'), /unknown entry "tabel"/);
  });
});
