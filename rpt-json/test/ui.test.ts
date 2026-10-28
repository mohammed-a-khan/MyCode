import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertArgs } from '../src/ui/server.ts';

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
