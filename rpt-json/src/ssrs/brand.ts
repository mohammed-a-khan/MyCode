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
 * Text widths, roughly: each character's width in ems in Arial, scaled for other fonts and for weight (a font with no
 * semi-bold of its own draws SemiBold as Bold). Enough to tell whether text set in another font still fits.
 */
const charWidth = (c: string): number => {
  if (/[iljI|!.,:;'`]/.test(c)) return 0.28;
  if (c === ' ') return 0.28;
  if (/[ftr()[\]\/\-]/.test(c)) return 0.34;
  if (/[mwMW%@]/.test(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.68;
  if (/[0-9]/.test(c)) return 0.56;
  return 0.53;
};
const FONT_SCALE: Record<string, number> = {
  arial: 1, helvetica: 1, tahoma: 0.98, verdana: 1.13, 'segoe ui': 0.97, calibri: 0.88, 'times new roman': 0.9, times: 0.9,
  georgia: 1, cambria: 0.93, garamond: 0.85, 'book antiqua': 0.92, 'courier new': 1.15, 'arial narrow': 0.82, 'trebuchet ms': 0.97,
  'century gothic': 1.08, 'microsoft sans serif': 1, 'ms sans serif': 1,
};
const BOLD_SCALE: Record<string, number> = { tahoma: 1.19, verdana: 1.12, 'times new roman': 1.08, times: 1.08, 'segoe ui': 1.07 };
const HAS_SEMIBOLD = new Set(['segoe ui', 'calibri', 'open sans', 'source sans pro']);
function weightScale(font: string, weight: string): number {
  const f = font.toLowerCase();
  const bold = BOLD_SCALE[f] ?? 1.1;
  switch (weight.toLowerCase()) {
    case 'thin': case 'extralight': case 'light': return 0.97;
    case 'medium': return 1.02;
    case 'semibold': return HAS_SEMIBOLD.has(f) ? 1 + (bold - 1) / 2 : bold;
    case 'bold': return bold;
    case 'extrabold': case 'heavy': return bold + 0.03;
    default: return 1;
  }
}
/** A line's height, in ems: the font's ascent and descent as Windows lays its lines out. */
const LINE_HEIGHT: Record<string, number> = {
  arial: 1.15, helvetica: 1.15, tahoma: 1.21, verdana: 1.22, 'segoe ui': 1.33, calibri: 1.22, 'times new roman': 1.15, times: 1.15,
  georgia: 1.14, cambria: 1.17, garamond: 1.12, 'courier new': 1.13, 'arial narrow': 1.15, 'trebuchet ms': 1.16, 'century gothic': 1.18,
};
const lineHeight = (font: string) => LINE_HEIGHT[font.toLowerCase()] ?? 1.2;
/** A text's width, in points, at a size, font and weight. */
const textWidth = (text: string, font: string, weight: string, size: number) =>
  [...text].reduce((w, c) => w + charWidth(c), 0) * (FONT_SCALE[font.toLowerCase()] ?? 1) * weightScale(font, weight) * size;
/** How many lines a text takes in a width (wrapped at spaces), and whether a word is broken. */
function wrapLines(text: string, room: number, width: (t: string) => number): { lines: number; broken: boolean } {
  let lines = 1;
  let line = '';
  let broken = false;
  for (const word of text.split(/ +/)) {
    if (width(word) > room) broken = true;
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > room) {
      lines++;
      line = word;
    } else line = next;
  }
  return { lines, broken };
}

/** The space kept between a painted heading band and the text under it, in points. */
const GAP = 2;
/** The white strip drawn along a heading band's foot to keep it off the rows under it, in points. */
const STRIP = 3;
/** The space kept between a painted title band and the chart under it, in points. */
const CHART_GAP = 6;
const inches = (pt: number) => `${Math.round((pt / 72) * 1000) / 1000}in`;

/** An item's left (or top) edge from the page's body, through the rectangles it sits in. */
function offsetOf(item: XmlElement, parents: Map<XmlElement, XmlElement>, side: 'Left' | 'Top' = 'Left'): number {
  let at = lengthInPoints(textOf(child(item, side))) ?? 0;
  for (let up = parents.get(item); up; up = parents.get(up)) if (up.name === 'Rectangle') at += lengthInPoints(textOf(child(up, side))) ?? 0;
  return at;
}
/**
 * A band's fill for a title: where its text is worked out when the report runs, only where there is text (an empty
 * title, such as a chart's in a frame left blank, leaves no coloured band).
 */
function fillWhenText(textbox: XmlElement, fill: string): string {
  const values = descendants(textbox).filter((e) => e.name === 'Value').map(textOf);
  if (!values.length || !values.every((v) => v.startsWith('=')) || isFixed(textbox)) return fill;
  const text = values.map((v) => `CStr(${v.slice(1)})`).join(' & ');
  return `=IIf(Trim(${text}) = "", "Transparent", "${fill}")`;
}

/** A thick rule drawn as a bar: a filled rectangle with nothing in it, no taller than a few points, at least 2in long. */
function isRuleBar(e: XmlElement): boolean {
  if (e.name !== 'Rectangle' || child(e, 'ReportItems')) return false;
  const style = childElements(e, 'Style')[0];
  const fill = textOf(child(style, 'BackgroundColor'));
  const height = lengthInPoints(textOf(child(e, 'Height'))) ?? 0;
  return !!fill && !/^transparent$/i.test(fill) && /^(none)?$/i.test(textOf(child(style, 'Border/Style'))) && height > 0 && height <= 6
    && (lengthInPoints(textOf(child(e, 'Width'))) ?? 0) >= 144;
}
const ITEMS = new Set(['Rectangle', 'Textbox', 'Line', 'Chart', 'Tablix', 'Subreport', 'Image']);

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
      if (band.fill) setChild(ownStyle(item), 'BackgroundColor', item.name === 'Textbox' && parents.get(item)?.name !== 'CellContents' ? fillWhenText(item, band.fill) : band.fill);
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
    // A thick rule drawn as a bar (a filled rectangle) takes the house's line colour too.
    if (style.border && isRuleBar(e) && isBlack(textOf(child(childElements(e, 'Style')[0], 'BackgroundColor')))) {
      setChild(childElements(e, 'Style')[0], 'BackgroundColor', style.border);
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
    // A line chart keeps Crystal's line colours: its lines tell values apart by them (one blue, the next red, as
    // Crystal draws a value against its limit).
    const lines = (chart: XmlElement) => descendants(chart).some((e) => e.name === 'ChartSeries' && textOf(child(e, 'Type')) === 'Line');
    for (const chart of all.filter((e) => e.name === 'Chart' && !lines(e))) {
      for (const colors of descendants(chart).filter((e) => e.name === 'ChartCustomPaletteColors')) {
        colors.children = palette.map((c) => el('ChartCustomPaletteColor', c));
      }
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

  // What is a little short of a rule across the page, at its right: as wide as the rule (a box with what is in it).
  const inCell = (e: XmlElement) => {
    for (let up = parents.get(e); up; up = parents.get(up)) if (up.name === 'CellContents') return true;
    return false;
  };
  const len = (e: XmlElement, name: string) => lengthInPoints(textOf(child(e, name))) ?? 0;
  const placed = all.filter((e) => ITEMS.has(e.name) && !inCell(e) && parents.get(e)?.name === 'ReportItems');
  // How wide an item is drawn: a table as wide as its columns, a rectangle as wide as what is in it.
  const drawnWidth = (e: XmlElement): number => {
    const own = len(e, 'Width');
    if (e.name === 'Tablix') {
      const columns = childElements(child(e, 'TablixBody/TablixColumns') ?? el('TablixColumns'), 'TablixColumn');
      return Math.max(own, columns.reduce((sum, c) => sum + len(c, 'Width'), 0));
    }
    if (e.name === 'Rectangle') {
      const items = childElements(child(e, 'ReportItems') ?? el('ReportItems')).filter((c) => ITEMS.has(c.name));
      return Math.max(own, ...items.map((c) => len(c, 'Left') + drawnWidth(c)));
    }
    return own;
  };
  const boxOf = (e: XmlElement) => {
    const left = offsetOf(e, parents, 'Left');
    const top = offsetOf(e, parents, 'Top');
    return { left, top, right: left + drawnWidth(e), bottom: top + len(e, 'Height') };
  };
  const boxes = new Map(placed.map((e) => [e, boxOf(e)]));
  const isFrame = (e: XmlElement) => e.name === 'Rectangle' && !/^none$/i.test(textOf(child(e, 'Style/Border/Style')) || 'None');
  const painted = (e: XmlElement) => {
    const fill = textOf(child(ownStyle(e), 'BackgroundColor'));
    return !!fill && !/^transparent$/i.test(fill);
  };
  const rules = placed.filter((e) => (e.name === 'Line' && Math.abs(len(e, 'Height')) < 1) || isRuleBar(e)).map((e) => boxes.get(e)!).filter((r) => r.right - r.left > 144);
  const end = Math.max(...rules.map((r) => r.right), 0);
  const ruleLeft = Math.min(...rules.filter((r) => r.right === end).map((r) => r.left));
  const thin = (e: XmlElement) => e.name === 'Line' && Math.abs(len(e, 'Width')) < 1;
  // Plain text is not part of the layout's edge (only a band or a framed text is).
  const edgeItem = (e: XmlElement) => {
    const framed = !/^(none)?$/i.test(textOf(child(ownStyle(e), 'Border/Style')));
    return !thin(e) && e.name !== 'Image' && (e.name !== 'Textbox' || painted(e) || framed);
  };
  const besides = (e: XmlElement) => {
    const b = boxes.get(e)!;
    return childElements(parents.get(e)!).some((o) => {
      if (o === e || !boxes.has(o) || thin(o)) return false;
      const ob = boxes.get(o)!;
      return ob.left >= b.right - 0.5 && ob.top < b.bottom && ob.bottom > b.top;
    });
  };
  const area = (e: XmlElement) => { const b = boxes.get(e)!; return (b.right - b.left) * (b.bottom - b.top); };
  const within = (inner: { left: number; top: number; right: number; bottom: number }, outer: { left: number; top: number; right: number; bottom: number }) =>
    inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  // A frame holds what lies on it (beside it in its container) or in it.
  const holds = (frame: XmlElement, e: XmlElement) => {
    if (parents.get(frame) === parents.get(e)) return true;
    for (let up = parents.get(e); up; up = parents.get(up)) if (up === frame) return true;
    return false;
  };
  // What an item lies in: the rectangles it sits in, or a frame drawn round where it starts (the innermost).
  const encloser = (e: XmlElement) => {
    const b = boxes.get(e)!;
    return placed.filter((r) => {
      if (r === e || r.name !== 'Rectangle' || !holds(r, e)) return false;
      if (parents.get(r) !== parents.get(e)) return true;
      const rb = boxes.get(r)!;
      return area(r) > area(e) && b.left >= rb.left - 1 && b.left < rb.right && b.top >= rb.top - 1 && b.bottom <= rb.bottom + 1;
    }).sort((x, y) => area(x) - area(y))[0];
  };
  // What lies in a frame moves with the frame (keeping its distance from the frame's side); what lies in none
  // (or in a rectangle without a border) reaches the rule itself. Nothing ends past the rule.
  const grows = new Map<XmlElement, number>();
  const order = placed.filter((e) => edgeItem(e) && !besides(e)).sort((x, y) => area(y) - area(x));
  for (const e of order) {
    const b = boxes.get(e)!;
    if (b.left < ruleLeft - 2 || b.right >= end - 0.5) continue;
    // A rectangle drawn without a border (a subreport without a frame, a section's holder) lying in no frame is none:
    // what is in it reaches the rule as what lies in none does.
    const framedAround = (r: XmlElement | undefined): boolean => !!r && (isFrame(r) || framedAround(encloser(r)));
    const outer = [encloser(e)].find(framedAround);
    let grow: number;
    if (outer) {
      const frameGrow = grows.get(outer);
      // Only what runs along the frame's right side.
      if (!frameGrow || b.right < boxes.get(outer)!.right - 54) continue;
      grow = frameGrow;
    } else {
      if (b.right < end - 54) continue;
      grow = end - b.right;
    }
    grow = Math.min(grow, end - b.right);
    if (grow > 0.5) grows.set(e, grow);
  }
  // Lines down a frame's right side move with it.
  for (const e of placed.filter(thin)) {
    const b = boxes.get(e)!;
    const moved = [...grows.entries()].find(([f]) => holds(f, e) && Math.abs(boxes.get(f)!.right - b.left) <= 3 && b.top >= boxes.get(f)!.top - 1 && b.bottom <= boxes.get(f)!.bottom + 1);
    if (moved) setChild(e, 'Left', inches(len(e, 'Left') + moved[1]));
  }
  for (const [e, grow] of grows) {
    const width = drawnWidth(e);
    if (e.name === 'Tablix') {
      const columns = childElements(child(e, 'TablixBody/TablixColumns') ?? el('TablixColumns'), 'TablixColumn');
      const last = columns[columns.length - 1];
      if (!last) continue;
      setChild(last, 'Width', inches(len(last, 'Width') + grow));
    }
    setChild(e, 'Width', inches(width + grow));
    // Its containers widened with it where they would now cut it off.
    let right = len(e, 'Left') + width + grow;
    for (let up = parents.get(e); up; up = parents.get(up)) {
      if (up.name !== 'Rectangle' && up.name !== 'ReportSection') continue;
      const w = len(up, 'Width');
      if (w < right) setChild(up, 'Width', inches(right));
      if (up.name === 'ReportSection') break;
      right = len(up, 'Left') + Math.max(w, right);
    }
  }

  // A painted title along a frame's top: across the frame, side to side, from its top (a frame drawn beside it, or the
  // bordered rectangle it is in, such as a subreport's frame).
  // (A title worked out by a formula too: a painted text no taller than a line or two.)
  const bands = placed.filter((e) => e.name === 'Textbox' && painted(e) && (isFixed(e) || len(e, 'Height') <= 30));
  const flush = new Set<XmlElement>();
  const ownBox = (f: XmlElement) => {
    const left = offsetOf(f, parents, 'Left');
    const top = offsetOf(f, parents, 'Top');
    return { left, top, right: left + len(f, 'Width'), bottom: top + len(f, 'Height') };
  };
  for (const band of bands) {
    const b = boxOf(band);
    const holder = parents.get(parents.get(band)!);
    const frames = [
      ...placed.filter((f) => isFrame(f) && parents.get(f) === parents.get(band)).map((f) => ({ f, inside: false })),
      ...(holder && isFrame(holder) ? [{ f: holder, inside: true }] : []),
    ];
    const frame = frames.map((x) => ({ ...x, fb: ownBox(x.f) }))
      // (Its sides close to the frame's: within 25pt, or a twentieth of a wide frame.)
      .filter(({ fb }) => within(b, fb) && b.top - fb.top <= 36 && b.left - fb.left <= Math.max(25, (fb.right - fb.left) / 20)
        && fb.right - b.right <= Math.max(25, (fb.right - fb.left) / 20) && (b.right - b.left) >= (fb.right - fb.left) * 0.6)
      .sort((x, y) => (x.fb.right - x.fb.left) - (y.fb.right - y.fb.left))[0];
    if (!frame) continue;
    setChild(band, 'Top', frame.inside ? '0in' : textOf(child(frame.f, 'Top')));
    setChild(band, 'Left', frame.inside ? '0in' : textOf(child(frame.f, 'Left')));
    setChild(band, 'Width', textOf(child(frame.f, 'Width')));
    flush.add(band);
  }
  // A chart under a painted title starts below it, a little apart (the band would cover the chart's top; plain text did not).
  for (const band of bands) {
    const b = { top: len(band, 'Top'), left: len(band, 'Left'), right: len(band, 'Left') + len(band, 'Width') };
    const bottom = b.top + len(band, 'Height');
    for (const chart of childElements(parents.get(band)!, 'Chart')) {
      const top = len(chart, 'Top');
      const height = len(chart, 'Height');
      const left = len(chart, 'Left');
      const right = left + len(chart, 'Width');
      // A few points clear of it: the value axis's top label is drawn half above the chart's plot.
      const below = bottom + CHART_GAP;
      if (right <= b.left || left >= b.right || below <= top || b.top > top + height / 5 || below - top >= height / 3) continue;
      setChild(chart, 'Top', inches(below));
      setChild(chart, 'Height', inches(height - (below - top)));
    }
  }
  // Painted titles side by side (a row of charts' titles): on one line, at the lowest one's place.
  const rowsOf: XmlElement[][] = [];
  for (const band of bands.filter((e) => !flush.has(e) && (textSize(e) ?? 10) < usual + 6)) {
    const t = len(band, 'Top');
    const row = rowsOf.find((r) => parents.get(r[0]) === parents.get(band) && r.every((o) => Math.abs(len(o, 'Top') - t) <= 14
      && (len(o, 'Left') + len(o, 'Width') <= len(band, 'Left') + 1 || len(band, 'Left') + len(band, 'Width') <= len(o, 'Left') + 1)));
    if (row) row.push(band);
    else rowsOf.push([band]);
  }
  for (const row of rowsOf.filter((r) => r.length > 1)) {
    const top = Math.max(...row.map((e) => len(e, 'Top')));
    const bottom = Math.max(...row.map((e) => len(e, 'Top') + len(e, 'Height')));
    for (const e of row) {
      setChild(e, 'Top', inches(top));
      setChild(e, 'Height', inches(bottom - top));
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
  const cellHeight = (tb: XmlElement): number | undefined => {
    const own = lengthInPoints(textOf(child(tb, 'Height')));
    if (own !== undefined) return own;
    let row: XmlElement | undefined = tb;
    while (row && row.name !== 'TablixRow') row = parents.get(row);
    return row && lengthInPoints(textOf(child(row, 'Height')));
  };
  for (const tb of textboxes) {
    const styles = runStyles(tb);
    const s = styles[0];
    const old = s && before.get(s);
    if (!old) continue;
    const now = { font: textOf(child(s, 'FontFamily')) || defaultFont, weight: textOf(child(s, 'FontWeight')) || 'Normal' };
    if (now.weight.startsWith('=') || (now.font === old.font && now.weight === old.weight)) continue;
    const size = points(textOf(child(s, 'FontSize'))) ?? 10;
    const sample = 'Sample Text 1,234.56';
    const growth = textWidth(sample, now.font, now.weight, size) / textWidth(sample, old.font, old.weight, size);
    let factor = Math.min(1, 1 / growth);
    // Fixed text: only as much as it needs to wrap no more than in Crystal, no word broken (it may have room to spare).
    const width = cellWidth(tb);
    if (isFixed(tb) && width) {
      const own = ownStyle(tb);
      const room = (width - (points(textOf(child(own, 'PaddingLeft'))) ?? 2) - (points(textOf(child(own, 'PaddingRight'))) ?? 2)) * 0.96;
      const lines = fixedLines(tb).filter((l) => l.trim());
      // Its height too: the lines as tall as the box allows (or as Crystal's one line was, where it already filled it;
      // SSRS clips a second line overflowing the box, even where Crystal's own lines did).
      const height = cellHeight(tb);
      const tall = height === undefined ? Infinity
        : (height - (points(textOf(child(own, 'PaddingTop'))) ?? 2) - (points(textOf(child(own, 'PaddingBottom'))) ?? 2)) * 0.97;
      const fits = (f: number) => {
        let linesBefore = 0;
        let linesAfter = 0;
        const wraps = lines.every((line) => {
          const before = wrapLines(line, room, (t) => textWidth(t, old.font, old.weight, size));
          const after = wrapLines(line, room, (t) => textWidth(t, now.font, now.weight, size * f));
          linesBefore += before.lines;
          linesAfter += after.lines;
          return after.lines <= before.lines && (!after.broken || before.broken);
        });
        const allowed = linesAfter > 1 ? tall : Math.max(tall, linesBefore * size * lineHeight(old.font));
        return wraps && linesAfter * size * f * lineHeight(now.font) <= allowed + 0.01;
      };
      factor = 1;
      while (factor > 0.6 && !fits(factor)) factor -= 0.02;
    }
    if (factor >= 0.999) continue;
    for (const st of styles) {
      const own = points(textOf(child(st, 'FontSize'))) ?? 10;
      setChild(st, 'FontSize', `${Math.max(5, Math.floor(own * factor * 10) / 10)}pt`);
    }
  }

  // Rows under a painted heading: their text a little way off the band (as far as each row has room to spare).
  const fontOf = (st: XmlElement) => textOf(child(st, 'FontFamily')) || defaultFont;
  const slackOf = (tb: XmlElement, height: number) => {
    const own = ownStyle(tb);
    // Its lines as they wrap in its width (a long heading takes two), in the font it now has, with a little to spare.
    const first = runStyles(tb)[0];
    const width = cellWidth(tb);
    const room = width === undefined ? undefined
      : width - (points(textOf(child(own, 'PaddingLeft'))) ?? 2) - (points(textOf(child(own, 'PaddingRight'))) ?? 2);
    const font = first ? fontOf(first) : defaultFont;
    const weight = (first && textOf(child(first, 'FontWeight'))) || 'Normal';
    const size = (first && points(textOf(child(first, 'FontSize')))) ?? 10;
    const lines = !isFixed(tb) ? 1 : fixedLines(tb).filter((l) => l.trim()).reduce((sum, line) => sum
      + (room === undefined || weight.startsWith('=') ? 1 : wrapLines(line, room, (t) => textWidth(t, font, weight, size)).lines), 0) || 1;
    const text = Math.max(...runStyles(tb).map((st) => (points(textOf(child(st, 'FontSize'))) ?? 10) * lineHeight(fontOf(st))), 0) * lines * 1.08;
    return height - text - (points(textOf(child(own, 'PaddingTop'))) ?? 2) - (points(textOf(child(own, 'PaddingBottom'))) ?? 2);
  };
  for (const tablix of all.filter((e) => e.name === 'Tablix')) {
    const rows = childElements(child(tablix, 'TablixBody/TablixRows') ?? el('TablixRows'), 'TablixRow');
    const kinds = rowKinds(tablix);
    const painted = rows.some((_, i) => kinds[i] === 'heading' && (style.heading?.fill || style.title?.fill));
    if (!painted) continue;
    // The band's last row: a strip of white along its foot, where its text leaves room for one.
    const last = kinds.lastIndexOf('heading');
    const foot = rows[last];
    const footHeight = foot && lengthInPoints(textOf(child(foot, 'Height')));
    const footCells = foot ? descendants(foot).filter((e) => e.name === 'CellContents').flatMap((c) => childElements(c)).filter((e) => e.name === 'Textbox' || e.name === 'Rectangle') : [];
    if (footHeight && footCells.length && footCells.every((c) => {
      const border = child(ownStyle(c), 'BottomBorder/Style') ?? child(ownStyle(c), 'Border/Style');
      return (!border || /^none$/i.test(textOf(border))) && (c.name !== 'Textbox' || slackOf(c, footHeight) >= STRIP + 1);
    })) {
      for (const c of footCells) {
        const own = ownStyle(c);
        setChild(own, 'BottomBorder', '');
        const border = child(own, 'BottomBorder')!;
        border.children = [el('Color', 'White'), el('Style', 'Solid'), el('Width', `${STRIP}pt`)];
        if (c.name === 'Textbox') setChild(own, 'PaddingBottom', `${(points(textOf(child(own, 'PaddingBottom'))) ?? 2) + STRIP}pt`);
      }
      continue;
    }
    rows.forEach((row, i) => {
      if (kinds[i] === 'heading' || kinds[i] === 'noData') return;
      const height = lengthInPoints(textOf(child(row, 'Height')));
      const cells = descendants(row).filter((e) => e.name === 'CellContents').flatMap((c) => childElements(c, 'Textbox'));
      if (!height || !cells.length) return;
      const tops = cells.map((tb) => points(textOf(child(ownStyle(tb), 'PaddingTop'))) ?? 2);
      const shift = Math.min(GAP - Math.min(...tops), ...cells.map((tb) => slackOf(tb, height) / 2));
      if (shift < 0.5) return;
      const move = Math.floor(shift * 10) / 10;
      cells.forEach((tb, j) => setChild(ownStyle(tb), 'PaddingTop', `${Math.round((tops[j] + move) * 10) / 10}pt`));
    });
  }

  // A title over a band: in the middle of its box (as far off the band as off what is above it).
  for (const tb of textboxes) {
    if (!banded.has(tb) || !isTitle(tb) || child(ownStyle(tb), 'VerticalAlign')) continue;
    const height = lengthInPoints(textOf(child(tb, 'Height')));
    if (height === undefined || parents.get(tb)?.name === 'CellContents') continue;
    const slack = slackOf(tb, height);
    if (slack > 0.5 && slack < height / 2) setChild(ownStyle(tb), 'VerticalAlign', 'Middle');
  }

  // A heading Crystal wrote as text objects one under another, a little overlapping (Crystal's text is transparent):
  // painted, the one drawn last would cover the other's line. The top one paints the band down to the last line's
  // foot, the lines under it are drawn over it without a fill of their own.
  for (const holder of all.filter((e) => e.name === 'ReportItems')) {
    const fillOf = (e: XmlElement) => textOf(child(ownStyle(e), 'BackgroundColor'));
    const stacked = childElements(holder, 'Textbox').filter((e) => {
      const fill = fillOf(e);
      return !!fill && !fill.startsWith('=') && !/^transparent$/i.test(fill) && !/^(middle|bottom)$/i.test(textOf(child(ownStyle(e), 'VerticalAlign')));
    }).sort((a, b) => len(a, 'Top') - len(b, 'Top'));
    const merged = new Set<XmlElement>();
    for (const upper of stacked) {
      if (merged.has(upper)) continue;
      const left = len(upper, 'Left');
      const right = left + len(upper, 'Width');
      let bottom = len(upper, 'Top') + len(upper, 'Height');
      for (const lower of stacked) {
        if (lower === upper || merged.has(lower) || fillOf(lower).toLowerCase() !== fillOf(upper).toLowerCase()) continue;
        const top = len(lower, 'Top');
        const overlap = Math.min(right, len(lower, 'Left') + len(lower, 'Width')) - Math.max(left, len(lower, 'Left'));
        // (A line under it: starting half its height down at least; text beside it on the same line is not.)
        if (top < len(upper, 'Top') + len(upper, 'Height') / 2 || top >= bottom - 0.5 || overlap < Math.min(right - left, len(lower, 'Width')) / 2) continue;
        bottom = Math.max(bottom, top + len(lower, 'Height'));
        // No fill of its own (SSRS takes no "Transparent" as a fixed colour: the fill is left out).
        const own = ownStyle(lower);
        own.children = own.children.filter((c) => !(typeof c === 'object' && c !== null && (c as XmlElement).name === 'BackgroundColor'));
        merged.add(lower);
        // Drawn after the band.
        holder.children = [...holder.children.filter((c) => c !== lower), lower];
      }
      if (bottom > len(upper, 'Top') + len(upper, 'Height')) {
        setChild(upper, 'Height', inches(bottom - len(upper, 'Top')));
      }
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
