/** Minimal XML element builder used to write RDL. */

export type XmlChild = XmlElement | string | number | boolean | null | undefined | false;

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlChild[];
}

/** Builds an element. Plain strings/numbers become escaped text; null/undefined/false are skipped. */
export function el(name: string, attributesOrChild?: Record<string, string> | XmlChild, ...children: XmlChild[]): XmlElement {
  const isAttributes = typeof attributesOrChild === 'object' && attributesOrChild !== null && !('children' in attributesOrChild);
  return {
    name,
    attributes: isAttributes ? (attributesOrChild as Record<string, string>) : {},
    children: isAttributes ? children : [attributesOrChild as XmlChild, ...children],
  };
}

/** Escapes text content. Quotes need no escaping in element text, which keeps expressions readable. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Characters XML 1.0 cannot carry at all are dropped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

const escapeAttribute = (text: string) => escapeXml(text).replace(/"/g, '&quot;');

function render(node: XmlElement, indent: string, out: string[]): void {
  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`)
    .join('');
  const children = node.children.filter((c) => c !== null && c !== undefined && c !== false);
  if (children.length === 0) {
    out.push(`${indent}<${node.name}${attrs} />`);
    return;
  }
  if (children.every((c) => typeof c !== 'object')) {
    out.push(`${indent}<${node.name}${attrs}>${children.map((c) => escapeXml(String(c))).join('')}</${node.name}>`);
    return;
  }
  out.push(`${indent}<${node.name}${attrs}>`);
  for (const child of children) {
    if (typeof child === 'object') render(child as XmlElement, `${indent}  `, out);
    else out.push(`${indent}  ${escapeXml(String(child))}`);
  }
  out.push(`${indent}</${node.name}>`);
}

export function toXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="utf-8"?>'];
  render(root, '', out);
  return out.join('\r\n') + '\r\n';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/**
 * Parses an XML document into elements (enough for report definitions: elements, attributes, text, CDATA;
 * comments, processing instructions and the DOCTYPE are skipped). Whitespace-only text between elements is
 * dropped; other text is kept as it is.
 */
export function parseXml(xml: string): XmlElement {
  const text = xml.replace(/^﻿/, '');
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = 0;
  const fail = (message: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new Error(`XML line ${line}: ${message}`);
  };
  const addText = (value: string) => {
    if (!stack.length) {
      if (value.trim()) fail('text outside the root element');
      return;
    }
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + value;
    else parent.children.push(value);
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(text.slice(i, lt)));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) fail('unclosed comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) fail('unclosed CDATA section');
      addText(text.slice(i + 9, end));
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) fail('unclosed processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) fail('unclosed declaration');
      i = end + 1;
    } else if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      if (end < 0) fail('unclosed end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`</${name}> does not match <${open?.name ?? '(none)'}>`);
      i = end + 1;
    } else {
      const tag = /^<([A-Za-z_][\w:.-]*)/.exec(text.slice(i, i + 256));
      if (!tag) fail('malformed tag');
      const element: XmlElement = { name: tag![1], attributes: {}, children: [] };
      i += tag![0].length;
      const attribute = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
      for (;;) {
        attribute.lastIndex = i;
        const m = attribute.exec(text);
        if (!m) break;
        element.attributes[m[1]] = decodeEntities(m[3] ?? m[4]);
        i = attribute.lastIndex;
      }
      while (/\s/.test(text[i] ?? '')) i++;
      const selfClosing = text[i] === '/';
      if (selfClosing) i++;
      if (text[i] !== '>') fail(`malformed tag <${element.name}>`);
      i++;
      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root) fail('more than one root element');
      else root = element;
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is not closed`);
  if (!root) throw new Error('XML: no root element');
  // Whitespace-only text between elements carries no meaning in a report definition.
  const prune = (e: XmlElement) => {
    if (e.children.some((c) => typeof c === 'object')) {
      e.children = e.children.filter((c) => typeof c === 'object' || (typeof c === 'string' && c.trim()));
    }
    for (const c of e.children) if (typeof c === 'object' && c) prune(c as XmlElement);
  };
  prune(root);
  return root;
}

/** Child elements of an element, optionally only those with a given name. */
export function childElements(parent: XmlElement, name?: string): XmlElement[] {
  return parent.children.filter((c): c is XmlElement => typeof c === 'object' && c !== null && (!name || (c as XmlElement).name === name));
}

/** The first child element with a name (a path "A/B/C" walks down). */
export function child(parent: XmlElement | undefined, path: string): XmlElement | undefined {
  let node = parent;
  for (const part of path.split('/')) node = node ? childElements(node, part)[0] : undefined;
  return node;
}

/** Text content of an element (its text children joined). */
export function textOf(element: XmlElement | undefined): string {
  return element ? element.children.filter((c) => typeof c === 'string' || typeof c === 'number').join('') : '';
}

/** Every element below (and including) a root, depth first. */
export function descendants(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    out.push(e);
    for (const c of childElements(e)) walk(c);
  };
  walk(root);
  return out;
}

export function cloneElement(element: XmlElement): XmlElement {
  return structuredClone(element);
}
