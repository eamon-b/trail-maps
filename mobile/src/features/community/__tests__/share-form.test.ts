import { ApiError, NetworkError } from '../../../api/client';
import {
  RIGHTS_TEXT,
  buildSubmitRequest,
  initialShareForm,
  isShareFormValid,
  shareFailure,
  validateShareForm,
  type ShareForm,
} from '../share-form';
import { validateReport } from '../community-route';

const VALID: ShareForm = {
  name: 'Lake Loop',
  description: 'A gentle loop around the lake with two campsites.',
  credit: '',
  country: 'AU',
  state: 'VIC',
  rightsConfirmed: true,
};

describe('validateShareForm', () => {
  it('accepts a complete form', () => {
    expect(validateShareForm(VALID)).toEqual({});
    expect(isShareFormValid(VALID)).toBe(true);
  });

  it('starts invalid: the rights box is unticked and no country is chosen', () => {
    const errors = validateShareForm({ ...initialShareForm('Lake Loop'), description: VALID.description });
    expect(Object.keys(errors).sort()).toEqual(['country', 'rights']);
  });

  it('checks the text limits', () => {
    expect(validateShareForm({ ...VALID, name: 'ab' }).name).toBeDefined();
    expect(validateShareForm({ ...VALID, name: 'x'.repeat(81) }).name).toBeDefined();
    expect(validateShareForm({ ...VALID, description: 'too short' }).description).toBeDefined();
    expect(validateShareForm({ ...VALID, description: 'x'.repeat(2001) }).description).toBeDefined();
    expect(validateShareForm({ ...VALID, credit: 'x'.repeat(301) }).credit).toBeDefined();
  });

  it('requires a region of the chosen country when it has any', () => {
    expect(validateShareForm({ ...VALID, state: null }).state).toBeDefined();
    expect(validateShareForm({ ...VALID, state: 'SI' }).state).toBeDefined();
    // Japan lists no regions: none is needed.
    expect(validateShareForm({ ...VALID, country: 'JP', state: null })).toEqual({});
  });

  it('carries the CC0 confirmation wording', () => {
    expect(RIGHTS_TEXT).toMatch(/CC0/);
  });
});

describe('buildSubmitRequest', () => {
  it('trims the text and sends a blank credit as null', () => {
    const trail = { config: {} };
    expect(
      buildSubmitRequest({ ...VALID, name: '  Lake Loop ', credit: '   ' }, trail),
    ).toEqual({
      name: 'Lake Loop',
      description: VALID.description,
      credit: null,
      country: 'AU',
      state: 'VIC',
      rightsConfirmed: true,
      trail,
    });
  });
});

describe('shareFailure', () => {
  it('shows the server’s checks on a 422', () => {
    const checks = [{ id: 'length', level: 'fail', message: 'Too short' }];
    const f = shareFailure(
      new ApiError(422, 'checks_failed', 'no', { error: { code: 'checks_failed' }, checks }),
    );
    expect(f.checks).toEqual(checks);
  });

  it('explains a duplicate and the daily limit', () => {
    expect(shareFailure(new ApiError(409, 'duplicate', 'dup')).message).toMatch(/already been shared/);
    expect(shareFailure(new ApiError(429, 'rate_limited', 'slow')).message).toMatch(/daily limit/);
  });

  it('falls back to the connection message offline', () => {
    expect(shareFailure(new NetworkError('x')).message).toMatch(/connection/);
  });
});

describe('validateReport', () => {
  it('needs a known reason', () => {
    expect(validateReport(null, '').ok).toBe(false);
    expect(validateReport('nonsense', '').ok).toBe(false);
    expect(validateReport('spam', '  ')).toEqual({ ok: true, reason: 'spam', note: null });
  });

  it('needs a note for "other"', () => {
    expect(validateReport('other', '').ok).toBe(false);
    expect(validateReport('other', 'wrong country')).toEqual({
      ok: true,
      reason: 'other',
      note: 'wrong country',
    });
  });
});
