/**
 * Display-name rules, shared by the two places a name can be set: the
 * first-post prompt in the comment composer and the Account section in
 * Settings.
 *
 * The limit mirrors `MAX_DISPLAY_NAME_LEN` in
 * `workers/comments-api/src/validation.ts` so the client rejects an over-long
 * name before spending a round trip (the server is still the authority).
 */

/** Server-side cap on `displayName` (comments API validation). */
export const MAX_DISPLAY_NAME_LENGTH = 40;

export type DisplayNameCheck =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** Trim and length-check a typed display name. */
export function validateDisplayName(raw: string): DisplayNameCheck {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, message: 'Enter a display name.' };
  }
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      message: `Display names can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}
