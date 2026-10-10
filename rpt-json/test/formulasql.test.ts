import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formulaToSql } from '../src/ssrs/formula.ts';

const types: Record<string, string> = { Name: 'string', Region: 'string', Amount: 'currency', Qty: 'number', Shipped: 'date' };
const ctx = {
  column: (_t: string, f: string) => (types[f] ? `[T].[${f}]` : undefined),
  columnType: (_t: string, f: string) => types[f],
  formula: (name: string) => (name === 'Doubled' ? { sql: '([T].[Amount] * 2)', type: 'number' as const } : undefined),
  customFunction: (name: string) => ({ tag: 'Function (StringVar s, StringVar t) if s = "DE" then "[" + t + "]" else t', count: 'Function (NumberVar n) Local NumberVar i := n; i + 1' } as Record<string, string>)[name],
};
const sql = (formula: string) => {
  const out = formulaToSql(formula, ctx);
  assert.ok('sql' in out, `translated: ${'reason' in out ? out.reason : ''}`);
  return out;
};
const refused = (formula: string) => {
  const out = formulaToSql(formula, ctx);
  assert.ok('reason' in out, `refused: ${formula}`);
  return out.reason;
};

describe('formulas as SQL columns', () => {
  it('joins text, null where a field is null (as Crystal prints nothing)', () => {
    assert.deepEqual(sql('{T.Name} + " Inc"'), { sql: "([T].[Name] + N' Inc')", type: 'string' });
  });

  it('gives nothing where a condition reads a null field, unless the formula tests it', () => {
    assert.equal(sql('if {T.Region} = "DE" then "Delaware" else "Other"').sql,
      "CASE WHEN [T].[Region] IS NULL THEN NULL WHEN [T].[Region] COLLATE Latin1_General_CS_AS = N'DE' THEN N'Delaware' ELSE N'Other' END");
    assert.equal(sql('if IsNull({T.Region}) then "none" else {T.Region}').sql, "CASE WHEN [T].[Region] IS NULL THEN N'none' ELSE [T].[Region] END");
  });

  it('gives the empty value of the type for an if without else', () => {
    assert.match(sql('if {T.Region} in ["DE", "DC"] then "East"').sql, /ELSE N'' END$/);
    assert.match(sql('if {T.Qty} > 2 then 1').sql, /ELSE 0 END$/);
  });

  it('divides as decimals and counts trailing spaces in a length, as Crystal does', () => {
    assert.equal(sql('{T.Amount} / {T.Qty}').sql, '(CAST([T].[Amount] AS float) / [T].[Qty])');
    assert.equal(sql('Length({T.Name})').sql, "(LEN([T].[Name] + N'x') - 1)");
  });

  it('writes numbers as Crystal\'s ToText does, and dates in the format given', () => {
    assert.equal(sql('ToText({T.Amount})').sql, "FORMAT([T].[Amount], 'N2', 'en-US')");
    assert.equal(sql('ToText({T.Amount}, 0)').sql, "FORMAT([T].[Amount], 'N0', 'en-US')");
    assert.equal(sql('ToText({T.Shipped}, "MM/dd/yyyy")').sql, "FORMAT([T].[Shipped], 'MM/dd/yyyy', 'en-US')");
  });

  it('works with dates: days added, parts, day of the week from Sunday whatever the server', () => {
    assert.deepEqual(sql('{T.Shipped} + 30'), { sql: 'DATEADD(day, 30, [T].[Shipped])', type: 'date' });
    assert.equal(sql('DateAdd("m", 1, {T.Shipped})').sql, 'DATEADD(month, 1, [T].[Shipped])');
    assert.equal(sql('DayOfWeek({T.Shipped})').sql, "((DATEDIFF(day, '19000107', [T].[Shipped]) % 7 + 7) % 7 + 1)");
  });

  it('works out select case, lists, ranges, true/false results and other formulas', () => {
    assert.match(sql('select {T.Region} case "DE", "DC": "East" default: "Other"').sql, /^CASE WHEN \[T\]\.\[Region\] IS NULL THEN NULL WHEN .* OR .* THEN N'East' ELSE N'Other' END$/);
    assert.deepEqual(sql('{T.Qty} > 2 and {T.Region} <> "NY"').type, 'boolean');
    assert.equal(sql('{@Doubled} + 1').sql, '(([T].[Amount] * 2) + 1)');
  });

  it('takes parts of text, currency and custom functions of one expression', () => {
    assert.equal(sql('{T.Name}[1 to 5]').sql, 'SUBSTRING([T].[Name], 1, (5) - (1) + 1)');
    assert.equal(sql('{T.Name}[2]').sql, 'SUBSTRING([T].[Name], 2, 1)');
    assert.equal(sql('CCur({T.Amount} / 3)').sql, 'CAST((CAST([T].[Amount] AS float) / 3) AS money)');
    assert.equal(sql('tag({T.Region}, {T.Name})').sql,
      "CASE WHEN [T].[Region] IS NULL OR [T].[Name] IS NULL THEN NULL ELSE CASE WHEN [T].[Region] COLLATE Latin1_General_CS_AS = N'DE' THEN ((N'[' + [T].[Name]) + N']') ELSE [T].[Name] END END");
    assert.match(refused('count({T.Qty})'), /statements one after another/);
  });

  it('leaves in the report what SQL would not give exactly the same', () => {
    assert.match(refused('WhilePrintingRecords; NumberVar x := x + 1'), /variables|prints/);
    assert.match(refused('{?Country} + "x"'), /parameter/);
    assert.match(refused('ToText({T.Shipped})'), /without a format/);
    assert.match(refused('ProperCase({T.Name})'), /propercase/);
    assert.match(refused('{T.Name} + 1'), /arithmetic|joins/);
    assert.match(refused('{@Unknown}'), /not worked out in SQL/);
    assert.match(refused('PageNumber'), /PageNumber/i);
  });
});

describe('formulas in the query of a team template', () => {
  it('makes a formula a column of the query, and drafts the procedure around it', async () => {
    const { convertToRdl } = await import('../src/ssrs/rdl.ts');
    const { applyConventions, readConventions } = await import('../src/ssrs/conventions.ts');
    const definition = {
      saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [],
      formulas: [
        { name: 'Label', index: 1, kind: 'formula', text: 'if IsNull({Orders.Region}) then "none" else {Orders.Region} + "!"', referencedFields: ['Orders.Region'] },
        { name: 'Counter', index: 2, kind: 'formula', text: 'NumberVar n := n + Length({Orders.Region})', referencedFields: ['Orders.Region'] },
      ],
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
        { kind: 'field', name: 'L', field: '@Label', position: { x: 0, y: 0 }, size: { width: 2880, height: 240 } },
        { kind: 'field', name: 'C', field: '@Counter', position: { x: 2880, y: 0 }, size: { width: 1440, height: 240 } },
      ] }] }],
    } as never;
    const source = { connections: [], links: [], tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Region', type: 'string' }] }] } as never;
    const { rdl, review } = convertToRdl(definition, source, { reportName: 'Q', formulasInQuery: true });
    assert.match(rdl, /-- \{@Label\}: if IsNull\(\{Orders\.Region\}\) then "none" else \{Orders\.Region\} \+ "!"\n\s*CASE WHEN \[Orders\]\.\[Region\] IS NULL THEN N'none' ELSE \(\[Orders\]\.\[Region\] \+ N'!'\) END AS \[F_Label\]/);
    assert.match(rdl, /<Field Name="F_Label">\s*<rd:TypeName>System.String<\/rd:TypeName>\s*<DataField>F_Label<\/DataField>/);
    assert.ok(review.some((n) => n.item === 'Formulas' && n.message.includes('{@Counter}')), 'what stays in the report is listed');
    const plain = convertToRdl(definition, source, { reportName: 'Q' }).rdl;
    assert.match(plain, /<Field Name="F_Label">\s*<Value>/, 'without the option, a field worked out in the report');
    const conv = readConventions(JSON.stringify({ parameters: [{ name: 'as_of', match: 'as.?of', dataType: 'DateTime' }] }));
    const out = applyConventions(rdl, 'Q', conv, undefined, { sqlFunctions: ['CREATE FUNCTION dbo.[Q_Counter] (@f1 nvarchar(max))\nRETURNS nvarchar(max)\nAS\nBEGIN\n  RETURN @f1;\nEND'] });
    const draft = out.files?.['.sql'] ?? '';
    assert.match(draft, /CREATE FUNCTION dbo\.\[Q_Counter\][\s\S]*\nGO\n[\s\S]*CREATE PROCEDURE dbo\.\w+\n    @as_of datetime\nAS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT/);
    assert.match(draft, /AS \[F_Label\][\s\S]*;\nEND\nGO\n$/);
    // The template's dataset calls the procedure, with the standard parameters, as the team's templates do.
    // A second dataset of its own (a subreport placed in the report) gets a procedure of its own too.
    const two = rdl.replace(/(<DataSet Name="[^"]*">[\s\S]*?<\/DataSet>)/, (d) => d + d.replace(/<DataSet Name="[^"]*">/, '<DataSet Name="Second">'))
      .replace(/<Value>=Fields!F_Label\.Value<\/Value>/, '<Value>=Fields!F_Label.Value &amp; First(Fields!F_Label.Value, "Second")</Value>');
    const both = applyConventions(two, 'Q', conv);
    assert.equal(both.files?.['.sql']?.match(/CREATE PROCEDURE/g)?.length, 2);
    assert.match(both.rdl, /<CommandType>StoredProcedure<\/CommandType>\s*<CommandText>dbo\.Second<\/CommandText>/);
    // On request, a copy to preview that runs the query itself.
    const preview = applyConventions(rdl, 'Q', conv, undefined, { preview: true }).files?.['.preview.rdl'] ?? '';
    assert.match(preview, /<CommandText>SELECT[\s\S]*AS \[F_Label\]/);
    assert.ok(!preview.includes('<CommandType>StoredProcedure</CommandType>\n          <CommandText>dbo.'));
    assert.equal(out.files?.['.preview.rdl'], undefined, 'only when asked');
    assert.match(out.rdl, /<QueryParameter Name="@as_of">\s*<Value>=Parameters!as_of.Value<\/Value>\s*<\/QueryParameter>\s*<\/QueryParameters>\s*<CommandType>StoredProcedure<\/CommandType>\s*<CommandText>dbo\.\w+<\/CommandText>/);
  });
});

describe('a team template without custom code', () => {
  const source = { connections: [], links: [], tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Amount', type: 'currency' }] }] } as never;
  const base = { saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [] };
  const field = (name: string, ref: string, x = 0) => ({ kind: 'field', name, field: ref, position: { x, y: 0 }, size: { width: 1440, height: 240 } });
  const convert = async (definition: unknown, formulasInQuery = true) => (await import('../src/ssrs/rdl.ts')).convertToRdl(definition as never, source, { reportName: 'P', formulasInQuery });

  it('counts records within their group in the query, in the report\'s order', async () => {
    const definition = { ...base,
      formulas: [
        { name: 'Group #1 Order', kind: 'internal', text: '', referencedFields: ['Orders.Name'] },
        { name: 'Reset', index: 1, kind: 'formula', text: 'WhilePrintingRecords; NumberVar n := 0', referencedFields: [] },
        { name: 'Line', index: 2, kind: 'formula', text: 'WhilePrintingRecords; NumberVar n := n + 1', referencedFields: [] },
      ],
      layout: [
        { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [field('R', '@Reset')] }] },
        { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [field('L', '@Line'), field('A', 'Orders.Amount', 1440)] }] },
      ] };
    const sorted = (await convert({ ...definition, sorts: [{ field: 'Orders.Amount', descending: true }] })).rdl;
    assert.match(sorted, /SUM\(1\) OVER \(PARTITION BY \[Orders\]\.\[Name\] ORDER BY \[Orders\]\.\[Amount\] DESC ROWS UNBOUNDED PRECEDING\) AS \[F_Line\]/);
    assert.ok(!sorted.includes('<Code>'));
    // Records in no order of the report's own: the count stays in the report.
    assert.ok(!(await convert(definition)).rdl.includes('AS [F_Line]'));
  });

  it('scales a chart\'s axis and colours its bars in the query', async () => {
    const definition = { ...base, formulas: [], layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 3000, objects: [
      { kind: 'chart', name: 'Bars', position: { x: 0, y: 0 }, size: { width: 4000, height: 2800 }, chart: { family: 0, graphType: 0, values: ['Sum of Orders.Amount'], onChangeOf: 'Orders.Name' } }] }] }] };
    const { rdl, sqlFunctions } = await convert(definition);
    assert.ok(!rdl.includes('<Code>'), 'no custom code');
    assert.match(rdl, /dbo\.\[P_ChartScale\]\(CAST\(ISNULL\(MIN\(\[Orders\]\.\[Amount\]\) OVER \(\), 0\) AS float\), CAST\(ISNULL\(MAX\(\[Orders\]\.\[Amount\]\) OVER \(\), 0\) AS float\), 0\) AS \[Bars_AxisFrom\]/);
    assert.match(rdl, /DENSE_RANK\(\) OVER \(ORDER BY \[Orders\]\.\[Name\]\) AS \[Bars_Point\]/);
    assert.match(rdl, /<Color>=Choose\(\(Fields!Bars_Point\.Value - 1\) Mod 10 \+ 1, "#/);
    assert.match(rdl, /<Value>=Min\(Fields!Bars_Point\.Value\)<\/Value>/, 'the bars in the order their colours follow');
    assert.match(rdl, /First\(Fields!Bars_AxisFrom\.Value\)/);
    assert.match(sqlFunctions?.join('\n') ?? '', /CREATE FUNCTION dbo\.\[P_ChartScale\]\(@lo float, @hi float, @part int\)/);
    // Outside a template: Crystal's scale and colours by custom code, as before.
    const plain = (await convert(definition, false)).rdl;
    assert.ok(plain.includes('Code.CrAxis(') && plain.includes('Code.CrPointColor('));
  });

  it('writes a custom function of one value in place', async () => {
    const definition = { ...base,
      formulas: [
        { name: 'Shade', index: 1, kind: 'formula', text: 'Function (NumberVar row, Optional NumberVar c := RGB(239,235,220))\nIf Remainder(row,2)=0 Then\n    c\nElse\n    crNoColor', referencedFields: [] },
        { name: 'Section_Back_Color', index: 2, kind: 'conditionalFormat', text: 'Shade(RecordNumber)', referencedFields: [] },
      ],
      layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 240, conditions: { backColor: { name: 'Section_Back_Color', index: 2 } }, objects: [field('A', 'Orders.Amount')] }] }] };
    const { rdl } = await convert(definition);
    assert.ok(!rdl.includes('<Code>'), 'no custom code');
    assert.match(rdl, /=IIf\(\(\(RowNumber\(Nothing\) Mod 2\) = 0\), "#efebdc", "Transparent"\)/);
    assert.match((await convert(definition, false)).rdl, /Code\.F_Shade\(RowNumber\(Nothing\)\)/);
  });
});
