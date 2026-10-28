import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertArgs } from '../src/ui/server.ts';
import { readBranding } from '../src/ui/house.ts';
import { page } from '../src/ui/page.ts';

describe('the app turning page choices into a conversion', () => {
  it('uses the team conventions kept with the app, the prefix and the section id', () => {
    const args = convertArgs('in', 'out', { prefix: 'Pack', sectionId: '12', sharedDataSource: 'Shared', chartAxisFormat: '0.00%', parameters: 'kind=A', splitSubreports: true, partsFormat: 'report', rdlOnly: true }, 'team.json');
    assert.deepEqual(args, ['to-rdl', 'in', 'out', '--conventions', 'team.json', '--prefix', 'Pack', '--shared-datasource', 'Shared', '--parameter', 'section_id=12', '--parameter', 'kind=A',
      '--chart-axis-format', '0.00%', '--split-subreports', '--parts-format', 'report', '--rdl-only']);
  });

  it('leaves out what was not given, and takes no prefix without conventions', () => {
    assert.deepEqual(convertArgs('in', 'out', { prefix: 'Pack', sectionId: ' ', partsFormat: 'report' }), ['to-rdl', 'in', 'out']);
  });

  it('takes only a whole number as the section id', () => {
    assert.throws(() => convertArgs('in', 'out', { sectionId: '12a' }, 'team.json'), /whole number/);
  });
});

describe('the app look', () => {
  it('takes the branding colours, font, name and logo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'look-'));
    writeFileSync(join(dir, 'logo.png'), Buffer.from([137, 80, 78, 71]));
    const b = readBranding(JSON.stringify({ name: 'Tools & Co', logo: 'logo.png', font: 'Arial, sans-serif', colors: { header: '#123456', accent: 'rgb(1, 2, 3)' } }), dir);
    assert.equal(b.logo, 'data:image/png;base64,iVBORw==');
    const html = page('tok', true, { tabs: ['convert'], branding: b });
    assert.match(html, /<title>Tools &#38; Co<\/title>/);
    assert.match(html, /:root\{--head:#123456;--accent:rgb\(1, 2, 3\);--font:Arial, sans-serif\}/);
    assert.match(html, /<img class="logo" src="data:image\/png;base64,iVBORw==" alt="">/);
    assert.match(html, /var SHOWN = \["convert"\];/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses values that could break the page', () => {
    assert.throws(() => readBranding('{"colors":{"header":"red;}body{x:1"}}', '.'), /colour "header"/);
    assert.throws(() => readBranding('{"colors":{"banner":"#fff"}}', '.'), /unknown colour/);
    assert.throws(() => readBranding('{"font":"Arial}<"}', '.'), /font/);
    assert.throws(() => readBranding('{"logo":"logo.exe"}', '.'), /logo/);
  });

  it('shows every tab without a build choice', () => {
    assert.match(page('tok', false), /var SHOWN = null;/);
  });
});
