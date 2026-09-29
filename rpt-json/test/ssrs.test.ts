import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DataSourceInfo, ReportDefinition } from '../src/crystal/model.ts';
import { readCfb } from '../src/index.ts';
import { convertDocumentToSsrs } from '../src/ssrs/convert.ts';
import { CODE_HELPERS, crystalColor, translateFormula, type FormulaContext } from '../src/ssrs/formula.ts';
import { isBasicSyntax } from '../src/ssrs/basic.ts';
import { chartStyle, convertToRdl } from '../src/ssrs/rdl.ts';

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
    assert.ok(rdl.includes('<CommandText>usp_OrdersByDate</CommandText>'));
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
    assert.deepEqual(t.helpers, ['CrSplit']);
    assert.match(t.code!, /Public Function F_Last\(ByVal a1 As Object, ByVal a2 As Object\) As Object\n {4}Dim result As Object = Nothing\n {4}Dim v_parts\(\) As Object\n {4}Dim v_n As Double/);
    assert.match(t.code!, /v_parts = CrSplit\(a1, "\\\\"\)\n {4}v_n = UBound\(v_parts\)\n {4}If v_n > 1 Then\n {8}result = v_parts\(v_n\) & " of " & CStr\(v_n\)\n {4}Else\n {8}result = System\.Uri\.UnescapeDataString/);
    assert.match(t.code!, /End If\n {4}Return result\nEnd Function$/);
  });

  it('translates Basic syntax custom functions and keeps Crystal arrays 1-based', () => {
    const fn = translateFormula('Function Twice (x As Number, Optional y As Number = 1) As Number\r\n  Twice = x * 2 + y\r\nEnd Function', ctx, { codeName: 'F_Twice' });
    assert.equal(fn.expression, '=Code.F_Twice()');
    assert.match(fn.code!, /Public Function F_Twice\(ByVal p_x As Double, Optional ByVal p_y As Double = 1\) As Object/);
    assert.match(fn.code!, /result = p_x \* 2 \+ p_y/);
    const array = translateFormula('Local StringVar Array a := ["x", "y"]; a[1]', ctx, { codeName: 'F_A' });
    assert.match(array.code!, /v_a = New String\(\) \{Nothing, "x", "y"\}/);
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
  });
});
