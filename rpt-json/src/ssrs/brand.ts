/**
 * A house style laid over a converted report: the Crystal layout (positions, sizes, page setup, logo) stays as it
 * is; fonts, colours and weights take the house's.
 *
 * The style is a small JSON file; every entry is optional and what it leaves out keeps the Crystal look:
 *
 *   {
 *     "font": "Segoe UI",                       every text, charts included
 *     "textColor": "#222222",                   text Crystal prints in black
 *     "border": "#5B6770",                      lines, boxes and borders Crystal draws in black
 *     "title":        { "fill": "#1F4E79", "color": "#FFFFFF", "weight": "SemiBold", "font": "Georgia" },
 *     "heading":      { "fill": "#DDE6F0", "color": "#1F4E79", "weight": "Bold" },
 *     "groupHeading": { "color": "#1F4E79", "weight": "SemiBold" },
 *     "total":        { "fill": "#F2F2F2", "weight": "SemiBold" },
 *     "rowBands":     { "odd": "#FFFFFF", "even": "#F2F2F2" },
 *     "red": "#C00000",                         text Crystal prints in red (a failed test, a negative figure)
 *     "link": "#2F5597",                        text with a hyperlink
 *     "chart": { "palette": ["#1F4E79", "#F2A541"], "plotBackground": "#FFFFFF", "font": "Segoe UI",
 *                "textColor": "#222222", "title": { "fill": "#1F4E79", "color": "#FFFFFF" } }
 *   }
 *
 * A band (title, heading, groupHeading, total, chart.title) has a fill, a text colour, a weight (Thin, Light,
 * Normal, Medium, SemiBold, Bold, ExtraBold, Heavy; or "bold": true / false) and a font of its own.
 *
 * Which text is what: a title is fixed text 2 points or more larger than the report's usual text; a table's column
 * headings are its rows above its first row of data, its group headings the rows a group opens with, its totals the
 * rows a group (or the table) closes with; a chart's title is text over the top of a chart. Text and borders Crystal
 * colours (other than red) keep their colour.
 *
 * Sizes stay as in Crystal; where the house font or weight is wider than Crystal's, text is made just small enough
 * to fit where Crystal put it (as it fitted there), so headings do not wrap where Crystal's did not.
 */

import { readHouseTemplate } from './house.ts';
import { child, childElements, descendants, el, parseXml, textOf, toXml, type XmlElement } from './xml.ts';

export interface BandStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
  weight?: string;
  font?: string;
}

export interface HouseStyle {
  font?: string;
  textColor?: string;
  border?: string;
  title?: BandStyle;
  heading?: BandStyle;
  groupHeading?: BandStyle;
  total?: BandStyle;
  rowBands?: { odd?: string; even?: string };
  red?: string;
  link?: string;
  chart?: { palette?: string[]; plotBackground?: string; font?: string; textColor?: string; title?: BandStyle };
}

const COLOR = /^(#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+)$/i;
const WEIGHTS = ['Thin', 'ExtraLight', 'Light', 'Normal', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Heavy'];

/** Reads and checks a house style file. */
export function readHouseStyle(json: string): HouseStyle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a JSON object');
  const object = (key: string, value: unknown, allowed: string[]): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`"${key}" must be an object with ${allowed.join(', ')}`);
    const o = value as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.length) throw new Error(`${key ? `"${key}" has u` : 'u'}nknown entr${extra.length > 1 ? 'ies' : 'y'} ${extra.map((k) => `"${k}"`).join(', ')} (expected ${allowed.join(', ')})`);
    return o;
  };
  const text = (key: string, value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty text`);
    return value.trim();
  };
  const color = (key: string, value: unknown) => {
    const v = text(key, value);
    if (v !== undefined && !COLOR.test(v)) throw new Error(`"${key}" must be a colour such as "#1F4E79" or "Navy" (got "${v}")`);
    return v;
  };
  const weight = (key: string, value: unknown) => {
    const v = text(key, value);
    if (v === undefined) return undefined;
    const w = WEIGHTS.find((x) => x.toLowerCase() === v.toLowerCase());
    if (!w) throw new Error(`"${key}" must be one of ${WEIGHTS.join(', ')} (got "${v}")`);
    return w;
  };
  const band = (key: string, value: unknown): BandStyle | undefined => {
    const b = object(key, value, ['fill', 'color', 'bold', 'weight', 'font']);
    if (!b) return undefined;
    if (b.bold !== undefined && typeof b.bold !== 'boolean') throw new Error(`"${key}.bold" must be true or false`);
    return { fill: color(`${key}.fill`, b.fill), color: color(`${key}.color`, b.color), bold: b.bold as boolean | undefined,
      weight: weight(`${key}.weight`, b.weight), font: text(`${key}.font`, b.font) };
  };
  const o = object('', raw, ['font', 'textColor', 'border', 'title', 'heading', 'groupHeading', 'total', 'rowBands', 'red', 'link', 'chart'])!;
  const bands = object('rowBands', o.rowBands, ['odd', 'even']);
  const c = object('chart', o.chart, ['palette', 'plotBackground', 'font', 'textColor', 'title']);
  if (c?.palette !== undefined && (!Array.isArray(c.palette) || !c.palette.length)) throw new Error('"chart.palette" must be a list of colours');
  return {
    font: text('font', o.font),
    textColor: color('textColor', o.textColor),
    border: color('border', o.border),
    title: band('title', o.title),
    heading: band('heading', o.heading),
    groupHeading: band('groupHeading', o.groupHeading),
    total: band('total', o.total),
    rowBands: bands ? { odd: color('rowBands.odd', bands.odd), even: color('rowBands.even', bands.even) } : undefined,
    red: color('red', o.red),
    link: color('link', o.link),
    chart: c ? {
      palette: (c.palette as unknown[] | undefined)?.map((p, i) => color(`chart.palette[${i}]`, p)!),
      plotBackground: color('chart.plotBackground', c.plotBackground),
      font: text('chart.font', c.font),
      textColor: color('chart.textColor', c.textColor),
      title: band('chart.title', c.title),
    } : undefined,
  };
}

const BORDERS = new Set(['Border', 'TopBorder', 'BottomBorder', 'LeftBorder', 'RightBorder']);
const isBlack = (value: string) => !value || /^(black|#000000|#000000ff)$/i.test(value.trim());
const isRed = (value: string) => /^(red|#ff0000|#ff0000ff)$/i.test(value.trim());

/** Sets (or adds) a child element's text. */
function setChild(parent: XmlElement, name: string, value: string, first = false): void {
  const existing = childElements(parent, name)[0];
  if (existing) existing.children = [value];
  else if (first) parent.children.unshift(el(name, value));
  else parent.children.push(el(name, value));
}

/** A textbox's text runs' styles (adding a style where a run has none). */
function runStyles(textbox: XmlElement): XmlElement[] {
  return descendants(textbox).filter((e) => e.name === 'TextRun').map((run) => {
    let style = child(run, 'Style');
    if (!style) {
      style = el('Style');
      run.children.push(style);
    }
    return style;
  });
}

/** An item's own style (a text box's: the one after its paragraphs, not a run's). */
function ownStyle(item: XmlElement): XmlElement {
  let style = childElements(item, 'Style')[0];
  if (!style) {
    style = el('Style');
    item.children.push(style);
  }
  return style;
}

const FIXED = /^=\s*"([^"]|"")*"(\s*&\s*vbCrLf\s*&\s*"([^"]|"")*")*\s*$/;

/** Fixed text: not an expression, or one giving a literal text. */
function isFixed(textbox: XmlElement): boolean {
  const values = descendants(textbox).filter((e) => e.name === 'Value').map(textOf);
  return values.length > 0 && values.some((v) => v.trim()) && values.every((v) => !v.startsWith('=') || FIXED.test(v));
}

/** The lines of a text box's fixed text. */
function fixedLines(textbox: XmlElement): string[] {
  return descendants(textbox).filter((e) => e.name === 'Paragraph').flatMap((p) => {
    const value = descendants(p).filter((e) => e.name === 'Value').map(textOf).join('');
    if (!value.startsWith('=')) return value.split(/\r?\n/);
    return value.split(/\s*&\s*vbCrLf\s*&\s*/).map((part) => part.replace(/^=?\s*"|"\s*$/g, '').replace(/""/g, '"'));
  });
}

const points = (size: string) => {
  const m = /^\s*([\d.]+)\s*pt\s*$/i.exec(size);
  return m ? Number(m[1]) : undefined;
};
const lengthInPoints = (value: string) => {
  const m = /^\s*([\d.]+)\s*(in|cm|mm|pt|pc)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return { in: n * 72, cm: (n / 2.54) * 72, mm: (n / 25.4) * 72, pt: n, pc: n * 12 }[(m[2] ?? 'in').toLowerCase() as 'in'];
};

/** The largest font size of a textbox's runs. */
function textSize(textbox: XmlElement): number | undefined {
  const sizes = descendants(textbox).filter((e) => e.name === 'TextRun').map((r) => points(textOf(child(r, 'Style/FontSize')))).filter((s): s is number => s !== undefined);
  return sizes.length ? Math.max(...sizes) : undefined;
}

/**
 * Average character widths, in ems, of mixed text in common fonts (unknown fonts count as Arial), and how much wider
 * a weight makes them: enough to tell whether text set in another font still fits.
 */
const FONT_WIDTHS: Record<string, number> = {
  'times new roman': 0.44, times: 0.44, garamond: 0.42, 'book antiqua': 0.46, cambria: 0.47, georgia: 0.51,
  arial: 0.5, helvetica: 0.5, 'arial narrow': 0.41, tahoma: 0.5, verdana: 0.58, 'segoe ui': 0.49, calibri: 0.45,
  'trebuchet ms': 0.49, 'century gothic': 0.55, 'microsoft sans serif': 0.5, 'ms sans serif': 0.5, 'courier new': 0.6,
};
const WEIGHT_WIDTHS: Record<string, number> = { thin: 0.95, extralight: 0.96, light: 0.97, normal: 1, medium: 1.02, semibold: 1.05, bold: 1.09, extrabold: 1.11, heavy: 1.12 };
const widthOf = (font: string, weight: string) => (FONT_WIDTHS[font.toLowerCase()] ?? 0.5) * (WEIGHT_WIDTHS[weight.toLowerCase()] ?? 1);

type RowKind = 'heading' | 'groupHeading' | 'detail' | 'total' | 'noData';

/** What each row of a table is: column headings, a group's opening row, a row of data or a closing (total) row. */
function rowKinds(tablix: XmlElement): RowKind[] {
  const kinds: RowKind[] = [];
  let seenData = false;
  const hasGroup = (m: XmlElement) => descendants(m).some((e) => e.name === 'Group');
  const walk = (members: XmlElement | undefined, inGroup: boolean, inDetails: boolean) => {
    const list = childElements(members ?? el('TablixMembers'), 'TablixMember');
    const firstDynamic = list.findIndex(hasGroup);
    list.forEach((m, i) => {
      const group = child(m, 'Group');
      const details = inDetails || (!!group && !child(group, 'GroupExpressions'));
      const grouped = inGroup || !!group;
      const nested = child(m, 'TablixMembers');
      if (nested) return walk(nested, grouped, details);
      // Rows shown only where the table has no data.
      if (/CountRows\(\)\s*&gt;|CountRows\(\)\s*>/.test(textOf(child(m, 'Visibility/Hidden')))) return kinds.push('noData');
      if (details || (group && !nested)) {
        seenData = true;
        return kinds.push('detail');
      }
      if (!grouped) return kinds.push(seenData || (firstDynamic >= 0 && i > firstDynamic) ? 'total' : 'heading');
      kinds.push(firstDynamic >= 0 && i > firstDynamic ? 'total' : 'groupHeading');
    });
  };
  walk(child(tablix, 'TablixRowHierarchy/TablixMembers'), false, false);
  return kinds;
}

/** Lays a house style over a converted report's RDL. */
export function applyHouseStyle(rdl: string, style: HouseStyle): string {
  const root = parseXml(rdl);
  const all = descendants(root);
  const parents = new Map<XmlElement, XmlElement>();
  for (const e of all) for (const c of childElements(e)) parents.set(c, e);
  const textboxes = all.filter((e) => e.name === 'Textbox');

  // Each run's font and weight as Crystal set them, to fit the text in the house's again afterwards.
  const defaultFont = textOf(all.find((e) => e.name === 'df:DefaultFontFamily')) || 'Arial';
  const before = new Map<XmlElement, { font: string; weight: string }>();
  for (const tb of textboxes) {
    for (const s of runStyles(tb)) {
      const weight = textOf(child(s, 'FontWeight'));
      before.set(s, { font: textOf(child(s, 'FontFamily')) || defaultFont, weight: weight && !weight.startsWith('=') ? weight : 'Normal' });
    }
  }

  // The report's usual text size: the one most text boxes use.
  const counts = new Map<number, number>();
  for (const tb of textboxes) {
    const size = textSize(tb);
    if (size !== undefined) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 10;
  const isTitle = (tb: XmlElement) => isFixed(tb) && (textSize(tb) ?? 0) >= usual + 2;

  // Bands: what is painted keeps its colours (the plain text colour below does not apply to it).
  const banded = new Set<XmlElement>();
  const paint = (items: XmlElement[], band: BandStyle | undefined) => {
    if (!band) return;
    const weight = band.weight ?? (band.bold === undefined ? undefined : band.bold ? 'Bold' : 'Normal');
    for (const item of items) {
      if (band.fill) setChild(ownStyle(item), 'BackgroundColor', band.fill);
      for (const tb of item.name === 'Textbox' ? [item] : descendants(item).filter((e) => e.name === 'Textbox')) {
        if (band.fill && tb !== item) setChild(ownStyle(tb), 'BackgroundColor', band.fill);
        for (const s of runStyles(tb)) {
          const current = textOf(child(s, 'Color'));
          // A colour Crystal sets by a formula, or red, is kept.
          if (band.color && !current.startsWith('=') && !isRed(current)) setChild(s, 'Color', band.color);
          if (weight) setChild(s, 'FontWeight', weight);
          if (band.font) setChild(s, 'FontFamily', band.font, true);
        }
        banded.add(tb);
      }
    }
  };

  // Tables: headings (and their titles), group headings, totals and data rows.
  for (const tablix of all.filter((e) => e.name === 'Tablix')) {
    const rows = childElements(child(tablix, 'TablixBody/TablixRows') ?? el('TablixRows'), 'TablixRow');
    const kinds = rowKinds(tablix);
    rows.forEach((row, i) => {
      const cells = descendants(row).filter((e) => e.name === 'CellContents').flatMap((c) => childElements(c)).filter((e) => e.name === 'Textbox' || e.name === 'Rectangle');
      const inRow = cells.flatMap((c) => (c.name === 'Textbox' ? [c] : descendants(c).filter((e) => e.name === 'Textbox')));
      const kind = kinds[i];
      if (kind === 'heading') paint(cells, inRow.some(isTitle) ? style.title : style.heading);
      else if (kind === 'groupHeading') paint(cells, style.groupHeading);
      else if (kind === 'total') paint(cells, style.total);
      else if (kind === 'detail' && style.rowBands && (style.rowBands.odd || style.rowBands.even)) {
        const odd = style.rowBands.odd ?? 'Transparent';
        const even = style.rowBands.even ?? 'Transparent';
        for (const cell of cells) {
          const s = ownStyle(cell);
          const current = textOf(child(s, 'BackgroundColor'));
          // A cell Crystal fills itself keeps its fill.
          if (!current || /^(transparent|white|#ffffff)$/i.test(current)) setChild(s, 'BackgroundColor', `=IIf(RowNumber(Nothing) Mod 2 = 1, "${odd}", "${even}")`);
        }
      }
    });
  }

  // A chart's title: text over the top of a chart beside it.
  if (style.chart?.title) {
    for (const chart of all.filter((e) => e.name === 'Chart')) {
      const items = parents.get(chart);
      const top = lengthInPoints(textOf(child(chart, 'Top'))) ?? 0;
      const height = lengthInPoints(textOf(child(chart, 'Height'))) ?? 0;
      const left = lengthInPoints(textOf(child(chart, 'Left'))) ?? 0;
      const right = left + (lengthInPoints(textOf(child(chart, 'Width'))) ?? 0);
      const titles = childElements(items ?? el('ReportItems'), 'Textbox').filter((tb) => {
        const t = lengthInPoints(textOf(child(tb, 'Top'))) ?? 0;
        const l = lengthInPoints(textOf(child(tb, 'Left'))) ?? 0;
        const r = l + (lengthInPoints(textOf(child(tb, 'Width'))) ?? 0);
        // Over the chart's top, or just above it (up to a quarter of an inch).
        return !banded.has(tb) && t <= top + height / 5 && t + (lengthInPoints(textOf(child(tb, 'Height'))) ?? 0) >= top - 18 && l < right && r > left;
      });
      paint(titles, style.chart.title);
      // The chart's own title.
      const band = style.chart.title;
      const weight = band.weight ?? (band.bold === undefined ? undefined : band.bold ? 'Bold' : 'Normal');
      for (const t of descendants(chart).filter((e) => e.name === 'ChartTitle')) {
        const s = ownStyle(t);
        if (band.fill) setChild(s, 'BackgroundColor', band.fill);
        if (band.color) setChild(s, 'Color', band.color);
        if (weight) setChild(s, 'FontWeight', weight);
        if (band.font) setChild(s, 'FontFamily', band.font);
      }
    }
  }
  // A title outside a table (a section's title over its box).
  for (const tb of textboxes.filter((e) => !banded.has(e) && isTitle(e))) paint([tb], style.title);

  for (const e of all) {
    // Fonts: every text, the report's default included (a band's own font is kept).
    if (style.font && e.name === 'df:DefaultFontFamily') e.children = [style.font];
    // Lines, boxes and borders drawn in black.
    if (style.border && BORDERS.has(e.name)) {
      const kind = textOf(child(e, 'Style'));
      if (kind && /^none$/i.test(kind)) continue;
      if (isBlack(textOf(child(e, 'Color')))) setChild(e, 'Color', style.border, true);
    }
  }
  const bandFont = new Set<XmlElement>();
  for (const tb of banded) for (const s of runStyles(tb)) if (before.get(s) && textOf(child(s, 'FontFamily')) !== before.get(s)!.font) bandFont.add(s);
  for (const tb of textboxes) {
    const linked = !!child(tb, 'ActionInfo/Actions/Action/Hyperlink');
    for (const s of runStyles(tb)) {
      if (style.font && !bandFont.has(s)) setChild(s, 'FontFamily', style.font, true);
      const color = child(s, 'Color');
      const current = textOf(color);
      // Red, as Crystal prints a failed test or a negative figure: the house's red, in formulas too.
      if (style.red && color && current.startsWith('=')) color.children = [current.replace(/"(Red|#FF0000)"/gi, `"${style.red}"`)];
      else if (style.red && isRed(current)) setChild(s, 'Color', style.red);
      else if (style.link && linked && !banded.has(tb) && (isBlack(current) || !current)) setChild(s, 'Color', style.link);
      else if (style.textColor && !banded.has(tb) && isBlack(current)) setChild(s, 'Color', style.textColor);
    }
  }

  // Charts: their text, their colours in the house palette, and the plot's background.
  for (const chart of all.filter((e) => e.name === 'Chart')) {
    for (const s of descendants(chart).filter((e) => e.name === 'Style')) {
      const font = style.chart?.font ?? style.font;
      if (font && child(s, 'FontFamily')) setChild(s, 'FontFamily', font);
      const textColor = style.chart?.textColor ?? style.textColor;
      if (textColor && child(s, 'FontFamily') && isBlack(textOf(child(s, 'Color')))) setChild(s, 'Color', textColor);
    }
  }
  if (style.chart?.palette) {
    const palette = style.chart.palette;
    for (const colors of all.filter((e) => e.name === 'ChartCustomPaletteColors')) {
      colors.children = palette.map((c) => el('ChartCustomPaletteColor', c));
    }
    const code = all.find((e) => e.name === 'Code');
    if (code) {
      code.children = [textOf(code).replace(/Dim palette\(\) As String = \{[^}]*\}/g, `Dim palette() As String = {${palette.map((c) => `"${c}"`).join(', ')}}`)];
    }
  }
  if (style.chart?.plotBackground) {
    for (const area of all.filter((e) => e.name === 'ChartArea')) {
      const areaStyle = childElements(area, 'Style')[0];
      if (areaStyle && child(areaStyle, 'BackgroundColor')) setChild(areaStyle, 'BackgroundColor', style.chart.plotBackground);
    }
  }

  // Text in a wider font or weight than Crystal's: made just small enough to fit where Crystal put it.
  const cellWidth = (tb: XmlElement): number | undefined => {
    const own = lengthInPoints(textOf(child(tb, 'Width')));
    if (own !== undefined) return own;
    const contents = parents.get(tb);
    const cell = contents && parents.get(contents);
    const cells = cell && parents.get(cell);
    const tablix = cells && parents.get(parents.get(parents.get(cells)!)!) ;
    if (!cell || !cells || !tablix) return undefined;
    const columns = childElements(child(tablix, 'TablixColumns') ?? el('TablixColumns'), 'TablixColumn').map((c) => lengthInPoints(textOf(child(c, 'Width'))) ?? 0);
    let index = 0;
    for (const c of childElements(cells, 'TablixCell')) {
      const span = Number(textOf(child(c, 'CellContents/ColSpan'))) || 1;
      if (c === cell) return columns.slice(index, index + span).reduce((a, b) => a + b, 0);
      index += span;
    }
    return undefined;
  };
  for (const tb of textboxes) {
    const styles = runStyles(tb);
    const changes = styles.map((s) => {
      const old = before.get(s);
      const now = { font: textOf(child(s, 'FontFamily')) || defaultFont, weight: textOf(child(s, 'FontWeight')) || 'Normal' };
      return old && !now.weight.startsWith('=') ? widthOf(now.font, now.weight) / widthOf(old.font, old.weight) : 1;
    });
    const growth = Math.max(...changes, 1);
    if (growth <= 1.001) continue;
    let factor = 1 / growth;
    // Fixed text: only as much as it needs to fit its box (it may have room to spare).
    const width = cellWidth(tb);
    if (isFixed(tb) && width) {
      const own = ownStyle(tb);
      const room = width - (points(textOf(child(own, 'PaddingLeft'))) ?? 2) - (points(textOf(child(own, 'PaddingRight'))) ?? 2);
      const s = styles[0];
      const size = points(textOf(child(s, 'FontSize'))) ?? 10;
      const old = before.get(s)!;
      const longest = Math.max(...fixedLines(tb).map((l) => l.length));
      const oldWidth = longest * widthOf(old.font, old.weight) * size;
      const newWidth = oldWidth * growth;
      factor = Math.min(1, Math.max(room, oldWidth) / newWidth);
    }
    if (factor >= 0.999) continue;
    for (const s of styles) {
      const size = points(textOf(child(s, 'FontSize'))) ?? 10;
      setChild(s, 'FontSize', `${Math.max(5, Math.floor(size * factor * 10) / 10)}pt`);
    }
  }
  return toXml(root);
}

/**
 * A house style read from an existing SSRS report of the house's (a template), with the values of the theme dataset
 * it reads its looks from at run time (=First(Fields!X.Value, "Theme")): the first row of that dataset's query, as
 * field name and value. The template's table gives the title, column-heading and body looks; the theme's other
 * style classes (fields named <class>_background, _color, _font_weight, _font_family) give the rest, found by the
 * words in their names: group + header, total, odd, even, red, link, chart, chart + title, palette. What it cannot
 * find is listed in the notes, with the query to run where the theme's values are missing.
 */
export function styleFromTemplate(xml: string, values: Record<string, string> = {}): { style: HouseStyle; notes: string[] } {
  const template = readHouseTemplate(xml);
  const root = parseXml(xml);
  const notes: string[] = [];
  const missing = new Map<string, string[]>();
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const given = (v: string | undefined) => (v !== undefined && v.trim() && !/^null$/i.test(v.trim()) ? v.trim() : undefined);
  // A style value: literal, or a theme field's value where it is given.
  const resolve = (value: string, what: string): string | undefined => {
    if (!value) return undefined;
    if (!value.startsWith('=')) return value;
    const field = /^=\s*First\(\s*Fields!(\w+)\.Value\s*,\s*"([^"]+)"\s*\)\s*$/i.exec(value);
    if (field) {
      const v = given(lower.get(field[1].toLowerCase()));
      if (v) return v;
      missing.set(field[2], [...(missing.get(field[2]) ?? []), `${what}: field ${field[1]}`]);
      return undefined;
    }
    notes.push(`${what} is an expression the helper does not read (${value}); set it by hand`);
    return undefined;
  };
  const weightOf = (w: string | undefined) => (w ? WEIGHTS.find((x) => x.toLowerCase() === w.toLowerCase()) : undefined);
  const toBand = (l: { fill?: string; color?: string; weight?: string; font?: string }, withFont = true): BandStyle | undefined => {
    const b: BandStyle = {};
    if (l.fill && COLOR.test(l.fill) && !/^(transparent|no color)$/i.test(l.fill)) b.fill = l.fill;
    if (l.color && COLOR.test(l.color)) b.color = l.color;
    const w = weightOf(l.weight);
    if (w) b.weight = w;
    if (withFont && l.font) b.font = l.font;
    return Object.keys(b).length ? b : undefined;
  };
  const look = (textbox: XmlElement | undefined, what: string, withFill = true) => {
    const own = textbox ? childElements(textbox, 'Style')[0] : undefined;
    const run = child(textbox, 'Paragraphs/Paragraph/TextRuns/TextRun/Style');
    return {
      fill: withFill ? resolve(textOf(child(own, 'BackgroundColor')), `${what} fill`) : undefined,
      color: resolve(textOf(child(run, 'Color')), `${what} text colour`),
      weight: resolve(textOf(child(run, 'FontWeight')), `${what} weight`),
      font: resolve(textOf(child(run, 'FontFamily')), `${what} font`),
    };
  };
  // The theme's style classes: field names ending in _background, _color, _font_weight or _font_family.
  const PARTS = /_(background|color|font_weight|font_family)$/i;
  const classNames = [...new Set(Object.keys(values).filter((k) => PARTS.test(k)).map((k) => k.replace(PARTS, '')))];
  const used: string[] = [];
  // A class by the words in its name: the first test any name passes, the shortest such name (the plainest).
  const themeClass = (...tests: ((words: string[]) => boolean)[]): { fill?: string; color?: string; weight?: string; font?: string } => {
    let name: string | undefined;
    for (const matches of tests) {
      name = classNames.filter((n) => matches(n.toLowerCase().split(/[_\s]+/))).sort((a, b) => a.length - b.length)[0];
      if (name) break;
    }
    if (!name) return {};
    const l = { fill: given(lower.get(`${name}_background`.toLowerCase())), color: given(lower.get(`${name}_color`.toLowerCase())),
      weight: given(lower.get(`${name}_font_weight`.toLowerCase())), font: given(lower.get(`${name}_font_family`.toLowerCase())) };
    if (Object.values(l).some(Boolean)) used.push(name);
    return l;
  };

  const style: HouseStyle = {};
  // The detail rows give the font and text colour (their fill, often banded, is not part of the style).
  const detail = look(template.detail.text.textbox, 'detail text', false);
  const heading = template.heading ? look(template.heading.other.textbox, 'column heading') : undefined;
  const title = template.title ? look(template.title.textbox, 'title') : undefined;
  const font = detail.font ?? heading?.font ?? title?.font;
  if (font) style.font = font;
  if (detail.color && !isBlack(detail.color)) style.textColor = detail.color;
  // A band's font is kept only where it differs from the report's.
  const bandOf = (l: Parameters<typeof toBand>[0]) => toBand(l.font && l.font !== font ? l : { ...l, font: undefined });
  if (title) style.title = bandOf(title);
  else notes.push('the template\'s table has no title row: "title" is left out');
  if (heading) style.heading = bandOf(heading);
  else notes.push('the template\'s table has no column-heading row: "heading" is left out');

  // The theme's other classes, by their usual names.
  const groupHeading = bandOf(themeClass((w) => w.includes('group') && (w.includes('header') || w.includes('heading'))));
  if (groupHeading) style.groupHeading = groupHeading;
  const total = bandOf(themeClass((w) => w.includes('total') && w.includes('data'), (w) => w.includes('total')));
  if (total) style.total = total;
  const odd = themeClass((w) => w.includes('odd')).fill;
  const even = themeClass((w) => w.includes('even')).fill;
  if (odd || even) style.rowBands = { ...(odd ? { odd } : {}), ...(even ? { even } : {}) };
  const red = themeClass((w) => w.includes('red')).color;
  if (red) style.red = red;
  const link = themeClass((w) => (w.includes('hyperlink') || w.includes('link')) && w.length === 1).color;
  if (link) style.link = link;

  // Borders: the colour the template's table draws its lines in most (black is Crystal's own).
  const counts = new Map<string, number>();
  for (const e of descendants(template.tablix).filter((x) => BORDERS.has(x.name) && !/^none$/i.test(textOf(child(x, 'Style'))))) {
    const c = resolve(textOf(child(e, 'Color')), 'border colour');
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const border = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (border && !isBlack(border)) style.border = border;

  // Charts: the template's first chart, or the theme's chart classes and palette.
  const chart: NonNullable<HouseStyle['chart']> = {};
  const templateChart = descendants(root).find((e) => e.name === 'Chart');
  if (templateChart) {
    const palette = descendants(templateChart).filter((e) => e.name === 'ChartCustomPaletteColor').map((e) => resolve(textOf(e), 'chart colour')).filter((c): c is string => !!c);
    if (palette.length) chart.palette = palette;
    const background = resolve(textOf(child(childElements(child(templateChart, 'ChartAreas/ChartArea') ?? el('ChartArea'), 'Style')[0], 'BackgroundColor')), 'chart plot background');
    if (background) chart.plotBackground = background;
  }
  if (!chart.palette) {
    const palette = Object.entries(values).filter(([k]) => /palette/i.test(k) && /_(background|color)$/i.test(k)).map(([, v]) => given(v)).filter((c): c is string => !!c && COLOR.test(c));
    if (palette.length) chart.palette = palette;
  }
  const chartClass = themeClass((w) => w.length === 1 && w[0] === 'chart');
  if (!chart.plotBackground && chartClass.fill && COLOR.test(chartClass.fill)) chart.plotBackground = chartClass.fill;
  if (chartClass.font && chartClass.font !== font) chart.font = chartClass.font;
  if (chartClass.color && COLOR.test(chartClass.color) && chartClass.color !== style.textColor) chart.textColor = chartClass.color;
  const chartTitle = toBand(themeClass((w) => w.includes('chart') && w.includes('title') && !w.includes('sub')));
  if (chartTitle) chart.title = chartTitle.font === font ? { ...chartTitle, font: undefined } : chartTitle;
  if (Object.keys(chart).length) style.chart = chart;
  else notes.push('no chart colours in the template or the theme values: "chart" is left out');
  if (used.length) notes.push(`also taken from the theme's classes: ${used.join(', ')}`);

  // What the theme dataset gives at run time: its query, to run for the values.
  const dataSets = childElements(child(root, 'DataSets') ?? el('DataSets'), 'DataSet');
  for (const [dataSet, fields] of missing) {
    const query = textOf(child(dataSets.find((d) => d.attributes.Name === dataSet), 'Query/CommandText')).trim();
    notes.push(`taken from dataset "${dataSet}" at run time, left out:\n  ${fields.join('\n  ')}` +
      (query ? `\nrun its query and give the result to fill them in:\n  ${query.replace(/\s+/g, ' ')}` : ''));
  }
  return { style: JSON.parse(JSON.stringify(style)) as HouseStyle, notes };
}

/** The first row of a CSV export (a header row and a row of values), as field name and value. */
export function firstRowOf(csv: string): Record<string, string> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '');
  for (let i = 0; i < text.length && rows.length < 2; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (rows.length < 2 && (cell || row.length)) { row.push(cell); if (row.some((c) => c.trim())) rows.push(row); }
  if (rows.length < 2) throw new Error('expected a header row and a row of values');
  return Object.fromEntries(rows[0].map((name, i) => [name.trim(), (rows[1][i] ?? '').trim()]));
}

// Run directly: node src/ssrs/brand.ts style-from <template.rdl> [theme-values.csv] > style.json
if (process.argv[1] && /brand\.ts$/.test(process.argv[1])) {
  const [command, templatePath, valuesPath] = process.argv.slice(2);
  if (command !== 'style-from' || !templatePath) {
    console.error('usage: node src/ssrs/brand.ts style-from <template.rdl> [theme-values.csv] > style.json');
    process.exitCode = 2;
  } else {
    const { readFileSync } = await import('node:fs');
    try {
      const values = valuesPath ? firstRowOf(readFileSync(valuesPath, 'utf8')) : {};
      const { style, notes } = styleFromTemplate(readFileSync(templatePath, 'utf8'), values);
      process.stdout.write(`${JSON.stringify(style, null, 2)}\n`);
      for (const note of notes) console.error(`NOTE ${note}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
