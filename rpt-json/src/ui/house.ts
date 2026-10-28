import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

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

export interface Branding {
  name?: string;
  tagline?: string;
  logo?: string;
  font?: string;
  colors: Record<string, string>;
}

export const COLOR_KEYS = ['header', 'headerText', 'accent', 'accentText', 'background', 'panel', 'text', 'muted', 'line', 'soft', 'nav'] as const;

const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\))$/i;
const FONT = /^[A-Za-z0-9 ,"'-]{1,120}$/;
const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

export function readBranding(json: string, folder: string): Branding {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`branding.json is not valid JSON: ${(err as Error).message}`);
  }
  const text = (key: string) => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > 80) throw new Error(`branding.json: "${key}" must be a text of up to 80 characters`);
    return v.trim();
  };
  const colors: Record<string, string> = {};
  const given = (raw.colors ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(given)) {
    if (!(COLOR_KEYS as readonly string[]).includes(k)) throw new Error(`branding.json: unknown colour "${k}" (expected ${COLOR_KEYS.join(', ')})`);
    if (typeof v !== 'string' || !COLOR.test(v.trim())) throw new Error(`branding.json: colour "${k}" must be like #1f6feb or rgb(31, 111, 235)`);
    colors[k] = v.trim();
  }
  const font = text('font');
  if (font && !FONT.test(font)) throw new Error('branding.json: "font" may hold only font names, commas and quotes');
  let logo: string | undefined;
  const logoFile = text('logo');
  if (logoFile) {
    const path = resolve(folder, logoFile);
    const type = IMAGE[extname(path).toLowerCase()];
    if (!type) throw new Error('branding.json: "logo" must be a .png, .jpg, .gif or .svg file');
    if (!existsSync(path)) throw new Error(`branding.json: the logo file ${logoFile} was not found next to it`);
    const data = readFileSync(path);
    if (data.length > 512 * 1024) throw new Error('branding.json: the logo file is larger than 512 KB');
    logo = `data:${type};base64,${data.toString('base64')}`;
  }
  return { name: text('name'), tagline: text('tagline'), font, logo, colors };
}

function houseFolder(): string | undefined {
  const roots = [process.cwd(), process.argv[1] ? resolve(dirname(process.argv[1]), '..') : ''].filter(Boolean);
  for (const root of [...roots, ...roots.map((r) => resolve(r, '..'))]) {
    const folder = join(root, 'house-style');
    if (existsSync(folder)) return folder;
  }
  return undefined;
}

export function houseBranding(): Branding | undefined {
  const fromPack = globalThis as { houseBranding?: Branding };
  if (fromPack.houseBranding) return fromPack.houseBranding;
  const folder = houseFolder();
  const file = folder ? join(folder, 'branding.json') : undefined;
  return file && existsSync(file) ? readBranding(readFileSync(file, 'utf8'), folder!) : undefined;
}

export function appTabs(): string[] | undefined {
  const fromPack = globalThis as { appTabs?: string[] };
  return Array.isArray(fromPack.appTabs) ? fromPack.appTabs : undefined;
}
