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
  isCommunityRouteId,
  type CommunityCheck,
  type CommunitySubmitRequest,
} from '@lib/community-types';
import { isValidCountry, isValidState } from '@lib/trail-regions';
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
  /**
   * A state code of the chosen country, or null: "not specified / several",
   * which the web form and the worker accept too (the route is listed under
   * the country alone).
   */
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

/**
 * UTF-8 size of a string in bytes — what the worker's 4 MB trail cap counts,
 * where `string.length` counts UTF-16 code units and under-reports every
 * non-ASCII name and description. `TextEncoder` is built into Hermes (RN 0.74+)
 * and Node; the hand count is the fallback for a runtime without it.
 */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export interface ShareFailure {
  message: string;
  /** The server's checks, on a 422. */
  checks?: CommunityCheck[];
  /**
   * On a 409 duplicate, the id of the route already shared — sent only when it
   * is the caller's own (a lost 201, or the same track shared twice), so the
   * screen can offer "View my shared routes". It may be hidden.
   */
  existingId?: string;
}

/** The picker's value for "Not specified / several" (the form holds null). */
export const NO_STATE_CHOICE = '';

/**
 * The sentence the server put in its error envelope, if any. The worker words
 * its limits itself — 30 share attempts a day versus 10 published routes a
 * day, and the duplicate — so its text says which one was hit.
 */
function serverMessage(err: ApiError): string | null {
  const message = (err.body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
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
      const existingId = (err.body as { existingId?: unknown } | undefined)?.existingId;
      return {
        message:
          serverMessage(err) ??
          'This route has already been shared — the same track was shared before.',
        ...(typeof existingId === 'string' && isCommunityRouteId(existingId) ? { existingId } : {}),
      };
    }
    if (err.status === 429) {
      return {
        message:
          serverMessage(err) ??
          'You have reached today’s limit for sharing routes. Try again tomorrow.',
      };
    }
    if (err.status === 413) {
      return { message: 'This route is too large to share.' };
    }
  }
  return { message: apiErrorMessage(err, 'Couldn’t share this route. Please try again.') };
}
