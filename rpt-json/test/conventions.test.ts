import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataSourceInfo, ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { applyConventions, readConventions } from '../src/ssrs/conventions.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';
import { child, childElements, descendants, el, parseXml, textOf, toXml, type XmlElement } from '../src/ssrs/xml.ts';

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
    const empty = '(IsNothing(Fields!Customer.Value) OrElse Trim(CStr(Fields!Customer.Value)) = "")';
    assert.equal(fill, `=IIF(${empty}, "White", IIF(RunningValue(IIf(${empty}, 0, 1), Sum, Nothing) Mod 2, First(Fields!Odd_fill.Value, "Theme"), First(Fields!Even_fill.Value, "Theme")))`, 'an empty record keeps no band and is not counted');
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

    // A second frame drawn over the first (Crystal's frames overlapping, or one frame holding the table and a second
    // frame within the table's reach): it lies under the table all the same.
    for (const [where, top] of [['beside', '0.1in'], ['inside', '0.1in']] as const) {
      let piled = converted().replace(/<Tablix Name="[^"]+">[\s\S]*?<\/Tablix>/, (m) => box('FrameA', m.replace(/(<\/TablixRowHierarchy>[\s\S]*?<Top>)[^<]*(<\/Top>)/, '$10in$2')
        + (where === 'inside' ? box('FrameB', note, top, '0.2in') : ''), '0in', '0.2in'));
      if (where === 'beside') piled = piled.replace(/(<Rectangle Name="FrameA">[\s\S]*?<\/Rectangle>)/, `$1${box('FrameB', note, top, '0.2in')}`);
      const root = parseXml(applyConventions(piled, 'Orders', conventions).rdl);
      const t = descendants(root).find((e) => e.name === 'Tablix')!;
      const n = descendants(root).find((e) => e.name === 'Textbox' && valueIn(e) === 'Below the table')!;
      const frameB = descendants(root).find((x) => x.name === 'Rectangle' && childElements(child(x, 'ReportItems') ?? el('x')).includes(n))!;
      const sameHolder = descendants(root).find((x) => x.name === 'ReportItems' && x.children.includes(t) && x.children.includes(frameB));
      const tableBottom = inch(t, 'Top') + inch(t, 'Height');
      if (sameHolder) assert.ok(inch(frameB, 'Top') >= tableBottom - 0.001, `${where}: the frame lies under the table`);
      else {
        const frameA = descendants(root).find((x) => x.name === 'Rectangle' && childElements(child(x, 'ReportItems') ?? el('x')).includes(t))!;
        assert.ok(inch(frameA, 'Height') >= tableBottom - 0.001, `${where}: the first frame holds its table`);
        assert.ok(inch(frameB, 'Top') >= inch(frameA, 'Top') + inch(frameA, 'Height') - 0.001, `${where}: the second frame starts under the first`);
      }
    }
  });

  it('keeps a table grouped on a constant as tall as its rows once Crystal\'s blank band is replaced', () => {
    // Crystal prints a table grouped on a constant even with no data, its detail band blank; that band's rows show
    // only then and are not counted in the table's height. Replaced by the message row, the table stays as tall as
    // its rows, and the frame under it starts below it.
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['@One'] },
        { name: 'One', index: 1, kind: 'formula', text: '1', referencedFields: [] },
      ],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [text('CustomerHeading', 'Customer', 0), text('AmountHeading', 'Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] },
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 240, objects: [text('Note', 'Figures in dollars', 0)] }] },
      ],
    } as unknown as ReportDefinition;
    const plain = convertToRdl(definition, source, { reportName: 'Orders' }).rdl;
    const r = parseXml(applyConventions(plain, 'Orders', conventions).rdl);
    const inch = (e: XmlElement, n: string) => parseFloat(textOf(child(e, n)));
    for (const t of descendants(r).filter((e) => e.name === 'Tablix')) {
      const rows = descendants(t).filter((e) => e.name === 'TablixRow').reduce((sum, row) => sum + inch(row, 'Height'), 0);
      assert.ok(Math.abs(inch(t, 'Height') - rows) < 0.002, `${t.attributes.Name} is ${inch(t, 'Height')}in, its rows ${rows}in`);
    }
  });

  it('ends a text box where a rule drawn a hair inside its foot starts', () => {
    // An underline drawn just inside the foot of a figure (as a moving underline is drawn, in pieces): one under the
    // other, not over each other (Preview would move the rule aside).
    const tb = '<Textbox Name="Figure"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether><Paragraphs><Paragraph><TextRuns><TextRun><Value>Underlined figure</Value><Style /></TextRun></TextRuns><Style /></Paragraph></Paragraphs>'
      + '<Top>0in</Top><Left>0in</Left><Height>0.20556in</Height><Width>3in</Width><Style /></Textbox>';
    const line = (n: number, left: number) => `<Line Name="Rule${n}"><Top>0.19556in</Top><Left>${left}in</Left><Height>0in</Height><Width>1in</Width><Style><Border><Style>Solid</Style><Width>1pt</Width></Border></Style></Line>`;
    const box = `<Rectangle Name="Under"><ReportItems>${tb}${line(1, 0)}${line(2, 1.05)}</ReportItems><KeepTogether>true</KeepTogether><Top>3in</Top><Left>0in</Left><Height>0.21in</Height><Width>3in</Width><Style><Border><Style>None</Style></Border></Style></Rectangle>`;
    const plain = converted().replace(/(<Body>\s*<ReportItems>)/, `$1${box}`);
    const r = parseXml(applyConventions(plain, 'Orders', conventions).rdl);
    const inch = (e: XmlElement, n: string) => parseFloat(textOf(child(e, n)) || '0');
    const figure = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === 'Underlined figure')!;
    const rules = descendants(r).filter((e) => e.name === 'Line' && descendants(r).some((h) => h.name === 'ReportItems' && h.children.includes(e) && h.children.includes(figure)));
    assert.equal(rules.length, 2, 'the rules stay with the figure');
    for (const rule of rules) assert.ok(inch(rule, 'Top') >= inch(figure, 'Top') + inch(figure, 'Height') - 0.001, `${rule.attributes.Name} lies under the figure`);
  });

  it('keeps what lies side by side across the page together in a band, and makes a frame round a title its border', () => {
    // Crystal keeps a label beside a heading in one section; a frame round a centred title is the title's border.
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Region'] }],
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 1400, objects: [
          { ...text('Left', 'Prepared for the board', 0), ...at(0, 2880, 600) },
          { ...text('Right', 'Draft', 6000), ...at(6000, 1440, 240) },
          { ...text('Title', 'Orders by Region', 1000, { align: 'center' }), position: { x: 1000, y: 800 }, size: { width: 6000, height: 300 } },
          { kind: 'box', name: 'Frame', position: { x: 2500, y: 760 }, size: { width: 3000, height: 400 }, border: { sides: [1, 1, 1, 1], color: '#000080', width: 40 } },
        ] }] },
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [text('CustomerHeading', 'Customer', 0), text('AmountHeading', 'Amount', 2880)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('AmountValue', 'Orders.Amount', 2880)] }] },
      ],
    } as unknown as ReportDefinition;
    const out = applyConventions(convertToRdl(definition, source, { reportName: 'Orders' }).rdl, 'Orders', conventions);
    const r = parseXml(out.rdl);
    const holderOf = (e: XmlElement) => descendants(r).find((h) => h.name === 'ReportItems' && h.children.includes(e))!;
    const left = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === 'Prepared for the board')!;
    const right = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === 'Draft')!;
    assert.equal(holderOf(left), holderOf(right), 'side by side: one band');
    assert.ok(descendants(r).some((e) => e.name === 'Rectangle' && child(e, 'ReportItems') === holderOf(left) && !childElements(holderOf(left)).some((c) => c.name === 'Tablix')), 'the band is a box of its own');
    // No frame left over the title: the title carries its border.
    assert.ok(!descendants(r).some((e) => e.name === 'Rectangle' && !child(e, 'ReportItems') && /000080/i.test(JSON.stringify(e))), 'no empty frame');
    // Nothing left over anything else, nothing past its box.
    assert.ok(!out.review.some((n) => /drawn over each other|reaches past its box/.test(n.message)), JSON.stringify(out.review.filter((n) => /drawn over|reaches past/.test(n.message))));
  });

  it('draws a rule moved with its figure in whole steps as a text box at each place, its rule as wide and thick as Crystal\'s', () => {
    // A statement's figure indented by its level, underlined where a flag says: in pieces of line across the cell
    // otherwise (a line's place cannot be an expression); in a template, the text's underline on the same condition.
    const statement = { connections: [], links: [], tables: [{ alias: 'S', name: 'S', kind: 'table', fields: [{ name: 'Label', type: 'string' }, { name: 'Amount', type: 'currency' }, { name: 'Level', type: 'number' }, { name: 'Under', type: 'string' }] }] } as DataSourceInfo;
    const at2 = (x: number, y: number, width: number) => ({ position: { x, y }, size: { width, height: 240 } });
    const definition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['S.Label'] },
        { name: 'DeltaX', index: 1, kind: 'conditionalFormat', text: '{S.Level} * 1.15 * 1440', referencedFields: ['S.Level'] },
        { name: 'Bottom_Line', index: 2, kind: 'conditionalFormat', text: 'if {S.Under} = "Y" then crSingleLine else crNoLine', referencedFields: ['S.Under'] },
      ],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [{ ...text('H1', 'Line', 0), ...at2(0, 0, 3000) }, { ...text('H2', 'Value', 3200), ...at2(3200, 0, 5500) }] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 300, objects: [{ ...field('L', 'S.Label', 0), ...at2(0, 0, 3000) },
          { ...field('A', 'S.Amount', 3200), ...at2(3200, 30, 1585), border: { sides: [0, 0, 0, 0], color: '#000000', width: 20 }, conditions: { deltaX: { name: 'DeltaX', index: 1 }, bottomLine: { name: 'Bottom_Line', index: 2 } } },
          { ...field('Z', 'S.Label', 9000), ...at2(9000, 0, 1000) }] }] },
      ],
    } as unknown as ReportDefinition;
    const plain = convertToRdl(definition, statement, { reportName: 'O' }).rdl;
    assert.ok((plain.match(/<Line /g) ?? []).length > 1, 'drawn in pieces otherwise');
    // Moved by whole steps (1.15in a level): a text box at each place the figure can stand, side by side, each showing
    // it and drawing its rule (as wide and thick as Crystal's) where the record's level puts it.
    const rdl = convertToRdl(definition, statement, { reportName: 'O', rulesAsText: true }).rdl;
    assert.ok(!/<Line /.test(rdl), 'no pieces of line');
    const boxes = parseXml(rdl);
    const places = descendants(boxes).filter((e) => e.name === 'Textbox' && /^A_At\d$/.test(e.attributes.Name ?? ''));
    assert.deepEqual(places.map((e) => textOf(child(e, 'Left'))), ['0in', '1.15in', '2.3in']);
    const level = 'IIf(IsNothing(Fields!Level.Value) OrElse Fields!Level.Value <= 0, 0, IIf(Fields!Level.Value >= 2, 2, Round(Fields!Level.Value)))';
    assert.equal(valueIn(places[1]), `=IIf(${level} = 1, Fields!Amount.Value, Nothing)`);
    assert.equal(textOf(child(places[1]!, 'Style/BottomBorder/Style')), `=IIf(${level} = 1, IIf((RTrim(Fields!Under.Value) = "Y"), "Solid", "None"), "None")`);
    assert.equal(textOf(child(places[1]!, 'Style/BottomBorder/Width')), '1.00pt');
    // Named as the column they show (its box, its values, its heading), as the merge finds them.
    const names = [...applyConventions(rdl, 'O', conventions).rdl.matchAll(/<(?:Textbox|Rectangle) Name="([^"]*)"/g)].map((m) => m[1]);
    for (const name of ['O_Grid_1_Amount_Box', 'O_Grid_1_Amount_Val', 'O_Grid_1_Amount_Val_2', 'O_Grid_1_Amount_Val_3', 'O_Grid_1_Amount_Head']) {
      assert.ok(names.includes(name), `${name} in ${names.join(', ')}`);
    }
  });

  it('gives the rows printed for each record one line of the designer\'s size and no more, a rule along the text moving with it', () => {
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
    // A row printed for each record holds a line of the designer's 10pt (0.16in, its text all seen) and no more, so
    // that a page holds about as many as Crystal's 0.153in rows do (with room round it, 0.19in, a statement would run
    // on to another page).
    for (const row of childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow')) {
      if (descendants(row).some((e) => e.name === 'Textbox' && valueIn(e).startsWith('=Fields!'))) {
        assert.ok(inch(row, 'Height') >= 0.159 && inch(row, 'Height') <= 0.161, `a record's row holds one line: ${inch(row, 'Height')}`);
      }
    }
    const amount = descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === '=Fields!Amount.Value')!;
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
    assert.equal(inch(descendants(r).find((e) => e.name === 'Textbox' && valueIn(e) === '=Fields!Customer.Value' && child(e, 'Width'))!, 'Width'), 3, 'a text stops where its neighbour starts');
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

  it('gives each table after the first thin spare columns, which hiding the first one\'s columns takes off instead', () => {
    let plain = converted();
    const tablix = /<Tablix Name="([^"]+)">[\s\S]*?<\/Tablix>/.exec(plain)!;
    const second = tablix[0].replace(`Name="${tablix[1]}"`, 'Name="Second"').replace(/Name="(?!Second")([^"]+)"/g, 'Name="$1_b"')
      .replace(/(<\/TablixRowHierarchy>[\s\S]*?<Top>)[^<]*(<\/Top>)/, '$15in$2');
    plain = plain.replace(tablix[0], tablix[0] + second);
    const r = parseXml(applyConventions(plain, 'Orders', conventions).rdl);
    const tables = descendants(r).filter((e) => e.name === 'Tablix');
    assert.equal(tables.length, 2);
    const cols = (t: XmlElement) => childElements(child(t, 'TablixBody/TablixColumns')!, 'TablixColumn').length;
    const width = (t: XmlElement) => childElements(child(t, 'TablixBody/TablixColumns')!, 'TablixColumn').reduce((a, c) => a + parseFloat(textOf(child(c, 'Width'))), 0);
    const before = parseXml(plain);
    const original = descendants(before).filter((e) => e.name === 'Tablix');
    assert.equal(cols(tables[1]!), cols(original[1]!) + cols(tables[0]!) - 1, 'one spare column for each column the first table could lose');
    assert.ok(Math.abs(width(tables[1]!) - width(original[1]!)) < 0.001, 'as wide as before');
    for (const row of childElements(child(tables[1]!, 'TablixBody/TablixRows')!, 'TablixRow')) {
      const cells = childElements(child(row, 'TablixCells')!, 'TablixCell');
      const spans = cells.reduce((a, c) => a + (c.children.length ? 1 : 0) + Math.max(0, Number(textOf(child(c, 'CellContents/ColSpan')) || 1) - 1), 0);
      assert.equal(cells.length, cols(tables[1]!));
      assert.ok(spans <= cols(tables[1]!));
    }
    assert.equal(childElements(child(tables[1]!, 'TablixColumnHierarchy/TablixMembers')!, 'TablixMember').length, cols(tables[1]!));
    // Empty cells numbered in reading order, row by row, left to right.
    const blankNumbers = descendants(tables[1]!).filter((e) => e.name === 'Textbox' && /_empty\d+$/.test(e.attributes.Name ?? '')).map((e) => Number(/(\d+)$/.exec(e.attributes.Name!)![1]));
    assert.deepEqual(blankNumbers, blankNumbers.map((_, i) => i + 1), `empty cells in reading order: ${blankNumbers}`);
    const widths = childElements(child(tables[1]!, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => parseFloat(textOf(child(c, 'Width'))));
    const spareWidths = widths.slice(-(cols(tables[0]!) - 1));
    assert.ok(spareWidths.every((w) => w <= 0.011), `spare columns thin: ${widths}`);
    const own = childElements(child(original[1]!, 'TablixBody/TablixColumns')!, 'TablixColumn').map((c) => parseFloat(textOf(child(c, 'Width'))));
    const kept = widths.slice(0, own.length);
    assert.equal(kept.filter((w, i) => Math.abs(w - own[i]!) > 0.001).length, 1, `only the widest column gives up their width: ${own} -> ${kept}`);

    // A rule along a row (the last cell's border) runs on through the spare cells to the table's edge.
    const withRule = parseXml(plain);
    const secondTable = descendants(withRule).find((e) => e.name === 'Tablix' && e.attributes.Name === 'Second')!;
    const detail = childElements(child(secondTable, 'TablixBody/TablixRows')!, 'TablixRow').find((row) => descendants(row).some((e) => e.name === 'Textbox' && valueIn(e).startsWith('=Fields!')))!;
    const lastBox = descendants(childElements(child(detail, 'TablixCells')!, 'TablixCell').at(-1)!).find((e) => e.name === 'Textbox')!;
    childElements(lastBox, 'Style')[0]!.children.push(el('BottomBorder', el('Color', 'Black'), el('Style', 'Solid'), el('Width', '2pt')));
    const ruled = toXml(withRule);
    const rr = parseXml(applyConventions(ruled, 'Orders', conventions).rdl);
    const ruledRow = childElements(child(descendants(rr).filter((e) => e.name === 'Tablix')[1]!, 'TablixBody/TablixRows')!, 'TablixRow')
      .find((row) => descendants(row).some((e) => e.name === 'Textbox' && valueIn(e).startsWith('=Fields!')))!;
    const spareCells = childElements(child(ruledRow, 'TablixCells')!, 'TablixCell').slice(-(cols(tables[0]!) - 1));
    for (const cell of spareCells) assert.equal(textOf(child(descendants(cell).find((e) => e.name === 'Textbox')!, 'Style/BottomBorder/Width')), '2pt', 'the rule runs on through the spare cell');
  });

  it('gives each column a heading of its own and lists the columns by number, for reports combined', () => {
    // "Customer" over two columns (the name and the region beside it), centred.
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      layout: [
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [text('CustomerHeading', 'Customer', 0, { align: 'center', ...at(0, 5760) }), text('AmountHeading', 'Amount', 5760)] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('CustomerValue', 'Orders.Customer', 0), field('RegionValue', 'Orders.Region', 2880), field('AmountValue', 'Orders.Amount', 5760)] }] },
      ],
    } as ReportDefinition;
    const out = applyConventions(convertToRdl(definition, source, { reportName: 'Heads' }).rdl, 'Heads', conventions);
    const r = parseXml(out.rdl);
    const tablix = descendants(r).find((e) => e.name === 'Tablix')!;
    const headingRow = childElements(child(tablix, 'TablixBody/TablixRows')!, 'TablixRow').find((row) => descendants(row).some((e) => e.name === 'Textbox' && valueIn(e) === 'Customer'))!;
    assert.ok(!descendants(headingRow).some((e) => e.name === 'ColSpan'), 'no heading across columns');
    for (const col of ['Customer', 'Region', 'Amount']) assert.ok(out.rdl.includes(`Name="Heads_Grid_1_${col}_Head"`), `a heading for ${col}`);
    assert.ok(out.review.some((n) => n.message.includes('columns, by number:') && /1 Customer, 2 Region, 3 Amount/.test(n.message)));
    assert.ok(out.review.some((n) => n.message.includes('"Customer" was over columns 1 to 2')));
  });

  it('names custom code after the report, so reports combined keep their functions apart', () => {
    const plain = converted().replace(/<rd:ReportUnitType>/, '<Code>Dim seen As Integer\nPublic Function Tick(a) As Integer\n  seen = seen + 1\n  Return Helper(a)\nEnd Function\nPublic Function Helper(a) As Integer\n  Return "Tick" &amp; a\nEnd Function</Code><rd:ReportUnitType>')
      .replace(/<Body>\s*<ReportItems>/, (m) => m + '<Textbox Name="T"><CanGrow>true</CanGrow><KeepTogether>true</KeepTogether><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Code.Tick(1)</Value><Style /></TextRun></TextRuns><Style /></Paragraph></Paragraphs><Top>9in</Top><Left>0in</Left><Height>0.2in</Height><Width>1in</Width><Style /></Textbox>');
    const out = applyConventions(plain, 'Orders', conventions);
    const code = textOf(descendants(parseXml(out.rdl)).find((e) => e.name === 'Code'));
    assert.match(code, /Dim Orders_seen As Integer/);
    assert.match(code, /Function Orders_Tick\(a\)[\s\S]*Orders_seen = Orders_seen \+ 1[\s\S]*Return Orders_Helper\(a\)/);
    assert.match(code, /Return "Tick" & a/, 'quoted text kept');
    assert.ok(out.rdl.includes('=Code.Orders_Tick(1)'));
  });

  it('rejects unknown entries', () => {
    assert.throws(() => readConventions('{"nmes": {}}'), /unknown entry "nmes"/);
    assert.throws(() => readConventions('{"names": {"tabel": "x"}}'), /unknown entry "tabel"/);
  });
});
