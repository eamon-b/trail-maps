/**
 * `XmlAdapter` backed by fast-xml-parser — the React Native path.
 *
 * Hermes has no DOMParser, so the mobile app parses GPX through this adapter.
 * It is kept in its own module so web/build bundles that use DOMParser or jsdom
 * never pull fast-xml-parser in.
 *
 * The parser runs in `preserveOrder` mode, which is what makes DOM parity
 * possible: document order is load-bearing for GPX (track point order *is* the
 * route). `trimValues: false` is equally deliberate — DOM `textContent` does not
 * trim, and the build pipeline feeds raw text straight into waypoint names.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { XmlAdapter, XmlNode } from './xml-adapter';

/** One element in the intermediate tree built from fast-xml-parser output. */
interface FxpElement {
  tag: string;
  attrs: Record<string, string>;
  children: FxpElement[];
  /** Concatenated descendant text, matching DOM `textContent`. */
  text: string;
}

/** A `preserveOrder` entry: `{ tagName: [...children], ':@': {attrs} }` or `{ '#text': '...' }`. */
type FxpEntry = Record<string, unknown>;

const ATTR_PREFIX = '@_';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // CSS type selectors ignore namespaces, so drop prefixes to match the DOM
  // adapters (`<gpxx:name>` has to answer to `querySelector('name')`).
  removeNSPrefix: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function tagOf(entry: FxpEntry): string | null {
  for (const key of Object.keys(entry)) {
    if (key === ':@') continue;
    return key;
  }
  return null;
}

function elementFromEntry(entry: FxpEntry): FxpElement | null {
  const tag = tagOf(entry);
  if (tag === null || tag === '#text' || tag === '#comment') return null;

  const attrs: Record<string, string> = {};
  const rawAttrs = entry[':@'] as Record<string, unknown> | undefined;
  if (rawAttrs) {
    for (const [key, value] of Object.entries(rawAttrs)) {
      const name = key.startsWith(ATTR_PREFIX) ? key.slice(ATTR_PREFIX.length) : key;
      attrs[name] = value == null ? '' : String(value);
    }
  }

  const { children, text } = childrenFromEntries((entry[tag] as FxpEntry[] | undefined) ?? []);
  return { tag, attrs, children, text };
}

function childrenFromEntries(entries: FxpEntry[]): { children: FxpElement[]; text: string } {
  const children: FxpElement[] = [];
  let text = '';
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(entry, '#text')) {
      const value = entry['#text'];
      text += value == null ? '' : String(value);
      continue;
    }
    const child = elementFromEntry(entry);
    if (child) {
      children.push(child);
      text += child.text;
    }
  }
  return { children, text };
}

function collectDescendants(element: FxpElement, tag: string, out: FxpElement[]): void {
  for (const child of element.children) {
    if (child.tag === tag) out.push(child);
    collectDescendants(child, tag, out);
  }
}

function firstDescendant(element: FxpElement, tag: string): FxpElement | null {
  for (const child of element.children) {
    if (child.tag === tag) return child;
    const nested = firstDescendant(child, tag);
    if (nested) return nested;
  }
  return null;
}

function toXmlNode(element: FxpElement): XmlNode {
  return {
    querySelectorAll(tag: string): XmlNode[] {
      const found: FxpElement[] = [];
      collectDescendants(element, tag, found);
      return found.map(toXmlNode);
    },
    querySelector(tag: string): XmlNode | null {
      const found = firstDescendant(element, tag);
      return found ? toXmlNode(found) : null;
    },
    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(element.attrs, name) ? element.attrs[name] : null;
    },
    textContent: element.text,
  };
}

export interface FxpAdapterOptions {
  /**
   * Run fast-xml-parser's validator before parsing so malformed XML throws
   * instead of silently producing a truncated tree (default: true). Costs a
   * second pass over the string; turn off only for input already known good.
   */
  validate?: boolean;
}

/** Build a fast-xml-parser–backed {@link XmlAdapter}. */
export function createFxpXmlAdapter(options: FxpAdapterOptions = {}): XmlAdapter {
  const validate = options.validate ?? true;
  return (xml: string): XmlNode => {
    if (validate) {
      const result = XMLValidator.validate(xml);
      if (result !== true) {
        throw new Error(`Invalid GPX XML: ${result.err.msg} (line ${result.err.line})`);
      }
    }
    const entries = parser.parse(xml) as FxpEntry[];
    const { children, text } = childrenFromEntries(entries);
    return toXmlNode({ tag: '#document', attrs: {}, children, text });
  };
}

/** Default fast-xml-parser adapter (validates input). */
export const fxpXmlAdapter: XmlAdapter = createFxpXmlAdapter();
