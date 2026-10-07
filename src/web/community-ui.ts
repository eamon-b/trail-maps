/**
 * Pieces of community-route UI shared by the share step on upload.html, the
 * public route page and the admin queue: the check list, the status badge,
 * the region label and the country/state picker.
 *
 * Every string that came from a user or the server goes through `escapeHtml`.
 */

import type { CommunityAiReview, CommunityCheck } from '@lib/community-types';
import { hashString } from '@lib/gpx-import';
import { COUNTRIES, findCountry } from '@lib/trail-regions';
import { multilineHtml } from './community-labels';
import { escapeHtml } from './web-utils';

export {
  HIDDEN_EXPLANATION,
  UNVERIFIED_EXPLANATION,
  VERIFIED_EXPLANATION,
  hiddenReasonText,
  multilineHtml,
  placeLabel,
  regionLabel,
  statusBadgeHtml,
} from './community-labels';

const LEVEL_LABELS: Record<CommunityCheck['level'], string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
};

/** The automatic checks as a list, fails first, then warnings, then passes. */
export function checksListHtml(checks: readonly CommunityCheck[]): string {
  if (checks.length === 0) return '<p class="import-note">No checks recorded.</p>';
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  const sorted = [...checks].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));
  return `<ul class="community-checks">${sorted
    .map(
      c =>
        `<li class="community-check community-check-${escapeHtml(c.level)}"><span class="community-check-level">${escapeHtml(
          LEVEL_LABELS[c.level] ?? c.level,
        )}</span> ${escapeHtml(c.message)}</li>`,
    )
    .join('')}</ul>`;
}

/** Value of the country `<select>` that reveals the free two-letter field. */
export const OTHER_COUNTRY = '__other';

export interface RegionPicker {
  /** Upper-case ISO code, or null when nothing valid is chosen. */
  country(): string | null;
  /** A listed state code, or null. */
  state(): string | null;
  set(country: string | null, state: string | null): void;
}

/**
 * Wire a country `<select>`, a free "other" code input and a dependent state
 * `<select>` (hidden, with its label wrapper, when the country lists no states).
 */
export function initRegionPicker(
  countrySelect: HTMLSelectElement,
  otherInput: HTMLInputElement,
  stateSelect: HTMLSelectElement,
  stateWrapper: HTMLElement,
  otherWrapper: HTMLElement,
  onChange: () => void = () => {},
): RegionPicker {
  countrySelect.innerHTML =
    '<option value="">Choose a country…</option>' +
    COUNTRIES.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.name)}</option>`).join('') +
    `<option value="${OTHER_COUNTRY}">Other…</option>`;

  const fillStates = (selected: string | null): void => {
    const def = findCountry(countrySelect.value === OTHER_COUNTRY ? otherInput.value : countrySelect.value);
    const states = def?.states ?? [];
    stateWrapper.hidden = states.length === 0;
    stateSelect.innerHTML =
      '<option value="">Not specified / several</option>' +
      states.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)}</option>`).join('');
    stateSelect.value = selected && states.some(s => s.code === selected) ? selected : '';
  };

  const syncOther = (): void => {
    otherWrapper.hidden = countrySelect.value !== OTHER_COUNTRY;
  };

  countrySelect.addEventListener('change', () => {
    syncOther();
    fillStates(null);
    onChange();
  });
  otherInput.addEventListener('input', () => {
    fillStates(stateSelect.value || null);
    onChange();
  });
  stateSelect.addEventListener('change', onChange);
  syncOther();
  fillStates(null);

  const picker: RegionPicker = {
    country() {
      const raw = countrySelect.value === OTHER_COUNTRY ? otherInput.value.trim() : countrySelect.value;
      return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
    },
    state() {
      return stateWrapper.hidden ? null : stateSelect.value || null;
    },
    set(country, state) {
      const code = country?.toUpperCase() ?? '';
      if (!code) countrySelect.value = '';
      else if (findCountry(code)) countrySelect.value = code;
      else {
        countrySelect.value = OTHER_COUNTRY;
        otherInput.value = code;
      }
      syncOther();
      fillStates(state);
    },
  };
  return picker;
}

/** Encode text as UTF-8 base64 (btoa alone only takes Latin-1). */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The IndexedDB id a saved copy lives under: import-shaped, stable per route. */
export function localCopyId(communityId: string): string {
  return `u_c${hashString(`community:${communityId}`)}`;
}

/** The AI review as owners and admins see it. */
export function reviewHtml(review: CommunityAiReview | undefined): string {
  if (!review) return '<p class="import-note">No review yet.</p>';
  const parts: string[] = [];
  const status =
    review.status === 'pending'
      ? 'Waiting for the automatic review.'
      : review.status === 'skipped'
        ? 'The automatic review was skipped.'
        : review.status === 'failed'
          ? 'The automatic review could not run; a person will look at it instead.'
          : 'Reviewed automatically.';
  parts.push(`<p class="import-note">${escapeHtml(status)}</p>`);
  if (review.verdict) {
    const verdict =
      review.verdict === 'looks_good' ? 'Looks good' : review.verdict === 'needs_human' ? 'Needs a person to check' : 'Reject';
    const conf = typeof review.confidence === 'number' ? ` (confidence ${Math.round(review.confidence * 100)}%)` : '';
    parts.push(`<p><strong>Verdict:</strong> ${escapeHtml(verdict + conf)}</p>`);
  }
  if (review.summary) parts.push(`<p>${multilineHtml(review.summary)}</p>`);
  if (review.concerns && review.concerns.length > 0) {
    parts.push(`<ul>${review.concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}

