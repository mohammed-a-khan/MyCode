import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const packed = globalThis as { houseConventions?: string };

export function houseConventions(): { text: string; from: string } | undefined {
  if (typeof packed.houseConventions === 'string') return { text: packed.houseConventions, from: 'packed' };
  const roots = [process.cwd(), process.argv[1] ? resolve(dirname(process.argv[1]), '..') : ''].filter(Boolean);
  for (const root of [...roots, ...roots.map((r) => resolve(r, '..'))]) {
    const file = join(root, 'house-style', 'conventions.json');
    if (existsSync(file)) return { text: readFileSync(file, 'utf8'), from: file };
  }
  return undefined;
}
