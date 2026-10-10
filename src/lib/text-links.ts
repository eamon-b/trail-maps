/**
 * Finding links in free text — waypoint descriptions carry bare URLs
 * (Shikoku's henro.org / henrohouse.jp pages), email addresses and phone
 * numbers ("Tel: 0885-42-4655", "Phone: (09) 402 7678"), and the app makes
 * them tappable.
 *
 * Platform-neutral: this only splits the text; each platform renders the
 * segments. A link's `href` is only ever http(s) (through `safeHttpUrl`),
 * `mailto:` or `tel:` (through `safeTelUrl`).
 */

import { safeHttpUrl, safeTelUrl } from './poi-display';

export type TextLinkKind = 'url' | 'email' | 'phone';

export interface TextSegment {
  text: string;
  /** Set on a link segment: the http(s), `mailto:` or `tel:` URL to open. */
  href?: string;
  /** Set on a link segment: what kind of link it is. */
  kind?: TextLinkKind;
}

// `http(s)://…` or a bare `www.…`, up to whitespace or a character that never
// belongs to a URL written in prose.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

// Sentence punctuation that follows a URL rather than ending it.
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

// An address as people write one in prose. The local part may not start with
// a dot, and the domain must end in a letters-only top-level domain.
const EMAIL_PATTERN =
  /(?<![\w.%+-])[A-Za-z0-9_%+-][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g;

// A run of digit groups joined by single spaces, hyphens or brackets, with an
// optional leading `+`. Never part of a longer number, a decimal or a word:
// descriptions also carry coordinates ("-23.5774"), OSM ids and km figures.
const PHONE_CANDIDATE = /(?<![\w.,/+-])\+?\(?\d(?:[ -]?\(?\d|\)[ -]?\d)*(?![\w/]|[.,]\d)/g;

// A label that says the number after it is a phone number, so it may be
// written without separators ("Tel: 0886942046").
const PHONE_LABEL = /\b(?:tel|telephone|phone|ph|mob|mobile|call)\.?:?\s*$/i;

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

/**
 * Whether a candidate digit run reads as a phone number. It needs 8-15 digits
 * and either a separator, a leading `+` or a label before it — a bare run of
 * digits is far more often an id than a number to call. A date
 * ("2026-09-21") and a 4-4 range ("0800-1700", "2019-2023") never are.
 */
function isPhoneNumber(candidate: string, before: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  if (digits < MIN_PHONE_DIGITS || digits > MAX_PHONE_DIGITS) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  if (/^\d{4} ?- ?\d{4}$/.test(candidate)) return false;
  const opens = candidate.split('(').length - 1;
  const closes = candidate.split(')').length - 1;
  if (opens !== closes || opens > 1) return false;
  if (opens === 1 && candidate.indexOf('(') > candidate.indexOf(')')) return false;
  const separated = /[ \-()]/.test(candidate) || candidate.startsWith('+');
  return separated || PHONE_LABEL.test(before);
}

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

interface Found {
  start: number;
  text: string;
  href: string;
}

/**
 * Split `text` into plain and link segments, in order. Joining every segment's
 * `text` gives back the input unchanged.
 *
 * URLs are found first, then email addresses in the text between them, then
 * phone numbers in what is left — so a number inside a URL or an address is
 * never linked on its own.
 */
export function splitTextLinks(text: string): TextSegment[] {
  const inPlainText = (kind: TextLinkKind, find: (text: string) => Found[]) => (segment: TextSegment) =>
    segment.href ? [segment] : splitBy(segment.text, kind, find);
  return splitBy(text, 'url', findUrls)
    .flatMap(inPlainText('email', findEmails))
    .flatMap(inPlainText('phone', findPhones));
}

function splitBy(text: string, kind: TextLinkKind, find: (text: string) => Found[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const found of find(text)) {
    if (found.start > last) segments.push({ text: text.slice(last, found.start) });
    segments.push({ text: found.text, href: found.href, kind });
    last = found.start + found.text.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

function findUrls(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match[0].length > MAX_LINK_LENGTH) continue;
    const url = trimUrl(match[0]);
    const href = safeHttpUrl(url);
    if (!href || url.length === 0) continue;
    found.push({ start: match.index ?? 0, text: url, href });
  }
  return found;
}

function findEmails(text: string): Found[] {
  return [...text.matchAll(EMAIL_PATTERN)].map(match => ({
    start: match.index ?? 0,
    text: match[0],
    href: `mailto:${match[0]}`,
  }));
}

function findPhones(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const start = match.index ?? 0;
    // A label is read from the line the number is on, at most a few words back.
    const before =
      text
        .slice(Math.max(0, start - 20), start)
        .split('\n')
        .pop() ?? '';
    if (!isPhoneNumber(match[0], before)) continue;
    const href = safeTelUrl(match[0]);
    if (href) found.push({ start, text: match[0], href });
  }
  return found;
}
