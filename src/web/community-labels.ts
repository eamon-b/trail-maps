/**
 * The words for a community route's status and place, shared by the landing
 * page (`index.ts`) and the community pages (through `community-ui.ts`, which
 * re-exports them).
 *
 * A module of its own, with nothing heavier than `@lib/trail-regions` behind
 * it, so the landing page does not pull in `community-ui`'s dependencies
 * (`@lib/gpx-import` and the ingest pipeline, for `localCopyId`).
 */

import type { CommunityRouteDetail, CommunityRouteStatus } from '@lib/community-types';
import { countryName, stateName } from '@lib/trail-regions';
import { escapeHtml } from './web-utils';

export const UNVERIFIED_EXPLANATION =
  'Unverified: shared by a hiker and passed automatic checks; not yet checked by a person.';
export const VERIFIED_EXPLANATION = 'Verified: checked and approved by a Tracknotes admin.';
export const HIDDEN_EXPLANATION = 'Hidden: not listed publicly; only its owner and admins can see it.';

const STATUS_LABELS: Record<CommunityRouteStatus, string> = {
  unverified: 'Unverified',
  verified: 'Verified',
  hidden: 'Hidden',
  removed: 'Removed',
};

/** A pill for a route's status, with the explanation as its tooltip. */
export function statusBadgeHtml(status: CommunityRouteStatus): string {
  const title =
    status === 'verified'
      ? VERIFIED_EXPLANATION
      : status === 'unverified'
        ? UNVERIFIED_EXPLANATION
        : status === 'hidden'
          ? HIDDEN_EXPLANATION
          : 'Removed.';
  const label = STATUS_LABELS[status] ?? String(status);
  return `<span class="community-badge community-badge-${escapeHtml(status)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

type HiddenReason = NonNullable<CommunityRouteDetail['hiddenReason']>;

const HIDDEN_REASON_TEXT: Record<HiddenReason, string> = {
  review: 'Hidden by the automatic review',
  reports: 'Hidden after reports from other users',
  admin: 'Hidden by a moderator',
};

/**
 * Why a hidden route is hidden, as its owner sees it ("Hidden by the
 * automatic review"), or "" when the route is not hidden or the server gave
 * no reason it knows.
 */
export function hiddenReasonText(detail: Pick<CommunityRouteDetail, 'status' | 'hiddenReason'>): string {
  if (detail.status !== 'hidden' || typeof detail.hiddenReason !== 'string') return '';
  return Object.prototype.hasOwnProperty.call(HIDDEN_REASON_TEXT, detail.hiddenReason)
    ? HIDDEN_REASON_TEXT[detail.hiddenReason]
    : '';
}

/** Text with line breaks kept, escaped. */
export function multilineHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

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
