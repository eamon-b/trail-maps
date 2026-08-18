/**
 * The client-side display-name rules must mirror the comments API
 * (`MAX_DISPLAY_NAME_LEN` in workers/comments-api/src/validation.ts) so a name
 * the UI accepts is never rejected by the server on the round trip.
 */

import { MAX_DISPLAY_NAME_LENGTH, validateDisplayName } from '../display-name';

describe('validateDisplayName', () => {
  it('mirrors the server limit', () => {
    expect(MAX_DISPLAY_NAME_LENGTH).toBe(40);
  });

  it('trims and accepts a normal name', () => {
    expect(validateDisplayName('  Trail Ghost ')).toEqual({ ok: true, value: 'Trail Ghost' });
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateDisplayName('')).toEqual({ ok: false, message: 'Enter a display name.' });
    expect(validateDisplayName('   \n')).toEqual({
      ok: false,
      message: 'Enter a display name.',
    });
  });

  it('accepts exactly the limit and rejects one over', () => {
    const atLimit = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH);
    expect(validateDisplayName(atLimit)).toEqual({ ok: true, value: atLimit });

    const over = validateDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.message).toContain('40 characters');
  });

  it('length-checks the trimmed value, not the raw input', () => {
    const padded = `   ${'x'.repeat(MAX_DISPLAY_NAME_LENGTH)}   `;
    expect(validateDisplayName(padded).ok).toBe(true);
  });
});
