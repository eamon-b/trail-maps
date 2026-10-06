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

import type { LegRide, ResupplyLeg, ResupplyOption, ResupplySummary, StopAccess } from './resupply-plan';

/**
 * Dotted tokens that end no sentence: "U.S. 50", "Mt. Sonder", "approx. 3 km".
 * Initials ("U.S.", "J. R. R. Tolkien") are handled by `isAbbreviationDot`
 * itself; these are the multi-letter ones a trail description uses.
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

/** Whether the dot at `index` closes an initial ("U.S.", "J. R. R.") or a listed abbreviation ("Mt."). */
function isAbbreviationDot(prose: string, index: number): boolean {
  const word = prose.slice(0, index).match(/(\S+)$/)?.[1] ?? '';
  // "U.S." — the dot after the S sits behind a single capital letter, itself
  // behind another dotted letter.
  if (/^(?:[A-Z]\.)+[A-Z]$/.test(word)) return true;
  // A lone capital is an initial only inside a run of them: the next word is
  // one too ("J. R."), or the word before was ("R. Tolkien"). Otherwise it is
  // a letter that ends a sentence: "Water from tank B. Camp is beside it."
  if (/^[A-Z]$/.test(word)) {
    const before = prose.slice(0, index - 1).match(/(\S+)\s+$/)?.[1] ?? '';
    const after = prose.slice(index + 1).match(/^\s?(\S+)/)?.[1] ?? '';
    if (!/^[A-Z]/.test(after)) return false;
    return /^[A-Z]\.?$/.test(after) || /^[A-Z]\.$/.test(before);
  }
  return NON_TERMINAL_ABBREVIATIONS.has(word.replace(/^[^a-z]+/i, '').toLowerCase());
}

/**
 * How far off the route the place is, and how you get there.
 *
 * `formatKm` carries the unit: the web passes ``km => `${km.toFixed(1)} km` ``,
 * the phone `km => formatDistance(km, units)`.
 */
export function accessSummary(
  option: Pick<ResupplyOption, 'offTrailKm' | 'accessMode' | 'accessRoute'>,
  formatKm: (km: number) => string
): string {
  const hasKm = typeof option.offTrailKm === 'number' && option.offTrailKm > 0;
  const mode = option.accessMode;
  if (hasKm && option.accessRoute) return `${formatKm(option.offTrailKm!)} on foot via ${option.accessRoute.name}`;
  if (hasKm) return `${formatKm(option.offTrailKm!)} ${mode && mode !== 'on-trail' ? mode : 'off trail'}`;
  if (mode === 'on-trail') return 'on trail';
  return mode ?? '';
}

/**
 * The one line that sits above a set of legs — the web's Resupply datasheet
 * subtitle and the Days-tab collapsible, the phone's Resupply section subtitle.
 *
 * No stops is the full carry, start to end (`computeResupplyLegs` emits it as
 * the one leg), and says so rather than "0 stops · longest carry …".
 */
export function resupplySummaryText(
  summary: ResupplySummary,
  formatKm: (km: number) => string,
  formatFoodKg: (kg: number) => string
): string {
  const days = `${summary.longestDays} day${summary.longestDays === 1 ? '' : 's'}`;
  if (summary.stops === 0) {
    return `No resupply stops · full carry ${formatKm(summary.longestKm)} / ${days} · ` +
      `${formatFoodKg(summary.totalFoodKg)} food`;
  }
  const stops = `${summary.stops} stop${summary.stops === 1 ? '' : 's'}`;
  return `${stops} · longest carry ${formatKm(summary.longestKm)} / ${days} · ` +
    `${formatFoodKg(summary.totalFoodKg)} food in total`;
}

/**
 * A leg's distance with the trail and off-trail km kept apart:
 * "52.3 km" on the trail alone, "52.3 km + 4.0 km off trail" with a walk into
 * or out of a town. The trail figure is the one the datasheet's km add up to.
 */
export function legDistanceText(
  leg: Pick<ResupplyLeg, 'distanceKm' | 'offTrailWalkKm'>,
  formatKm: (km: number) => string
): string {
  const trail = formatKm(leg.distanceKm);
  return leg.offTrailWalkKm > 0 ? `${trail} + ${formatKm(leg.offTrailWalkKm)} off trail` : trail;
}

/**
 * The off-trail km a leg covers without walking, which its days and food leave
 * out: "35.0 km hitch in · 24.1 km hitch out, not walked". Empty when there are none.
 */
export function legRidesText(
  leg: Pick<ResupplyLeg, 'rides'>,
  formatKm: (km: number) => string
): string {
  if (leg.rides.length === 0) return '';
  const parts = leg.rides.map(ride => `${formatKm(ride.km)} ${rideWord(ride.mode)} ${ride.end === 'to' ? 'in' : 'out'}`);
  return `${parts.join(' · ')}, not walked`;
}

/**
 * The extra beyond the turn-off on the way to a stop, for a readout that
 * measures to the turn-off ("12.3 km + 2.0 km off trail"): the walk in, or the
 * ride in. Empty for a stop on the route.
 */
export function stopAccessText(
  access: StopAccess | undefined,
  formatKm: (km: number) => string
): string {
  if (!access) return '';
  if (access.walkKm > 0) return `+ ${formatKm(access.walkKm)} off trail`;
  if (access.rideKm > 0) return `+ ${formatKm(access.rideKm)} ${rideWord(access.rideMode)}`;
  return '';
}

/** "hitch", "shuttle", "boat" — or, when the data does not say how, "off trail". */
function rideWord(mode: LegRide['mode']): string {
  return mode ?? 'off trail';
}
