/**
 * The "Share to community" form's rules, with no UI attached
 * (`app/share-route.tsx`; spec `plans/community-routes.md`).
 *
 * The text limits are `COMMUNITY_LIMITS` — the same numbers the shared
 * `runCommunityChecks` `metadata` check and the worker enforce — so a form
 * that validates here is never refused for its length there. The checks on
 * the track itself are `runCommunityChecks`, run on the stored trail before
 * submitting; the worker runs them again and its answer counts.
 */

import {
  COMMUNITY_LIMITS,
  type CommunityCheck,
  type CommunitySubmitRequest,
} from '@lib/community-types';
import { findCountry, isValidCountry, isValidState } from '@lib/trail-regions';
import { failedChecks } from '../../api/community';
import { ApiError } from '../../api/client';
import { apiErrorMessage } from '../../api/error-message';

/** The confirmation the hiker must tick (the licence is CC0). */
export const RIGHTS_TEXT =
  'I recorded this track myself, or it is openly licensed, and I release it under CC0 (public domain)';

export interface ShareForm {
  name: string;
  description: string;
  credit: string;
  /** ISO 3166-1 alpha-2, or null until chosen. */
  country: string | null;
  /** A state code of the chosen country, or null. */
  state: string | null;
  rightsConfirmed: boolean;
}

export type ShareField = 'name' | 'description' | 'credit' | 'country' | 'state' | 'rights';

export type ShareFormErrors = Partial<Record<ShareField, string>>;

export function initialShareForm(trailName: string): ShareForm {
  return {
    name: trailName.trim().slice(0, COMMUNITY_LIMITS.nameMax),
    description: '',
    credit: '',
    country: null,
    state: null,
    rightsConfirmed: false,
  };
}

/** Every problem with the form, by field. Empty when it can be submitted. */
export function validateShareForm(form: ShareForm): ShareFormErrors {
  const errors: ShareFormErrors = {};
  const name = form.name.trim();
  if (name.length < COMMUNITY_LIMITS.nameMin || name.length > COMMUNITY_LIMITS.nameMax) {
    errors.name = `Use ${COMMUNITY_LIMITS.nameMin}-${COMMUNITY_LIMITS.nameMax} characters.`;
  }
  const description = form.description.trim();
  if (description.length < COMMUNITY_LIMITS.descriptionMin) {
    errors.description = `Describe the route in at least ${COMMUNITY_LIMITS.descriptionMin} characters.`;
  } else if (description.length > COMMUNITY_LIMITS.descriptionMax) {
    errors.description = `Keep it under ${COMMUNITY_LIMITS.descriptionMax} characters.`;
  }
  if (form.credit.trim().length > COMMUNITY_LIMITS.creditMax) {
    errors.credit = `Keep it under ${COMMUNITY_LIMITS.creditMax} characters.`;
  }
  if (!form.country || !isValidCountry(form.country)) {
    errors.country = 'Choose the country the route is in.';
  } else if (!isValidState(form.country, form.state)) {
    errors.state = 'Choose a region of that country.';
  } else if (!form.state && (findCountry(form.country)?.states.length ?? 0) > 0) {
    errors.state = 'Choose the region the route is in.';
  }
  if (!form.rightsConfirmed) {
    errors.rights = 'Tick the confirmation to share this route.';
  }
  return errors;
}

export function isShareFormValid(form: ShareForm): boolean {
  return Object.keys(validateShareForm(form)).length === 0;
}

/** The submit body. Call only on a valid form. */
export function buildSubmitRequest(form: ShareForm, trail: unknown): CommunitySubmitRequest {
  const credit = form.credit.trim();
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    credit: credit.length > 0 ? credit : null,
    country: (form.country ?? '').toUpperCase(),
    state: form.state ?? null,
    rightsConfirmed: true,
    trail,
  };
}

export interface ShareFailure {
  message: string;
  /** The server's checks, on a 422. */
  checks?: CommunityCheck[];
}

/** User-facing copy for a failed submit. */
export function shareFailure(err: unknown): ShareFailure {
  const checks = failedChecks(err);
  if (checks) {
    return {
      message: 'The server’s checks found a problem with this route. Nothing was shared.',
      checks,
    };
  }
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return {
        message:
          'This route has already been shared — the same track was shared before.',
      };
    }
    if (err.status === 429) {
      return {
        message: `You have shared ${COMMUNITY_LIMITS.submitsPerDay} routes today, the daily limit. Try again tomorrow.`,
      };
    }
    if (err.status === 413) {
      return { message: 'This route is too large to share.' };
    }
  }
  return { message: apiErrorMessage(err, 'Couldn’t share this route. Please try again.') };
}
