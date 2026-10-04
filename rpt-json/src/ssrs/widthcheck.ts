/**
 * Width check of an .rdl: what reaches past the printable page or past what holds it. SSRS prints whatever is wider
 * than the page on a page of its own after every page, and widens a rectangle, a table column or the body to whatever
 * they hold; this lists the items that do so, by name and size only.
 */

import { child, childElements, parseXml, textOf, type XmlElement } from './xml.ts';

const UNITS: Record<string, number> = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6 };

/** A size in inches ("1.5in", "2cm", "12pt"); 0 when absent. */
function size(element: XmlElement | undefined): number {
  const m = /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc)\s*$/.exec(textOf(element));
  return m ? parseFloat(m[1]) * UNITS[m[2]] : 0;
}

const ITEMS = new Set(['Textbox', 'Rectangle', 'Tablix', 'Line', 'Image', 'Subreport', 'Chart']);
const tolerance = 0.0005;
const fmt = (n: number) => `${n.toFixed(3)}in`;

export function checkRdlWidths(xml: string): string {
  const root = parseXml(xml);
  const out: string[] = [];
  const section = child(root, 'ReportSections/ReportSection') ?? root;
  const page = child(section, 'Page') ?? child(root, 'Page');
  const pageWidth = size(child(page, 'PageWidth'));
  const printable = pageWidth - size(child(page, 'LeftMargin')) - size(child(page, 'RightMargin'));
  const bodyWidth = size(child(section, 'Width'));
  out.push(`page ${fmt(pageWidth)}, printable ${fmt(printable)}, body ${fmt(bodyWidth)}${bodyWidth > printable + tolerance ? '  <-- body wider than the printable page' : ''}`);

  const issues: string[] = [];
  const name = (e: XmlElement) => `${e.name} "${e.attributes.Name ?? ''}"`;
  const right = (e: XmlElement) => size(child(e, 'Left')) + size(child(e, 'Width'));

  /** Checks the items in a ReportItems against the width that holds them. */
  const walkItems = (items: XmlElement | undefined, limit: number, where: string): number => {
    let widest = 0;
    for (const item of items ? childElements(items).filter((e) => ITEMS.has(e.name)) : []) {
      const own = item.name === 'Tablix' ? tablixRight(item) : right(item);
      if (item.name === 'Rectangle') {
        const inner = walkItems(child(item, 'ReportItems'), size(child(item, 'Width')), name(item));
        if (inner > size(child(item, 'Width')) + tolerance) issues.push(`${name(item)} is ${fmt(size(child(item, 'Width')))} wide but holds items to ${fmt(inner)}`);
      }
      if (own > limit + tolerance) issues.push(`${name(item)} reaches ${fmt(own)}, past ${where} (${fmt(limit)})`);
      widest = Math.max(widest, own);
    }
    return widest;
  };

  /** A table's right edge (its columns, which SSRS uses over its Width), checking each cell's contents too. */
  const tablixRight = (tablix: XmlElement): number => {
    const columns = childElements(child(tablix, 'TablixBody/TablixColumns') ?? tablix, 'TablixColumn').map((c) => size(child(c, 'Width')));
    const total = columns.reduce((a, b) => a + b, 0);
    const declared = size(child(tablix, 'Width'));
    if (total > declared + 0.01) issues.push(`${name(tablix)} columns add up to ${fmt(total)}, more than its width ${fmt(declared)}`);
    for (const [r, row] of childElements(child(tablix, 'TablixBody/TablixRows') ?? tablix, 'TablixRow').entries()) {
      let column = 0;
      for (const cell of childElements(child(row, 'TablixCells') ?? row, 'TablixCell')) {
        const span = parseInt(textOf(child(cell, 'CellContents/ColSpan')) || '1', 10);
        const width = columns.slice(column, column + span).reduce((a, b) => a + b, 0);
        const contents = child(cell, 'CellContents');
        const rect = contents ? childElements(contents).find((e) => e.name === 'Rectangle') : undefined;
        if (rect) {
          const inner = walkItems(child(rect, 'ReportItems'), width, `its cell (row ${r + 1}, column ${column + 1})`);
          if (inner > width + tolerance) issues.push(`${name(tablix)} row ${r + 1} column ${column + 1}: contents reach ${fmt(inner)} in a ${fmt(width)} column`);
        }
        // A cell spanning columns is followed by an empty cell for each further column it spans.
        column += 1;
      }
    }
    return size(child(tablix, 'Left')) + total;
  };

  const widest = walkItems(child(section, 'Body/ReportItems'), bodyWidth || printable, 'the body');
  if (widest > printable + tolerance) issues.push(`the body's items reach ${fmt(widest)}, past the printable page (${fmt(printable)})`);
  for (const area of ['Page/PageHeader', 'Page/PageFooter']) {
    const items = child(section, `${area}/ReportItems`);
    if (items) walkItems(items, printable, area.split('/')[1]);
  }
  const unique = [...new Set(issues)];
  out.push(...(unique.length ? unique.slice(0, 25) : ['nothing reaches past the page or what holds it']));
  if (unique.length > 25) out.push(`... and ${unique.length - 25} more`);
  return `${out.join('\n')}\n`;
}
