/**
 * The stored structure of every chart in a report, with names and text replaced by placeholders: for working
 * out how a chart is defined without sharing the report's names or data.
 */

import type { CfbDocument, CfbNode, CfbStorage } from '../cfb/types.ts';
import { decodedToJson } from './decodedJson.ts';
import { decodeStream } from './streams.ts';

const CHART_START = '0x00b4';
const CHART_END = '0x00b5';
/** Crystal's own words that say how a value is used; everything after them is a name and is hidden. */
const KEPT_PREFIX = /^(Sum|Count|Average|Maximum|Minimum|Distinct count|Median|Mode|Nth largest|Nth smallest|Percentage|Standard deviation|Variance|Pop\. [a-z ]+) of /i;
const KEPT = /^(Group #\d+ (Name|Order)|Page Number|Total Page Count|Record Number|Print Date)$/i;

type Json = { type?: string; name?: string; content?: Json[]; hex?: string; text?: string };

export function chartStructure(doc: CfbDocument): string {
  const placeholders = new Map<string, string>();
  const hide = (text: string): string => {
    if (!text) return '""';
    if (KEPT.test(text)) return `"${text}"`;
    const prefix = KEPT_PREFIX.exec(text)?.[0] ?? '';
    const rest = text.slice(prefix.length);
    let id = placeholders.get(rest);
    if (!id) {
      id = `S${placeholders.size + 1}`;
      placeholders.set(rest, id);
    }
    // Field references keep their shape ({table.field} as T.F, formulas as @, parameters as ?).
    const kind = /^@/.test(rest) ? '@' : /^\?/.test(rest) ? '?' : /^#/.test(rest) ? '#' : /\./.test(rest) ? 'field:' : '';
    return `"${prefix}${kind}${id}"`;
  };
  const lines: string[] = [];
  const show = (record: Json, depth: number) => {
    const parts = (record.content ?? []).map((c) => (c.type ? null : c.hex !== undefined ? c.hex : hide(c.text ?? ''))).filter((p) => p !== null);
    lines.push(`${'  '.repeat(depth)}${record.type}${record.name ? ` ${record.name}` : ''}: ${parts.join(' ')}`);
    for (const c of record.content ?? []) if (c.type) show(c, depth + 1);
  };
  const reportStreams: [string, CfbNode | undefined][] = [['main report', child(doc.root, 'Contents')]];
  for (const c of doc.root.children) {
    if (c.type === 'storage' && /^Subdocument \d+$/.test(c.name)) reportStreams.push([c.name, child(c, 'Contents')]);
  }
  for (const [label, stream] of reportStreams) {
    if (!stream || stream.type !== 'stream') continue;
    let records: Json[];
    try {
      const json = decodedToJson(decodeStream('contents', stream.data)) as { records?: Json[] };
      records = json.records ?? [];
    } catch {
      continue;
    }
    let inChart = false;
    let count = 0;
    for (const record of records) {
      if (record.type === CHART_START) {
        inChart = true;
        lines.push('', `== ${label}: chart ${++count}`);
      }
      if (inChart) show(record, 1);
      if (record.type === CHART_END) inChart = false;
    }
  }
  if (!lines.length) return 'No charts found.\n';
  return `${lines.join('\n').trim()}\n\n(Names and text are replaced by S1, S2, ...; the same name always gets the same placeholder.)\n`;
}

function child(storage: CfbStorage, name: string): CfbNode | undefined {
  return storage.children.find((c) => c.name === name);
}
