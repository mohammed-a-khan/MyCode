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
    assert.match(refused('count({T.Qty})'), /summary/);
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
    assert.match(out.rdl, /<CommandText>SELECT[\s\S]*AS \[F_Label\]/);
    assert.ok(!out.rdl.includes('<CommandType>StoredProcedure</CommandType>'), 'the template runs its query itself');
    assert.equal(out.files?.['.preview.rdl'], undefined);
    const two = rdl.replace(/(<DataSet Name="[^"]*">[\s\S]*?<\/DataSet>)/, (d) => d + d.replace(/<DataSet Name="[^"]*">/, '<DataSet Name="Second">'))
      .replace(/<Value>=Fields!F_Label\.Value<\/Value>/, '<Value>=Fields!F_Label.Value &amp; First(Fields!F_Label.Value, "Second")</Value>');
    assert.equal(applyConventions(two, 'Q', conv).files?.['.sql']?.match(/CREATE PROCEDURE/g)?.length, 2);
    const fn = 'CREATE FUNCTION dbo.[Q_label](@s nvarchar(max))\nRETURNS nvarchar(max)\nAS\nBEGIN\n  RETURN @s\nEND';
    const called = rdl.replace(/AS \[F_Label\]/, 'AS [F_Label], dbo.[Q_label](N\'x\') AS [F_Other]');
    const own = applyConventions(called, 'Q', conv, undefined, { sqlFunctions: [fn] }).rdl;
    assert.match(own, /<CommandText>IF OBJECT_ID\(N'dbo\.\[Q_label\]'\) IS NULL BEGIN TRY EXEC \(N'CREATE FUNCTION dbo\.\[Q_label\][\s\S]*?END TRY BEGIN CATCH END CATCH;\s*EXEC \(N'ALTER FUNCTION dbo\.\[Q_label\][\s\S]*?'\);\s*SELECT/);
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
    assert.match(rdl, /=IIf\(\(\(RowNumber\(Nothing\) Mod 2\) = 0\), "#efebdc", Nothing\)/);
    assert.match((await convert(definition, false)).rdl, /Code\.F_Shade\(RowNumber\(Nothing\)\)/);
  });
});

describe('a team template over a stored procedure', () => {
  const A = 'Orders_get;1';
  const source = { connections: [], links: [], tables: [{ alias: A, name: A, schema: 'dbo', kind: 'storedProcedure', fields: [
    { name: 'Name', type: 'string', length: 50 }, { name: 'Amount', type: 'currency' }, { name: 'Shipped', type: 'dateTime' }] }] } as never;
  const definition = (record?: string, formulas = true) => ({
    saveInfo: {}, selectionFormulas: record ? { record } : {}, sqlExpressions: [], groups: [], sortFields: [], summarizedFields: [],
    parameters: [{ name: '@region', valueType: 'string', prompt: 'Region' }],
    formulas: formulas ? [{ name: 'Size', index: 1, kind: 'formula', text: `if {${A}.Amount} > 100 then "big" else "small"`, referencedFields: [] }] : [],
    layout: [{ name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
      { kind: 'field', name: 'N', field: `${A}.Name`, position: { x: 0, y: 0 }, size: { width: 1440, height: 240 } },
      ...(formulas ? [{ kind: 'field', name: 'S', field: '@Size', position: { x: 1440, y: 0 }, size: { width: 1440, height: 240 } }] : [])] }] }],
  } as never);
  const convert = async (d: never, formulasInQuery = true) => (await import('../src/ssrs/rdl.ts')).convertToRdl(d, source, { reportName: 'Sp', formulasInQuery });

  it('calls the procedure as it is, its formulas calculated fields and its selection a filter, without custom code', async () => {
    const { rdl } = await convert(definition(`{${A}.Name} <> "Skip"`));
    assert.match(rdl, /<CommandType>StoredProcedure<\/CommandType>\s*<CommandText>\[dbo\]\.\[Orders_get\]<\/CommandText>/);
    assert.match(rdl, /<QueryParameter Name="@region">/);
    assert.match(rdl, /<Field Name="F_Size">\s*<Value>=IIf\(\(Fields!Amount\.Value &gt; 100\), "big", "small"\)<\/Value>/);
    assert.match(rdl, /<FilterExpression>=\(RTrim\(Fields!Name\.Value\) &lt;&gt; "Skip"\)<\/FilterExpression>/);
    assert.ok(!rdl.includes('#rows') && !rdl.includes('<Code>'));
  });
});

describe('a team template whose values come from a subreport', () => {
  const empty = { saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [] };
  const lines = 'Function (StringVar s)\nLocal NumberVar m := Count(Split(s, "<CR>"));\nLocal NumberVar i := 1;\nLocal StringVar j;\nLocal StringVar k;\n'
    + 'While i <= m Do\n(\n  j := Split(s, "<CR>")[i];\n  i := i + 1;\n  k := k + j + chr(10)\n);\nk';
  const header = { ...empty,
    formulas: [{ name: 'NoteSet', index: 0, kind: 'formula', text: 'WhilePrintingRecords; shared StringVar note := {Head_get;1.Note};', referencedFields: [] }],
    layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 300, objects: [
      { kind: 'field', name: 'n1', field: '@NoteSet', position: { x: 0, y: 0 }, size: { width: 2000, height: 230 } }] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 220, objects: [] }] }] };
  const main = { ...empty,
    formulas: [
      { name: 'NoteRead', index: 2, kind: 'formula', text: 'WhilePrintingRecords; shared StringVar note; note', referencedFields: [] },
      { name: 'Lines', index: 3, kind: 'formula', text: lines, referencedFields: [] },
      { name: 'Footer', index: 4, kind: 'formula', text: 'if InStr({@NoteRead}, "<CR>") > 0 then Lines({@NoteRead}) else {@NoteRead}', referencedFields: [] }],
    layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 308, objects: [{ kind: 'subreport', name: 'Subreport1', subreport: { index: 1, onDemand: false }, position: { x: 0, y: 0 }, size: { width: 9000, height: 308 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [{ kind: 'field', name: 'name1', field: 'T.Name', position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
      { name: 'ReportFooterArea1', sections: [{ name: 'RF', height: 400, objects: [{ kind: 'field', name: 'foot', field: '@Footer', position: { x: 0, y: 0 }, size: { width: 9000, height: 300 } }] }] }] };
  const source = { connections: [], links: [], tables: [{ alias: 'T', name: 'T', kind: 'table', schema: 'dbo', fields: [{ name: 'Name', type: 'string' }] }] };
  const headSource = { connections: [], links: [], tables: [{ alias: 'Head_get;1', name: 'Head_get;1', kind: 'storedProcedure', schema: 'dbo', fields: [{ name: 'Note', type: 'string' }] }] };

  it('reads a shared value from the procedure as it is and joins the footnote\'s lines in an expression, without custom code', async () => {
    const { convertToRdl } = await import('../src/ssrs/rdl.ts');
    const r = convertToRdl(main as never, source as never, { reportName: 'Main', formulasInQuery: true, rulesAsText: true,
      subreports: new Map([[1, { name: 'Sub1', links: [], definition: header, dataSource: headSource }]]) as never });
    assert.ok(!r.rdl.includes('<Code>') && !/Code\.\w+/.test(r.rdl), 'no custom code');
    assert.match(r.rdl, /<CommandType>StoredProcedure<\/CommandType>\s*<CommandText>\[dbo\]\.\[Head_get\]<\/CommandText>/);
    assert.ok(!r.rdl.includes('#rows') && !r.rdl.includes('<ReportParameter '), 'no table of its rows, no hidden parameter');
    const note = 'First(Fields!Note.Value, "DataSet_Sub1")';
    assert.ok(r.rdl.includes(`Join(Split(CStr(((${note}))), CStr("&lt;CR&gt;"), -1, CompareMethod.Binary), CStr(Chr(10))) &amp; CStr(Chr(10))`), r.rdl.match(/<Value>=\(IIf[^<]*/)?.[0]);
  });

  it('writes a parameter the base report lacks as a fixed value where it is read, so the merged report keeps working', async () => {
    const { convertToRdl } = await import('../src/ssrs/rdl.ts');
    const { applyConventions, readConventions } = await import('../src/ssrs/conventions.ts');
    const withPart = { ...header, parameters: [{ name: '@part_no', valueType: 'number', prompt: 'part' }] };
    const r = convertToRdl(main as never, source as never, { reportName: 'Main', formulasInQuery: true, rulesAsText: true,
      subreports: new Map([[1, { name: 'Sub1', links: [], definition: withPart, dataSource: headSource }]]) as never });
    assert.match(r.rdl, /<ReportParameter Name="part_no">/);
    const conv = readConventions(JSON.stringify({ parameters: [{ name: 'fund', match: 'fund' }] }));
    const given = applyConventions(r.rdl, 'Main', conv, undefined, { parameterValues: { part_no: '42' } });
    assert.match(given.rdl, /<QueryParameter Name="@part_no">\s*<Value>=42<\/Value>/);
    assert.ok(!given.rdl.includes('<ReportParameter Name="part_no">') && !given.rdl.includes('Parameters!part_no'));
    assert.ok(given.review.some((n) => n.item === 'Parameter part_no' && /42 is written/.test(n.message)));
    const open = applyConventions(r.rdl, 'Main', conv);
    assert.match(open.rdl, /<QueryParameter Name="@part_no">\s*<Value>=Nothing<\/Value>/);
  });

  it('reads a shared value in a condition as the subreport\'s field, without custom code', async () => {
    const { convertToRdl } = await import('../src/ssrs/rdl.ts');
    const condition = { name: 'Object_Visibility', index: 9, kind: 'conditionalFormat', text: 'WhilePrintingRecords; shared StringVar note; if note = "Cont" then true', referencedFields: [] };
    const hiding = { ...main, formulas: [...main.formulas, condition],
      layout: main.layout.map((a) => (a.name !== 'DetailArea1' ? a : { ...a, sections: a.sections.map((sec) => ({ ...sec, objects: sec.objects.map((o) => ({ ...o, conditions: { suppress: { name: 'Object_Visibility', index: 9 } } })) })) })) };
    const r = convertToRdl(hiding as never, source as never, { reportName: 'Main', formulasInQuery: true, rulesAsText: true,
      subreports: new Map([[1, { name: 'Sub1', links: [], definition: header, dataSource: headSource }]]) as never });
    assert.ok(!r.rdl.includes('<Code>') && !/Code\.\w+/.test(r.rdl), 'no custom code');
    assert.match(r.rdl, /<Hidden>=[^<]*First\(Fields!Note\.Value, "DataSet_Sub1"\)[^<]*= "Cont"/);
  });

  it('counts and takes the pieces of a split text in SQL', () => {
    const fn = (name: string) => `dbo.[${name}]`;
    const c = { ...ctx, addFunction: (key: string, body: (n: string) => string[]) => { body(fn(key)); return fn(key); } };
    const count = formulaToSql('Count(Split({T.Name}, ","))', c as never);
    assert.ok('sql' in count);
    assert.match(count.sql, /^CASE WHEN \[T\]\.\[Name\] IS NULL THEN NULL ELSE .*REPLACE\(\[T\]\.\[Name\] COLLATE Latin1_General_CS_AS, N',', N''\).* \+ 1 END$/);
    const part = formulaToSql('Split({T.Name}, ",")[2]', c as never);
    assert.ok('sql' in part);
    assert.match(part.sql, /\(\[T\]\.\[Name\], N',', 2\)/);
    const nocase = formulaToSql('Count(Split({T.Name}, "<CR>", -1, 1))', c as never);
    assert.ok('sql' in nocase && nocase.sql.includes('COLLATE Latin1_General_CI_AS'));
    const piece = formulaToSql('Split({T.Name}, "<CR>", -1, 1)[1]', c as never);
    assert.ok('sql' in piece && piece.sql.includes('helper:splitpartnocase'));
    const at = formulaToSql('InStr({T.Name}, "<CR>", 1)', c as never);
    assert.ok('sql' in at);
    assert.equal(at.sql, "CHARINDEX(N'<CR>' COLLATE Latin1_General_CI_AS, [T].[Name])");
    const ch = formulaToSql('{T.Name} + Chr(10)', c as never);
    assert.ok('sql' in ch && ch.sql.includes('NCHAR(10)'));
  });
});
