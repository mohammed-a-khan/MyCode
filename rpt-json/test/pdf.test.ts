import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pageLines, readPdf } from '../src/pdf/read.ts';
import { comparePart, differencesCsv, summaryText, verdict } from '../src/pdf/compare.ts';
import { valuesTested } from '../src/ui/params.ts';
import { crc32, zipFiles } from '../src/ui/zip.ts';

interface Placed { x: number; y: number; text: string; wide?: boolean }

function makePdf(pages: Placed[][], compress = true): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const helvetica = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const chars = [...new Set(pages.flat().filter((p) => p.wide).flatMap((p) => [...p.text]))];
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${chars.length} beginbfchar ${chars.map((c, k) => `<${(k + 3).toString(16).padStart(4, '0')}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`).join(' ')} endbfchar endcmap end end`;
  const toUnicode = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  const cid = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sub /CIDSystemInfo << /Registry (Adobe) /Ordering (Sub) /Supplement 0 >> /DW 500 >>');
  const type0 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /Sub /Encoding /UniCNS-UTF16-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const pagesId = objects.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const placed of pages) {
    const ops = placed.map((p) => {
      const shown = p.wide ? `<${[...p.text].map((c) => (chars.indexOf(c) + 3).toString(16).padStart(4, '0')).join('')}>` : `(${p.text.replace(/([()\\])/g, '\\$1')})`;
      return `BT /${p.wide ? 'F2' : 'F1'} 10 Tf 1 0 0 1 ${p.x} ${p.y} Tm ${shown} Tj ET`;
    }).join('\n');
    const content = compress ? deflateSync(Buffer.from(ops, 'latin1')).toString('latin1') : ops;
    const stream = add(`<< /Length ${content.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 ${helvetica} 0 R /F2 ${type0} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, k) => { offsets.push(out.length); out += `${k + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const row = (y: number, name: string, values: string[], wide = false, start = 60): Placed[] =>
  [{ x: start, y, text: name, wide }, ...values.map((v, k) => ({ x: start + 220 + k * 110, y, text: v, wide }))];

describe('reading report PDFs', () => {
  it('reads text placed with simple and two-byte fonts, compressed or not', () => {
    const data = makePdf([[...row(500, 'Opening balance', ['1,234.56', '(20.00)']), ...row(480, 'Share', ['12.50%', '4/9/2026'], true)]], false);
    const lines = pageLines(readPdf(data)[0]!);
    assert.deepEqual(lines.map((l) => l.cells.map((c) => c.text)), [['Opening balance', '1,234.56', '(20.00)'], ['Share', '12.50%', '4/9/2026']]);
    const packed = pageLines(readPdf(makePdf([row(500, 'Opening balance', ['1,234.56'])]))[0]!);
    assert.equal(packed[0]!.text, 'Opening balance  1,234.56');
  });

  it('refuses what is not a PDF', () => {
    assert.throws(() => readPdf(Buffer.from('hello')), /not a PDF/);
  });
});

describe('checking converted reports against the original PDF', () => {
  const rows = Array.from({ length: 30 }, (_, k) => ({ name: `Holding ${k + 1}`, a: `${(k + 1) * 1000 + 0.25}`.replace(/(\d)(?=(\d{3})+\.)/g, '$1,'), b: k % 3 ? `${k}.10` : `(${k}.10)`, c: `${(k * 1.5).toFixed(2)}%` }));
  const furniture = (n: number, of: number): Placed[] => [{ x: 60, y: 590, text: 'Monthly Pack' }, { x: 600, y: 590, text: `Printed 10/2${n}/2026` }, { x: 380, y: 20, text: `Page ${n} of ${of}` }];
  const original = makePdf([
    [...furniture(1, 3), { x: 60, y: 540, text: 'Summary' }, ...row(520, 'Units held', ['123,456']), { x: 60, y: 480, text: 'Holdings Overview' }, ...row(460, 'Name', ['Opening', 'Change', 'Share']),
      ...rows.slice(0, 15).flatMap((r, k) => row(440 - k * 18, r.name, [r.a, r.b, r.c]))],
    [...furniture(2, 3), ...row(540, 'Name', ['Opening', 'Change', 'Share']), ...rows.slice(15).flatMap((r, k) => row(520 - k * 18, r.name, [r.a, r.b, r.c]))],
    [...furniture(3, 3), { x: 60, y: 540, text: 'Another section' }, ...row(520, 'Other value', ['77.10', '88.20'])],
  ]);
  const converted = (change: (r: (typeof rows)[number], k: number) => string[]) => makePdf([
    [{ x: 40, y: 560, text: 'Holdings Overview', wide: true }, ...row(540, 'Name', ['Opening', 'Change', 'Share'], true, 40), ...rows.map((r, k) => row(520 - k * 16, r.name, change(r, k), true, 40)).flat()],
  ]);

  it('finds the part in the original and calls it a match when every value is the same', () => {
    const result = comparePart('part.pdf', readPdf(original), readPdf(converted((r) => [r.a, r.b, r.c])));
    assert.equal(result.found, true);
    assert.deepEqual(result.originalPages, [1, 2]);
    assert.equal(verdict(result), 'MATCH');
    assert.equal(result.identical, 120);
    assert.equal(result.totals.delta, '0.00');
  });

  it('reports a one cent difference with its row, both values and the difference', () => {
    const result = comparePart('part.pdf', readPdf(original), readPdf(converted((r, k) => [k === 20 ? r.a.replace(/25$/, '26') : r.a, r.b, r.c])));
    assert.equal(verdict(result), 'DIFFERENCES');
    const differs = result.differences.filter((d) => d.kind === 'differs');
    assert.equal(differs.length, 1);
    assert.equal(differs[0]!.label, 'Holding 21');
    assert.equal(differs[0]!.original!.raw, '21,000.25');
    assert.equal(differs[0]!.converted!.raw, '21,000.26');
    assert.equal(differs[0]!.delta, '0.01');
    assert.equal(differs[0]!.original!.page, 2);
    assert.equal(result.totals.delta, '0.01');
    assert.match(summaryText([result], 'original.pdf', 3), /Holding 21: original 21,000\.25 \(page 2\), converted 21,000\.26 \(page 1\), difference 0\.01/);
    assert.match(differencesCsv([result]), /part\.pdf,DIFFERENCES,Different value,Holding 21,"21,000\.25",2,"21,000\.26",1,0\.01/);
  });

  it('counts a value shown differently as the same value, apart from real differences', () => {
    const result = comparePart('part.pdf', readPdf(original), readPdf(converted((r) => [r.a, r.b.replace(/^\((.*)\)$/, '-$1'), r.c])));
    assert.equal(verdict(result), 'MATCH');
    assert.equal(result.differences.filter((d) => d.kind === 'format').length, 10);
  });

  it('reports values missing on either side', () => {
    const result = comparePart('part.pdf', readPdf(original), readPdf(converted((r, k) => (k === 5 ? [r.a, r.c] : [r.a, r.b, r.c]))));
    const missing = result.differences.filter((d) => d.kind === 'only-original');
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.original!.raw, '5.10');
  });

  it('says when the part is not in the original', () => {
    const other = makePdf([[{ x: 40, y: 560, text: 'Something else' }, ...row(540, 'Alpha', ['1.00']), ...row(520, 'Beta', ['2.00'])]]);
    const result = comparePart('other.pdf', readPdf(original), readPdf(other));
    assert.equal(result.found, false);
    assert.equal(verdict(result), 'NOT CHECKED');
  });
});

describe('parameter values a report tests for', () => {
  it('reads values compared with a parameter, listed for it, or a yes/no flag', () => {
    assert.deepEqual(valuesTested('if {?report_type} = "Monthly" or \'Daily\' = {?Report_Type} then true', 'report_type'), ['Monthly', 'Daily']);
    assert.deepEqual(valuesTested('{?kind} in ["A", "B"] and {?level} > 3', 'kind'), ['A', 'B']);
    assert.deepEqual(valuesTested('{?kind} in ["A", "B"] and {?level} > 3', 'level'), ['3']);
    assert.deepEqual(valuesTested('if not {?Pm-show} then crRed', 'show'), ['True', 'False']);
    assert.deepEqual(valuesTested('{?other} = 1', 'kind'), []);
  });
});

describe('zip files for download', () => {
  it('writes entries with their names, sizes and checksums', () => {
    const data = new TextEncoder().encode('hello hello hello hello\n'.repeat(40));
    const zip = zipFiles([{ name: 'a/b.txt', data }, { name: 'c.bin', data: new Uint8Array([1, 2, 3]) }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const end = zip.length - 22;
    assert.equal(view.getUint32(end, true), 0x06054b50);
    assert.equal(view.getUint16(end + 10, true), 2);
    const dir = view.getUint32(end + 16, true);
    assert.equal(view.getUint32(dir, true), 0x02014b50);
    assert.equal(view.getUint32(dir + 16, true), crc32(data));
    assert.equal(view.getUint32(dir + 24, true), data.length);
    assert.equal(new TextDecoder().decode(zip.subarray(dir + 46, dir + 46 + 7)), 'a/b.txt');
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });
});
