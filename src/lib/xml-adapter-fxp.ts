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
 *
 * Entities are decoded here rather than by fast-xml-parser, which decodes the
 * five named XML entities but leaves numeric references (`&#39;`, `&#x26;`,
 * `&#160;`) as literal text where the DOM decodes them. Decoding those
 * afterwards would decode twice: `&amp;#39;` is the text `&#39;`, not an
 * apostrophe. So the parser's own pass is off and one pass here does both.
 * Entities declared in a DOCTYPE are not expanded; no GPX generator writes one.
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
const CDATA_KEY = '#cdata';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_PATTERN = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;

/** Code points an XML 1.0 document may contain (its `Char` production). */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Decode XML entity and character references in a single pass. */
function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value;
  return value.replace(ENTITY_PATTERN, (match, hex?: string, dec?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named];
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? '', 10);
    return isXmlChar(cp) ? String.fromCodePoint(cp) : match;
  });
}

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
  processEntities: false,
  // CDATA is literal text: kept apart so the entity pass leaves it alone.
  cdataPropName: CDATA_KEY,
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
  if (tag === null || tag === '#text' || tag === '#comment' || tag === CDATA_KEY) return null;

  const attrs: Record<string, string> = {};
  const rawAttrs = entry[':@'] as Record<string, unknown> | undefined;
  if (rawAttrs) {
    for (const [key, value] of Object.entries(rawAttrs)) {
      const name = key.startsWith(ATTR_PREFIX) ? key.slice(ATTR_PREFIX.length) : key;
      attrs[name] = value == null ? '' : decodeEntities(String(value));
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
      text += value == null ? '' : decodeEntities(String(value));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(entry, CDATA_KEY)) {
      for (const part of (entry[CDATA_KEY] as FxpEntry[] | undefined) ?? []) {
        const value = part['#text'];
        text += value == null ? '' : String(value);
      }
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
    childElement(tag: string): XmlNode | null {
      const found = element.children.find(child => child.tag === tag);
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
