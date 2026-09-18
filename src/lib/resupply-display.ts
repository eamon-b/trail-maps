/**
 * The platform-neutral half of *showing* a resupply option — the `poi-display.ts`
 * pattern: the words live here, the markup and the styling stay with each UI.
 *
 * Every figure that has a unit is formatted by a function the caller passes in,
 * because the web pages are metric and the phone follows the hiker's unit
 * setting. The wording ("hitch", "off trail", "longest carry …") is shared, so
 * the two platforms cannot describe the same place differently.
 *
 * DOM-free and dependency-free beyond `src/lib`.
 */

import type { ResupplyOption, ResupplySummary } from './resupply-plan';

/**
 * Dotted tokens that end no sentence: "U.S. 50", "Mt. Sonder", "approx. 3 km".
 * A single capital letter before the dot (the "S" of "U.S.") is handled by the
 * pattern itself; these are the multi-letter ones a trail description uses.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mt', 'mtn', 'st', 'hwy', 'rd', 'jct', 'approx', 'alt', 'elev', 'ft', 'km', 'mi', 'no', 'vs', 'etc', 'inc', 'co', 'ltd',
]);

/**
 * The lead sentence of a description, which is the part that says what is
 * there. The trail generators prefix their descriptions with `|`-separated
 * metadata ("mi 1947.3 (SOBO mi 1947.3) | off. mi 1955.8 | CO | Leave the CDT
 * here for Salida…"), so the prose is the last segment.
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace or the end of the
 * text — unless the dot closes an initial or an abbreviation ("U.S. 50",
 * "Mt. Sonder"), which would otherwise cut the sentence to "Store beside U.S."
 */
export function firstSentence(text: string): string {
  const segments = text.split('|').map(part => part.trim()).filter(part => part !== '');
  const prose = segments.length > 0 ? segments[segments.length - 1] : '';

  const terminator = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(prose)) !== null) {
    const end = match.index + 1;
    if (match[0] === '.' && isAbbreviationDot(prose, match.index)) continue;
    return prose.slice(0, end).trim();
  }
  return prose.trim();
}

/** Whether the dot at `index` closes an initial ("U.S.") or a listed abbreviation ("Mt."). */
function isAbbreviationDot(prose: string, index: number): boolean {
  const word = prose.slice(0, index).match(/(\S+)$/)?.[1] ?? '';
  // "U.S." — the dot after the S sits behind a single capital letter, itself
  // behind another dotted letter or the start of the word.
  if (/^(?:[A-Z]\.)*[A-Z]$/.test(word)) return true;
  return NON_TERMINAL_ABBREVIATIONS.has(word.replace(/^[^a-z]+/i, '').toLowerCase());
}

/**
 * How far off the route the place is, and how you get there.
 *
 * `formatKm` carries the unit: the web passes ``km => `${km.toFixed(1)} km` ``,
 * the phone `km => formatDistance(km, units)`.
 */
export function accessSummary(
  option: Pick<ResupplyOption, 'offTrailKm' | 'accessMode'>,
  formatKm: (km: number) => string
): string {
  const hasKm = typeof option.offTrailKm === 'number' && option.offTrailKm > 0;
  const mode = option.accessMode;
  if (hasKm) return `${formatKm(option.offTrailKm!)} ${mode && mode !== 'on-trail' ? mode : 'off trail'}`;
  if (mode === 'on-trail') return 'on trail';
  return mode ?? '';
}

/**
 * The one line that sits above a set of legs — the web's Resupply datasheet
 * subtitle and the Days-tab collapsible, the phone's Resupply section subtitle.
 */
export function resupplySummaryText(
  summary: ResupplySummary,
  formatKm: (km: number) => string,
  formatFoodKg: (kg: number) => string
): string {
  const stops = `${summary.stops} stop${summary.stops === 1 ? '' : 's'}`;
  const days = `${summary.longestDays} day${summary.longestDays === 1 ? '' : 's'}`;
  return `${stops} · longest carry ${formatKm(summary.longestKm)} / ${days} · ` +
    `${formatFoodKg(summary.totalFoodKg)} food in total`;
}
