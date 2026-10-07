/**
 * The words for a community route's status and place, shared by the landing
 * page (`index.ts`) and the community pages (through `community-ui.ts`, which
 * re-exports them).
 *
 * A module of its own, with nothing heavier than `@lib/trail-regions` behind
 * it, so the landing page does not pull in `community-ui`'s dependencies
 * (`@lib/gpx-import` and the ingest pipeline, for `localCopyId`).
 */

import { countryName, stateName } from '@lib/trail-regions';

export const UNVERIFIED_EXPLANATION =
  'Unverified: shared by a hiker and passed automatic checks; not yet checked by a person.';
export const VERIFIED_EXPLANATION = 'Verified: checked and approved by a Tracknotes admin.';

/**
 * A place from a country and its states, as the trail lists and route pages
 * show it: "Victoria, New South Wales" (or with `withCountry`, "Victoria, New
 * South Wales, Australia"); the country alone when no state is given; "" when
 * there is neither. An unlisted code is shown as it is.
 */
export function placeLabel(
  country: string | null | undefined,
  states: readonly (string | null | undefined)[] | null | undefined,
  withCountry = true,
): string {
  const names = (states ?? []).filter((s): s is string => !!s).map(s => stateName(country, s) ?? s);
  if (names.length === 0) return country ? countryName(country) : '';
  return withCountry && country ? `${names.join(', ')}, ${countryName(country)}` : names.join(', ');
}

/** "Victoria, Australia", "Japan", or the raw code for an unlisted country. */
export function regionLabel(country: string | null | undefined, state: string | null | undefined): string {
  return placeLabel(country, [state]) || countryName(country);
}
