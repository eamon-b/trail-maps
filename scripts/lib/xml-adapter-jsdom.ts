/**
 * jsdom-backed `XmlAdapter` for the Node build scripts.
 *
 * Lives under `scripts/` on purpose: `src/lib` is bundled into the mobile app,
 * and jsdom must never end up on that import path.
 */

import { JSDOM } from 'jsdom';
import { wrapDomDocument, type DomLikeNode, type XmlAdapter, type XmlNode } from '../../src/lib/xml-adapter.js';

export const jsdomXmlAdapter: XmlAdapter = (xml: string): XmlNode => {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  return wrapDomDocument(dom.window.document as unknown as DomLikeNode);
};
