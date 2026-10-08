import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataSourceInfo, ReportDefinition, ReportObject } from '../src/crystal/model.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyHouseStyle, firstRowOf, readHouseStyle, styleFromTemplate } from '../src/ssrs/brand.ts';
import { convertToRdl } from '../src/ssrs/rdl.ts';

const source: DataSourceInfo = {
  connections: [],
  links: [],
  tables: [{ alias: 'Orders', name: 'Orders', kind: 'table', fields: [{ name: 'Name', type: 'string' }, { name: 'Amount', type: 'currency' }] }],
};

const emptyDefinition = (): ReportDefinition => ({
  saveInfo: {}, selectionFormulas: {}, sqlExpressions: [], parameters: [], groups: [], sortFields: [], summarizedFields: [], formulas: [], layout: [],
} as unknown as ReportDefinition);

const text = (name: string, value: string, x: number, size = 8, extra: Partial<ReportObject> = {}): ReportObject =>
  ({ kind: 'text', name, text: value, style: { size }, position: { x, y: 0 }, size: { width: 3000, height: 240 }, ...extra });

/** A report with a title over a table, its column headings, a row of data, a black rule and a red figure. */
function report(): string {
  const definition: ReportDefinition = { ...emptyDefinition(), layout: [
    { name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 400, objects: [
      text('Title', 'Sales Summary', 0, 12, { align: 'center', size: { width: 6000, height: 300 } }),
      { kind: 'line', name: 'Rule', position: { x: 0, y: 360 }, size: { width: 6000, height: 0 }, border: { sides: [0, 0, 1, 0], width: 20 } }] }] },
    { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [text('NameHeading', 'Name', 0), text('AmountHeading', 'Amount', 3000)] }] },
    { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
      { kind: 'field', name: 'NameValue', field: 'Orders.Name', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } },
      { kind: 'field', name: 'AmountValue', field: 'Orders.Amount', style: { size: 8, color: '#FF0000' }, position: { x: 3000, y: 0 }, size: { width: 3000, height: 240 } }] }] }] };
  return convertToRdl(definition, source, { reportName: 'Styled' }).rdl;
}

/** An element's XML by its Name attribute (up to its own closing tag). */
function item(rdl: string, kind: string, name: string): string {
  const start = rdl.indexOf(`<${kind} Name="${name}">`);
  assert.ok(start >= 0, `${kind} ${name} is in the report`);
  return rdl.slice(start, rdl.indexOf(`</${kind}>`, start));
}

describe('house style', () => {
  const style = readHouseStyle(JSON.stringify({
    font: 'Segoe UI', textColor: '#222222', border: '#5B6770',
    title: { fill: '#1F4E79', color: '#FFFFFF', bold: true },
    heading: { fill: '#DDE6F0', color: '#1F4E79', bold: true },
    chart: { palette: ['#1F4E79', '#F2A541'], plotBackground: '#FFFFFF' },
  }));

  it('keeps the layout and lays the house fonts, bands and colours over it', () => {
    const plain = report();
    const styled = applyHouseStyle(plain, style);
    // The same items at the same places.
    const places = (rdl: string) => [...rdl.matchAll(/<(Textbox|Line|Tablix) Name="([^"]*)">[\s\S]*?<Top>([^<]*)<\/Top>\s*<Left>([^<]*)<\/Left>/g)].map((m) => m.slice(1).join(' '));
    assert.deepEqual(places(styled), places(plain));
    assert.ok(!/<FontFamily>(?!Segoe UI<)/.test(styled), 'every font is the house font');
    // The title outside the table: a band in the title colours.
    const title = item(styled, 'Textbox', 'Title');
    assert.match(title, /<BackgroundColor>#1F4E79<\/BackgroundColor>/);
    assert.match(title, /<Color>#FFFFFF<\/Color>/);
    // The column headings: a band in the heading colours; the row of data is not one.
    for (const name of ['NameHeading', 'AmountHeading']) {
      assert.match(item(styled, 'Textbox', name), /<BackgroundColor>#DDE6F0<\/BackgroundColor>/);
      assert.match(item(styled, 'Textbox', name), /<Color>#1F4E79<\/Color>/);
      assert.match(item(styled, 'Textbox', name), /<FontWeight>Bold<\/FontWeight>/);
    }
    assert.ok(!item(styled, 'Textbox', 'NameValue').includes('#DDE6F0'));
    // Plain text in the house text colour; a figure Crystal colours keeps its colour.
    assert.match(item(styled, 'Textbox', 'NameValue'), /<Color>#222222<\/Color>/);
    assert.match(item(styled, 'Textbox', 'AmountValue'), /<Color>#FF0000<\/Color>/);
    // A black rule in the house border colour.
    assert.match(item(styled, 'Line', 'Rule'), /<Color>#5B6770<\/Color>/);
  });

  it('fits text set in a wider house font where Crystal put it, and never makes it larger', () => {
    // Narrow headings in Times New Roman, the house font wider and semi-bold.
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [
        { ...text('Narrow', 'Threshold', 0, 8), font: 'Times New Roman', size: { width: 700, height: 240 } },
        { ...text('Roomy', 'Min', 700, 8), font: 'Times New Roman', size: { width: 3000, height: 240 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
        { kind: 'field', name: 'AmountValue', field: 'Orders.Amount', font: 'Times New Roman', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 700, height: 240 } },
        { kind: 'field', name: 'NameValue', field: 'Orders.Name', font: 'Times New Roman', style: { size: 8 }, position: { x: 700, y: 0 }, size: { width: 3000, height: 240 } }] }] }] };
    const styled = applyHouseStyle(convertToRdl(definition, source, { reportName: 'F' }).rdl, readHouseStyle(JSON.stringify({ font: 'Verdana', heading: { weight: 'SemiBold' } })));
    const size = (name: string) => Number(/<FontSize>([\d.]+)pt<\/FontSize>/.exec(item(styled, 'Textbox', name))![1]);
    assert.ok(size('Narrow') < 8, 'a heading that would no longer fit is made smaller');
    assert.equal(size('Roomy'), 8, 'one with room to spare keeps its size');
    assert.ok(size('NameValue') < 8 && size('NameValue') > 5, 'a field keeps the width Crystal gave it');
    assert.match(item(styled, 'Textbox', 'Narrow'), /<FontWeight>SemiBold<\/FontWeight>/);
  });

  it('keeps wrapped headings to their lines and long titles on one line', () => {
    const bold = { size: 8, bold: true };
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 480, objects: [
        { ...text('TwoLines', 'Min/Max Threshold', 0, 8), style: bold, font: 'Times New Roman', size: { width: 760, height: 480 } },
        { ...text('OneLine', 'Monthly Shipment Summary', 900, 8), style: bold, font: 'Times New Roman', size: { width: 2200, height: 240 } },
        { ...text('Short', 'Name', 3100, 8), style: bold, font: 'Times New Roman', size: { width: 2200, height: 240 } }] }] }] };
    const styled = applyHouseStyle(convertToRdl(definition, source, { reportName: 'W' }).rdl, readHouseStyle(JSON.stringify({ font: 'Tahoma', heading: { weight: 'SemiBold' } })));
    const size = (name: string) => Number(/<FontSize>([\d.]+)pt<\/FontSize>/.exec(item(styled, 'Textbox', name))?.[1] ?? 10);
    assert.ok(size('TwoLines') < 7.5, 'the longest word still fits its line');
    assert.ok(size('OneLine') < 8, 'a title that filled its line is made smaller to stay on it');
    assert.equal(size('Short'), 8, 'a short heading keeps its size');
  });

  it('keeps two lines of a heading inside its box in a taller font, off the rows under its band, as wide as the rule', () => {
    const bold = { size: 8, bold: true };
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 900, objects: [
        { kind: 'line', name: 'Rule', position: { x: 0, y: 100 }, size: { width: 6400, height: 0 }, border: { sides: [0, 0, 1, 0], width: 20 } },
        { ...text('Wide', 'Name', 0, 8), style: bold, font: 'Times New Roman', position: { x: 0, y: 400 }, size: { width: 4000, height: 500 } },
        { ...text('TwoLines', 'Monthly Shipment Summary', 4000, 8), style: bold, font: 'Times New Roman', position: { x: 4000, y: 400 }, size: { width: 1400, height: 380 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
        { kind: 'field', name: 'NameValue', field: 'Orders.Name', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 4000, height: 240 } },
        { kind: 'field', name: 'AmountValue', field: 'Orders.Amount', style: { size: 8 }, position: { x: 4000, y: 0 }, size: { width: 1400, height: 240 } }] }] }] };
    const plain = convertToRdl(definition, source, { reportName: 'H' }).rdl;
    const styled = applyHouseStyle(plain, readHouseStyle(JSON.stringify({ font: 'Tahoma', heading: { fill: '#203040', weight: 'SemiBold' } })));
    const heading = item(styled, 'Textbox', 'TwoLines');
    const size = Number(/<FontSize>([\d.]+)pt<\/FontSize>/.exec(heading)![1]);
    const row = Number(/<TablixRow>\s*<Height>([\d.]+)in/.exec(styled)![1]) * 72;
    assert.ok(size < 8 && 2 * size * 1.21 <= row, 'two lines of the heading fit the row');
    assert.match(item(styled, 'Textbox', 'Wide'), /<BottomBorder>\s*<Color>White<\/Color>\s*<Style>Solid<\/Style>/, 'a white strip keeps the band off the rows under it');
    const width = (rdl: string) => Number(/<Tablix Name="[^"]+">[\s\S]*?<\/TablixBody>[\s\S]*?<Width>([\d.]+)in/.exec(rdl)![1]);
    assert.ok(width(plain) < 6400 / 1440 - 0.1 && Math.abs(width(styled) - 6400 / 1440) < 0.01, 'the table reaches the end of the rule');
  });

  it('styles group headings, totals, alternate rows, red figures, links and chart titles', () => {
    const definition: ReportDefinition = { ...emptyDefinition(), groups: ['Orders.Name'], layout: [
      { name: 'PageHeaderArea1', sections: [{ name: 'PH', height: 240, objects: [text('Heading', 'Amount', 0)] }] },
      { name: 'GroupHeaderArea1', sections: [{ name: 'GH', height: 240, objects: [
        { kind: 'field', name: 'GroupName', field: 'Orders.Name', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
      { name: 'DetailArea1', sections: [{ name: 'D', height: 240, objects: [
        { kind: 'field', name: 'Value', field: 'Orders.Amount', style: { size: 8, color: '#FF0000' }, position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] },
      { name: 'GroupFooterArea1', sections: [{ name: 'GF', height: 240, objects: [
        { kind: 'field', name: 'GroupTotal', field: 'Sum of Orders.Amount', style: { size: 8 }, position: { x: 0, y: 0 }, size: { width: 3000, height: 240 } }] }] }] };
    const styled = applyHouseStyle(convertToRdl(definition, source, { reportName: 'G' }).rdl, readHouseStyle(JSON.stringify({
      groupHeading: { color: '#1F4E79', weight: 'SemiBold' }, total: { fill: '#F2F2F2' }, rowBands: { odd: '#FFFFFF', even: '#EEEEEE' }, red: '#C00000',
    })));
    assert.match(item(styled, 'Textbox', 'GroupName'), /<Color>#1F4E79<\/Color>/);
    assert.match(item(styled, 'Textbox', 'GroupTotal'), /<BackgroundColor>#F2F2F2<\/BackgroundColor>/);
    assert.match(item(styled, 'Textbox', 'Value'), /<BackgroundColor>=IIf\(RowNumber\(Nothing\) Mod 2 = 1, "#FFFFFF", "#EEEEEE"\)<\/BackgroundColor>/);
    assert.match(item(styled, 'Textbox', 'Value'), /<Color>#C00000<\/Color>/);
    assert.ok(!item(styled, 'Textbox', 'Heading').includes('RowNumber'), 'headings are not banded');
    // Red set by a formula takes the house red too; a chart's title and a link their own colours.
    const formula = '<Textbox Name="X"><Paragraphs><Paragraph><TextRuns><TextRun><Value>=Fields!A.Value</Value><Style><Color>=IIf(Fields!A.Value &lt; 0, "Red", "Black")</Color></Style></TextRun></TextRuns></Paragraph></Paragraphs></Textbox>';
    assert.match(applyHouseStyle(`<Report><Body><ReportItems>${formula}</ReportItems></Body></Report>`, { red: '#C00000' }), /"#C00000", "Black"/);
  });

  it('colours charts from the house palette', () => {
    const definition: ReportDefinition = { ...emptyDefinition(), layout: [{ name: 'ReportHeaderArea1', sections: [{ name: 'RH', height: 3000, objects: [
      { kind: 'chart', name: 'Bars', position: { x: 0, y: 0 }, size: { width: 4000, height: 2800 }, chart: { family: 0, graphType: 0, values: ['Sum of Orders.Amount'], onChangeOf: 'Orders.Name' } }] }] }] };
    const styled = applyHouseStyle(convertToRdl(definition, source, { reportName: 'C' }).rdl, style);
    assert.match(styled, /<ChartCustomPaletteColors>\s*<ChartCustomPaletteColor>#1F4E79<\/ChartCustomPaletteColor>\s*<ChartCustomPaletteColor>#F2A541<\/ChartCustomPaletteColor>\s*<\/ChartCustomPaletteColors>/);
    // Bars coloured one by one take the house palette too.
    assert.match(styled, /Dim palette\(\) As String = \{"#1F4E79", "#F2A541"\}/);
    assert.ok(!styled.includes('#D9D9D9'), 'the plot has the house background');
  });

  it('leaves out what the style does not set', () => {
    const plain = report();
    assert.equal(applyHouseStyle(plain, readHouseStyle('{}')), applyHouseStyle(plain, {}));
    const fontOnly = applyHouseStyle(plain, readHouseStyle('{ "font": "Segoe UI" }'));
    assert.ok(!fontOnly.includes('#DDE6F0') && !fontOnly.includes('#5B6770'));
  });

  it('explains a style file it cannot use', () => {
    assert.throws(() => readHouseStyle('{ "colour": "#000000" }'), /unknown entry "colour"/);
    assert.throws(() => readHouseStyle('{ "border": "not a colour" }'), /"border" must be a colour/);
    assert.throws(() => readHouseStyle('{ "title": { "fill": "#000000", "size": 12 } }'), /"title" has unknown entry "size"/);
    assert.throws(() => readHouseStyle('{ "chart": { "palette": [] } }'), /"chart.palette" must be a list of colours/);
    assert.throws(() => readHouseStyle('not json'), /not valid JSON/);
  });

  describe('from a template', () => {
    const template = readFileSync(join(import.meta.dirname, 'fixtures', 'house-template.rdl'), 'utf8');

    it('lists the theme fields a template reads at run time, with the query to run', () => {
      const { style, notes } = styleFromTemplate(template);
      assert.deepEqual(style, {});
      const theme = notes.find((n) => n.includes('dataset "Theme"'))!;
      assert.match(theme, /column heading fill: field ColumnHead_background/);
      assert.match(theme, /title text colour: field Caption_color/);
      assert.match(theme, /run its query/);
    });

    it('fills them in from the theme values, as a style --house reads', () => {
      const values = firstRowOf('Caption_background;Caption_color;Caption_font_weight;ColumnHead_background;ColumnHead_color;ColumnHead_font_weight;Cell_color;Cell_font_family\r\n'
        + '#1F4E79;#FFFFFF;Bold;#DDE6F0;"#1F4E79";Normal;#222222;Segoe UI\r\n');
      const { style } = styleFromTemplate(template, values);
      assert.deepEqual(style, {
        font: 'Segoe UI', textColor: '#222222',
        title: { fill: '#1F4E79', color: '#FFFFFF', weight: 'Bold' },
        heading: { fill: '#DDE6F0', color: '#1F4E79', weight: 'Normal' },
      });
      assert.deepEqual(JSON.parse(JSON.stringify(readHouseStyle(JSON.stringify(style)))), style);
    });

    it('takes chart colours from the theme values where the template has no chart, and skips NULLs', () => {
      const { style } = styleFromTemplate(template, {
        ColumnHead_background: 'NULL', ColumnHead_color: '#1F4E79',
        Chart_background: '#EEEEEE', Chart_Palette_First_background: '#1F4E79', Chart_Palette_Second_background: 'NULL', Chart_Palette_Third_background: '#F2A541',
      });
      assert.deepEqual(style.heading, { color: '#1F4E79' });
      assert.deepEqual(style.chart, { palette: ['#1F4E79', '#F2A541'], plotBackground: '#EEEEEE' });
    });

    it('finds the theme\'s other classes by the words in their names', () => {
      const { style } = styleFromTemplate(template, {
        Group_Header_background: '#EEEEEE', Group_Header_font_weight: 'SemiBold', Grand_Total_color: '#1F4E79', Grand_Total_font_weight: 'Bold',
        Row_Odd_background: '#FFFFFF', Row_Even_background: '#F2F2F2', Alert_Red_color: '#C00000', Link_color: '#2F5597',
        Chart_color: '#333333', Chart_Title_background: '#1F4E79', Chart_Title_color: '#FFFFFF',
      });
      assert.deepEqual(style.groupHeading, { fill: '#EEEEEE', weight: 'SemiBold' });
      assert.deepEqual(style.total, { color: '#1F4E79', weight: 'Bold' });
      assert.deepEqual(style.rowBands, { odd: '#FFFFFF', even: '#F2F2F2' });
      assert.equal(style.red, '#C00000');
      assert.equal(style.link, '#2F5597');
      assert.deepEqual(style.chart, { textColor: '#333333', title: { fill: '#1F4E79', color: '#FFFFFF' } });
    });

    it('reads a CSV export\'s first row', () => {
      assert.deepEqual(firstRowOf('﻿a,b\n"x, y",""""\nignored,row\n'), { a: 'x, y', b: '"' });
      assert.throws(() => firstRowOf('only,a,header\n'), /a header row and a row of values/);
    });
  });
});
