import { groupOptionByte } from '../src/crystal/model.ts';
import { checkRdlWidths } from '../src/ssrs/widthcheck.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { chartOptions, type ChartInfo, type DataSourceInfo, type ReportDefinition, type ReportObject } from '../src/crystal/model.ts';
import { encodeString } from '../src/crystal/strings.ts';
import { readCfb } from '../src/index.ts';
import { convertDocumentToSsrs, reviewMarkdown } from '../src/ssrs/convert.ts';
import { extractHeaders, formatHeadersCsv, formatHeadersText } from '../src/crystal/headers.ts';
import { CODE_HELPERS, crystalColor, translateFormula, translateToSql, vbString, type FormulaContext } from '../src/ssrs/formula.ts';
import { isBasicSyntax } from '../src/ssrs/basic.ts';
import { chartStyle, convertToRdl, fixedCondition, dateFormatString, formatFor, numberFormatString, scopeOutsideRegion, substituteCommandParameters } from '../src/ssrs/rdl.ts';
import { classifyAreas } from '../src/crystal/areas.ts';
import { buildHouseReport, readHouseTemplate } from '../src/ssrs/house.ts';
import { child, childElements, descendants, parseXml } from '../src/ssrs/xml.ts';

const ctx: FormulaContext = {
  field: (table, column) => (table === 'Orders' ? column.replace(/\W/g, '_') : undefined),
  formula: (name) => (name === 'Tax' ? 'Fields!Tax.Value' : undefined),
  parameter: (name) => name.replace(/\W/g, '_'),
  groupScope: (ref) => (ref === 'Orders.Region' ? 'Group1_Region' : undefined),
};
const tr = (source: string, colors = false) => translateFormula(source, ctx, { colors });

/** Checks that every opened tag is closed in order (a small well-formedness check without an XML library). */
function assertBalancedXml(xml: string): void {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], 'unclosed elements');
}

describe('formula translation', () => {
  it('translates Crystal date-time, rounding and text functions SSRS has no name for', () => {
    assert.equal(tr('DateTimeValue({Orders.Text})').expression, '=CDate(Fields!Text.Value)');
    assert.equal(tr('DateTimeValue({Orders.Date}, {Orders.Time})').expression, '=CDate(Fields!Date.Value).Date.Add(CDate(Fields!Time.Value).TimeOfDay)');
    // Built from numbers: never CDate of a number, nor Date + Date (neither compiles in VB).
    assert.equal(tr('DateTimeValue(Year({Orders.Date}), Month({Orders.Date}), 1)').expression, '=DateSerial(Year(Fields!Date.Value), Month(Fields!Date.Value), 1)');
    assert.equal(tr('DateValue(2024, 1, 31)').expression, '=DateSerial(2024, 1, 31)');
    assert.equal(tr('DateTime(2024, 1, 31, 10, 30, 0)').expression, '=DateSerial(2024, 1, 31).Add(TimeSerial(10, 30, 0).TimeOfDay)');
    assert.equal(tr('CDate(45000)').expression, '=DateTime.FromOADate(CDbl(45000))');
    assert.equal(tr('TimeValue(10, 30, 0)').expression, '=TimeSerial(10, 30, 0)');
    assert.equal(tr('DateTimeValue({Orders.Date}, Time({Orders.Time}))').expression, '=CDate(Fields!Date.Value).Date.Add(CDate(Fields!Time.Value).TimeOfDay)');
    assert.equal(tr('CDateTime({Orders.Text})').expression, '=CDate(Fields!Text.Value)');
    assert.equal(tr('Ceiling({Orders.Amount}, 5)').expression, '=(Math.Ceiling(Fields!Amount.Value / 5) * 5)');
    assert.equal(tr('HasValue({?Start})').expression, '=(Not IsNothing(Parameters!Start.Value))');
    const words = tr('ToWords({Orders.Amount})');
    assert.equal(words.expression, '=Code.CrToWords(Fields!Amount.Value)');
    assert.deepEqual(words.helpers, ['CrToWords']);
  });
  it('never leaves a function SSRS does not know in an expression (the report would not upload)', () => {
    const t = tr('Median({Orders.Amount})');
    assert.equal(t.expression, '=Nothing');
    assert.ok(t.issues.some((i) => /Median\(\) which has no SSRS equivalent/.test(i)));
  });
  it('translates fields, parameters, formulas and operators', () => {
    assert.equal(tr('{Orders.Amount} * 1.1 + {@Tax}').expression, '=((Fields!Amount.Value * 1.1) + (Fields!Tax.Value))');
    assert.equal(tr('{Orders.Date} >= {?Start Date} and not IsNull({Orders.Date})').expression,
      '=((Fields!Date.Value >= Parameters!Start_Date.Value) AndAlso Not (IsNothing(Fields!Date.Value)))');
    assert.equal(tr('"Total: " & ToText({Orders.Amount}, 2)').expression, '=("Total: " & FormatNumber(Fields!Amount.Value, 2))');
    assert.equal(tr("'It''s' + UpperCase({Orders.Name})").expression, `=("It's" + UCase(Fields!Name.Value))`);
  });

  it('translates if/else, select case, in lists and ranges', () => {
    assert.equal(tr('if {Orders.Amount} > 100 then "big" else "small"').expression, '=IIf((Fields!Amount.Value > 100), "big", "small")');
    assert.equal(tr('select {Orders.Amount} case 1 to 10: "low" case 11, 12: "mid" default: "high"').expression,
      '=Switch((Fields!Amount.Value >= 1 AndAlso Fields!Amount.Value <= 10), "low", (Fields!Amount.Value = 11) OrElse (Fields!Amount.Value = 12), "mid", True, "high")');
    assert.equal(tr('{Orders.Region} in ["BC", "AB"]').expression, '=(Fields!Region.Value = "BC" OrElse Fields!Region.Value = "AB")');
    assert.equal(tr('{Orders.Date} in #2020-01-01# to #2020-12-31#').expression,
      '=(Fields!Date.Value >= CDate("2020-01-01") AndAlso Fields!Date.Value <= CDate("2020-12-31"))');
  });

  it('translates aggregates with group scope and special fields', () => {
    assert.equal(tr('Sum({Orders.Amount}, {Orders.Region})').expression, '=Sum(Fields!Amount.Value, "Group1_Region")');
    assert.equal(tr('Average({Orders.Amount})').expression, '=Avg(Fields!Amount.Value)');
    assert.equal(tr('"Page " & PageNumber & " of " & TotalPageCount').expression,
      '=((("Page " & Globals!PageNumber) & " of ") & Globals!TotalPages)');
  });

  it('converts Crystal colours in conditional formatting formulas', () => {
    assert.equal(crystalColor(255), '#ff0000');
    assert.equal(tr('if CurrentFieldValue < 0 then crRed else Color(0, 128, 0)', true).expression, '=IIf((Me.Value < 0), "Red", "#008000")');
    assert.equal(tr('if CurrentFieldValue < 0 then 255 else DefaultAttribute', true).expression, '=IIf((Me.Value < 0), "#ff0000", Nothing)');
  });

  it('compares text fields without trailing spaces, as Crystal does with padded database columns', () => {
    const typed: FormulaContext = { ...ctx, fieldType: (ref) => (ref === 'Orders.Kind' ? 'string' : 'number') };
    assert.equal(translateFormula('if {Orders.Kind} = "N" then "Residual" else "x"', typed).expression, '=IIf((RTrim(Fields!Kind.Value) = "N"), "Residual", "x")');
    assert.equal(translateFormula('{Orders.Kind} in ["A", "B"]', typed).expression, '=(RTrim(Fields!Kind.Value) = "A" OrElse RTrim(Fields!Kind.Value) = "B")');
    assert.equal(translateFormula('{Orders.Amount} > 3', typed).expression, '=(Fields!Amount.Value > 3)');
  });

  it('keeps typographic quotes and odd line breaks out of VB string literals', () => {
    assert.equal(vbString('(“Owner’s”) said "x"'), '"(" & ChrW(8220) & "Owner’s" & ChrW(8221) & ") said ""x"""');
    assert.equal(vbString('a\rb c'), '"a" & vbCrLf & "b" & vbCrLf & "c"');
    assert.equal(vbString('＂'), 'ChrW(65282)');
  });

  it('flags what it cannot translate instead of guessing', () => {
    const vars = tr('WhilePrintingRecords; NumberVar total := total + 1; total');
    assert.ok(vars.issues.some((i) => i.includes('WhilePrintingRecords')));
    const loop = tr('Local NumberVar i; For i := 1 To 3 Do (i)');
    assert.equal(loop.expression, '=Nothing');
    assert.ok(loop.issues[0].includes('could not be parsed'));
    assert.ok(tr('MyCustomFunction({Orders.Amount})').issues.some((i) => i.includes('MyCustomFunction')));
    assert.ok(tr('{Other.Unknown} + 1').issues.some((i) => i.includes('unknown field')));
  });
});

const emptyDefinition = (): ReportDefinition => ({
  saveInfo: {}, formulas: [], selectionFormulas: {}, sqlExpressions: [], parameters: [],
  groups: [], sortFields: [], summarizedFields: [], layout: [],
});

const detailLayout = (...fields: string[]) => [{
  name: 'DetailArea1',
  sections: [{ name: 'DetailSection1', objects: fields.map((f, i) => ({ kind: 'field', name: `F${i}`, field: f, position: { x: i * 1440, y: 0 } })) }],
}];

describe('RDL generation', () => {
  it('builds a joined SELECT for direct table access with a SQL Server connection', () => {
    const source: DataSourceInfo = {
      connections: [{ driver: 'OLE DB (ADO)', properties: { Provider: 'SQLOLEDB', 'Data Source': 'SQLPROD01', 'Initial Catalog': 'Sales' } }],
      tables: [
        { alias: 'Orders', name: 'Orders', schema: 'dbo', kind: 'table', fields: [{ name: 'Order ID', type: 'integer' }, { name: 'Customer ID', type: 'integer' }, { name: 'Amount', type: 'currency' }] },
        { alias: 'Customer', name: 'Customer', schema: 'dbo', kind: 'table', fields: [{ name: 'Customer ID', type: 'integer' }, { name: 'Name', type: 'string' }] },
      ],
      links: [{ from: { table: 'Orders', field: 'Customer ID' }, to: { table: 'Customer', field: 'Customer ID' }, join: 'inner', operator: '=', codes: [4, 1, 1] }],
    };
    const definition = { ...emptyDefinition(), selectionFormulas: { record: '{Orders.Amount} > 100' }, layout: detailLayout('Customer.Name', 'Orders.Amount') };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Orders' });
    assertBalancedXml(rdl);
    assert.ok(rdl.includes('<ConnectString>Data Source=SQLPROD01;Initial Catalog=Sales</ConnectString>'));
    assert.ok(rdl.includes('FROM [dbo].[Orders] AS [Orders]\nINNER JOIN [dbo].[Customer] AS [Customer] ON [Orders].[Customer ID] = [Customer].[Customer ID]'));
    assert.ok(rdl.includes('[Customer].[Name] AS [Name]') && rdl.includes('[Orders].[Amount] AS [Amount]'));
    assert.ok(!rdl.includes('[Order ID]'), 'only used columns are selected');
    assert.ok(rdl.includes('WHERE [Orders].[Amount] &gt; 100</CommandText>'), 'selection becomes a WHERE clause');
    assert.ok(!rdl.includes('<Filters>'), 'no dataset filter needed');
    assert.ok(rdl.includes('<Format>C2</Format>'));
    assert.ok(!review.some((r) => r.item === 'Data source'), 'no placeholder connection needed');
  });

  it('calls a stored procedure with its parameters', () => {
    const source: DataSourceInfo = {
      connections: [{ driver: 'ODBC (RDO)', properties: { Server: 'SQLPROD01', Database: 'Sales' } }],
      tables: [{ alias: 'usp_OrdersByDate;1', name: 'usp_OrdersByDate;1', kind: 'storedProcedure', fields: [{ name: 'OrderDate', type: 'dateTime' }, { name: 'Total', type: 'currency' }] }],
      links: [],
    };
    const definition = {
      ...emptyDefinition(),
      parameters: [{ name: '@StartDate', prompt: 'Start date', valueType: 'dateTime' }],
      layout: detailLayout('usp_OrdersByDate;1.OrderDate', 'usp_OrdersByDate;1.Total'),
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Proc' });
    assertBalancedXml(rdl);
    assert.ok(rdl.includes('<CommandType>StoredProcedure</CommandType>'));
    assert.ok(rdl.includes('<CommandText>[usp_OrdersByDate]</CommandText>'));
    assert.ok(rdl.includes('<QueryParameter Name="@StartDate">') && rdl.includes('<Value>=Parameters!StartDate.Value</Value>'));
    assert.ok(rdl.includes('<ReportParameter Name="StartDate">') && rdl.includes('<DataType>DateTime</DataType>'));
    assert.ok(rdl.includes('<DataField>OrderDate</DataField>'));
    assert.ok(rdl.includes('<ConnectString>Data Source=SQLPROD01;Initial Catalog=Sales</ConnectString>'));
  });

  it('uses a SQL command as the query text', () => {
    const sql = 'SELECT Name, Amount FROM dbo.Orders WHERE Amount > 0';
    const source: DataSourceInfo = {
      connections: [],
      tables: [{ alias: 'Command', name: 'Command', kind: 'command', sql, fields: [{ name: 'Name', type: 'string' }, { name: 'Amount', type: 'number' }] }],
      links: [],
    };
    const { rdl, review } = convertToRdl({ ...emptyDefinition(), layout: detailLayout('Command.Name') }, source, { reportName: 'Cmd' });
    assert.ok(rdl.includes(`<CommandText>${sql.replace(/>/g, '&gt;')}</CommandText>`));
    assert.ok(review.some((r) => r.item === 'Data source'), 'placeholder connection is flagged');
  });

  it('builds groups with header/footer rows and turns page-header labels into column headings', () => {
    const source: DataSourceInfo = {
      connections: [],
      tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Region', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
      links: [],
    };
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [{ name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Region'] }],
      layout: [
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [{ kind: 'text', name: 'H1', text: 'Amount', position: { x: 1440, y: 0 } }, { kind: 'field', name: 'PN', field: 'Page Number', position: { x: 7000, y: 0 } }] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', objects: [{ kind: 'field', name: 'G', field: 'Group #1 Name', position: { x: 0, y: 0 } }] }] },
        ...detailLayout('Orders.Region', 'Orders.Amount'),
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [{ kind: 'field', name: 'S', field: 'Sum of Orders.Amount', position: { x: 1440, y: 0 } }] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Grouped' });
    assertBalancedXml(rdl);
    assert.ok(rdl.includes('<Group Name="Group1_Region">') && rdl.includes('<GroupExpression>=Fields!Region.Value</GroupExpression>'));
    assert.ok(rdl.includes('<Value>=Sum(Fields!Amount.Value)</Value>'));
    assert.ok(rdl.includes('<RepeatOnNewPage>true</RepeatOnNewPage>'), 'column headings repeat on each page');
    assert.match(rdl, /<PageHeader>[\s\S]*Globals!PageNumber[\s\S]*<\/PageHeader>/);
    assert.ok(!/<PageHeader>[\s\S]*>Amount<[\s\S]*<\/PageHeader>/.test(rdl), 'the heading moved into the table');
  });
});

// Optional: convert real reports with RPT_SAMPLES_DIR=/path/to/rpt/files npm test
const samplesDir = process.env.RPT_SAMPLES_DIR;
describe('real .rpt samples to RDL', { skip: !samplesDir && 'set RPT_SAMPLES_DIR to enable' }, () => {
  const files = samplesDir ? readdirSync(samplesDir).filter((f) => f.toLowerCase().endsWith('.rpt')) : [];
  for (const file of files) {
    it(file, () => {
      const reports = convertDocumentToSsrs(readCfb(readFileSync(join(samplesDir!, file))), file.replace(/\.rpt$/i, ''));
      assert.ok(reports.length > 0);
      for (const report of reports) {
        assert.ok(report.rdl.length > 0, `${report.fileName} was generated`);
        assertBalancedXml(report.rdl);
        // Nothing past the printable page, nor a thousandth past a cell (SSRS would add a page after every page).
        const widths = checkRdlWidths(report.rdl);
        assert.ok(!/past the printable page|body wider/.test(widths), `${report.fileName}: ${widths}`);
        for (const m of widths.matchAll(/contents reach ([\d.]+)in in a ([\d.]+)in column/g)) {
          assert.ok(parseFloat(m[1]) - parseFloat(m[2]) > 0.015, `${report.fileName}: ${m[0]}`);
        }
      }
    });
  }
});

describe('custom code for multi-statement formulas', () => {
  it('turns loops and variables into a VB function and passes fields as arguments', () => {
    const source = 'Local NumberVar i; Local NumberVar n := 0; For i := 1 To Length({Orders.Size}) Do (if {Orders.Size}[i] = "X" then n := n + 1); n';
    const t = translateFormula(source, ctx, { codeName: 'F_Count' });
    assert.equal(t.expression, '=Code.F_Count(Fields!Size.Value)');
    assert.match(t.code!, /Public Function F_Count\(ByVal a1 As Object\) As Object/);
    assert.match(t.code!, /For v_i = 1 To Len\(a1\)/);
    assert.match(t.code!, /If \(Mid\(a1, v_i, 1\) = "X"\) Then/);
    assert.match(t.code!, /Return v_n/);
  });

  it('keeps shared variables as class members and aggregates as arguments', () => {
    const t = translateFormula('WhilePrintingRecords; Global CurrencyVar total := total + Sum({Orders.Amount}); total', ctx, { codeName: 'F_Total' });
    assert.equal(t.expression, '=Code.F_Total(Sum(Fields!Amount.Value))');
    assert.deepEqual(t.members, { v_total: 'Decimal' });
  });

  it('converts Crystal custom functions', () => {
    const t = translateFormula('Function (StringVar a, NumberVar b) a & ToText(b, 0)', ctx, { codeName: 'F_Join' });
    assert.match(t.code!, /Public Function F_Join\(ByVal p_a As String, ByVal p_b As Double\) As Object/);
    const call = translateFormula('Join2({Orders.Name}, 3)', { ...ctx, customFunction: (n) => (n === 'Join2' ? 'F_Join' : undefined) });
    assert.equal(call.expression, '=Code.F_Join(Fields!Name.Value, 3)');
  });
});

describe('layout conversion', () => {
  const source: DataSourceInfo = {
    connections: [],
    tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Customer', type: 'string' }, { name: 'Region', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
    links: [],
  };

  it('converts Top N groups, lines, boxes, pictures, colours and suppression', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Customer'] },
        { name: 'Font_Color', index: 1, kind: 'conditionalFormat', text: 'if CurrentFieldValue < 0 then crRed else crBlack', referencedFields: [] },
        { name: 'Section_Visibility', index: 2, kind: 'conditionalFormat', text: 'PageNumber = 1', referencedFields: [] },
      ],
      sorts: [{ field: 'Sum of Orders.Amount', descending: true, bySummary: true }],
      groupOptions: [{ field: 'Orders.Customer', topN: 5, keepOthers: false }],
      page: { orientation: 'landscape', paperSize: 1 },
      layout: [
        { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 720, conditions: { suppress: { name: 'Section_Visibility', index: 2 } }, objects: [
          { kind: 'text', name: 'Title', text: 'Sales', position: { x: 0, y: 0 }, size: { width: 2880, height: 360 }, font: 'Arial', style: { size: 18, bold: true, italic: true, color: '#000080' } },
          { kind: 'picture', name: 'Logo', embedding: 1, position: { x: 7200, y: 0 }, size: { width: 1440, height: 720 } },
          { kind: 'box', name: 'Frame', position: { x: 0, y: 0 }, size: { width: 10000, height: 700 }, border: { sides: [1, 1, 1, 1], color: '#5a79a5', background: '#eeeeee', width: 20 } },
        ] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 300, objects: [
          { kind: 'field', name: 'G', field: 'Group #1 Name', position: { x: 0, y: 0 }, size: { width: 1440, height: 221 } },
          { kind: 'line', name: 'Under', position: { x: 0, y: 280 }, size: { width: 5000, height: 0 }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 20 } },
        ] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 250, objects: [
          { kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 1440, y: 0 }, size: { width: 1440, height: 221 }, conditions: { fontColor: { name: 'Font_Color', index: 1 } } },
        ] }] },
      ],
    };
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { rdl } = convertToRdl(definition, source, { reportName: 'TopN', images: new Map([[1, png]]) });
    assertBalancedXml(rdl);
    assert.match(rdl, /<FilterExpression>=Sum\(Fields!Amount.Value\)<\/FilterExpression>\s*<Operator>TopN<\/Operator>\s*<FilterValues>\s*<FilterValue DataType="Integer">5<\/FilterValue>/);
    assert.match(rdl, /<Value>=Sum\(Fields!Amount.Value\)<\/Value>\s*<Direction>Descending<\/Direction>/);
    assert.match(rdl, /<PageWidth>11in<\/PageWidth>/);
    assert.match(rdl, /<FontStyle>Italic<\/FontStyle>\s*<FontFamily>Arial<\/FontFamily>\s*<FontSize>18pt<\/FontSize>\s*<FontWeight>Bold<\/FontWeight>/);
    assert.match(rdl, /<Color>#000080<\/Color>/);
    assert.match(rdl, /<Color>=IIf\(\(Me.Value &lt; 0\), "Red", "Black"\)<\/Color>/);
    assert.match(rdl, /<Hidden>=\(Globals!PageNumber = 1\)<\/Hidden>/);
    assert.match(rdl, /<EmbeddedImage Name="Logo">\s*<MIMEType>image\/png<\/MIMEType>/);
    assert.match(rdl, /<Image Name="Logo">\s*<Source>Embedded<\/Source>\s*<Value>Logo<\/Value>/);
    assert.match(rdl, /<Rectangle Name="Frame">[\s\S]*<BackgroundColor>#eeeeee<\/BackgroundColor>/);
    assert.match(rdl, /<BottomBorder>\s*<Style>Solid<\/Style>/, 'the line under the group header became a cell border');
    assert.match(rdl, /<Width>1in<\/Width>/, 'object widths are used for columns');
  });

  it('converts font style, line style, X position and width formatting formulas', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Font_Style', index: 1, kind: 'conditionalFormat', text: 'if {Orders.Region} = "Total" then crBold else crRegular', referencedFields: [] },
        { name: 'Bottom_Line_Style', index: 2, kind: 'conditionalFormat', text: 'if {Orders.Region} = "Total" then crSingleLine else crNoLine', referencedFields: [] },
        { name: 'DeltaX_Value_Formula', index: 3, kind: 'conditionalFormat', text: 'if {Orders.Region} = "Total" then 120 else 300', referencedFields: [] },
        { name: 'DeltaWidth_Value_Formula', index: 4, kind: 'conditionalFormat', text: 'DefaultAttribute', referencedFields: [] },
      ],
      groups: ['Orders.Region'],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 400, objects: [
          { kind: 'text', name: 'HeadA', text: 'Name', position: { x: 300, y: 0 }, size: { width: 900, height: 221 }, align: 'center' },
          { kind: 'text', name: 'HeadB', text: 'Amount', position: { x: 2880, y: 0 }, size: { width: 1440, height: 221 }, align: 'right' },
          { kind: 'line', name: 'UnderA', position: { x: 300, y: 260 }, size: { width: 900, height: 0 }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 20 } },
        ] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 250, objects: [
          { kind: 'field', name: 'Name', field: 'Orders.Customer', position: { x: 120, y: 0 }, size: { width: 2760, height: 221 },
            conditions: { fontStyle: { name: 'Font_Style', index: 1 }, deltaX: { name: 'DeltaX_Value_Formula', index: 3 }, deltaWidth: { name: 'DeltaWidth_Value_Formula', index: 4 } } },
          { kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 2880, y: 0 }, size: { width: 1440, height: 221 }, align: 'right',
            conditions: { bottomLine: { name: 'Bottom_Line_Style', index: 2 } } },
        ] }] },
      ],
    };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Styled' });
    assertBalancedXml(rdl);
    const total = '\\(\\(RTrim\\(Fields!Region.Value\\) = "Total"\\)';
    assert.match(rdl, new RegExp(`<FontWeight>=IIf\\(IsNothing\\(IIf${total}, "Bold", "Regular"\\)\\), "Normal", IIf\\(InStr\\(CStr\\(`));
    assert.match(rdl, new RegExp(`<BottomBorder>\\s*<Color>Black</Color>\\s*<Style>=IIf\\(IsNothing\\(IIf${total}, "Solid", "None"\\)\\), "None", `));
    // The X position formula moves the text by its offset, in twips, from the field's place in its cell.
    assert.match(rdl, new RegExp(`<PaddingLeft>=CStr\\(CInt\\(Math.Max\\(0, 0 \\+ IIf\\(IsNothing\\(IIf${total}, 120, 300\\)\\), 0, CDbl\\(IIf${total}, 120, 300\\)\\)\\)\\) / 20\\)\\) &amp; "pt"</PaddingLeft>`));
    assert.ok(!review.some((r) => /not converted/.test(JSON.stringify(r))), 'the formulas are converted');
    // The rule under one heading only stays under that heading, not along the whole row.
    const amountHead = rdl.slice(rdl.indexOf('<Textbox Name="HeadB">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="HeadB">')));
    assert.ok(!/BottomBorder/.test(amountHead));
    assert.match(rdl, /<Rectangle Name="HeadA_Area">[\s\S]*?<Line Name="UnderA">/);
    // The heading is placed as the values under it are (centred in its column), its rule moving with it.
    assert.match(rdl, /<Textbox Name="HeadA">[\s\S]*?<Left>0in<\/Left>\s*<Height>[^<]*<\/Height>\s*<Width>1.917in<\/Width>/);
    assert.match(rdl, /<Line Name="UnderA">\s*<Top>[^<]*<\/Top>\s*<Left>0.608in<\/Left>/);
  });

  it('widens a table to a thick rule across the page and keeps the whole rule on the page', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      groups: ['Orders.Region'],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 220, objects: [
          { kind: 'line', name: 'Rule', position: { x: 0, y: 0 }, size: { width: 14400, height: 0 }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 60 } },
        ] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [
          { kind: 'field', name: 'Name', field: 'Orders.Customer', position: { x: 588, y: 0 }, size: { width: 7000, height: 200 } },
          { kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 7751, y: 0 }, size: { width: 3000, height: 200 }, align: 'right' },
        ] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Ruled' });
    assertBalancedXml(rdl);
    const columns = rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).match(/<Width>[^<]*/g)?.map((w) => w.slice(7));
    // An empty column either side takes the table out to the rule's ends (0in to 10in).
    assert.deepEqual(columns, ['0.408in', '4.974in', '2.083in', '2.534in']);
    assert.match(rdl, /<Tablix Name="Table">[\s\S]*?<Top>0.024in<\/Top>\s*<Left>0in<\/Left>/, 'the table starts half the rule lower');
  });

  it('draws a line style formula under a field narrower than its column as a line as wide as the field', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        { name: 'Bottom_Line_Style', index: 1, kind: 'conditionalFormat', text: 'if {Orders.Region} = "Total" then crSingleLine else crNoLine', referencedFields: [] },
        { name: 'DeltaX_Value_Formula', index: 2, kind: 'conditionalFormat', text: '(if IsNull({Orders.Amount}) then 0 else 1) * 1.15 * 1440', referencedFields: [] },
      ],
      layout: [
        { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [
          { kind: 'field', name: 'Name', field: 'Orders.Customer', position: { x: 0, y: 0 }, size: { width: 7000, height: 200 } },
          { kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 7751, y: 0 }, size: { width: 2000, height: 200 }, align: 'right',
            conditions: { bottomLine: { name: 'Bottom_Line_Style', index: 1 }, deltaX: { name: 'DeltaX_Value_Formula', index: 2 } } },
          { kind: 'field', name: 'Tag', field: 'Orders.Region', position: { x: 13327, y: 0 }, size: { width: 650, height: 200 } },
        ] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Rule' });
    assertBalancedXml(rdl);
    const amount = rdl.slice(rdl.indexOf('<Textbox Name="Amt">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Amt">')));
    assert.ok(!/BottomBorder/.test(amount), 'not the whole cell\'s border');
    // Moved by the X position formula (a computed place): drawn in pieces across the cell, each drawn where it falls
    // within the moved line.
    const pieces = rdl.match(/<Line Name="Amt_Below(_\d+)?">/g) ?? [];
    assert.equal(pieces.length, Math.ceil(5576 / 72));
    assert.match(rdl, /<Line Name="Amt_Below_2">\s*<Top>0.139in<\/Top>\s*<Left>0.05in<\/Left>\s*<Height>0in<\/Height>\s*<Width>0.05in<\/Width>\s*<Style>\s*<Border>\s*<Color>Black<\/Color>\s*<Style>=IIf\(\(\(0 \+ IIf\(IsNothing\([^<]*\) &lt;= 108 AndAlso 108 &lt;= \(2000 \+ [^<]*\)\), IIf\(IsNothing\([^<]*, "None"\)<\/Style>/);
    // Never hidden (SSRS would slide the pieces beside a hidden one across into its place).
    assert.ok(!/<Line Name="Amt_Below[^"]*">\s*<Top>[^<]*<\/Top>\s*<Left>[^<]*<\/Left>\s*<Height>[^<]*<\/Height>\s*<Width>[^<]*<\/Width>\s*<Visibility>/.test(rdl));
  });

  it('keeps a table reaching out to a rule within the printable page', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      groups: ['Orders.Region'],
      page: { orientation: 'landscape', paperSize: 1 },
      margins: { left: 360, right: 360, top: 360, bottom: 360 },
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 220, objects: [
          { kind: 'line', name: 'Rule', position: { x: 0, y: 0 }, size: { width: 15400, height: 0 }, border: { sides: [0, 0, 1, 0], color: '#000000', width: 60 } },
        ] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [
          { kind: 'field', name: 'Name', field: 'Orders.Customer', position: { x: 600, y: 0 }, size: { width: 6000, height: 200 } },
          { kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 6700, y: 0 }, size: { width: 8500, height: 200 } },
        ] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Edge' });
    const columns = (rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).match(/<Width>[^<]*/g) ?? []).map((w) => parseFloat(w.slice(7)));
    // Wider than the page, SSRS would print the overflow on a page of its own after every page.
    assert.ok(columns.reduce((a, b) => a + b, 0) <= 10.5 + 1e-9, `columns ${columns.join(', ')}`);
    assert.match(checkRdlWidths(rdl), /nothing reaches past the page or what holds it/);
  });

  it('keeps the columns of a subreport table wider than its place', () => {
    const fields = [{ name: 'Customer', type: 'string' as const }, ...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `V${i}`, type: 'number' as const }))];
    const subSource: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields }] };
    const values = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ kind: 'field' as const, name: `V${i}f`, field: `T.V${i}`, position: { x: 5400 + (i - 1) * 1300, y: 0 }, size: { width: 1200, height: 200 }, align: 'right' as const }));
    const sub: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [{ kind: 'field', name: 'Nf', field: 'T.Customer', position: { x: 0, y: 0 }, size: { width: 5000, height: 200 } }, ...values] }] }] };
    const main: ReportDefinition = { ...emptyDefinition(), page: { orientation: 'landscape', paperSize: 5 }, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 400, objects: [{ kind: 'subreport', name: 'Sub1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 3000, height: 400 } }] }] }] };
    const { rdl } = convertToRdl(main, subSource, { reportName: 'Main', subreports: new Map([[1, { name: 'Sub1', links: [], definition: sub, dataSource: subSource }]]) });
    const widths = (rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).match(/<Width>[^<]*/g) ?? []).map((w) => parseFloat(w.slice(7)));
    // Squeezed into the subreport's place, every column after the first would be left 0.05in wide.
    assert.equal(widths.length, 8);
    assert.ok(widths.slice(1).every((w) => w > 0.8), `columns ${widths.join(', ')}`);
  });

  it('lays out columns placed by X position formulas side by side', () => {
    const n = [1, 2, 3, 4];
    const fields = [{ name: 'Customer', type: 'string' as const }, { name: 'Region', type: 'string' as const }, ...n.flatMap((i) => [{ name: `Pos${i}`, type: 'number' as const }, { name: `V${i}`, type: 'number' as const }])];
    const dynSource: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields }] };
    // The headings' formulas are written a little differently from the values' (still the same column).
    const formulas = n.flatMap((i) => [
      { name: 'DeltaX_Value_Formula', index: i, kind: 'conditionalFormat' as const, text: `{T.Pos${i}} * 1440`, referencedFields: [] },
      { name: 'DeltaX_Value_Formula', index: 10 + i, kind: 'conditionalFormat' as const, text: `({T.Pos${i}}*1440)`, referencedFields: [] },
    ]);
    // Every column designed in the same place, moved to its own by its formula.
    const at = (name: string, i: number, y: number) => ({ kind: 'field' as const, name, field: `T.V${i}`, position: { x: 30, y }, size: { width: 1155, height: 210 }, align: 'right' as const, conditions: { deltaX: { name: 'DeltaX_Value_Formula', index: i } } });
    const definition: ReportDefinition = { ...emptyDefinition(), formulas, groups: ['T.Region'], layout: [
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 900, objects: [
        { kind: 'text', name: 'Title', text: 'Detail', position: { x: 0, y: 0 }, size: { width: 15000, height: 288 }, align: 'center' },
        { kind: 'text', name: 'NameHead', text: 'Name', position: { x: 53, y: 405 }, size: { width: 4987, height: 200 }, align: 'center' },
        ...n.map((i) => ({ ...at(`Head${i}`, i, 405), field: `T.Pos${i}`, align: 'center' as const, conditions: { deltaX: { name: 'DeltaX_Value_Formula', index: 10 + i } } })),
      ] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [
        { kind: 'field', name: 'Name1', field: 'T.Customer', position: { x: 53, y: 0 }, size: { width: 4987, height: 210 } },
        ...n.map((i) => at(`Value${i}`, i, 0)),
      ] }] },
    ] };
    const { rdl, review } = convertToRdl(definition, dynSource, { reportName: 'Dyn' });
    const widths = (rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).match(/<Width>[^<]*/g) ?? []).map((w) => parseFloat(w.slice(7)));
    // A name column, then one column per formula, spread to the title's width.
    assert.equal(widths.length, 5, `columns ${widths.join(', ')}`);
    assert.ok(Math.abs(widths[0] - (5040 + 144 - 53) / 1440) < 0.01, `name column ${widths[0]}`);
    // (the last ends where its fields end)
    assert.ok(widths.slice(1, -1).every((w) => w > 1.5) && widths[widths.length - 1] >= 0.8, `columns ${widths.join(', ')}`);
    assert.ok(!/PaddingLeft>=/.test(rdl), 'no longer moved within their own boxes');
    assert.ok(review.some((r) => /4 columns are placed by X position formulas/.test(r.message)));
    assert.match(checkRdlWidths(rdl), /nothing reaches past the page or what holds it/);
  });

  it('starts a new page after a group footer or a section with New Page After', () => {
    const grouped: ReportDefinition = { ...emptyDefinition(), groups: ['Orders.Region'], layout: [
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [{ kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 0, y: 0 }, size: { width: 1440, height: 200 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 220, newPageAfter: true, objects: [{ kind: 'text', name: 'Total', text: 'Total', position: { x: 0, y: 0 }, size: { width: 1440, height: 200 } }] }] },
    ] };
    assert.match(convertToRdl(grouped, source, { reportName: 'G' }).rdl, /<Group Name="[^"]*">[\s\S]*?<PageBreak>\s*<BreakLocation>End<\/BreakLocation>/);
    const sections: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'ReportHeaderArea1', sections: [
        { name: 'First', height: 300, newPageAfter: true, objects: [{ kind: 'text', name: 'One', text: 'One', position: { x: 0, y: 0 }, size: { width: 1440, height: 200 } }] },
        { name: 'Second', height: 300, objects: [{ kind: 'text', name: 'Two', text: 'Two', position: { x: 0, y: 0 }, size: { width: 1440, height: 200 } }] },
      ] },
    ] };
    assert.match(convertToRdl(sections, source, { reportName: 'S' }).rdl, /<Rectangle Name="First_Page">[\s\S]*?<PageBreak>\s*<BreakLocation>End<\/BreakLocation>/);
  });

  it('keeps a group together when its record says so', () => {
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    // The end of a group record: the options byte follows the last ffff 00000001 0000 ffff.
    const tail = '0000000000010000ffff0000000000010000ffff000000010000ffff';
    assert.equal(groupOptionByte(hex(`${tail}02000000000000`), 0), 2);
    assert.equal(groupOptionByte(hex(`${tail}00000000000000`), 0), 0);
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['Orders.Region'], groupsKeptTogether: ['Orders.Region'], layout: [
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [{ kind: 'field', name: 'Amt', field: 'Orders.Amount', position: { x: 0, y: 0 }, size: { width: 1440, height: 200 } }] }] },
    ] };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'K' });
    assert.match(rdl, /<\/TablixMembers>\s*<KeepTogether>true<\/KeepTogether>\s*<\/TablixMember>/);
    assert.ok(review.some((r) => /kept together on a page/.test(r.message)));
  });

  it('lists what reaches past the printable page or past what holds it', () => {
    const rdl = `<Report><ReportSections><ReportSection><Body><ReportItems>
      <Rectangle Name="Area"><ReportItems><Textbox Name="Wide"><Left>1in</Left><Width>3in</Width></Textbox></ReportItems><Left>0in</Left><Width>2in</Width></Rectangle>
      <Tablix Name="Grid"><TablixBody><TablixColumns><TablixColumn><Width>6in</Width></TablixColumn><TablixColumn><Width>4.6in</Width></TablixColumn></TablixColumns></TablixBody><Left>0in</Left><Width>10.5in</Width></Tablix>
      </ReportItems></Body><Width>10.5in</Width><Page><PageWidth>11in</PageWidth><LeftMargin>0.25in</LeftMargin><RightMargin>0.25in</RightMargin></Page></ReportSection></ReportSections></Report>`;
    const report = checkRdlWidths(rdl);
    assert.match(report, /^page 11.000in, printable 10.500in, body 10.500in/);
    assert.match(report, /Rectangle "Area" is 2.000in wide but holds items to 4.000in/);
    assert.match(report, /Tablix "Grid" columns add up to 10.600in, more than its width 10.500in/);
    assert.match(report, /the body's items reach 10.600in, past the printable page \(10.500in\)/);
  });

  it('converts cross-tabs to matrices, charts to charts and running totals to RunningValue', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      runningTotals: [{ name: 'Total', field: 'Orders.Amount', operation: 'sum' }],
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 5000, objects: [
          { kind: 'crossTab', name: 'CrossTab1', position: { x: 0, y: 0 }, crossTab: { rows: ['Orders.Region'], columns: ['Orders.Customer'], summaries: ['Sum of Orders.Amount'] } },
          { kind: 'chart', name: 'Chart1', position: { x: 0, y: 2000 }, size: { width: 5760, height: 2880 }, chart: { values: ['Sum of Orders.Amount'], onChangeOf: 'Orders.Region', title: 'Sales', categoryTitle: 'Region', valueTitle: 'Amount' } },
        ] }] },
        ...detailLayout('Orders.Customer', '#Total'),
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Matrix' });
    assertBalancedXml(rdl);
    assert.match(rdl, /<TablixCorner>/);
    assert.match(rdl, /<GroupExpression>=Fields!Customer.Value<\/GroupExpression>[\s\S]*<GroupExpression>=Fields!Region.Value<\/GroupExpression>/);
    assert.match(rdl, /<Chart Name="Chart1">[\s\S]*<GroupExpression>=Fields!Region.Value<\/GroupExpression>[\s\S]*<Y>=Sum\(Fields!Amount.Value\)<\/Y>[\s\S]*<Caption>Sales<\/Caption>/);
    assert.match(rdl, /<Value>=RunningValue\(Fields!Amount.Value, Sum, "DataSet1"\)<\/Value>/);
  });
});

describe('selection formulas and parameters', () => {
  const source: DataSourceInfo = {
    connections: [],
    tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Date', type: 'dateTime' }, { name: 'Region', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
    links: [],
  };

  it('turns range and multi-value parameters into SQL and SSRS parameters', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      parameters: [
        { name: 'Period', prompt: 'Enter Period:', valueType: 'date', allowRange: true, allowDiscrete: false },
        { name: 'Regions', prompt: 'Regions', valueType: 'string', allowMultiple: true },
      ],
      selectionFormulas: { record: '{Orders.Date} = {?Period} and {Orders.Region} in ["BC", "AB"] and not IsNull({Orders.Amount})' },
      layout: detailLayout('Orders.Region', 'Orders.Amount'),
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Params' });
    assertBalancedXml(rdl);
    assert.ok(rdl.includes("WHERE (([Orders].[Date] BETWEEN @Period_Start AND @Period_End AND [Orders].[Region] IN ('BC', 'AB')) AND NOT ([Orders].[Amount] IS NULL))"));
    assert.match(rdl, /<ReportParameter Name="Period_Start">\s*<DataType>DateTime<\/DataType>\s*<Prompt>Enter Period \(from\)<\/Prompt>/);
    assert.match(rdl, /<QueryParameter Name="@Period_End">\s*<Value>=Parameters!Period_End.Value<\/Value>/);
    assert.match(rdl, /<ReportParameter Name="Regions">[\s\S]*<MultiValue>true<\/MultiValue>/);
  });

  it('falls back to a dataset filter when the selection has no SQL equivalent', () => {
    const definition = { ...emptyDefinition(), selectionFormulas: { record: 'UpperCase({Orders.Region})[1] = "B"' }, layout: detailLayout('Orders.Region') };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Filter' });
    assert.ok(!rdl.includes('WHERE'));
    assert.match(rdl, /<FilterExpression>=\(Mid\(UCase\(Fields!Region.Value\), 1, 1\) = "B"\)<\/FilterExpression>/);
  });
});

describe('joins, dates and custom function coverage', () => {
  const source: DataSourceInfo = {
    connections: [],
    tables: [
      { alias: 'Orders', name: 'Orders', schema: 'dbo', kind: 'table', fields: [{ name: 'Customer ID', type: 'integer' }, { name: 'Order Date', type: 'dateTime' }, { name: 'Ship Date', type: 'dateTime' }, { name: 'Amount', type: 'currency' }] },
      { alias: 'Customer', name: 'Customer', schema: 'dbo', kind: 'table', fields: [{ name: 'Customer ID', type: 'integer' }, { name: 'Name', type: 'string' }] },
    ],
    links: [{ from: { table: 'Customer', field: 'Customer ID' }, to: { table: 'Orders', field: 'Customer ID' }, join: 'leftOuter', operator: '=', codes: [4, 2, 1] }],
  };
  const formula = (name: string, text: string) => ({ name, kind: 'formula' as const, text, referencedFields: [] });

  it('converts outer joins, named date ranges, Next(), date arithmetic and typed if defaults', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [
        formula('Days', '{Orders.Ship Date} - {Orders.Order Date}'),
        formula('Due', '{Orders.Order Date} + 30'),
        formula('NextAmt', 'Next({Orders.Amount})'),
        formula('Big', 'if {Orders.Amount} > 100 then "Big"'),
      ],
      selectionFormulas: { record: '{Orders.Order Date} in LastFullMonth' },
      layout: detailLayout('Customer.Name', '@Days', '@Due', '@NextAmt', '@Big'),
    };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Dates' });
    assertBalancedXml(rdl);
    assert.ok(rdl.includes('FROM [dbo].[Customer] AS [Customer]\nLEFT OUTER JOIN [dbo].[Orders] AS [Orders] ON [Customer].[Customer ID] = [Orders].[Customer ID]'));
    assert.ok(rdl.includes('LEAD([Orders].[Amount]) OVER (ORDER BY (SELECT NULL)) AS [Next_Amount]'));
    assert.ok(rdl.includes('WHERE ([Orders].[Order Date] &gt;= DATEADD(month, -1, DATEFROMPARTS('));
    assert.ok(rdl.includes('<Value>=DateDiff("d", Fields!Order_Date.Value, Fields!Ship_Date.Value)</Value>'));
    assert.ok(rdl.includes('<Value>=DateAdd("d", (30), Fields!Order_Date.Value)</Value>'));
    assert.ok(rdl.includes('<Value>=IIf((Fields!Amount.Value &gt; 100), "Big", "")</Value>'), 'Crystal default for a string');
    assert.ok(review.some((r) => r.item === 'Next(Orders.Amount)'));
  });

  it('converts Select statements, WeekDay constants and hoists declarations', () => {
    const source = `Function (NumberVar y)
      DateVar d := CDate(y, 1, 1);
      Select WeekDay(d, crMonday)
        Case 6: NumberVar n := 2
        Case 7: (n := 1; d := d + 1)
        Default: n := 0;
      if n > 0 then d := d + n;
      d`;
    const t = translateFormula(source, ctx, { codeName: 'F_Next' });
    assert.deepEqual(t.issues, []);
    const lines = t.code!.split('\n');
    assert.equal(lines[1], '    Dim v_d As Date');
    assert.equal(lines[2], '    Dim v_n As Double');
    assert.match(t.code!, /Select Case Weekday\(v_d, FirstDayOfWeek\.Monday\)\n {8}Case 6\n {12}v_n = 2\n {8}Case 7\n {12}v_n = 1\n {12}v_d = DateAdd\("d", \(1\), v_d\)\n {8}Case Else\n {12}v_n = 0\n {4}End Select/);
    assert.match(t.code!, /v_d = DateAdd\("d", \(v_n\), v_d\)/);
  });

  it('builds colours from RGB() at run time and resolves date arithmetic on custom function results', () => {
    const color = translateFormula('Function (NumberVar v) RGB(v, 0, 255 - v)', ctx, { codeName: 'F_C' });
    assert.match(color.code!, /Return String\.Format\("#\{0:X2\}\{1:X2\}\{2:X2\}", CInt\(p_v\), CInt\(0\), CInt\(\(255 - p_v\)\)\)/);
    const t = translateFormula('MyDay({Orders.Date}) - 2', { ...ctx, customFunction: () => 'F_MyDay' });
    assert.equal(t.expression, '=Code.CrSubtract(Code.F_MyDay(Fields!Date.Value), 2)');
    assert.deepEqual(t.helpers, ['CrSubtract']);
    assert.match(CODE_HELPERS.CrSubtract, /If TypeOf a Is Date Then Return DateAdd\("d", -CDbl\(b\), CDate\(a\)\)/);
  });
});

describe('chart types, margins, subreports and Basic syntax', () => {
  const source: DataSourceInfo = {
    connections: [],
    tables: [{ alias: 'Sales.Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Region', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
    links: [],
  };
  const chartLayout = (family: number, graphType: number) => [{
    name: 'ReportHeaderArea1',
    sections: [{ name: 'RH', height: 4000, objects: [{
      kind: 'chart', name: 'Chart1', position: { x: 0, y: 0 }, size: { width: 5760, height: 3600 },
      chart: { values: ['Sum of Sales_Orders.Amount'], onChangeOf: 'Sales_Orders.Region', family, graphType },
    }] }],
  }];

  it('maps Crystal graph types to SSRS chart types', () => {
    assert.deepEqual(chartStyle(0, 1), { type: 'Column', subtype: 'Stacked', threeD: false });
    assert.deepEqual(chartStyle(3, 31), { type: 'Shape', subtype: 'Pie', threeD: true });
    assert.deepEqual(chartStyle(4, 40), { type: 'Shape', subtype: 'Doughnut', threeD: false });
    assert.equal(chartStyle(2, 22).subtype, 'PercentStacked');
    assert.match(chartStyle(7, 70).note!, /XY scatter/);
    const { rdl, review } = convertToRdl({ ...emptyDefinition(), layout: chartLayout(3, 31) as ReportDefinition['layout'] }, source, { reportName: 'Pie' });
    assertBalancedXml(rdl);
    assert.match(rdl, /<Type>Shape<\/Type>\s*<Subtype>Pie<\/Subtype>/);
    assert.match(rdl, /<ChartThreeDProperties>\s*<Enabled>true<\/Enabled>/);
    assert.ok(!review.some((r) => r.item.includes('Chart1')), 'a pie chart needs no review');
  });

  it('uses the stored margins and resolves dotted table names', () => {
    const definition = { ...emptyDefinition(), margins: { left: 936, right: 260, top: 144, bottom: 260 }, layout: detailLayout('Sales_Orders.Amount') };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Margins' });
    assert.match(rdl, /<LeftMargin>0.65in<\/LeftMargin>\s*<RightMargin>0.181in<\/RightMargin>\s*<TopMargin>0.1in<\/TopMargin>\s*<BottomMargin>0.181in<\/BottomMargin>/);
    assert.ok(!review.some((r) => r.item === 'Page'));
    assert.ok(rdl.includes('<Value>=Fields!Amount.Value</Value>'), '{Sales_Orders.Amount} is the table "Sales.Orders"');
  });

  it('reads a subreport\'s areas as report header, report footer and details', () => {
    const section = (name: string, text: string) => ({ name, objects: [{ kind: 'text', name: `T_${name}`, text, position: { x: 0, y: 0 } }] });
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      layout: [
        { name: 'Area1', sections: [section('S1', 'Heading')] },
        { name: 'Area4', sections: [{ name: 'S4', objects: [] }] },
        { name: 'Area3', sections: [section('S3', 'Row')] },
        { name: 'DetailFooter1', sections: [] },
      ],
    };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Sub', subreport: true });
    assert.ok(!rdl.includes('<PageHeader>'), 'a subreport has no page header');
    assert.ok(rdl.includes('Heading') && rdl.includes('Row'));
    assert.ok(!review.some((r) => /unrecognised|margins/.test(r.message)));
  });

  it('translates Crystal Basic syntax formulas into custom code', () => {
    const source = [
      'dim parts() as string',
      'dim n as number',
      "parts = split({Orders.Name}, \"\\\\\") ' last part",
      'n = ubound(parts)',
      'if n > 1 then',
      '  formula = parts(n) & " of " & CStr(n)',
      'else',
      '  formula = URLDecode({?Title})',
      'end if',
    ].join('\r\n');
    assert.ok(isBasicSyntax(source));
    assert.ok(!isBasicSyntax('if {Orders.Amount} > 0 then "a" else "b"'));
    const t = translateFormula(source, ctx, { codeName: 'F_Last' });
    assert.equal(t.expression, '=Code.F_Last(Fields!Name.Value, Parameters!Title.Value)');
    assert.deepEqual(t.helpers, ['CrSplit', 'CrToText'], 'CStr of a value whose type is decided at run time');
    assert.match(t.code!, /Public Function F_Last\(ByVal a1 As Object, ByVal a2 As Object\) As Object\n {4}Dim result As Object = Nothing\n {4}Dim v_parts\(\) As Object\n {4}Dim v_n As Double/);
    assert.match(t.code!, /v_parts = CrSplit\(a1, "\\\\"\)\n {4}v_n = UBound\(v_parts\)\n {4}If v_n > 1 Then\n {8}result = v_parts\(v_n\) & " of " & CrToText\(v_n\)\n {4}Else\n {8}result = System\.Uri\.UnescapeDataString/);
    assert.match(t.code!, /End If\n {4}Return result\nEnd Function$/);
  });

  it('translates Basic syntax custom functions and keeps Crystal arrays 1-based', () => {
    const fn = translateFormula('Function Twice (x As Number, Optional y As Number = 1) As Number\r\n  Twice = x * 2 + y\r\nEnd Function', ctx, { codeName: 'F_Twice' });
    assert.equal(fn.expression, '=Code.F_Twice()');
    assert.match(fn.code!, /Public Function F_Twice\(ByVal p_x As Double, Optional ByVal p_y As Double = 1\) As Object/);
    // VB needs a constant default: an expression default is computed in the function instead.
    const colour = translateFormula('Function (numberVar row, optional numberVar shade := Color(239, 235, 220))\r\nif row mod 2 = 0 then shade else crNoColor', ctx, { codeName: 'F_Shade' });
    assert.match(colour.code!, /Optional ByVal p_shade As Object = Nothing\)/);
    assert.match(colour.code!, /If p_shade Is Nothing Then p_shade = /);
    assert.match(fn.code!, /result = p_x \* 2 \+ p_y/);
    const array = translateFormula('Local StringVar Array a := ["x", "y"]; a[1]', ctx, { codeName: 'F_A' });
    assert.match(array.code!, /v_a = New Object\(\) \{Nothing, "x", "y"\}/);
    assert.match(array.code!, /Return v_a\(1\)/);
    assert.equal(tr('Join(Split({Orders.Name}, ","), ";")').expression, '=Code.CrJoin(Code.CrSplit(Fields!Name.Value, ","), ";")');
  });
});

describe('formatting formulas and connection details', () => {
  it('hides objects by Object_Visibility, skips empty formatting formulas and finds the database', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulaTexts: ['', 'PageNumber > 1', ''],
      formulas: [{ name: 'HeaderLabel', kind: 'formula', text: 'WhileReadingRecords; ""', referencedFields: [] }],
      layout: [{ name: 'PageHeaderArea1', sections: [{
        name: 'PH', conditions: { suppress: { name: 'Section_Visibility', index: 2 } },
        objects: [
          { kind: 'text', name: 'T', text: 'Title', position: { x: 0, y: 0 }, conditions: { suppress: { name: 'Object_Visibility', index: 1 } } },
          { kind: 'field', name: 'H', field: '@HeaderLabel', position: { x: 1440, y: 0 } },
        ],
      }] }],
    };
    const source: DataSourceInfo = {
      connections: [{ driver: 'OLE DB (ADO)', database: 'Warehouse', properties: { Provider: 'SQLOLEDB', 'Data Source': 'SRV1' } }],
      tables: [{ alias: 'usp_Report;1', name: 'usp_Report', kind: 'storedProcedure', fields: [] }],
      links: [],
    };
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Real' });
    assert.match(rdl, /<Hidden>=\(Globals!PageNumber &gt; 1\)<\/Hidden>/);
    assert.ok(rdl.includes('<ConnectString>Data Source=SRV1;Initial Catalog=Warehouse</ConnectString>'));
    assert.deepEqual(review.map((r) => r.item).filter((i) => i !== 'Page' && i !== 'Dataset'), [], JSON.stringify(review));
  });
});

describe('subreports in page headers and footers', () => {
  const params = [{ name: '@account', valueType: 'number' }, { name: '@kind', valueType: 'number' }];
  const jdbc = { driver: 'JDBC (JNDI)', database: 'jdbc:sqlserver://dbhost\\\\INST:1433;databaseName=SalesDb', properties: { Server: 'dbhost\\\\INST', 'User ID': 'reader' } };
  const header: ReportDefinition = {
    ...emptyDefinition(),
    parameters: params,
    formulas: [
      { name: 'Object_Visibility', index: 0, kind: 'conditionalFormat', text: '{?@kind} = 1', referencedFields: [] },
      { name: 'OwnerShared', index: 1, kind: 'formula', text: 'WhilePrintingRecords; shared StringVar owner; owner := {usp_Header;1.Owner};', referencedFields: [] },
    ],
    formulaTexts: ['{?@kind} = 1', 'WhilePrintingRecords; shared StringVar owner; owner := {usp_Header;1.Owner};'],
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 900, objects: [
        { kind: 'field', name: 'title1', field: 'usp_Header;1.Title', position: { x: 3600, y: 300 }, size: { width: 5000, height: 300 }, conditions: { suppress: { name: 'Object_Visibility', index: 0 } } },
        { kind: 'field', name: 'owner1', field: '@OwnerShared', position: { x: 0, y: 600 }, size: { width: 2000, height: 230 } },
      ] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 220, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [] }] },
    ],
  };
  const footer: ReportDefinition = {
    ...emptyDefinition(),
    formulas: [{ name: 'OwnerShared', index: 0, kind: 'formula', text: 'WhilePrintingRecords; shared StringVar owner; owner;', referencedFields: [] }],
    formulaTexts: ['WhilePrintingRecords; shared StringVar owner; owner;'],
    layout: [
      { name: 'Area1', sections: [{ name: 'S1', height: 220, objects: [{ kind: 'field', name: 'owner2', field: '@OwnerShared', position: { x: 0, y: 0 }, size: { width: 3000, height: 180 } }] }] },
      { name: 'Area5', sections: [{ name: 'S5', height: 220, objects: [] }] },
      { name: 'Area3', sections: [{ name: 'S3', height: 220, objects: [] }] },
    ],
  };
  const main: ReportDefinition = {
    ...emptyDefinition(),
    parameters: params,
    formulas: [
      { name: 'HeaderGroup', index: 0, kind: 'formula', text: 'WhileReadingRecords; " "', referencedFields: [] },
      { name: 'Group #1 Order', index: 1, kind: 'internal', text: '', referencedFields: ['@HeaderGroup'] },
    ],
    selectionFormulas: { record: '{Holdings.Account} = {?@account}' },
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 308, objects: [{ kind: 'subreport', name: 'Subreport1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 9000, height: 308 } }] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', height: 308, objects: [{ kind: 'subreport', name: 'Subreport2', subreport: { index: 2, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 9000, height: 308 } }] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 400, objects: [{ kind: 'text', name: 'Heading', text: 'Name', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 300, objects: [{ kind: 'field', name: 'name1', field: 'Holdings.Name', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
    ],
  };
  const source: DataSourceInfo = {
    connections: [jdbc],
    tables: [{ alias: 'Holdings', name: 'Holdings', kind: 'table', schema: 'dbo', fields: [{ name: 'Account', type: 'integer' }, { name: 'Name', type: 'string' }] }],
    links: [],
  };
  const headerSource: DataSourceInfo = {
    connections: [jdbc],
    tables: [{ alias: 'usp_Header;1', name: 'usp_Header;1', kind: 'storedProcedure', schema: 'dbo', fields: [{ name: 'Title', type: 'string' }, { name: 'Owner', type: 'string' }] }],
    links: [],
  };

  it('places their content directly in the header/footer, with their own datasets and shared variables', () => {
    const subreports = new Map([
      [1, { name: 'Main_Subdocument_1', links: [], parameters: ['@account', '@kind'], definition: header, dataSource: headerSource }],
      [2, { name: 'Main_Subdocument_2', links: [], parameters: [], definition: footer, dataSource: { connections: [], tables: [], links: [] } }],
    ]);
    const { rdl, review } = convertToRdl(main, source, { reportName: 'Main', subreports });
    assertBalancedXml(rdl);
    assert.ok(!rdl.includes('<Subreport '), 'SSRS allows no subreport in a page header or footer');
    assert.ok(rdl.includes('<ConnectString>Data Source=dbhost\\INST,1433;Initial Catalog=SalesDb</ConnectString>'), 'server, instance, port and database from the JDBC URL');
    assert.equal((rdl.match(/<DataSource Name=/g) ?? []).length, 1, 'subreports on the same connection share the data source');
    assert.match(rdl, /<DataSet Name="DataSet_Main_Subdocument_1">[\s\S]*<CommandType>StoredProcedure<\/CommandType>\s*<CommandText>\[dbo\]\.\[usp_Header\]<\/CommandText>/);
    assert.match(rdl, /<DataSet Name="DataSet_Main_Subdocument_2">[\s\S]*<CommandText>SELECT 1 AS \[NoData\]<\/CommandText>/);
    assert.ok(rdl.includes('<Value>=First(Fields!Title.Value, "DataSet_Main_Subdocument_1")</Value>'));
    assert.ok(rdl.includes('<Hidden>=(Parameters!kind.Value = 1)</Hidden>'));
    assert.match(rdl, /Dim v_owner As String[\s\S]*v_owner = a1[\s\S]*Return v_owner/, 'one class member carries the shared variable between them');
    assert.equal((rdl.match(/<ReportParameter Name="(account|kind)">/g) ?? []).length, 2, 'parameters are not duplicated');
    assert.match(rdl, /<KeepWithGroup>After<\/KeepWithGroup>\s*<RepeatOnNewPage>true<\/RepeatOnNewPage>/, 'a group on a constant repeats its header');
    assert.ok(review.some((r) => /SQL Server login/.test(r.message)));
    assert.ok(review.some((r) => /placed here directly/.test(r.message)));
    const { inlinedOnly } = convertToRdl(main, source, { reportName: 'Main', subreports });
    assert.deepEqual(inlinedOnly, [1, 2], 'neither subreport needs its own .rdl');
    const formulaNotes = review.filter((r) => r.item.endsWith('Formula {@OwnerShared}'));
    assert.equal(formulaNotes.length, 2, 'one note per converted formula');
    assert.match(formulaNotes[0].message, /custom code \(Code\.F_OwnerShared\); it uses WhilePrintingRecords/);
    assert.ok(!review.some((r) => /reads no database|check that its parameters match/.test(r.message)), JSON.stringify(review));
  });
});

describe('header text extraction', () => {
  const text = (name: string, value: string, x: number, y: number, width = 1400) =>
    ({ kind: 'text', name, text: value, runs: value.split(/(\n)/).filter(Boolean).map((t) => ({ text: t })), position: { x, y }, size: { width, height: 240 } });
  const main: ReportDefinition = {
    ...emptyDefinition(),
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [
        text('Title', 'Orders Summary', 0, 0, 6000),
        text('H1', 'Customer', 0, 400), text('H2', 'Amount\n(in $)', 3000, 400),
        { kind: 'subreport', name: 'Sub1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 800 }, size: { width: 5000, height: 300 } },
      ] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [text('Foot', 'Confidential', 0, 0)] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', objects: [
        { kind: 'text', name: 'GLabel', text: 'Region: ', runs: [{ text: 'Region: ' }, { field: 'Orders.Region' }], position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', objects: [
        { kind: 'field', name: 'C', field: 'Orders.Customer', position: { x: 0, y: 0 }, size: { width: 1400, height: 240 } },
        { kind: 'field', name: 'A', field: 'Orders.Amount', position: { x: 3000, y: 0 }, size: { width: 1400, height: 240 } },
      ] }] },
    ],
  };
  const sub: ReportDefinition = {
    ...emptyDefinition(),
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'SRH', objects: [text('SubTitle', 'Run Date:', 0, 0)] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'SRF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'SD', objects: [] }] },
    ],
  };
  const reports = [{ storage: '', definition: main }, { storage: 'Subdocument 1', definition: sub }];

  it('lists titles, column headings in order, group labels and subreport headers', () => {
    const items = extractHeaders(reports);
    assert.deepEqual(items.map((i) => [i.report, i.area, i.kind, i.column, i.text]), [
      ['Main report', 'Page Header', 'text', undefined, 'Orders Summary'],
      ['Main report', 'Page Header', 'column heading', 1, 'Customer'],
      ['Main report', 'Page Header', 'column heading', 2, 'Amount\n(in $)'],
      ['Main report', 'Group Header 1', 'text', undefined, 'Region: {Orders.Region}'],
      ['Subdocument 1 (in Page Header)', 'Report Header', 'text', undefined, 'Run Date:'],
    ]);
    assert.ok(extractHeaders(reports, { all: true }).some((i) => i.area === 'Page Footer' && i.text === 'Confidential'), '--all adds footers');
    const listing = formatHeadersText(items);
    assert.match(listing, /column headings {3}Customer \| Amount \(in \$\)/);
    assert.match(formatHeadersCsv(items), /^file,report,area,section,kind,column,text,object,x,y\r\n,Main report,Page Header,PH,text,,Orders Summary,Title,0,0\r\n/);
  });

  it('keeps line breaks of multi-line text in SSRS', () => {
    assert.equal(vbString('Amount\n(in $)'), '"Amount" & vbCrLf & "(in $)"');
    const { rdl } = convertToRdl({ ...emptyDefinition(), layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [text('Two', 'Line one\nLine two', 0, 0, 3000)] }] },
    ] }, { connections: [], tables: [], links: [] }, { reportName: 'Lines' });
    assert.ok(rdl.includes('<Value>="Line one" &amp; vbCrLf &amp; "Line two"</Value>'));
  });
});

describe('audit fixes', () => {
  const multiCtx: FormulaContext = { ...ctx, parameterMultiple: (n) => n === 'Regions', fieldType: (ref) => ({ 'Orders.Amount': 'currency', 'Orders.Name': 'string' } as Record<string, string>)[ref] };
  const f = (source: string) => translateFormula(source, multiCtx).expression;

  it('follows Crystal operator precedence', () => {
    assert.equal(f('10 mod 4 * 2'), '=(10 Mod (4 * 2))');
    assert.equal(f('7 \\ 2 * 3'), '=(7 \\ (2 * 3))');
    assert.equal(f('2^3^2'), '=((2 ^ 3) ^ 2)');
    assert.equal(f('-2^2'), '=((-(2)) ^ 2)', 'negation binds tighter than ^ in Crystal');
    assert.equal(f('true xor false or true'), '=(True Xor (False OrElse True))');
  });

  it('maps functions with Crystal semantics', () => {
    assert.equal(f('Round(2.5)'), '=Math.Round(2.5, MidpointRounding.AwayFromZero)');
    assert.equal(f('Truncate({Orders.Amount}, 2)'), '=(Fix(Fields!Amount.Value * 10 ^ 2) / 10 ^ 2)');
    assert.equal(f('ToText({Orders.Amount})'), '=FormatNumber(Fields!Amount.Value, 2)');
    assert.equal(f('{Orders.Name} startswith "A"'), '=CStr(Fields!Name.Value).StartsWith("A")');
    assert.equal(f('"b" in "abc"'), '=(InStr(CStr("abc"), CStr("b")) > 0)');
    assert.equal(f('Split({Orders.Name}, ",")[2]'), '=Code.CrSplit(Fields!Name.Value, ",")(2)');
    assert.match(f('if {Orders.Amount} <> 0 then 1 / {Orders.Amount} else 0'), /^=If\(/, 'a guarded division must not be evaluated');
  });

  it('treats multi-value parameters as 0-based arrays', () => {
    assert.equal(f('Join({?Regions}, ", ")'), '=Join(Parameters!Regions.Value, ", ")');
    assert.equal(f('UBound({?Regions})'), '=Parameters!Regions.Count');
    assert.equal(f('Count({?Regions})'), '=Parameters!Regions.Count');
    assert.equal(f('{?Regions}[1]'), '=Parameters!Regions.Value((1) - 1)');
  });

  it('keeps references inside string literals as text in custom code', () => {
    const t = translateFormula('stringvar s := "Sum(of parts) Fields!X.Value"; s & {Orders.Name}', ctx, { codeName: 'F_S' });
    assert.equal(t.expression, '=Code.F_S(Fields!Name.Value)');
    assert.match(t.code!, /v_s = "Sum\(of parts\) Fields!X.Value"/);
  });

  it('writes selection formulas as valid T-SQL', () => {
    const types: Record<string, string> = { 'Orders.Date': 'date', 'Orders.Qty': 'integer' };
    const sql = (s: string) => translateToSql(s, {
      column: (t, c) => `[${t}].[${c}]`, parameter: (n) => `@${n}`, parameterMultiple: (n) => n === 'Regions',
      columnType: (t, c) => types[`${t}.${c}`], parameterType: () => 'string',
    });
    assert.equal(sql('{Orders.Date} >= CurrentDate - 30'), '[Orders].[Date] >= DATEADD(day, -(30), CAST(GETDATE() AS date))');
    assert.equal(sql('{Orders.Region} = {?Regions}'), '[Orders].[Region] IN (@Regions)');
    assert.equal(sql('{Orders.Name} like "*_*"'), "[Orders].[Name] LIKE '%[_]%'");
    assert.equal(sql('{Orders.Name} startswith "10%"'), "[Orders].[Name] LIKE '10[%]%'");
    assert.equal(sql('{Orders.Qty} / 2 > 2'), '([Orders].[Qty] * 1.0 / 2) > 2');
    assert.equal(sql('{Orders.Name} in []'), '1 = 0');
  });

  it('scopes expressions outside data regions and splits command literals', () => {
    assert.equal(scopeOutsideRegion('(Fields!Flag.Value = 1)', 'DataSet1'), '(First(Fields!Flag.Value, "DataSet1") = 1)');
    assert.equal(scopeOutsideRegion('Sum(Fields!A.Value) & "Fields!B.Value"', 'DataSet1'), 'Sum(Fields!A.Value, "DataSet1") & "Fields!B.Value"');
    assert.equal(substituteCommandParameters("WHERE a = {?A} AND b LIKE '%{?B}%'", (n) => `@${n}`), "WHERE a = @A AND b LIKE '%' + @B + '%'");
  });

  it('assigns each group footer to its own group and keeps data regions out of page headers', () => {
    const section = (name: string) => ({ name, objects: [] });
    const areas = classifyAreas([
      { name: 'PageHeaderArea1', sections: [section('PH')] }, { name: 'PageFooterArea1', sections: [section('PF')] },
      { name: 'ReportHeaderArea1', sections: [section('RH')] }, { name: 'ReportFooterArea1', sections: [section('RF')] },
      { name: 'GroupHeaderArea1', sections: [section('GH1')] }, { name: 'GroupFooterArea1', sections: [section('GF1')] },
      { name: 'GroupHeaderArea2', sections: [section('GH2')] }, { name: 'GroupFooterArea2', sections: [section('GF2')] },
      { name: 'DetailArea1', sections: [section('D')] },
    ]);
    assert.equal(areas.groupFooters.get(1)?.[0].name, 'GF1');
    assert.equal(areas.groupFooters.get(2)?.[0].name, 'GF2');
    const { rdl, review } = convertToRdl({ ...emptyDefinition(), layout: [{ name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [
      { kind: 'chart', name: 'Chart1', position: { x: 0, y: 0 }, size: { width: 3000, height: 2000 }, chart: { values: ['Sum of Orders.Amount'], onChangeOf: 'Orders.Region' } },
    ] }] }] }, { connections: [], tables: [], links: [] }, { reportName: 'PageChart' });
    assert.ok(!rdl.includes('<Chart '));
    assert.ok(review.some((r) => /no charts or cross-tabs in a page header/.test(r.message)));
  });

  it('escapes CSV cells Excel would run as formulas', () => {
    const csv = formatHeadersCsv([{ report: 'Main report', area: 'Page Header', section: 'PH', kind: 'text', text: '=HYPERLINK("x")', object: 'T', x: 0, y: 0 }]);
    assert.match(csv, /,"'=HYPERLINK\(""x""\)",/);
  });
});

describe('house template layout', () => {
  const templateXml = readFileSync(join(import.meta.dirname, 'fixtures', 'house-template.rdl'), 'utf8');
  const template = readHouseTemplate(templateXml);
  const text = (name: string, value: string, x: number, y: number, size = 10) =>
    ({ kind: 'text', name, text: value, runs: [{ text: value }], position: { x, y }, size: { width: 1400, height: 240 }, style: { size } });
  const field = (name: string, ref: string, x: number) => ({ kind: 'field', name, field: ref, position: { x, y: 0 }, size: { width: 1400, height: 240 } });
  const source: DataSourceInfo = {
    connections: [],
    tables: [{ alias: 'usp_Holdings;1', name: 'usp_Holdings;1', kind: 'storedProcedure', fields: [
      { name: 'Name', type: 'string' }, { name: 'Units', type: 'integer' }, { name: 'Value', type: 'currency' },
    ] }],
    links: [],
  };
  const report = (title: string): ReportDefinition => ({
    ...emptyDefinition(),
    parameters: [{ name: '@owner_id', prompt: 'Owner', valueType: 'number' }, { name: '@region', prompt: 'Region', valueType: 'string' }],
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [
        text('Title', title, 0, 0, 16),
        text('H1', 'Holding', 0, 400), text('H2', 'Units', 2880, 400), text('H3', 'Value', 5760, 400),
      ] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [field('Page', 'Page Number', 0)] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [text('TotalText', 'Grand total:', 0, 0), field('Sum', 'Sum of usp_Holdings;1.Value', 5760)] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', objects: [
        field('N', 'usp_Holdings;1.Name', 0), field('U', 'usp_Holdings;1.Units', 2880), field('V', 'usp_Holdings;1.Value', 5760),
      ] }] },
    ],
  });

  it('reads the template: data source, support datasets, page header and table rows', () => {
    assert.equal(template.dataSourceName, 'SharedDb');
    assert.deepEqual(template.supportDataSets.map((d) => d.attributes.Name), ['Theme', 'PageInfo']);
    assert.deepEqual(template.tableDataSets, ['SampleList']);
    assert.equal(template.title?.text, 'Sample List');
    assert.equal(template.noData?.text, 'NO SAMPLE LIST DATA FOR THIS PERIOD');
    assert.equal(template.total?.text, 'Totals:');
    assert.ok(template.heading && template.detail && template.rectangle);
    assert.ok(template.warnings.some((w) => w.includes('Placeholder')), 'an unused template dataset is reported');
  });

  it('lays a report out with the template and keeps the report\'s own data', () => {
    const { rdl, review } = buildHouseReport(template, [{ name: 'Holdings', definition: report('Holdings Detail'), dataSource: source }], 'Holdings');
    const doc = parseXml(rdl);
    assert.equal(doc.name, 'Report');
    // The report's own stored procedure, through the template's data source.
    assert.ok(rdl.includes('<DataSet Name="Holdings">') && rdl.includes('<CommandText>[usp_Holdings]</CommandText>'));
    assert.ok(/<DataSet Name="Holdings">\s*<Query>\s*<DataSourceName>SharedDb<\/DataSourceName>/.test(rdl));
    assert.ok(!rdl.includes('usp_SampleList') && !rdl.includes('"SampleList"'), 'the template\'s own table data is gone');
    assert.ok(rdl.includes('dbo.usp_Theme') && rdl.includes('dbo.usp_PageInfo'), 'branding and header datasets are kept');
    // Title, headings, values, totals in the template's cells.
    for (const value of ['<Value>Holdings Detail</Value>', '<Value>Holding</Value>', '<Value>Units</Value>', '<Value>=Fields!Name.Value</Value>',
      '<Value>=Sum(Fields!Value.Value)</Value>', '<Value>Grand total:</Value>', '<Value>="NO HOLDINGS DETAIL DATA FOR THIS PERIOD"</Value>']) {
      assert.ok(rdl.includes(value), value);
    }
    assert.ok(rdl.includes('First(Fields!ColumnHead_font_family.Value, "Theme")'), 'styles come from the template');
    assert.ok(rdl.includes('ROWNUMBER(NOTHING) MOD 2'), 'alternating row colours are kept');
    assert.ok(rdl.includes('<Format>#,0;(#,0)</Format>'), 'whole numbers get the template format without decimals');
    assert.ok(rdl.includes('<Hidden>=CountRows("Holdings") &gt; 0</Hidden>'), 'the no-data row shows only without rows');
    assert.ok(rdl.includes('<BreakLocation>End</BreakLocation>') && rdl.includes('<Rectangle Name="Holdings_Block">'));
    // Page header and footer, logo and parameters come from the template; the report's own parameter is added once.
    assert.ok(rdl.includes('<Textbox Name="Hdr_Owner">') && rdl.includes('<EmbeddedImage Name="Logo">'));
    assert.equal((rdl.match(/<ReportParameter Name="owner_id">/g) ?? []).length, 1);
    assert.ok(rdl.includes('<ReportParameter Name="region">'));
    assert.ok(review.some((r) => r.item === 'Layout' && r.message.includes('Page Number')), 'items left out are listed');
  });

  it('combines several reports into one, one block each', () => {
    const { rdl } = buildHouseReport(template, [
      { name: 'Holdings', definition: report('Holdings Detail'), dataSource: source },
      { name: 'Holdings_Prior', definition: report('Prior Holdings'), dataSource: source },
    ], 'Combined');
    assert.ok(rdl.includes('<DataSet Name="Holdings">') && rdl.includes('<DataSet Name="Holdings_Prior">'));
    assert.ok(rdl.includes('<Rectangle Name="Holdings_Block">') && rdl.includes('<Rectangle Name="Holdings_Prior_Block">'));
    assert.ok(rdl.includes('<Value>Prior Holdings</Value>') && rdl.includes('CountRows("Holdings_Prior")'));
    const names = [...rdl.matchAll(/<(?:Textbox|Tablix|Rectangle|Group) Name="([^"]+)"/g)].map((m) => m[1].toLowerCase());
    assert.equal(new Set(names).size, names.length, 'item names are unique');
    assert.equal((rdl.match(/<ReportParameter Name="region">/g) ?? []).length, 1, 'shared parameters appear once');
    assert.equal((rdl.match(/<PageHeader>/g) ?? []).length, 1);
  });

  it('rejects a template without a table to copy', () => {
    const bare = templateXml.replace(/<Body>[\s\S]*<\/Body>/, '<Body><ReportItems /><Height>1in</Height></Body>');
    assert.throws(() => readHouseTemplate(bare), /no table/);
  });

  it('points a plain conversion at a shared data source', () => {
    const { rdl } = convertToRdl({ ...emptyDefinition(), layout: detailLayout('usp_Holdings;1.Name') }, source, { reportName: 'Shared', sharedDataSource: '/Data Sources/SharedDb' });
    assert.ok(rdl.includes('<DataSourceReference>/Data Sources/SharedDb</DataSourceReference>'));
    assert.ok(!rdl.includes('<ConnectString>'));
    assert.ok(rdl.includes('<DataSource Name="SharedDb">') && rdl.includes('<DataSourceName>SharedDb</DataSourceName>'), 'named after the shared data source');
  });
});

describe('XML reading', () => {
  it('parses elements, attributes, entities and CDATA', () => {
    const x = parseXml('<?xml version="1.0"?><!-- c --><R a="1&amp;2"><V>=a &lt; b</V><E/><M><![CDATA[<raw>]]></M></R>');
    assert.equal(x.attributes.a, '1&2');
    assert.deepEqual(x.children.map((c) => (typeof c === 'object' && c ? (c as { name: string }).name : c)), ['V', 'E', 'M']);
    assert.throws(() => parseXml('<R><A></R>'), /does not match/);
  });
});

describe('InStr with typed arguments', () => {
  // Untyped (Object) field values make VB's InStr overloads ambiguous in SSRS (BC30519): every argument is converted.
  const t = (source: string) => translateFormula(source, ctx).expression;
  it('translates each Crystal form', () => {
    assert.equal(t('InStr({Orders.Note}, "x")'), '=InStr(CStr(Fields!Note.Value), CStr("x"))');
    assert.equal(t('InStr({Orders.Note}, "x", 1) = 0'), '=(InStr(CStr(Fields!Note.Value), CStr("x"), CompareMethod.Text) = 0)');
    assert.equal(t('InStr({Orders.Note}, "x", 0)'), '=InStr(CStr(Fields!Note.Value), CStr("x"), CompareMethod.Binary)');
    assert.equal(t('InStr(2, {Orders.Note}, "x")'), '=InStr(CInt(2), CStr(Fields!Note.Value), CStr("x"))');
    assert.equal(t('InStr(2, {Orders.Note}, "x", 1)'), '=InStr(CInt(2), CStr(Fields!Note.Value), CStr("x"), CompareMethod.Text)');
    assert.equal(t('InStrRev({Orders.Note}, "x")'), '=InStrRev(CStr(Fields!Note.Value), CStr("x"))');
  });
});

describe('Crystal value formats', () => {
  const number = (over: object) => ({ decimals: 2, thousands: true, leadingZero: true, negative: 1, symbolType: 0, symbol: '', symbolPosition: 0, ...over });
  it('builds number formats: decimals, symbols, negatives', () => {
    assert.equal(numberFormatString(number({ decimals: 4 })), '#,0.0000;-#,0.0000');
    assert.equal(numberFormatString(number({ negative: 3, symbolType: 2, symbol: '$', symbolPosition: 1 })), "'$'#,0.00;('$'#,0.00)");
    assert.equal(numberFormatString(number({ negative: 3, symbolType: 0, symbol: '$', symbolPosition: 1 })), '#,0.00;(#,0.00)', 'no symbol when it is switched off');
    assert.equal(numberFormatString(number({ symbolType: 2, symbol: '%', symbolPosition: 3 })), "#,0.00'%';-#,0.00'%'", 'a percent sign is a literal');
    assert.equal(numberFormatString(number({ decimals: 0, thousands: false, leadingZero: false })), '0;-0');
  });
  it('builds date formats and picks the format for the value type', () => {
    const date = { order: 2, year: 1, month: 1, day: 1, dayOfWeek: 2, separators: ['/', '/'] as [string, string] };
    assert.equal(dateFormatString(date), "MM'/'dd'/'yyyy");
    assert.equal(dateFormatString({ ...date, month: 3, separators: [' ', ', '] }), "MMMM' 'dd', 'yyyy");
    assert.equal(dateFormatString({ ...date, order: 0, year: 0 }), "yy'/'MM'/'dd");
    const format = { currency: number({ symbolType: 2, symbol: '$', symbolPosition: 1 }), number: number({ decimals: 4 }), date, dateTimeOrder: 2 };
    assert.equal(formatFor(format, 'number'), '#,0.0000;-#,0.0000');
    assert.equal(formatFor(format, 'currency'), "'$'#,0.00;-'$'#,0.00");
    // Left at the default format, a currency value shows like a number: no symbol.
    assert.equal(formatFor({ ...format, systemDefault: true }, 'currency'), '#,0.0000;-#,0.0000');
    assert.equal(formatFor(format, 'dateTime'), "MM'/'dd'/'yyyy", 'date only');
    assert.equal(formatFor(format, 'string'), undefined);
  });
  it('applies the decoded format and alignment to a field', () => {
    const source: DataSourceInfo = { connections: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Price', type: 'number' }] }], links: [] };
    const definition = { ...emptyDefinition(), layout: [{ name: 'DetailArea1', sections: [{ name: 'D', objects: [
      { kind: 'field', name: 'P', field: 'T.Price', position: { x: 0, y: 0 }, align: 'center' as const, format: { number: number({ decimals: 4 }) } },
    ] }] }] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'Formats' });
    assert.ok(rdl.includes('<Format>#,0.0000;-#,0.0000</Format>'));
    assert.ok(rdl.includes('<TextAlign>Center</TextAlign>'));
  });
});

describe('shared variables from a page-header subreport', () => {
  // The header subreport copies its own data into shared variables (in suppressed fields); the main report's page
  // footer shows them next to the page number.
  const header: ReportDefinition = {
    ...emptyDefinition(),
    formulas: [
      { name: 'SetOwner', index: 0, kind: 'formula', text: 'WhilePrintingRecords;\r\nshared StringVar  ownername;\r\nownername := {usp_Header;1.owner_name};\r\n', referencedFields: [] },
    ],
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 600, objects: [
        { kind: 'field', name: 'title1', field: 'usp_Header;1.title', position: { x: 0, y: 0 }, size: { width: 5000, height: 300 } },
        { kind: 'field', name: 'setter1', field: '@SetOwner', suppressed: true, position: { x: 0, y: 300 }, size: { width: 3000, height: 230 } },
      ] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 0, objects: [] }] },
    ],
  };
  const main: ReportDefinition = {
    ...emptyDefinition(),
    formulas: [{ name: 'OwnerName', index: 0, kind: 'formula', text: 'WhilePrintingRecords;\r\nshared StringVar ownername;\r\nownername ;\r\n', referencedFields: [] }],
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 600, objects: [{ kind: 'subreport', name: 'Header1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 9000, height: 600 } }] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', height: 300, objects: [
        { kind: 'field', name: 'owner2', field: '@OwnerName', position: { x: 0, y: 0 }, size: { width: 4000, height: 230 } },
        { kind: 'field', name: 'page1', field: 'Page Number', position: { x: 8000, y: 0 }, size: { width: 1000, height: 230 } },
      ] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 300, objects: [{ kind: 'field', name: 'name1', field: 'Holdings.Name', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
    ],
  };
  const source = (table: string, fields: string[]): DataSourceInfo => ({
    connections: [], links: [],
    tables: [{ alias: table, name: table, kind: table.includes(';') ? 'storedProcedure' : 'table', fields: fields.map((name) => ({ name, type: 'string' })) }],
  });

  it('shows the subreport\'s value in the footer, hides suppressed items and keeps the page number', () => {
    const { rdl, review } = convertToRdl(main, source('Holdings', ['Name']), {
      reportName: 'Main',
      subreports: new Map([[1, { name: 'Main_Subdocument_1', links: [], definition: header, dataSource: source('usp_Header;1', ['title', 'owner_name']) }]]),
    });
    assertBalancedXml(rdl);
    assert.ok(!rdl.includes('__CrShared_'), 'no placeholder is left');
    const footer = rdl.slice(rdl.indexOf('<PageFooter>'), rdl.indexOf('</PageFooter>'));
    assert.ok(footer.includes('First(Fields!owner_name.Value, "DataSet_Main_Subdocument_1")'), 'the footer reads the header subreport\'s data');
    assert.ok(footer.includes('Globals!PageNumber'), 'the page number is in the footer');
    assert.ok(!rdl.includes('<Field Name="F_OwnerName">'), 'not a dataset field (computed before the header runs)');
    assert.ok(!rdl.includes('<Textbox Name="setter1">'), 'a suppressed helper field in the page header is left out (it prints nothing)');
    assert.ok(review.some((r) => r.item === 'Shared variable ownername'));
  });

  it('uses the last value that is not empty when several header subreports set the variable', () => {
    const twoHeaders: ReportDefinition = {
      ...main,
      layout: main.layout.map((a) => (a.name === 'PageHeaderArea1'
        ? { ...a, sections: [{ name: 'PH', height: 1200, objects: [
          { kind: 'subreport', name: 'Header1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 9000, height: 600 } },
          { kind: 'subreport', name: 'Header2', subreport: { index: 2, onDemand: false }, position: { x: 0, y: 600 }, size: { width: 9000, height: 600 } },
        ] }] }
        : a)),
    };
    const { rdl } = convertToRdl(twoHeaders, source('Holdings', ['Name']), {
      reportName: 'Main',
      subreports: new Map([
        [1, { name: 'Main_Subdocument_1', links: [], definition: header, dataSource: source('usp_Header;1', ['title', 'owner_name']) }],
        [2, { name: 'Main_Subdocument_2', links: [], definition: header, dataSource: source('usp_Header;1', ['title', 'owner_name']) }],
      ]),
    });
    const footer = rdl.slice(rdl.indexOf('<PageFooter>'), rdl.indexOf('</PageFooter>'));
    const second = 'First(Fields!owner_name.Value, "DataSet_Main_Subdocument_2")';
    const first = 'First(Fields!owner_name.Value, "DataSet_Main_Subdocument_1")';
    assert.ok(footer.includes(`IIf(Len(CStr(${second}) &amp; "") &gt; 0, ${second}, ${first})`), footer);
    assert.ok(!footer.includes('Code.'), 'no custom code left to read an unset variable');
  });

  it('never nests First aggregates when a footer formula mixes a shared variable with a main-report field', () => {
    const mixed: ReportDefinition = {
      ...main,
      formulas: [
        ...main.formulas,
        { name: 'ShowOwner', index: 1, kind: 'formula', text: 'If InStr({@OwnerName}, "x", 1) > 0 then {Holdings.Name} else {@OwnerName}', referencedFields: [] },
      ],
      layout: main.layout.map((a) => (a.name === 'PageFooterArea1'
        ? { ...a, sections: [{ name: 'PF', height: 300, objects: [{ kind: 'field', name: 'show1', field: '@ShowOwner', position: { x: 0, y: 0 }, size: { width: 4000, height: 230 } }] }] }
        : a)),
    };
    const { rdl } = convertToRdl(mixed, source('Holdings', ['Name']), {
      reportName: 'Main',
      subreports: new Map([[1, { name: 'Main_Subdocument_1', links: [], definition: header, dataSource: source('usp_Header;1', ['title', 'owner_name']) }]]),
    });
    const value = /<Textbox Name="show1">[\s\S]*?<Value>([^<]*)<\/Value>/.exec(rdl)?.[1] ?? '';
    assert.ok(value.includes('First(Fields!owner_name.Value, "DataSet_Main_Subdocument_1")'), value);
    assert.ok(value.includes('First(Fields!Name.Value, "DataSet1")'), value);
    // No First(...) inside another First(...).
    const depth = (text: string) => {
      let max = 0;
      const stack: boolean[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text.startsWith('First(', i)) { stack.push(true); i += 5; max = Math.max(max, stack.filter(Boolean).length); }
        else if (text[i] === '(') stack.push(false);
        else if (text[i] === ')') stack.pop();
      }
      return max;
    };
    assert.equal(depth(value), 1, value);
  });

  it('passes a shared variable\'s value into custom code as an argument', () => {
    const coded: ReportDefinition = {
      ...main,
      formulas: [
        ...main.formulas,
        { name: 'ShowOwner', index: 1, kind: 'formula', text: 'WhilePrintingRecords;\r\nstringvar x := {@OwnerName};\r\nif len(x) > 3 then x else "";', referencedFields: [] },
      ],
      layout: main.layout.map((a) => (a.name === 'PageFooterArea1'
        ? { ...a, sections: [{ name: 'PF', height: 300, objects: [{ kind: 'field', name: 'show2', field: '@ShowOwner', position: { x: 0, y: 0 }, size: { width: 4000, height: 230 } }] }] }
        : a)),
    };
    const { rdl } = convertToRdl(coded, source('Holdings', ['Name']), {
      reportName: 'Main',
      subreports: new Map([[1, { name: 'Main_Subdocument_1', links: [], definition: header, dataSource: source('usp_Header;1', ['title', 'owner_name']) }]]),
    });
    const code = rdl.slice(rdl.indexOf('<Code>'), rdl.indexOf('</Code>'));
    assert.ok(!code.includes('First(') && !code.includes('Fields!') && !code.includes('__CrShared_'), code);
    assert.ok(code.includes('Public Function F_ShowOwner(ByVal a1 As Object)'), code);
    const value = /<Textbox Name="show2">[\s\S]*?<Value>([^<]*)<\/Value>/.exec(rdl)?.[1] ?? '';
    assert.ok(/Code\.F_ShowOwner\(\(*First\(Fields!owner_name\.Value, "DataSet_Main_Subdocument_1"\)\)*\)/.test(value), value);
    assert.ok(!rdl.includes('<Field Name="F_ShowOwner">'), 'not a dataset field');
  });

  it('points the main and the inline subreport\'s datasets at one shared data source', () => {
    const { rdl } = convertToRdl(main, source('Holdings', ['Name']), {
      reportName: 'Main',
      sharedDataSource: '/DataSources/SalesDb',
      subreports: new Map([[1, { name: 'Main_Subdocument_1', links: [], definition: header, dataSource: { ...source('usp_Header;1', ['title', 'owner_name']), connections: [{ driver: 'ODBC (RDO)', properties: { Server: 'otherhost', Database: 'Other' } }] } }]]),
    });
    assert.equal((rdl.match(/<DataSource Name=/g) ?? []).length, 1);
    assert.ok(rdl.includes('<DataSource Name="SalesDb">') && rdl.includes('<DataSourceReference>/DataSources/SalesDb</DataSourceReference>'));
    assert.equal((rdl.match(/<DataSourceName>SalesDb<\/DataSourceName>/g) ?? []).length, 2);
  });
});

describe('suppressed objects', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Note', type: 'string' }] }] };
  const layout = (extra: object) => [{ name: 'DetailArea1', sections: [{ name: 'D', objects: [
    { kind: 'field', name: 'N', field: 'T.Note', position: { x: 0, y: 0 }, suppressed: true, ...extra },
  ] }] }];
  it('hides an object with the Suppress box ticked', () => {
    const { rdl } = convertToRdl({ ...emptyDefinition(), layout: layout({}) }, source, { reportName: 'S' });
    assert.ok(rdl.includes('<Hidden>=True</Hidden>'));
  });
  it('lets a suppress formula decide over the Suppress box, as Crystal does', () => {
    const definition = {
      ...emptyDefinition(),
      formulas: [{ name: 'Object_Visibility', index: 0, kind: 'conditionalFormat' as const, text: 'PageNumber = 1', referencedFields: [] }],
      formulaTexts: ['PageNumber = 1'],
      layout: layout({ conditions: { suppress: { name: 'Object_Visibility', index: 0 } } }),
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'S' });
    assert.ok(!rdl.includes('<Hidden>=True</Hidden>') && rdl.includes('<Hidden>=(Nothing = 1)</Hidden>'), 'the formula decides, with the page number left blank');
  });
});

describe('True/False formatting formulas', () => {
  it('gives False for an "if" without "else" in a suppress condition', () => {
    const t = translateFormula('if {Orders.Region} = "BC" then true', ctx, { boolean: true });
    assert.equal(t.expression, '=IIf((Fields!Region.Value = "BC"), True, False)');
    assert.ok(!t.issues.some((i) => i.includes('without "else"')));
  });
});

describe('subreports in the report body', () => {
  const sub: ReportDefinition = {
    ...emptyDefinition(),
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 300, objects: [{ kind: 'text', name: 'SubTitle', text: 'Totals by region', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ kind: 'field', name: 'region1', field: 'Regions.Region', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
    ],
  };
  const main: ReportDefinition = {
    ...emptyDefinition(),
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 400, objects: [{ kind: 'subreport', name: 'Sub1', subreport: { index: 7, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 6000, height: 400 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ kind: 'field', name: 'n', field: 'Orders.Name', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
    ],
  };
  const src = (table: string, field: string): DataSourceInfo => ({ connections: [], links: [], tables: [{ alias: table, name: table, kind: 'table', fields: [{ name: field, type: 'string' }] }] });
  const subreports = new Map([[7, { name: 'Main_Subdocument_7', links: [], definition: sub, dataSource: src('Regions', 'Region') }]]);

  it('builds a report-footer subreport into the report: one .rdl, its own table and dataset', () => {
    const { rdl, inlinedOnly } = convertToRdl(main, src('Orders', 'Name'), { reportName: 'Main', subreports });
    assertBalancedXml(rdl);
    assert.ok(!rdl.includes('<Subreport '), 'no subreport item');
    assert.deepEqual(inlinedOnly, [7], 'no separate file needed');
    assert.ok(rdl.includes('<DataSet Name="DataSet_Main_Subdocument_7">'));
    assert.ok(/<DataSetName>DataSet_Main_Subdocument_7<\/DataSetName>/.test(rdl), 'its table reads its own dataset');
    assert.ok(rdl.includes('<Value>Totals by region</Value>'));
  });

  it('gives every table group, data region and dataset a unique name', () => {
    const { rdl } = convertToRdl(main, src('Orders', 'Name'), { reportName: 'Main', subreports });
    const names = [...rdl.matchAll(/<(?:Group|Tablix|Chart|DataSet) Name="([^"]+)"/g)].map((m) => m[1].toLowerCase());
    assert.equal(new Set(names).size, names.length, `duplicates in ${names.join(', ')}`);
  });

  it('leaves page numbers in the body blank: SSRS allows them only in the page header or footer', () => {
    const withPage: ReportDefinition = {
      ...sub,
      layout: sub.layout.map((a) => a.name !== 'ReportFooterArea1' ? a : { ...a, sections: [{ name: 'RF', height: 240, objects: [{ kind: 'field', name: 'PageNumber1', field: 'Page Number', position: { x: 0, y: 0 }, size: { width: 1000, height: 240 } }] }] }),
    };
    const pages = new Map([[7, { ...subreports.get(7)!, definition: withPage }]]);
    const { rdl, review } = convertToRdl(main, src('Orders', 'Name'), { reportName: 'Main', subreports: pages });
    const body = rdl.slice(rdl.indexOf('<Body>'), rdl.indexOf('</Body>'));
    assert.ok(body.includes('PageNumber1'), 'the box is still there');
    assert.ok(!/Globals!(Overall)?(PageNumber|TotalPages)/.test(body));
    assert.ok(review.some((r) => /left blank/.test(r.message)));
  });

  it('sizes a subreport as in Crystal so it grows with what it shows, and starts a new page where Crystal does', () => {
    const paged: ReportDefinition = { ...main, layout: main.layout.map((a) => (a.name === 'ReportFooterArea1'
      ? { ...a, sections: [{ ...a.sections[0], newPageBefore: true }] } : a)) };
    const { rdl } = convertToRdl(paged, src('Orders', 'Name'), { reportName: 'Main', subreports });
    const sub = rdl.slice(rdl.indexOf('<Rectangle Name="Sub1">'));
    assert.ok(/<\/KeepTogether>\s*<Top>[^<]*<\/Top>\s*<Left>[^<]*<\/Left>\s*<Height>0\.278in<\/Height>/.test(sub), 'the Crystal object height (0.278in), not its content\'s');
    assert.ok(/<PageBreak>\s*<BreakLocation>Start<\/BreakLocation>\s*<\/PageBreak>/.test(rdl), 'a new page before the section');
  });

  it('keeps separate subreport files on request', () => {
    const { rdl, inlinedOnly } = convertToRdl(main, src('Orders', 'Name'), { reportName: 'Main', subreports, embedSubreports: false });
    assert.ok(rdl.includes('<Subreport ') && rdl.includes('<ReportName>Main_Subdocument_7</ReportName>'));
    assert.equal(inlinedOnly, undefined);
  });
});

describe('charts that summarise fields themselves', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'usp_Tests;1', name: 'usp_Tests;1', kind: 'storedProcedure', fields: [
    { name: 'test_name', type: 'string' }, { name: 'as_of', type: 'date' }, { name: 'result', type: 'number' },
  ] }] };
  const layout = (chart: ChartInfo) => [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 3000, objects: [{ kind: 'chart', name: 'Graph1', position: { x: 0, y: 0 }, size: { width: 7000, height: 3000 }, chart }] }] },
    { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', objects: [] }] },
  ];
  it('draws one line per series value, over the category', () => {
    const chart = { values: ['Sum of usp_Tests;1.result'], onChangeOf: 'usp_Tests;1.as_of', series: 'usp_Tests;1.test_name', family: 1, graphType: 10 };
    const { rdl, review } = convertToRdl({ ...emptyDefinition(), layout: layout(chart) }, source, { reportName: 'Tests', subreport: true });
    assert.ok(!review.some((r) => r.message.includes('could not be determined')));
    const series = rdl.slice(rdl.indexOf('<ChartSeriesHierarchy>'), rdl.indexOf('</ChartSeriesHierarchy>'));
    assert.ok(series.includes('<GroupExpression>=Fields!test_name.Value</GroupExpression>'), series);
    const categories = rdl.slice(rdl.indexOf('<ChartCategoryHierarchy>'), rdl.indexOf('</ChartCategoryHierarchy>'));
    assert.ok(categories.includes('<GroupExpression>=Fields!as_of.Value</GroupExpression>'));
    assert.ok(rdl.includes('<Y>=Sum(Fields!result.Value)</Y>'));
  });
  it('draws an "all records" chart with no category, and reads the layout from the right byte', () => {
    const chart = { values: ['Sum of usp_Tests;1.result'], layoutCode: 0, family: 0, graphType: 0 };
    const { rdl, review } = convertToRdl({ ...emptyDefinition(), layout: layout(chart) }, source, { reportName: 'Tests', subreport: true });
    assert.ok(!review.some((r) => r.message.includes('could not be determined')));
    assert.ok(rdl.includes('<Chart Name="Graph1">') && !rdl.includes('_Category"'));
  });
  it('gives each bar of a one-value bar chart its own Crystal colour, without a legend', () => {
    const chart = { values: ['Sum of usp_Tests;1.result'], onChangeOf: 'usp_Tests;1.test_name', family: 0, graphType: 0 };
    const { rdl } = convertToRdl({ ...emptyDefinition(), layout: layout(chart) }, source, { reportName: 'Tests', subreport: true });
    assert.ok(rdl.includes('<Color>=Code.CrPointColor("Graph1", Fields!test_name.Value)</Color>'));
    assert.ok(rdl.includes('Public Function CrPointColor(') && rdl.includes('Dim crPointColors As New System.Collections.Hashtable'));
    assert.ok(/<ChartLegend Name="Default">\s*<Hidden>true<\/Hidden>/.test(rdl));
    assert.ok(rdl.includes('<Palette>Custom</Palette>') && rdl.includes('<ChartCustomPaletteColor>#3E6A9E</ChartCustomPaletteColor>'));
  });

  it('draws a pie of one value per category', () => {
    const chart = { values: ['Average of usp_Tests;1.result'], onChangeOf: 'usp_Tests;1.test_name', family: 3, graphType: 31 };
    const { rdl } = convertToRdl({ ...emptyDefinition(), layout: layout(chart) }, source, { reportName: 'Tests', subreport: true });
    assert.ok(rdl.includes('<Y>=Avg(Fields!result.Value)</Y>') && rdl.includes('<Type>Shape</Type>'));
  });
});

describe('chart options', () => {
  const bytes = (...parts: (number[] | string)[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...encodeString(p)] : p)));
  it('reads the legend and the data labels from the chart text record', () => {
    // Titles, then the options run (legend shown at the bottom), then the data labels: value and category, format 7.
    const record = bytes('Title', '', '', '', '', '', '', '', 'A', 'B', [0, 1, 2, 0, 1, 3, 2, 1, 0, 0, 2, 0], '', [0, 0, 1], '', [3, 7, 0, 0, 1, 0x8a]);
    assert.deepEqual(chartOptions(record), { legend: { visible: true, position: 2 }, dataLabels: { kind: 3, format: 7 } });
    // The marker and one 00 byte in the same run as the labels (value only, format 7).
    const merged = bytes('Title', [0, 0, 0, 0, 1, 2, 2, 1, 0, 0, 2, 0], '', [0, 0, 1, 0, 2, 7, 0, 0, 2, 1]);
    assert.deepEqual(chartOptions(merged).dataLabels, { kind: 2, format: 7 });
    const plain = bytes('Title', [0, 0, 3, 0, 1, 3, 2, 1, 0, 0, 2, 3], '', [0, 0, 0, 0, 0, 0x10, 0, 0]);
    assert.deepEqual(chartOptions(plain), { legend: { visible: false, position: 3 }, dataLabels: { kind: 0, format: 0 } });
  });
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Label', type: 'string' }, { name: 'Share', type: 'number' }] }] };
  const chartReport = (chart: ChartInfo): ReportDefinition => ({ ...emptyDefinition(), layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 3000, objects: [{ kind: 'chart', name: 'Graph1', position: { x: 0, y: 0 }, size: { width: 4000, height: 3000 }, chart }] }] },
    { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', objects: [] }] },
  ] });
  it('labels pie slices outside with the category and the value as a percentage, without a legend', () => {
    const { rdl } = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 3, graphType: 31,
      legend: { visible: false, position: 0 }, dataLabels: { kind: 3, format: 7 } }), source, { reportName: 'C', subreport: true });
    assert.ok(rdl.includes('<Label>="#AXISLABEL" &amp; vbCrLf &amp; "#VALY{0.00%}"</Label>') && rdl.includes('<Value>Outside</Value>'));
    assert.ok(/<ChartLegend Name="Default">\s*<Hidden>true<\/Hidden>/.test(rdl));
  });
  it('uses the given axis format for a chart whose own format is not stored', () => {
    const { rdl } = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 1, graphType: 13,
      legend: { visible: true, position: 2 }, dataLabels: { kind: 0, format: 0 } }), source, { reportName: 'C', subreport: true, chartAxisFormat: '0.00%' });
    const values = rdl.slice(rdl.indexOf('<ChartValueAxes>'), rdl.indexOf('</ChartValueAxes>'));
    assert.ok(values.includes('<Format>0.00%</Format>'), values);
  });

  it('hides a chart without data, as Crystal prints nothing for it', () => {
    const { rdl } = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 0, graphType: 0 }), source, { reportName: 'C', subreport: true });
    assert.ok(rdl.includes('<Hidden>=CountRows("DataSet1") = 0</Hidden>') || /<Hidden>=CountRows\("[^"]+"\) = 0<\/Hidden>/.test(rdl));
  });

  it('tilts 3D pies back like Crystal, scales line charts to their values and keeps lines visible', () => {
    const pie = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 3, graphType: 31 }), source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(/<Inclination>50<\/Inclination>/.test(pie) && pie.includes('<AllowOutSidePlotArea>True</AllowOutSidePlotArea>'));
    const line = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 1, graphType: 13 }), source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(line.includes('<IncludeZero>false</IncludeZero>') && line.includes('<Width>1.5pt</Width>') && line.includes('<Interval>1</Interval>'));
  });

  it('leaves a gap at both ends of a line chart\'s category axis, as Crystal does', () => {
    const line = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 1, graphType: 13 }), source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(!line.includes('<Margin>'));
  });

  it('starts a chart below a title placed over its top', () => {
    const definition = chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 0, graphType: 0 });
    definition.layout[0].sections[0].objects.push({ kind: 'text', name: 'ChartTitle', text: 'Title', position: { x: 100, y: 15 }, size: { width: 3000, height: 240 } });
    const { rdl } = convertToRdl(definition, source, { reportName: 'C', subreport: true });
    const chart = rdl.slice(rdl.indexOf('<Chart Name="Graph1">'));
    assert.ok(/<\/DataSetName>\s*<Top>0\.257in<\/Top>/.test(chart), chart.slice(chart.indexOf('<DataSetName>'), chart.indexOf('<DataSetName>') + 120));
  });

  it('keeps categories in the order the data comes when Crystal does, or sorts them as Crystal does', () => {
    const original = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', categoryOrder: 2, family: 0, graphType: 0 }), source, { reportName: 'C', subreport: true }).rdl;
    const categories = original.slice(original.indexOf('<ChartCategoryHierarchy>'), original.indexOf('</ChartCategoryHierarchy>'));
    assert.ok(!categories.includes('<SortExpressions>'), 'original order: no sort');
    const sorted = chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', categoryOrder: 2, family: 0, graphType: 0 });
    sorted.sorts = [{ field: 'T.Share', descending: true, bySummary: false }];
    const recordOrder = convertToRdl(sorted, source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(/<ChartCategoryHierarchy>[\s\S]*<Value>=Max\(Fields!Share\.Value\)<\/Value>\s*<Direction>Descending/.test(recordOrder), 'original order follows the record sort');
    const descending = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', categoryOrder: 1, family: 0, graphType: 0 }), source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(/<ChartCategoryHierarchy>[\s\S]*<Direction>Descending<\/Direction>/.test(descending));
  });

  it('labels no empty pie slice, and draws each line thick with its own marker and Crystal\'s line colours', () => {
    const pie = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 3, graphType: 31, dataLabels: { kind: 3, format: 7 } }), source, { reportName: 'C', subreport: true }).rdl;
    assert.ok(/<ChartDataLabel>[\s\S]*<Visible>=CDbl\(IIf\(IsNothing\(Sum\(Fields!Share\.Value\)\), 0, Sum\(Fields!Share\.Value\)\)\) &lt;&gt; 0<\/Visible>/.test(pie), 'zero slices unlabelled');
    const line = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 1, graphType: 13 }), source, { reportName: 'C', subreport: true }).rdl;
    const point = line.slice(line.indexOf('<ChartDataPoint>'), line.indexOf('</ChartDataPoint>'));
    assert.ok(point.includes('<Width>1.5pt</Width>') && point.includes('<Size>4pt</Size>'), point);
    assert.ok(/<ChartCustomPaletteColor>#3E6A9E<\/ChartCustomPaletteColor>\s*<ChartCustomPaletteColor>#E02C2C</.test(line), 'blue, then red');
  });

  it('puts the legend where Crystal does and leaves points unlabelled when it does', () => {
    const { rdl } = convertToRdl(chartReport({ values: ['Sum of T.Share'], onChangeOf: 'T.Label', family: 1, graphType: 13,
      legend: { visible: true, position: 2 }, dataLabels: { kind: 0, format: 0 } }), source, { reportName: 'C', subreport: true });
    assert.ok(rdl.includes('<Position>BottomCenter</Position>') && !rdl.includes('#VALY'));
  });
});

describe('review checklist', () => {
  it('lists the items sharing a message under one check', () => {
    const md = reviewMarkdown('Sample.rpt', [{ fileName: 'Sample.rdl', storage: '', rdl: '', review: [
      { item: 'Section A', message: 'was hidden' }, { item: 'Box 1', message: 'is new' }, { item: 'Section B', message: 'was hidden' },
    ] }]);
    assert.ok(md.includes('- [ ] was hidden (2 items)\n  - Section A\n  - Section B'));
    assert.ok(md.includes('- [ ] **Box 1**: is new'));
    assert.equal(md.match(/- \[ \]/g)?.length, 2);
    const code = reviewMarkdown('Sample.rpt', [{ fileName: 'Sample.rdl', storage: '', rdl: '', review: [
      { item: 'Formula {@A}', message: 'was converted to custom code (Code.F_A); review the VB function' },
      { item: 'Formula {@B}', message: 'was converted to custom code (Code.F_B); review the VB function' },
    ] }]);
    assert.ok(code.includes('- [ ] was converted to custom code; review the VB function (2 items)\n  - Formula {@A} (Code.F_A)\n  - Formula {@B} (Code.F_B)'));
  });
});

describe('matching the Crystal page', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
    { name: 'Label', type: 'string' }, { name: 'Amount', type: 'number' },
  ] }] };
  const field = (name: string, ref: string, extra: object = {}) => ({ kind: 'field', name, field: ref, position: { x: 0, y: 0 }, size: { width: 2000, height: 240 }, ...extra });

  it('leaves out sections whose Suppress box is ticked, unless a suppress formula decides', () => {
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [{ name: 'Section_Visibility', index: 0, kind: 'conditionalFormat', text: 'PageNumber = 1', referencedFields: [] }],
      formulaTexts: ['PageNumber = 1'],
      layout: [
        { name: 'ReportHeaderArea1', sections: [
          { name: 'RH1', height: 240, suppressed: true, objects: [field('Gone', 'T.Label')] },
          { name: 'RH2', height: 240, suppressed: true, conditions: { suppress: { name: 'Section_Visibility', index: 0 } }, objects: [field('ByFormula', 'T.Label')] },
        ] },
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, suppressed: true, objects: [field('Row', 'T.Amount')] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'S', subreport: true });
    assert.ok(!rdl.includes('"Gone"') && !rdl.includes('"Row"'), 'suppressed sections do not print');
    assert.ok(rdl.includes('"ByFormula"'), 'the formula decides');
  });

  // A table as Crystal designs it: a frame and column lines drawn in the header that run down to the footer.
  const framed = (): ReportDefinition => ({
    ...emptyDefinition(),
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 600, objects: [
        { kind: 'text', name: 'Title', text: 'Summary', position: { x: 200, y: 50 }, size: { width: 3000, height: 240 } },
        { kind: 'text', name: 'Head1', text: 'Label', position: { x: 200, y: 330 }, size: { width: 1800, height: 240 } },
        { kind: 'text', name: 'Head2', text: 'Amount', position: { x: 2100, y: 330 }, size: { width: 1800, height: 240 } },
        { kind: 'box', name: 'Frame', position: { x: 100, y: 0 }, size: { width: 4000, height: 1300 }, border: { sides: [1, 1, 1, 1] } },
        { kind: 'line', name: 'Divider', position: { x: 2050, y: 300 }, size: { width: 0, height: 1000 }, border: { sides: [1, 1, 1, 1] } },
      ] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 300, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('Label1', 'T.Label', { position: { x: 200, y: 0 } }), field('Amount1', 'T.Amount', { position: { x: 2100, y: 0 } })] }] },
    ],
  });

  it('frames the table with a box that runs on below the header, so it grows with the rows', () => {
    const { rdl } = convertToRdl(framed(), source, { reportName: 'S', subreport: true });
    const frame = rdl.slice(rdl.indexOf('<Rectangle Name="Frame">'));
    assert.ok(rdl.includes('<Rectangle Name="Frame">'), 'the frame is drawn');
    const items = frame.slice(0, frame.indexOf('</ReportItems>'));
    assert.ok(items.includes('<Tablix ') && items.includes('Summary'), 'the frame holds the title and the table');
  });

  it('draws a line that runs down the table as a column border on every row', () => {
    const { rdl } = convertToRdl(framed(), source, { reportName: 'S', subreport: true });
    const amount = rdl.slice(rdl.indexOf('<Textbox Name="Amount1">'));
    const style = amount.slice(amount.indexOf('<Style>', amount.indexOf('</Paragraphs>')), amount.indexOf('</Textbox>'));
    assert.ok(style.includes('<LeftBorder>'), style);
  });

  it('orders chart dates held as text by date, and leaves numbers alone', () => {
    const chartOf = (onChangeOf: string) => ({ ...emptyDefinition(),
      formulas: [{ name: 'when', index: 0, kind: 'formula' as const, text: 'ToText({T.Label})', referencedFields: ['T.Label'], valueType: 'string' }],
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 3000, objects: [{ kind: 'chart', name: 'Graph1', position: { x: 0, y: 0 }, size: { width: 6000, height: 3000 },
          chart: { values: ['Sum of T.Amount'], onChangeOf, family: 1, graphType: 10 } }] }] },
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', objects: [] }] },
      ] });
    const text = convertToRdl(chartOf('@when'), source, { reportName: 'S', subreport: true }).rdl;
    const sort = /<ChartCategoryHierarchy>[\s\S]*?<SortExpression>\s*<Value>([^<]*)<\/Value>/.exec(text)![1];
    assert.ok(sort.includes('IsDate(') && sort.includes('yyyyMMddHHmmss'), sort);
    const number = convertToRdl(chartOf('T.Amount'), source, { reportName: 'S', subreport: true }).rdl;
    assert.ok(/<ChartCategoryHierarchy>[\s\S]*?<SortExpression>\s*<Value>=Fields!Amount.Value<\/Value>/.test(number));
    assert.ok(/<ChartNoDataMessage Name="NoDataMessage">\s*<Caption\s*\/>/.test(text) || /<ChartNoDataMessage Name="NoDataMessage">\s*<Caption><\/Caption>/.test(text), 'nothing printed for a chart without data');
  });

  it('formats a formula by the result type Crystal stores with it, without extra padding', () => {
    const format = { systemDefault: true, number: { decimals: 2, thousands: true, leadingZero: true, negative: 1, symbolType: 0, symbol: '', symbolPosition: 0 } };
    const definition: ReportDefinition = {
      ...emptyDefinition(),
      formulas: [{ name: 'due', index: 0, kind: 'formula', text: '{T.Amount} * 1.5', referencedFields: ['T.Amount'], valueType: 'number' }],
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('Due', '@due', { format })] }] },
      ],
    };
    const { rdl } = convertToRdl(definition, source, { reportName: 'S', subreport: true });
    assert.ok(rdl.includes('<Format>#,0.00;-#,0.00</Format>'));
    assert.ok(rdl.includes('<PaddingLeft>0.0pt</PaddingLeft>') && !rdl.includes('<PaddingLeft>2pt</PaddingLeft>'));
  });
});

describe('page number option', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Label', type: 'string' }] }] };
  const definition = (): ReportDefinition => ({ ...emptyDefinition(), layout: detailLayout('T.Label') });
  it('adds "Page N" at the right of the page footer on request', () => {
    const { rdl } = convertToRdl(definition(), source, { reportName: 'P', pageNumber: true });
    const footer = rdl.slice(rdl.indexOf('<PageFooter>'), rdl.indexOf('</PageFooter>'));
    assert.ok(footer.includes('="Page " &amp; Globals!PageNumber') && footer.includes('<TextAlign>Right</TextAlign>'), footer);
  });
  it('adds nothing by default', () => {
    assert.ok(!convertToRdl(definition(), source, { reportName: 'P' }).rdl.includes('PageNumberFooter'));
  });
});

describe('converting for given parameter values', () => {
  it('decides suppress formulas that only compare parameters with constants', () => {
    assert.equal(fixedCondition('{?kind} = 1', { kind: '1' }), true);
    assert.equal(fixedCondition('{?Kind} <> 1;', { kind: '1' }), false);
    assert.equal(fixedCondition('({?kind} = 2) or not ({?region} = "East")', { kind: '1', region: 'West' }), true);
    assert.equal(fixedCondition('{?Pm-?kind} >= 3 and {?kind} < 9', { kind: '4' }), true);
    assert.equal(fixedCondition('{?kind} = 1 and {T.Flag} = 1', { kind: '1' }), undefined, 'a field is not known');
    assert.equal(fixedCondition('{?other} = 1', { kind: '1' }), undefined, 'a parameter without a value');
    assert.equal(fixedCondition('WhilePrintingRecords; {?kind} = 1', { kind: '1' }), undefined);
    assert.equal(fixedCondition('{?@kind} = 1', { kind: '1' }), true, 'a parameter named with @');
  });

  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Label', type: 'string' }] }] };
  const definition = (): ReportDefinition => ({
    ...emptyDefinition(),
    parameters: [{ name: 'kind', valueType: 'number' }],
    formulas: [
      { name: 'Section_Visibility', index: 0, kind: 'conditionalFormat', text: '{?kind} = 1', referencedFields: [] },
      { name: 'Object_Visibility', index: 1, kind: 'conditionalFormat', text: '{?kind} <> 1', referencedFields: [] },
    ],
    formulaTexts: ['{?kind} = 1', '{?kind} <> 1'],
    layout: [
      { name: 'ReportHeaderArea1', sections: [
        { name: 'Other', height: 900, conditions: { suppress: { name: 'Section_Visibility', index: 0 } }, objects: [{ kind: 'text', name: 'OtherKind', text: 'Only for others', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] },
        { name: 'Mine', height: 300, objects: [{ kind: 'text', name: 'MineText', text: 'Mine', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 }, conditions: { suppress: { name: 'Object_Visibility', index: 1 } } }] },
      ] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ kind: 'field', name: 'L', field: 'T.Label', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
    ],
  });

  it('leaves out what the formulas hide for those values, so it takes no space', () => {
    const { rdl } = convertToRdl(definition(), source, { reportName: 'K', parameterValues: { kind: '1' } });
    assert.ok(!rdl.includes('OtherKind'), 'the hidden section is gone');
    const mine = rdl.slice(rdl.indexOf('<Textbox Name="MineText">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="MineText">')));
    assert.ok(mine.includes('<Top>0in</Top>') && !mine.includes('<Hidden>'), mine);
  });

  it('keeps the formulas when no values are given', () => {
    const { rdl } = convertToRdl(definition(), source, { reportName: 'K' });
    assert.ok(rdl.includes('OtherKind') && rdl.includes('Parameters!kind.Value'));
  });
});

describe('a page header that differs on page 1', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Label', type: 'string' }] }] };
  // Away from the detail column, so they stay header text (not column headings).
  const text = (name: string, value: string) => ({ kind: 'text', name, text: value, position: { x: 5000, y: 0 }, size: { width: 3000, height: 240 } });
  const definition0 = (): ReportDefinition => ({
    ...emptyDefinition(),
    formulas: [
      { name: 'Section_Visibility', index: 0, kind: 'conditionalFormat', text: 'PageNumber >1', referencedFields: ['Page Number'] },
      { name: 'Section_Visibility', index: 1, kind: 'conditionalFormat', text: 'PageNumber <=1', referencedFields: ['Page Number'] },
    ],
    formulaTexts: ['PageNumber >1', 'PageNumber <=1'],
    layout: [
      { name: 'PageHeaderArea1', sections: [
        { name: 'Always', height: 300, objects: [text('Logo', 'Logo')] },
        { name: 'FirstPage', height: 900, conditions: { suppress: { name: 'Section_Visibility', index: 0 } }, objects: [text('Address', 'Address')] },
        { name: 'OtherPages', height: 300, conditions: { suppress: { name: 'Section_Visibility', index: 1 } }, objects: [text('Short', 'Short')] },
      ] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ kind: 'field', name: 'L', field: 'T.Label', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
    ],
  });
  it('shows each version of the page header on its pages, and starts page 1\'s body with what does not fit', () => {
    const definition = definition0();
    definition.layout[0].sections[1].objects.push({ ...text('Below', 'Below'), position: { x: 5000, y: 700 } });
    const { rdl } = convertToRdl(definition, source, { reportName: 'H' });
    const body = rdl.slice(rdl.indexOf('<Body>'), rdl.indexOf('</Body>'));
    const header = rdl.slice(rdl.indexOf('<PageHeader>'), rdl.indexOf('</PageHeader>'));
    const hiddenOf = (name: string) => { const at = header.indexOf(`<Textbox Name="${name}">`); return /<Hidden>([^<]*)<\/Hidden>/.exec(header.slice(at, header.indexOf('</Textbox>', at)))?.[1]; };
    assert.equal(hiddenOf('Short'), '=Globals!PageNumber = 1', 'the other pages\' version is hidden on page 1');
    assert.equal(hiddenOf('Address'), '=Globals!PageNumber &gt; 1', 'page 1\'s version is hidden after page 1');
    assert.ok(header.includes('<PrintOnFirstPage>true</PrintOnFirstPage>'));
    assert.ok(body.includes('>Below<') && !header.includes('>Below<'), 'what lies below the page header\'s height starts page 1\'s body');
  });
  it('keeps header text at its size, and puts the other pages\' rule at the foot of the taller header', () => {
    const definition = definition0();
    // Page 1's box reaches past the other pages' header; their rule then sits at the header's foot.
    definition.layout[0].sections[1].objects.push({ kind: 'box', name: 'Contact', position: { x: 9000, y: 0 }, size: { width: 2000, height: 750 }, border: { sides: [1, 1, 1, 1] } });
    definition.layout[0].sections[2].objects.push({ kind: 'line', name: 'Rule', position: { x: 0, y: 280 }, size: { width: 9000, height: 0 }, border: { sides: [0, 0, 1, 0] } });
    const { rdl } = convertToRdl(definition, source, { reportName: 'H' });
    const header = rdl.slice(rdl.indexOf('<PageHeader>'), rdl.indexOf('</PageHeader>'));
    const height = parseFloat(/<PageHeader>\s*<Height>([0-9.]+)in/.exec(rdl)![1]);
    const rule = header.slice(header.indexOf('<Line Name="Rule">'));
    const top = parseFloat(/<Top>([0-9.]+)in/.exec(rule)![1]);
    assert.ok(height - top < 0.05, `rule at ${top}in in a ${height}in header`);
    assert.ok(header.includes('<CanGrow>false</CanGrow>') && !header.includes('<CanGrow>true</CanGrow>'));
  });
});

describe('layout summary', { skip: !process.env.RPT_SAMPLES_DIR && 'set RPT_SAMPLES_DIR to enable' }, () => {
  it('prints the subreports showing a text, with other names and text hidden', async () => {
    const { layoutSummary } = await import('../src/crystal/layoutinfo.ts');
    const dir = process.env.RPT_SAMPLES_DIR!;
    const outputs = readdirSync(dir).filter((f) => f.endsWith('.rpt')).map((f) => layoutSummary(readCfb(readFileSync(join(dir, f))), ['total']));
    const found = outputs.find((o) => o.startsWith('=='));
    assert.ok(found, 'some sample has a subreport with "total" in a text');
    assert.ok(/\[total\]/.test(found!) && !/"[A-Za-z][^"]*[a-z ][^"]*"/.test(found!), 'only placeholders and the searched text are shown');
  });
});

describe('tables framed in a group header', () => {
  // A frame and column lines drawn in group header 1 that run down to group footer 1 (positions in twips).
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
    { name: 'Kind', type: 'string' }, { name: 'Name', type: 'string' }, { name: 'Low', type: 'number' }, { name: 'High', type: 'number' },
  ] }] };
  const text = (name: string, x: number, y: number) => ({ kind: 'text', name, text: name, position: { x, y }, size: { width: 1200, height: 210 } });
  const field = (name: string, ref: string, x: number) => ({ kind: 'field', name, field: ref, position: { x, y: 0 }, size: { width: 1200, height: 180 } });
  const definition = (): ReportDefinition => ({
    ...emptyDefinition(),
    groups: ['T.Kind'],
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, suppressed: true, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, suppressed: true, objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 900, objects: [
        { kind: 'box', name: 'Frame', position: { x: 45, y: 25 }, size: { width: 4100, height: 1400 }, border: { sides: [1, 1, 1, 1] } },
        text('Heading', 120, 70),
        { kind: 'line', name: 'Rule', position: { x: 1450, y: 360 }, size: { width: 0, height: 1050 }, border: { sides: [1, 0, 0, 0] } },
        { kind: 'line', name: 'Under', position: { x: 45, y: 840 }, size: { width: 4100, height: 0 }, border: { sides: [0, 0, 1, 0] } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 30, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 195, objects: [field('NameCell', 'T.Name', 120), field('LowCell', 'T.Low', 1500), field('HighCell', 'T.High', 2900)] }] },
    ],
  });

  it('draws the column line down every row and closes the frame below the group', () => {
    const { rdl } = convertToRdl(definition(), source, { reportName: 'G', subreport: true });
    const cell = (name: string) => { const at = rdl.indexOf(`<Textbox Name="${name}">`); return rdl.slice(at, rdl.indexOf('</Textbox>', at)); };
    assert.ok(cell('LowCell').includes('<LeftBorder>'), 'the column line runs down the data');
    assert.ok(cell('NameCell').includes('<LeftBorder>') && cell('HighCell').includes('<RightBorder>'), 'the frame\'s sides');
    assert.ok(rdl.includes('Group1Frame'), 'a closing row for the frame\'s bottom edge');
    const frame = rdl.slice(rdl.indexOf('<Rectangle Name="Frame">'), rdl.indexOf('</Rectangle>', rdl.indexOf('<Rectangle Name="Frame">')));
    assert.ok(frame.includes('<TopBorder>') && !frame.includes('<BottomBorder>'), 'the cut box has no bottom edge across the next row');
  });
  it('splits a heading at the rule under its title: the rule is the title row\'s bottom border, the column lines the cells\' borders below it', () => {
    const def = definition();
    const gh = def.layout.find((a) => a.name === 'GroupHeaderArea1')!.sections[0];
    gh.objects.push({ kind: 'line', name: 'TitleRule', position: { x: 45, y: 345 }, size: { width: 4100, height: 0 }, border: { sides: [0, 0, 1, 0] } },
      text('ColumnHead', 1500, 500), text('ColumnHead2', 1500, 620));
    // The rule closing the headings sits a little above the section's foot: it does not split them again.
    gh.objects.find((o) => o.name === 'Under')!.position = { x: 45, y: 800 };
    const { rdl } = convertToRdl(def, source, { reportName: 'G', subreport: true });
    const rows = descendants(parseXml(rdl)).filter((e) => e.name === 'TablixRow');
    const holding = (name: string) => rows.findIndex((r) => descendants(r).some((e) => e.attributes.Name === name));
    const title = holding('Heading');
    assert.ok(title >= 0 && holding('ColumnHead') === title + 1, 'title and column headings in rows of their own');
    const styles = (i: number) => childElements(child(rows[i], 'TablixCells')!).map((c) => child(c, 'CellContents')).filter((c) => !!c)
      .map((c) => childElements(c!)[0]).map((r) => descendants(child(r, 'Style')!).map((e) => e.name));
    assert.ok(styles(title).some((st) => st.includes('BottomBorder')), 'the rule under the title');
    assert.ok(!descendants(rows[title]).some((e) => e.name === 'Line' && e.attributes.Name === 'TitleRule'));
    assert.ok(styles(title + 1).filter((st) => st.includes('LeftBorder')).length >= 2, 'the column line is a cell border');
  });

  it('reaches out to its frame and closes it at the foot of every page', () => {
    const { rdl } = convertToRdl(definition(), source, { reportName: 'G', subreport: true });
    const tablix = descendants(parseXml(rdl)).find((e) => e.name === 'Tablix')!;
    assert.equal(child(tablix, 'Left')!.children.join(''), '0.031in', 'from the frame\'s left side');
    assert.ok(!descendants(child(tablix, 'Style')!).some((e) => e.name === 'BottomBorder') && rdl.includes('Group1Frame'), 'each group closed by its own row');
    // A group holding every record: the table's own bottom border closes it on every page, drawn once.
    const single = definition();
    single.groups = ['@One'];
    single.formulas = [{ name: 'One', index: 0, kind: 'formula', text: '1', referencedFields: [] }];
    const one = convertToRdl(single, source, { reportName: 'G', subreport: true }).rdl;
    const table = descendants(parseXml(one)).find((e) => e.name === 'Tablix')!;
    assert.ok(descendants(child(table, 'Style')!).some((e) => e.name === 'BottomBorder') && !one.includes('Group1Frame'));
  });

  it('draws the column line as a cell border in a row laid out freely, so it reaches down a row that grows', () => {
    const def = definition();
    const detail = def.layout.find((a) => a.name === 'DetailArea1')!.sections[0];
    detail.height = 420;
    detail.objects.push({ ...field('NoteCell', 'T.Kind', 120), position: { x: 120, y: 210 } });
    const { rdl } = convertToRdl(def, source, { reportName: 'G', subreport: true });
    const row = descendants(parseXml(rdl)).filter((e) => e.name === 'TablixRow').find((r) => descendants(r).some((e) => e.attributes.Name === 'NoteCell'))!;
    const rectangles = childElements(child(row, 'TablixCells')!).map((c) => child(child(c, 'CellContents')!, 'Rectangle')!);
    assert.equal(rectangles.length, 3, 'a cell per column');
    assert.ok(descendants(child(rectangles[1], 'Style')!).some((e) => e.name === 'LeftBorder'), 'the column line is the cell\'s border');
    assert.ok(!descendants(row).some((e) => e.name === 'Line'), 'no line of fixed height');
  });
});

describe('subreports in the report footer', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Label', type: 'string' }, { name: 'Flag', type: 'number' }] }] };
  const panel: ReportDefinition = {
    ...emptyDefinition(),
    layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 0, objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [{ kind: 'field', name: 'PanelValue', field: 'T.Label', position: { x: 0, y: 0 }, size: { width: 2000, height: 220 } }] }] },
    ],
  };
  const subreports = new Map([1, 2, 3].map((n) => [n, { name: `M_Subdocument_${n}`, links: [], definition: panel, dataSource: source }]));
  const main = (objects: ReportObject[], formulas: ReportDefinition['formulas'] = []): ReportDefinition => ({
    ...emptyDefinition(),
    formulas,
    formulaTexts: formulas.map((f) => f.text),
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', objects: [] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'Panels', height: 630, objects }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [] }] },
    ],
  });
  const sub = (name: string, index: number, x: number, extra: object = {}): ReportObject => ({ kind: 'subreport', name, subreport: { index, onDemand: false }, position: { x, y: 400 }, size: { width: 4000, height: 230 }, ...extra });

  it('grows a box drawn around subreports with them, and draws a divider along a subreport as its border', () => {
    const { rdl } = convertToRdl(main([
      { kind: 'box', name: 'Panel', position: { x: 100, y: 60 }, size: { width: 8200, height: 680 }, border: { sides: [1, 1, 1, 1] } },
      sub('Left', 1, 150), sub('Right', 2, 4170),
      { kind: 'line', name: 'Divider', position: { x: 4150, y: 380 }, size: { width: 0, height: 350 }, border: { sides: [1, 0, 0, 0] } },
    ]), source, { reportName: 'M', subreports });
    const panelBox = descendants(parseXml(rdl)).find((r) => r.name === 'Rectangle' && r.attributes.Name === 'Panel')!;
    const held = childElements(child(panelBox, 'ReportItems')!).map((e) => e.attributes.Name);
    assert.ok(held.includes('Left') && held.includes('Right'), `the box holds both subreports: ${held.join(', ')}`);
    const leftPanel = rdl.slice(rdl.indexOf('<Rectangle Name="Left">'));
    assert.ok(leftPanel.slice(0, leftPanel.indexOf('<Rectangle Name="Right">')).includes('<RightBorder>'), 'the divider is the left panel\'s right border');
  });

  it('keeps the next section\'s subreport below a box that runs on past its section, not inside it', () => {
    const definition = main([
      { kind: 'box', name: 'Panel', position: { x: 100, y: 60 }, size: { width: 8200, height: 1400 }, border: { sides: [1, 1, 1, 1] } },
      sub('Left', 1, 150),
    ]);
    definition.layout[3].sections.push({ name: 'Next', height: 400, objects: [{ ...sub('Below', 2, 150), position: { x: 150, y: 50 } }] });
    const { rdl } = convertToRdl(definition, source, { reportName: 'M', subreports });
    const panelBox = descendants(parseXml(rdl)).find((r) => r.name === 'Rectangle' && r.attributes.Name === 'Panel')!;
    const held = childElements(child(panelBox, 'ReportItems')!).map((e) => e.attributes.Name);
    assert.ok(held.includes('Left') && !held.includes('Below'), held.join(', '));
  });

  it('keeps the height of the subreport\'s report header, whatever it shows', () => {
    const tall: ReportDefinition = { ...panel, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 2880, objects: [{ kind: 'text', name: 'Note', text: 'Note', position: { x: 0, y: 1300 }, size: { width: 2000, height: 220 } }] }] },
      ...panel.layout.slice(1),
    ] };
    const { rdl } = convertToRdl(main([sub('Tall', 1, 150)]), source, { reportName: 'M', subreports: new Map([[1, { name: 'M_Subdocument_1', links: [], definition: tall, dataSource: source }]]) });
    const rectangle = descendants(parseXml(rdl)).find((r) => r.name === 'Rectangle' && r.attributes.Name === 'Tall')!;
    assert.equal(child(rectangle, 'Height')!.children.join(''), '2in');
  });

  it('prints what a formula on a database field suppresses when there are no records, as Crystal does', () => {
    const formulas = [{ name: 'Object_Visibility', index: 0, kind: 'conditionalFormat' as const, text: 'Count ({T.Label}) = 0', referencedFields: ['T.Label'] }];
    const withTitle: ReportDefinition = { ...panel, formulas, formulaTexts: [formulas[0].text], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 400, objects: [{ kind: 'text', name: 'Heading', text: 'Heading', position: { x: 0, y: 0 }, size: { width: 2000, height: 220 }, conditions: { suppress: { name: 'Object_Visibility', index: 0 } } }] }] },
      ...panel.layout.slice(1),
    ] };
    const { rdl } = convertToRdl(main([sub('Titled', 1, 150)]), source, { reportName: 'M', subreports: new Map([[1, { name: 'M_Subdocument_1', links: [], definition: withTitle, dataSource: source }]]) });
    assert.ok(/<Hidden>=\(Not \(IsNothing\(First\(Fields!Label\.Value, "DataSet_M_Subdocument_1"\)\)\)\) AndAlso \(/.test(rdl), rdl.slice(rdl.indexOf('<Textbox Name="Heading">'), rdl.indexOf('<Textbox Name="Heading">') + 1500));
  });

  it('keeps a subreport to its frame, its wider content cut off at the frame as Crystal does', () => {
    const wide: ReportDefinition = { ...panel, layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 300, objects: [{ kind: 'text', name: 'Wide', text: 'Wide', position: { x: 500, y: 0 }, size: { width: 10000, height: 220 } }] }] },
      ...panel.layout.slice(1),
    ] };
    const { rdl } = convertToRdl(main([sub('Framed', 1, 150)]), source, { reportName: 'M', subreports: new Map([[1, { name: 'M_Subdocument_1', links: [], definition: wide, dataSource: source }]]) });
    const items = descendants(parseXml(rdl));
    const num = (name: string, prop: string) => parseFloat(child(items.find((e) => e.attributes.Name === name)!, prop)!.children.join(''));
    assert.equal(num('Framed', 'Width'), 2.778, 'the frame keeps its Crystal width');
    assert.ok(num('Wide', 'Left') + num('Wide', 'Width') <= 2.7781, 'the content is cut off at the frame');
  });

  it('hides a subreport by its own suppress formula', () => {
    const formulas = [{ name: 'Object_Visibility', index: 0, kind: 'conditionalFormat' as const, text: 'if {T.Flag} <> 1 then true', referencedFields: ['T.Flag'] }];
    const { rdl } = convertToRdl(main([sub('Chart1', 3, 150, { conditions: { suppress: { name: 'Object_Visibility', index: 0 } } })], formulas), source, { reportName: 'M', subreports });
    const chart = rdl.slice(rdl.indexOf('<Rectangle Name="Chart1">'));
    assert.ok(/<Hidden>=[^<]*Flag[^<]*<\/Hidden>/.test(chart.slice(0, chart.indexOf('</Rectangle>') + 4000)), 'the formula decides');
  });
});

describe('text and group order as Crystal prints them', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Amount', type: 'number' }] }] };
  it('breaks a line where a run of spaces pushed the words on in a box of several lines', () => {
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 1100, objects: [
        { kind: 'text', name: 'Note', text: 'First line here       Second line      ', align: 'center', position: { x: 0, y: 0 }, size: { width: 3000, height: 1080 } },
        { kind: 'text', name: 'Label', text: 'A     B', position: { x: 0, y: 1080 }, size: { width: 3000, height: 200 } }] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', objects: [] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'T', subreport: true });
    assert.ok(rdl.includes('<Value>="First line here" &amp; vbCrLf &amp; "Second line"</Value>'), 'a line break');
    assert.ok(rdl.includes('<Value>A     B</Value>'), 'spaces kept on one line');
    const nbsp = convertToRdl({ ...definition, layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 1100, objects: [
      { kind: 'text', name: 'Boxed', text: 'Contact us\u00a0\u00a0\u00a0\u00a0\u00a0Service desk', align: 'center', border: { sides: [1, 1, 1, 1] }, position: { x: 0, y: 0 }, size: { width: 3000, height: 1080 } }] }] }, ...definition.layout.slice(1)] }, source, { reportName: 'T', subreport: true }).rdl;
    assert.ok(nbsp.includes('<Value>="Contact us" &amp; vbCrLf &amp; "Service desk"</Value>'), 'non-breaking spaces too');
    // Lines centred with spaces in a text without an alignment of its own: centred, without the spaces.
    const padded = convertToRdl({ ...definition, layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 1100, objects: [
      { kind: 'text', name: 'Padded', text: '   First line here        Second        Third line', position: { x: 0, y: 0 }, size: { width: 3000, height: 1080 } }] }] }, ...definition.layout.slice(1)] }, source, { reportName: 'T', subreport: true }).rdl;
    const at = padded.indexOf('<Textbox Name="Padded">');
    const box = padded.slice(at, padded.indexOf('</Textbox>', at));
    assert.ok(box.includes('<Value>="First line here" &amp; vbCrLf &amp; "Second" &amp; vbCrLf &amp; "Third line"</Value>') && box.includes('<TextAlign>Center</TextAlign>'), box.slice(0, 600));
    assert.ok(/<PaddingLeft>4\.0pt<\/PaddingLeft>\s*<PaddingRight>4\.0pt<\/PaddingRight>\s*<PaddingTop>1pt<\/PaddingTop>\s*<PaddingBottom>0pt/.test(nbsp), 'text kept inside its border');
  });
  it('orders groups with equal summaries by their own value', () => {
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.Name'],
      sorts: [{ field: 'Sum of T.Amount', descending: true, bySummary: true }],
      layout: [
        { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
        { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 200, objects: [{ kind: 'field', name: 'N', field: 'T.Name', position: { x: 0, y: 0 }, size: { width: 2000, height: 200 } }] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', objects: [] }] },
      ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'T', subreport: true });
    assert.ok(/<Value>=Sum\(Fields!Amount\.Value\)<\/Value>\s*<Direction>Descending<\/Direction>\s*<\/SortExpression>\s*<SortExpression>\s*<Value>=Fields!Name\.Value<\/Value>/.test(rdl),
      rdl.slice(rdl.indexOf('<SortExpressions>'), rdl.indexOf('</SortExpressions>')));
  });
});

describe('formulas without data, page breaks by formula and the default font', () => {
  const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Name', type: 'string' }] }] };
  const report = (objects: ReportObject[], extra: Partial<ReportDefinition> = {}, section: object = {}): ReportDefinition => ({ ...emptyDefinition(), ...extra, layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 400, objects, ...section }] },
    { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 200, objects: [{ kind: 'field', name: 'N', field: 'T.Name', position: { x: 0, y: 0 }, size: { width: 1000, height: 200 }, font: 'Times New Roman' }] }] },
  ] });
  it('prints a formula that reads no field as its expression, not a dataset field', () => {
    const formulas = [{ name: 'Title', index: 0, kind: 'formula' as const, text: '"A title"', referencedFields: [], valueType: 'string' }];
    const { rdl } = convertToRdl(report([{ kind: 'field', name: 'T1', field: '@Title', position: { x: 0, y: 0 }, size: { width: 2000, height: 200 } }], { formulas, formulaTexts: ['"A title"'] }), source, { reportName: 'R' });
    assert.ok(/<Value>=\("A title"\)<\/Value>/.test(rdl) && !rdl.includes('F_Title'), rdl.slice(rdl.indexOf('<Textbox Name="T1">'), rdl.indexOf('<Textbox Name="T1">') + 400));
  });
  it('breaks the page before a section where its formula says so', () => {
    const formulas = [{ name: 'New_Page_Before', index: 0, kind: 'conditionalFormat' as const, text: '{?Split} = 1', referencedFields: [] }];
    const definition = report([{ kind: 'text', name: 'X', text: 'X', position: { x: 0, y: 0 }, size: { width: 1000, height: 200 } }],
      { formulas, formulaTexts: [formulas[0].text], parameters: [{ name: 'Split', valueType: 'number' }] }, { conditions: { newPageBefore: { name: 'New_Page_Before', index: 0 } } });
    const { rdl } = convertToRdl(definition, source, { reportName: 'R' });
    assert.ok(/<PageBreak>\s*<BreakLocation>Start<\/BreakLocation>\s*<Disabled>=Not \(/.test(rdl), 'a break the formula switches');
  });
  it('keeps a rule under a title inside the box it crosses, and the title above it', () => {
    const { rdl } = convertToRdl(report([
      { kind: 'box', name: 'Frame', position: { x: 45, y: 25 }, size: { width: 4000, height: 900 }, border: { sides: [1, 1, 1, 1] } },
      { kind: 'text', name: 'Heading', text: 'Heading', position: { x: 120, y: 70 }, size: { width: 3800, height: 280 } },
      { kind: 'line', name: 'Rule', position: { x: 45, y: 345 }, size: { width: 4010, height: 0 }, border: { sides: [0, 0, 1, 0] } },
    ], {}, { height: 1000 }), source, { reportName: 'R' });
    const items = descendants(parseXml(rdl));
    const heading = items.find((e) => e.attributes.Name === 'Heading')!;
    assert.ok(descendants(child(heading, 'Style')!).some((e) => e.name === 'BottomBorder'), 'the rule is the title\'s bottom border');
    assert.ok(!items.some((e) => e.attributes.Name === 'Rule'), 'drawn once');
    const num = (e: typeof heading, prop: string) => parseFloat(child(e, prop)!.children.join(''));
    const frame = items.find((e) => e.attributes.Name === 'Frame')!;
    assert.ok(num(heading, 'Left') + num(heading, 'Width') <= num(frame, 'Left') + num(frame, 'Width') + 0.0001, 'within the box');
  });
  it('joins framed boxes a hair apart, so one line is drawn between them', () => {
    const box = (name: string, x: number, y: number) => ({ kind: 'box', name, position: { x, y }, size: { width: 2000, height: 1000 }, border: { sides: [1, 1, 1, 1] as [number, number, number, number] } });
    const { rdl } = convertToRdl(report([box('A', 100, 0), box('B', 2166, 0), box('C', 100, 1040)], {}, { height: 2100 }), source, { reportName: 'R' });
    const items = descendants(parseXml(rdl));
    const get = (name: string) => items.find((e) => e.attributes.Name === name)!;
    const sides = (name: string) => descendants(child(get(name), 'Style')!).map((e) => e.name);
    const num = (name: string, prop: string) => parseFloat(child(get(name), prop)!.children.join(''));
    assert.ok(sides('B').includes('LeftBorder') && Math.abs(num('B', 'Left') - (num('A', 'Left') + num('A', 'Width'))) < 0.002, 'B moves to A');
    assert.ok(sides('C').includes('TopBorder'), 'C leaves its top to A');
  });
  it('joins framed boxes in a section that starts a new page too', () => {
    const box = (name: string, x: number) => ({ kind: 'box', name, position: { x, y: 0 }, size: { width: 2000, height: 1000 }, border: { sides: [1, 1, 1, 1] as [number, number, number, number] } });
    const { rdl } = convertToRdl(report([box('P', 100), box('Q', 2166)], {}, { height: 1100, newPageBefore: true }), source, { reportName: 'R' });
    const q = descendants(parseXml(rdl)).find((e) => e.attributes.Name === 'Q')!;
    assert.ok(descendants(child(q, 'Style')!).some((e) => e.name === 'LeftBorder'));
  });
  it('aligns each paragraph of a text as Crystal does, without blank lines from trailing spaces', () => {
    const { rdl } = convertToRdl(report([{ kind: 'text', name: 'Contact', text: 'First line\nSecond line      \nThird', align: 'left', paragraphAligns: ['left', 'center', 'center'],
      border: { sides: [1, 1, 1, 1] }, position: { x: 0, y: 0 }, size: { width: 3000, height: 1080 } }], {}, { height: 1100 }), source, { reportName: 'R' });
    const box = descendants(parseXml(rdl)).find((e) => e.attributes.Name === 'Contact')!;
    const paragraphs = descendants(box).filter((e) => e.name === 'Paragraph');
    assert.deepEqual(paragraphs.map((p) => descendants(p).find((e) => e.name === 'Value')!.children.join('')), ['First line', 'Second line', 'Third']);
    assert.deepEqual(paragraphs.map((p) => descendants(p).find((e) => e.name === 'TextAlign')?.children.join('')), ['Left', 'Center', 'Center']);
  });
  it('drops the spaces ending a line of a centred text holding a field, so no line is pushed aside or added', () => {
    const { rdl } = convertToRdl(report([{ kind: 'text', name: 'Contact', align: 'center', border: { sides: [1, 1, 1, 1] },
      text: 'Call us\nOur desk          \nWeb ', embeddedFields: ['T.Name'],
      runs: [{ text: 'Call us' }, { text: '\n' }, { text: 'Our desk          ' }, { text: '\n' }, { text: 'Web ' }, { field: 'T.Name' }],
      position: { x: 0, y: 0 }, size: { width: 3000, height: 1080 } }], {}, { height: 1100 }), source, { reportName: 'R' });
    const at = rdl.indexOf('<Textbox Name="Contact">');
    const value = /<Value>([^<]*)<\/Value>/.exec(rdl.slice(at))![1];
    assert.equal(value, '="Call us" &amp; vbCrLf &amp; "Our desk" &amp; vbCrLf &amp; "Web " &amp; RTrim(First(Fields!Name.Value, "DataSet1"))', 'a padded text field is trimmed');
  });
  it('joins the boxes under a row that starts a new page to that row, their column lines running straight on', () => {
    const box = (name: string, x: number, w: number) => ({ kind: 'box', name, position: { x, y: 40 }, size: { width: w, height: 1000 }, border: { sides: [1, 1, 1, 1] as [number, number, number, number] } });
    const definition = report([box('Top1', 140, 5291), box('Top2', 5497, 5291), box('Top3', 10854, 4225)], {}, { height: 1080, newPageBefore: true });
    definition.layout[0].sections.push({ name: 'Next', height: 1080, objects: [box('Low1', 140, 5300), box('Low2', 5520, 5295), box('Low3', 10854, 4235)] });
    const { rdl } = convertToRdl(definition, source, { reportName: 'R' });
    const items = descendants(parseXml(rdl));
    const get = (name: string) => items.find((e) => e.attributes.Name === name)!;
    const num = (name: string, prop: string) => parseFloat(child(get(name), prop)!.children.join(''));
    const sides = (name: string) => descendants(child(get(name), 'Style')!).map((e) => e.name);
    for (const n of [1, 2, 3]) {
      assert.ok(sides(`Low${n}`).includes('TopBorder'), `Low${n} shares the line above it`);
      assert.equal(num(`Low${n}`, 'Left'), num(`Top${n}`, 'Left'), `column ${n} left edge`);
      assert.equal(num(`Low${n}`, 'Width'), num(`Top${n}`, 'Width'), `column ${n} width`);
    }
  });

  it('left-aligns justified text (SSRS aligns only General, Left, Center or Right)', () => {
    const { rdl } = convertToRdl(report([{ kind: 'text', name: 'Justified', text: 'Some text', align: 'justify', position: { x: 0, y: 0 }, size: { width: 2000, height: 200 } }]), source, { reportName: 'R' });
    assert.ok(!rdl.includes('Justify') && rdl.includes('<TextAlign>Left</TextAlign>'));
  });
  it('indents lines that start with tabs to Crystal\'s tab stop (text boxes do not tab)', () => {
    const { rdl } = convertToRdl(report([{ kind: 'text', name: 'Legend', text: '\t\t* = One\n\t\t+ = Two\n\t\t - = Three', align: 'left', border: { sides: [1, 1, 1, 1] },
      position: { x: 0, y: 0 }, size: { width: 3000, height: 650 } }]), source, { reportName: 'R' });
    const box = rdl.slice(rdl.indexOf('<Textbox Name="Legend">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Legend">')));
    assert.ok(box.includes('<LeftIndent>36.0pt</LeftIndent>'), 'two tab stops in');
    assert.ok(box.includes('="* = One" &amp; vbCrLf &amp; "+ = Two" &amp; vbCrLf &amp; " - = Three"'), 'the tabs are gone, other spaces kept');
  });
  it('keeps a blank first line', () => {
    const { rdl } = convertToRdl(report([{ kind: 'text', name: 'Notice', text: '\nSome text\nMore\n\n', align: 'justify', paragraphAligns: ['left', 'justify', 'left', 'left', 'justify'],
      position: { x: 0, y: 0 }, size: { width: 3000, height: 900 } }]), source, { reportName: 'R' });
    const box = rdl.slice(rdl.indexOf('<Textbox Name="Notice">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Notice">')));
    const values = [...box.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1]);
    assert.equal(values.length, 3, 'one paragraph per line');
    assert.equal(values[1], 'Some text');
  });
  it('finds a field whose table is named differently from the data source alias (owner in front, own name)', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'Lines', name: 'dbo.order_lines', kind: 'table', fields: [
      { name: 'shipped_on', type: 'date' }, { name: 'kind', type: 'string' },
    ] }] };
    const def = (ref: string): ReportDefinition => ({ ...emptyDefinition(), selectionFormulas: { record: `${ref} = "A"` },
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', objects: [{ kind: 'field', name: 'Cell', field: ref.slice(1, -1), position: { x: 0, y: 0 } }] }] }] });
    for (const ref of ['{dbo.order_lines.kind}', '{order_lines.kind}', '{Other.kind}']) {
      const { rdl } = convertToRdl(def(ref), src, { reportName: 'R' });
      assert.ok(rdl.includes('<Value>=Fields!kind.Value</Value>') && !rdl.includes('Nothing = "A"'), ref);
    }
  });
  it('keeps a message laid across a row\'s fields from cutting a sliver of a column', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
      { name: 'A', type: 'string' }, { name: 'B', type: 'string' }, { name: 'C', type: 'string' }, { name: 'D', type: 'string' },
    ] }] };
    const field = (name: string, ref: string, x: number, width: number) => ({ kind: 'field', name, field: ref, position: { x, y: 0 }, size: { width, height: 210 } });
    const def: ReportDefinition = { ...emptyDefinition(), layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 264, objects: [
      field('First', 'T.A', 165, 1080), field('Second', 'T.B', 1245, 1005), field('Third', 'T.C', 2535, 450), field('Fourth', 'T.D', 3120, 3225),
      // Shown in place of the values when a field is empty: it starts just before the third field.
      { kind: 'text', name: 'Message', text: 'None', position: { x: 2355, y: 45 }, size: { width: 4125, height: 219 } },
    ] }] }] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const widths = [...rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).matchAll(/<Width>([\d.]+)in<\/Width>/g)].map((m) => Number(m[1]));
    assert.equal(widths.length, 4, 'one column per field');
    assert.ok(Math.min(...widths) > 0.3, `no sliver of a column: ${widths}`);
  });
  it('shows a group\'s name written as GroupName ({Table.Field})', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Kind', type: 'string' }, { name: 'Amount', type: 'number' }] }] };
    const def: ReportDefinition = { ...emptyDefinition(), groups: ['T.Kind'], layout: [
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 240, objects: [{ kind: 'field', name: 'Heading', field: 'GroupName ({T.Kind})', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 210, objects: [{ kind: 'field', name: 'Cell', field: 'T.Amount', position: { x: 0, y: 0 }, size: { width: 1200, height: 210 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, objects: [] }] },
    ] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const box = rdl.slice(rdl.indexOf('<Textbox Name="Heading">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Heading">')));
    assert.ok(box.includes('<Value>=Fields!Kind.Value</Value>'), box.slice(0, 400));
  });
  it('shows a group\'s name written "Group #1" and sorts a descending group in reverse', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Kind', type: 'string' }, { name: 'Amount', type: 'number' }] }] };
    const def: ReportDefinition = { ...emptyDefinition(), groups: ['T.Kind'], groupSorts: [{ field: 'T.Kind', order: 1 }], layout: [
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 240, objects: [{ kind: 'field', name: 'Heading', field: 'Group #1', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 210, objects: [{ kind: 'field', name: 'Cell', field: 'T.Amount', position: { x: 0, y: 0 }, size: { width: 1200, height: 210 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, objects: [] }] },
    ] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const box = rdl.slice(rdl.indexOf('<Textbox Name="Heading">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Heading">')));
    assert.ok(box.includes('<Value>=Fields!Kind.Value</Value>'), 'the group\'s value');
    const group = rdl.slice(rdl.indexOf('<Group Name="Group1_Kind">'));
    assert.ok(/<SortExpression>\s*<Value>=Fields!Kind\.Value<\/Value>\s*<Direction>Descending<\/Direction>/.test(group), 'sorted descending');
  });
  it('gives a message shown only on a condition, laid across a row\'s fields, a row of its own', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
      { name: 'A', type: 'string' }, { name: 'B', type: 'string' }, { name: 'C', type: 'string' }, { name: 'D', type: 'string' },
    ] }] };
    const field = (name: string, ref: string, x: number, width: number) => ({ kind: 'field', name, field: ref, position: { x, y: 0 }, size: { width, height: 210 } });
    const def: ReportDefinition = { ...emptyDefinition(),
      formulas: [{ name: 'Object_Visibility', index: 1, kind: 'conditionalFormat', text: 'not isnull({T.A})', referencedFields: ['T.A'] }],
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 264, objects: [
        field('First', 'T.A', 165, 1080), field('Second', 'T.B', 1245, 1005), field('Third', 'T.C', 2535, 450), field('Fourth', 'T.D', 3120, 3225),
        { kind: 'text', name: 'Message', text: 'None', position: { x: 2355, y: 45 }, size: { width: 4125, height: 219 }, conditions: { suppress: { name: 'Object_Visibility', index: 1 } } },
      ] }] }] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const rows = rdl.slice(rdl.indexOf('<TablixRows>'), rdl.indexOf('</TablixRows>')).split('<TablixRow>').slice(1);
    const fieldsRow = rows.find((r) => r.includes('Name="Fourth"'))!;
    assert.ok(!fieldsRow.includes('<ColSpan>') && !fieldsRow.includes('Name="Message"'), 'the fields keep their own cells');
    assert.ok(rows.some((r) => r.includes('Name="Message"')), 'the message has a row');
    assert.ok(rdl.includes('<Hidden>=Not (IsNothing(Fields!A.Value))</Hidden>'), 'shown on its condition');
    const widths = [...rdl.slice(rdl.indexOf('<TablixColumns>'), rdl.indexOf('</TablixColumns>')).matchAll(/<Width>([\d.]+)in<\/Width>/g)].map((m) => Number(m[1]));
    assert.equal(widths.length, 4, 'the message\'s row cuts no column of its own');
  });
  it('draws a total\'s rule as wide as the total, with gaps between neighbouring totals', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
      { name: 'Kind', type: 'string' }, { name: 'A', type: 'number' }, { name: 'B', type: 'number' },
    ] }] };
    const cell = (name: string, ref: string, x: number, width: number, y = 0, border?: [number, number, number, number]) => ({ kind: 'field', name, field: ref, position: { x, y }, size: { width, height: 180 }, ...(border ? { border: { sides: border } } : {}) });
    const def: ReportDefinition = { ...emptyDefinition(), groups: ['T.Kind'], layout: [
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 0, objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 210, objects: [cell('A1', 'T.A', 11145, 1290), cell('B1', 'T.B', 12540, 1095)] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 287, objects: [cell('SumA', 'Sum of T.A', 11145, 1290, 105, [0, 0, 1, 0]), cell('SumB', 'Sum of T.B', 12540, 1095, 105, [0, 0, 1, 0])] }] },
    ] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const box = (name: string) => rdl.slice(rdl.indexOf(`<Textbox Name="${name}">`), rdl.indexOf('</Textbox>', rdl.indexOf(`<Textbox Name="${name}">`)));
    assert.ok(box('SumA').includes('<Width>0.896in</Width>'), 'the first total keeps its width, short of the next column');
    assert.ok(rdl.includes('<Rectangle Name="SumA_Area">'));
    // The last total fills its column's width, but is set lower in its row: its rule is at its own height too.
    assert.ok(box('SumB').includes('<Top>0.073in</Top>') && box('SumA').includes('<Top>0.073in</Top>'), 'both rules at the totals\' height');
  });
  it('heads a group named by a formula with the formula\'s value', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'Flag', type: 'string' }, { name: 'Amount', type: 'number' }] }] };
    const def: ReportDefinition = { ...emptyDefinition(), groups: ['T.Flag'],
      formulas: [{ name: 'FlagName', kind: 'formula', text: 'if {T.Flag} = "A" then "First kind" else "Second kind"', referencedFields: ['T.Flag'] }],
      groupNameFormulas: [{ field: 'T.Flag', formula: 'FlagName' }],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 240, objects: [{ kind: 'field', name: 'Heading', field: 'Group #1', position: { x: 0, y: 0 }, size: { width: 2000, height: 240 } }] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 210, objects: [{ kind: 'field', name: 'Cell', field: 'T.Amount', position: { x: 0, y: 0 }, size: { width: 1200, height: 210 } }] }] },
        { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 0, objects: [] }] },
      ] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const box = rdl.slice(rdl.indexOf('<Textbox Name="Heading">'), rdl.indexOf('</Textbox>', rdl.indexOf('<Textbox Name="Heading">')));
    // The formula's value: inline, or as the calculated field the formula became.
    assert.ok(/"First kind"|Fields!F_FlagName\.Value/.test(box) && rdl.includes('"First kind"') && rdl.includes('"Second kind"'), box.slice(0, 500));
    assert.ok(rdl.includes('<GroupExpression>=Fields!Flag.Value</GroupExpression>'), 'still grouped by the field');
  });
  it('keeps a heading or label wider than its column on one line, across the empty columns beside it', () => {
    const src: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [
      { name: 'Kind', type: 'string' }, { name: 'A', type: 'string' }, { name: 'B', type: 'string' }, { name: 'C', type: 'number' },
    ] }] };
    const cell = (name: string, ref: string, x: number, width: number, y = 0, border?: [number, number, number, number]) => ({ kind: 'field', name, field: ref, position: { x, y }, size: { width, height: 210 }, ...(border ? { border: { sides: border } } : {}) });
    const def: ReportDefinition = { ...emptyDefinition(), groups: ['T.Kind'], layout: [
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH1', height: 240, objects: [cell('Heading', 'Group #1 Name', 0, 2640)] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 264, objects: [cell('A1', 'T.A', 165, 1080), cell('B1', 'T.B', 1245, 1005), cell('B2', 'T.B', 2535, 450), cell('B3', 'T.A', 3120, 3225), cell('C1', 'T.C', 9045, 1215)] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF1', height: 287, objects: [
        { kind: 'text', name: 'Label', text: 'Sum of all:', position: { x: 1680, y: 105 }, size: { width: 1140, height: 182 } },
        cell('SumC', 'Sum of T.C', 9045, 1215, 105, [0, 0, 1, 0]),
      ] }] },
    ] };
    const { rdl } = convertToRdl(def, src, { reportName: 'R' });
    const box = (name: string) => rdl.slice(rdl.indexOf(`<Textbox Name="${name}">`), rdl.indexOf('</Textbox>', rdl.indexOf(`<Textbox Name="${name}">`)));
    const width = (name: string) => Number(/<Width>([\d.]+)in<\/Width>/.exec(box(name))![1]);
    assert.ok(width('Heading') > 1.6, `the heading runs across the columns beside it: ${width('Heading')}`);
    assert.ok(width('Label') >= 0.79, `the label keeps its width across the column edge: ${width('Label')}`);
    assert.ok(box('SumC').includes('<PaddingTop>2pt</PaddingTop>'), 'the total sits a little below its rule');
  });
  it('takes the font most of the text uses as the report default', () => {
    const { rdl } = convertToRdl(report([]), source, { reportName: 'R' });
    assert.ok(rdl.includes('<df:DefaultFontFamily>Times New Roman</df:DefaultFontFamily>'));
  });
});

describe('heading rows', () => {
  it('keeps a heading\'s place down its row and a thick rule\'s width', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.A'], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 600, objects: [
        { kind: 'text', name: 'HeadA', text: 'A', position: { x: 0, y: 240 }, size: { width: 1400, height: 220 } },
        { kind: 'text', name: 'HeadB', text: 'B', position: { x: 1500, y: 100 }, size: { width: 1400, height: 220 } },
        { kind: 'line', name: 'Under', position: { x: 0, y: 580 }, size: { width: 2900, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 200, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 180 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 180 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    const box = (name: string) => { const at = rdl.indexOf(`<Textbox Name="${name}">`); return rdl.slice(at, rdl.indexOf('</Textbox>', at)); };
    assert.ok(box('HeadA').includes('<PaddingTop>12pt</PaddingTop>') && box('HeadB').includes('<PaddingTop>5pt</PaddingTop>'), box('HeadA'));
    assert.ok(/<BottomBorder>\s*<Style>Solid<\/Style>\s*<Width>3\.50pt<\/Width>/.test(box('HeadA')), 'the thick rule keeps its width');
  });
});

describe('a rule under headings above the section\'s bottom', () => {
  it('ends the heading row at the rule and keeps the space below it', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.A'], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 600, objects: [
        { kind: 'text', name: 'HeadA', text: 'A', position: { x: 0, y: 100 }, size: { width: 1400, height: 220 } },
        { kind: 'text', name: 'HeadB', text: 'B', position: { x: 1500, y: 100 }, size: { width: 1400, height: 220 } },
        { kind: 'line', name: 'Under', position: { x: 0, y: 450 }, size: { width: 2900, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 200, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 180 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 180 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    const heights = [...rdl.matchAll(/<TablixRow>\s*<Height>([0-9.]+)in<\/Height>/g)].map((m) => m[1]);
    assert.deepEqual(heights.slice(0, 2), ['0.333', '0.083'], heights.join(', '));
  });
  it('also below the title\'s rule: title row, heading row ending at its rule, then the space below it', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.A'], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 1135, objects: [
        { kind: 'text', name: 'Title', text: 'Title', position: { x: 0, y: 0 }, size: { width: 2900, height: 249 } },
        { kind: 'text', name: 'HeadA', text: 'A', position: { x: 0, y: 598 }, size: { width: 1400, height: 225 } },
        { kind: 'text', name: 'HeadB', text: 'B', position: { x: 1500, y: 387 }, size: { width: 1400, height: 660 } },
        { kind: 'line', name: 'TitleRule', position: { x: 11, y: 255 }, size: { width: 2880, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
        { kind: 'line', name: 'HeadRule', position: { x: 11, y: 1075 }, size: { width: 2880, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 285, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 210 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 210 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    const heights = [...rdl.matchAll(/<TablixRow>\s*<Height>([0-9.]+)in<\/Height>/g)].map((m) => m[1]);
    assert.deepEqual(heights.slice(0, 3), ['0.198', '0.569', '0.031'], heights.join(', '));
  });
  it('splits at the heading rule even where a heading\'s frame reaches past it', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.A'], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 940, objects: [
        { kind: 'text', name: 'Title', text: 'Title', position: { x: 0, y: 0 }, size: { width: 2900, height: 288 } },
        { kind: 'text', name: 'HeadA', text: 'A', position: { x: 0, y: 510 }, size: { width: 1400, height: 240 } },
        { kind: 'text', name: 'HeadB', text: 'B', position: { x: 1500, y: 390 }, size: { width: 1400, height: 525 } },
        { kind: 'line', name: 'TitleRule', position: { x: 0, y: 290 }, size: { width: 2900, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
        { kind: 'line', name: 'HeadRule', position: { x: 0, y: 880 }, size: { width: 2900, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 250, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 210 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 210 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    const heights = [...rdl.matchAll(/<TablixRow>\s*<Height>([0-9.]+)in<\/Height>/g)].map((m) => m[1]);
    // Title row to the middle of its rule, heading row likewise, then the space below the heading rule.
    assert.deepEqual(heights.slice(0, 3), ['0.222', '0.41', '0.031'], heights.join(', '));
  });

  it('keeps the next row clear of a thick rule drawn at the very bottom of its section', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['T.A'], layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 600, objects: [
        { kind: 'text', name: 'HeadA', text: 'A', position: { x: 0, y: 200 }, size: { width: 1400, height: 225 } },
        { kind: 'text', name: 'HeadB', text: 'B', position: { x: 1500, y: 200 }, size: { width: 1400, height: 225 } },
        { kind: 'line', name: 'HeadRule', position: { x: 11, y: 585 }, size: { width: 2880, height: 0 }, border: { sides: [0, 0, 1, 0], width: 60 } },
      ] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 285, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 210 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 210 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    const heights = [...rdl.matchAll(/<TablixRow>\s*<Height>([0-9.]+)in<\/Height>/g)].map((m) => m[1]);
    assert.deepEqual(heights.slice(0, 2), ['0.417', '0.031'], heights.join(', '));
  });
});

describe('a layout a little wider than the page', () => {
  it('trims what reaches past the printable width, so SSRS adds no blank page across', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    // 11in landscape page, 0.2in margins: 10.6in printable; the table and a line reach 10.635in.
    const definition: ReportDefinition = { ...emptyDefinition(), page: { orientation: 'landscape', paperSize: 1 }, margins: { left: 288, right: 288, top: 288, bottom: 288 }, layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 300, objects: [{ kind: 'line', name: 'Rule', position: { x: 0, y: 200 }, size: { width: 15314, height: 0 }, border: { sides: [0, 0, 1, 0] } }] }] },
      { name: 'PageFooterArea1', sections: [{ name: 'PF', objects: [] }] },
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 200, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 7000, height: 180 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 7200, y: 0 }, size: { width: 8114, height: 180 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R' });
    const body = parseXml(rdl);
    const widthAfterBody = /<\/Body>\s*<Width>([0-9.]+)in<\/Width>/.exec(rdl)![1];
    assert.equal(widthAfterBody, '10.6');
    const rights = descendants(body).filter((e) => ['Tablix', 'Line'].includes(e.name)).map((e) => parseFloat(child(e, 'Left')!.children.join('')) + parseFloat(child(e, 'Width')!.children.join('')));
    assert.ok(rights.every((r) => r <= 10.6001), rights.join(', '));
  });
});

describe('row heights', () => {
  it('makes each table row as tall as its Crystal section', () => {
    const source: DataSourceInfo = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', fields: [{ name: 'A', type: 'string' }, { name: 'B', type: 'string' }] }] };
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'ReportHeaderArea1', sections: [{ name: 'RH', objects: [] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', objects: [] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 190, objects: [
        { kind: 'field', name: 'A1', field: 'T.A', position: { x: 0, y: 0 }, size: { width: 1400, height: 180 } },
        { kind: 'field', name: 'B1', field: 'T.B', position: { x: 1500, y: 0 }, size: { width: 1400, height: 180 } },
      ] }] },
    ] };
    const { rdl } = convertToRdl(definition, source, { reportName: 'R', subreport: true });
    assert.ok(/<TablixRow>\s*<Height>0\.132in<\/Height>/.test(rdl), 'not raised to 0.2in');
  });
});
