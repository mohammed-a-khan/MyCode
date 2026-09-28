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
