import { child, childElements, descendants, el, textOf, type XmlElement } from './xml.ts';

/** Sets (or adds) a child element's text. */
export function setChild(parent: XmlElement, name: string, value: string, first = false): void {
  const existing = childElements(parent, name)[0];
  if (existing) existing.children = [value];
  else if (first) parent.children.unshift(el(name, value));
  else parent.children.push(el(name, value));
}

/** An item's own style (a text box's: the one after its paragraphs, not a run's). */
export function ownStyle(item: XmlElement): XmlElement {
  let style = childElements(item, 'Style')[0];
  if (!style) {
    style = el('Style');
    item.children.push(style);
  }
  return style;
}

const FIXED = /^=\s*"([^"]|"")*"(\s*&\s*vbCrLf\s*&\s*"([^"]|"")*")*\s*$/;

/** Fixed text: not an expression, or one giving a literal text. */
export function isFixed(textbox: XmlElement): boolean {
  const values = descendants(textbox).filter((e) => e.name === 'Value').map(textOf);
  return values.length > 0 && values.some((v) => v.trim()) && values.every((v) => !v.startsWith('=') || FIXED.test(v));
}

export const points = (size: string) => {
  const m = /^\s*([\d.]+)\s*pt\s*$/i.exec(size);
  return m ? Number(m[1]) : undefined;
};
export const lengthInPoints = (value: string) => {
  const m = /^\s*([\d.]+)\s*(in|cm|mm|pt|pc)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return { in: n * 72, cm: (n / 2.54) * 72, mm: (n / 25.4) * 72, pt: n, pc: n * 12 }[(m[2] ?? 'in').toLowerCase() as 'in'];
};

/** The largest font size of a textbox's runs. */
export function textSize(textbox: XmlElement): number | undefined {
  const sizes = descendants(textbox).filter((e) => e.name === 'TextRun').map((r) => points(textOf(child(r, 'Style/FontSize')))).filter((s): s is number => s !== undefined);
  return sizes.length ? Math.max(...sizes) : undefined;
}

/** The space kept between a painted title band and the chart under it, in points. */
export const CHART_GAP = 6;
export const inches = (pt: number) => `${Math.round((pt / 72) * 1000) / 1000}in`;

/** An item's left (or top) edge from the page's body, through the rectangles it sits in. */
export function offsetOf(item: XmlElement, parents: Map<XmlElement, XmlElement>, side: 'Left' | 'Top' = 'Left'): number {
  let at = lengthInPoints(textOf(child(item, side))) ?? 0;
  for (let up = parents.get(item); up; up = parents.get(up)) if (up.name === 'Rectangle') at += lengthInPoints(textOf(child(up, side))) ?? 0;
  return at;
}

/** A thick rule drawn as a bar: a filled rectangle with nothing in it, no taller than a few points, at least 2in long. */
export function isRuleBar(e: XmlElement): boolean {
  if (e.name !== 'Rectangle' || child(e, 'ReportItems')) return false;
  const style = childElements(e, 'Style')[0];
  const fill = textOf(child(style, 'BackgroundColor'));
  const height = lengthInPoints(textOf(child(e, 'Height'))) ?? 0;
  return !!fill && !/^transparent$/i.test(fill) && /^(none)?$/i.test(textOf(child(style, 'Border/Style'))) && height > 0 && height <= 6
    && (lengthInPoints(textOf(child(e, 'Width'))) ?? 0) >= 144;
}
export const ITEMS = new Set(['Rectangle', 'Textbox', 'Line', 'Chart', 'Tablix', 'Subreport', 'Image']);

/**
 * A table's column widened on one side keeps its text where it was: each cell of the column takes the added width as
 * padding on that side (what a rectangle cell holds moves over instead).
 */
export function padColumn(tablix: XmlElement, index: 'first' | 'last', amount: number): void {
  for (const row of childElements(child(tablix, 'TablixBody/TablixRows') ?? el('TablixRows'), 'TablixRow')) {
    const cells = childElements(child(row, 'TablixCells') ?? el('TablixCells'), 'TablixCell');
    const cell = index === 'first' ? cells[0] : cells[cells.length - 1];
    const content = cell && childElements(child(cell, 'CellContents') ?? el('CellContents'))[0];
    if (!content) continue;
    if (content.name === 'Textbox') {
      const own = ownStyle(content);
      const side = index === 'first' ? 'PaddingLeft' : 'PaddingRight';
      // (A padding worked out per record, placing the text by a formula, is left to it.)
      if (textOf(child(own, side)).startsWith('=')) continue;
      setChild(own, side, `${Math.round(((points(textOf(child(own, side))) ?? 2) + amount) * 10) / 10}pt`);
    } else if (content.name === 'Rectangle' && index === 'first') {
      for (const c of childElements(child(content, 'ReportItems') ?? el('ReportItems'))) {
        const left = lengthInPoints(textOf(child(c, 'Left')));
        if (left !== undefined) setChild(c, 'Left', `${Math.round(((left + amount) / 72) * 1000) / 1000}in`);
      }
    }
  }
}

export function alignToRules(root: XmlElement): void {
  const all = descendants(root);
  const parents = new Map<XmlElement, XmlElement>();
  for (const e of all) for (const c of childElements(e)) parents.set(c, e);
  const counts = new Map<number, number>();
  for (const tb of all.filter((e) => e.name === 'Textbox')) {
    const size = textSize(tb);
    if (size !== undefined) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 10;
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
  // Whether a rectangle is a frame or lies in one.
  const framedAround = (r: XmlElement | undefined): boolean => !!r && (isFrame(r) || framedAround(encloser(r)));
  const grows = new Map<XmlElement, number>();
  const order = placed.filter((e) => edgeItem(e) && !besides(e)).sort((x, y) => area(y) - area(x));
  for (const e of order) {
    const b = boxes.get(e)!;
    if (b.left < ruleLeft - 2 || b.right >= end - 0.5) continue;
    // A rectangle drawn without a border (a subreport without a frame, a section's holder) lying in no frame is none:
    // what is in it reaches the rule as what lies in none does.
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
      padColumn(e, 'last', grow);
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

  // Likewise on the left: a table (or a band, a frame) starting a little inside the rule's left end, with nothing
  // beside it, reaches it; what holds it (a rectangle without a border) opens out to the left, what else is in it
  // keeping its place.
  for (const e of order.filter((x) => x.name === 'Tablix' || isFrame(x) || (x.name === 'Textbox' && painted(x)))) {
    const b = boxOf(e);
    const shift = b.left - ruleLeft;
    if (shift <= 0.5 || shift > 54 || [encloser(e)].some((r) => r && framedAround(r))) continue;
    const beside = placed.some((o) => o !== e && !thin(o) && parents.get(o) === parents.get(e) && boxes.get(o)!.right <= b.left + 0.5
      && boxes.get(o)!.top < b.bottom && boxes.get(o)!.bottom > b.top);
    if (beside) continue;
    let need = shift;
    let item = e;
    for (let up = parents.get(item); need > 0.5 && up; up = parents.get(up)) {
      if (up.name !== 'ReportItems') continue;
      const own = len(item, 'Left');
      const room = Math.min(own, need);
      setChild(item, 'Left', inches(own - room));
      need -= room;
      const holder = parents.get(up);
      if (need <= 0.5 || !holder || holder.name !== 'Rectangle' || isFrame(holder)) break;
      // The holder opens out to the left by what is left to move; the rest of what it holds stays in place.
      for (const c of childElements(up).filter((c) => c !== item && ITEMS.has(c.name))) setChild(c, 'Left', inches(len(c, 'Left') + need));
      setChild(holder, 'Width', inches(len(holder, 'Width') + need));
      item = holder;
    }
    const moved = shift - Math.max(0, need);
    if (moved <= 0.5) continue;
    if (e.name === 'Tablix') {
      const first = childElements(child(e, 'TablixBody/TablixColumns') ?? el('TablixColumns'), 'TablixColumn')[0];
      if (first) setChild(first, 'Width', inches(len(first, 'Width') + moved));
      padColumn(e, 'first', moved);
    }
    setChild(e, 'Width', inches(len(e, 'Width') + moved));
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
      // (A subreport's frame is designed as low as its section and grows with what it holds: only its sides count.)
      .filter(({ fb, inside }) => (inside ? b.left >= fb.left - 1 && b.right <= fb.right + 1 && b.top >= fb.top - 1 : within(b, fb)) && b.top - fb.top <= 36 && b.left - fb.left <= Math.max(25, (fb.right - fb.left) / 20)
        && fb.right - b.right <= Math.max(25, (fb.right - fb.left) / 20) && (b.right - b.left) >= (fb.right - fb.left) * 0.6)
      .sort((x, y) => (x.fb.right - x.fb.left) - (y.fb.right - y.fb.left))[0];
    if (!frame) continue;
    const old = { left: len(band, 'Left'), top: len(band, 'Top'), right: len(band, 'Left') + len(band, 'Width'), bottom: len(band, 'Top') + len(band, 'Height') };
    const to = { left: frame.inside ? 0 : len(frame.f, 'Left'), top: frame.inside ? 0 : len(frame.f, 'Top'), right: 0, bottom: 0 };
    to.right = to.left + len(frame.f, 'Width');
    to.bottom = to.top + old.bottom - old.top;
    const meets = (x: typeof old, s: typeof old) => s.left < x.right - 0.5 && s.right > x.left + 0.5 && s.top < x.bottom - 0.5 && s.bottom > x.top + 0.5;
    for (const s of childElements(parents.get(band)!).filter((e) => e !== band && e !== frame.f && ITEMS.has(e.name) && e.name !== 'Chart')) {
      const sb = { left: len(s, 'Left'), top: len(s, 'Top'), right: len(s, 'Left') + len(s, 'Width'), bottom: len(s, 'Top') + len(s, 'Height') };
      if (!meets(to, sb) || meets(old, sb)) continue;
      if (sb.right <= old.left + 0.5) to.left = Math.max(to.left, sb.right);
      else if (sb.left >= old.right - 0.5) to.right = Math.min(to.right, sb.left);
      else if (sb.bottom <= old.top + 0.5) { to.bottom += Math.max(to.top, sb.bottom) - to.top; to.top = Math.max(to.top, sb.bottom); }
    }
    if (to.right - to.left < old.right - old.left) continue;
    setChild(band, 'Top', inches(to.top));
    setChild(band, 'Left', inches(to.left));
    setChild(band, 'Width', inches(to.right - to.left));
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
}
