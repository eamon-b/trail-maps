/**
 * Minimal XML node interface shared by every GPX parser front-end.
 *
 * The GPX parsers only ever need four operations, and every selector they use
 * is a bare tag name (`trk`, `trkseg`, `trkpt`, `name`, `ele`, ...). That makes
 * the DOM surface small enough to re-implement on top of a non-DOM XML parser,
 * which is what lets `parseGpx` run in the browser (DOMParser), in build
 * scripts (jsdom) and in React Native (fast-xml-parser) from one code path.
 *
 * Semantics follow the DOM:
 * - `querySelectorAll(tag)` returns *descendants* (never the node itself) whose
 *   tag matches, in document order.
 * - `querySelector(tag)` returns the first such descendant, or null.
 * - `textContent` is the concatenation of every descendant text node, untrimmed.
 * - Namespace prefixes are ignored (`gpxx:name` matches `name`), matching how a
 *   CSS type selector behaves against an XML document.
 *
 * This module must stay free of Node and browser imports so it can be bundled
 * into the mobile app; the DOMParser path below is feature-detected at call
 * time rather than at module scope.
 */

/** A single element (or document) node exposed to the GPX parsers. */
export interface XmlNode {
  /** Descendant elements with this tag name, in document order. */
  querySelectorAll(tag: string): XmlNode[];
  /** First descendant element with this tag name, or null. */
  querySelector(tag: string): XmlNode | null;
  /** Attribute value, or null when absent. */
  getAttribute(name: string): string | null;
  /** Concatenated descendant text, untrimmed (DOM `textContent` semantics). */
  readonly textContent: string | null;
}

/** Parses an XML string into a root {@link XmlNode}. Throws on malformed XML. */
export type XmlAdapter = (xml: string) => XmlNode;

/**
 * Structural subset of a DOM `Element`/`Document` — enough to wrap either one
 * without importing DOM lib types into the mobile typecheck.
 */
export interface DomLikeNode {
  querySelectorAll(selector: string): ArrayLike<DomLikeNode>;
  querySelector(selector: string): DomLikeNode | null;
  getAttribute?(name: string): string | null;
  readonly textContent: string | null;
}

/** Wrap a DOM element/document (browser DOM, jsdom, ...) as an {@link XmlNode}. */
export function wrapDomNode(node: DomLikeNode): XmlNode {
  return {
    querySelectorAll(tag: string): XmlNode[] {
      const found = node.querySelectorAll(tag);
      const out: XmlNode[] = [];
      for (let i = 0; i < found.length; i++) out.push(wrapDomNode(found[i]));
      return out;
    },
    querySelector(tag: string): XmlNode | null {
      const found = node.querySelector(tag);
      return found ? wrapDomNode(found) : null;
    },
    getAttribute(name: string): string | null {
      return node.getAttribute ? node.getAttribute(name) : null;
    },
    get textContent(): string | null {
      return node.textContent;
    },
  };
}

/**
 * Wrap a parsed DOM document, converting the browser/jsdom `<parsererror>`
 * sentinel into a thrown error. Shared by the DOMParser and jsdom adapters.
 */
export function wrapDomDocument(doc: DomLikeNode): XmlNode {
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`Invalid GPX XML: ${parseError.textContent ?? 'parse error'}`);
  }
  return wrapDomNode(doc);
}

/**
 * Adapter backed by the platform `DOMParser` (browsers, and any test
 * environment such as jsdom that installs one globally).
 */
export const domParserXmlAdapter: XmlAdapter = (xml: string): XmlNode => {
  if (typeof DOMParser === 'undefined') {
    throw new Error(
      'No DOMParser available. Pass an XmlAdapter explicitly (jsdom in scripts, fast-xml-parser on mobile).'
    );
  }
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return wrapDomDocument(doc as unknown as DomLikeNode);
};

/**
 * The adapter to use when the caller did not supply one: DOMParser where it
 * exists, otherwise a clear error telling the caller to inject one. React
 * Native has no DOMParser, so mobile callers always pass `fxpXmlAdapter`.
 */
export function defaultXmlAdapter(): XmlAdapter {
  return domParserXmlAdapter;
}
