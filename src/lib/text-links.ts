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
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

/**
 * The longest URL made into a link. Anything longer is left as plain text:
 * no real page address is this long, and the cap bounds the work an imported
 * GPX `<desc>` can ask of every render.
 */
export const MAX_LINK_LENGTH = 2048;

/**
 * Drop trailing sentence punctuation and any closing bracket the URL did not
 * open ("(see https://example.com/page)."). One count, one pass back from the
 * end: linear however many brackets the text piles up.
 */
function trimUrl(raw: string): string {
  let opens = 0;
  let closes = 0;
  for (const char of raw) {
    if (char === '(') opens++;
    else if (char === ')') closes++;
  }
  let end = raw.length;
  for (;;) {
    while (end > 0 && TRAILING_PUNCTUATION.has(raw[end - 1])) end--;
    if (end > 0 && raw[end - 1] === ')' && opens < closes) {
      end--;
      closes--;
      continue;
    }
    return raw.slice(0, end);
  }
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
    if (match[0].length > MAX_LINK_LENGTH) continue;
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
