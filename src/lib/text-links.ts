/**
 * Finding web links in free text — waypoint descriptions carry bare URLs
 * (Shikoku's henro.org / henrohouse.jp pages), and the app makes them tappable.
 *
 * Platform-neutral: this only splits the text; each platform renders the
 * segments. Every `href` has passed `safeHttpUrl`, so nothing but http(s)
 * ever reaches a link.
 */

import { safeHttpUrl } from './poi-display';

export interface TextSegment {
  text: string;
  /** Set on a link segment: the normalised http(s) URL to open. */
  href?: string;
}

// `http(s)://…` or a bare `www.…`, up to whitespace or a character that never
// belongs to a URL written in prose.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

// Sentence punctuation that follows a URL rather than ending it.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, '');
  // "(see https://example.com/page)" — drop a closing bracket the URL did not open.
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
  return url;
}

/**
 * Split `text` into plain and link segments, in order. Joining every segment's
 * `text` gives back the input unchanged.
 */
export function splitTextLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    const href = safeHttpUrl(url);
    if (!href || url.length === 0) continue;

    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: url, href });
    last = start + url.length;
  }

  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
