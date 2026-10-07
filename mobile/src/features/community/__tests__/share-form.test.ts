import { ApiError, NetworkError } from '../../../api/client';
import {
  RIGHTS_TEXT,
  buildSubmitRequest,
  initialShareForm,
  isShareFormValid,
  shareFailure,
  utf8ByteLength,
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

  it('accepts "not specified / several" (null) and refuses a region of another country', () => {
    // The web form and the worker accept a route listed under its country alone.
    expect(validateShareForm({ ...VALID, state: null })).toEqual({});
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

describe('buildSubmitRequest with no region', () => {
  it('sends state: null', () => {
    expect(buildSubmitRequest({ ...VALID, state: null }, {}).state).toBeNull();
  });
});

describe('utf8ByteLength', () => {
  const samples = ['plain', 'Mt Kosciuszko — 2,228 m', '四国遍路', 'emoji 🥾 boot', ''];

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    for (const text of samples) expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    expect(utf8ByteLength('四国')).toBe(6);
  });

  it('counts the same without TextEncoder', () => {
    const original = globalThis.TextEncoder;
    // @ts-expect-error -- simulating a runtime without it
    delete globalThis.TextEncoder;
    try {
      for (const text of samples) expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    } finally {
      globalThis.TextEncoder = original;
    }
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

  it('shows the server’s own words for a duplicate and for each daily limit', () => {
    const envelope = (code: string, message: string) => ({ error: { code, message } });
    const attempts = 'Too many share attempts today (at most 30). Try again tomorrow.';
    const published = 'You can share at most 10 routes a day. Try again tomorrow.';
    const duplicate = 'This exact track has been shared before';
    expect(
      shareFailure(new ApiError(429, 'rate_limited', attempts, envelope('rate_limited', attempts))).message,
    ).toBe(attempts);
    expect(
      shareFailure(new ApiError(429, 'rate_limited', published, envelope('rate_limited', published))).message,
    ).toBe(published);
    expect(
      shareFailure(new ApiError(409, 'duplicate', duplicate, envelope('duplicate', duplicate))).message,
    ).toBe(duplicate);
  });

  it('carries the existing id of the caller’s own duplicate, and only a community id', () => {
    const duplicate = 'This exact track has been shared before';
    const body = (extra: object) => ({ error: { code: 'duplicate', message: duplicate }, ...extra });
    const own = shareFailure(
      new ApiError(409, 'duplicate', duplicate, body({ existingId: 'c_AAAAAAAAAAAAAAAA' })),
    );
    expect(own).toEqual({ message: duplicate, existingId: 'c_AAAAAAAAAAAAAAAA' });
    // Someone else's route: the worker sends no id, and the message stands alone.
    expect(shareFailure(new ApiError(409, 'duplicate', duplicate, body({})))).toEqual({
      message: duplicate,
    });
    expect(
      shareFailure(new ApiError(409, 'duplicate', duplicate, body({ existingId: '../x' }))).existingId,
    ).toBeUndefined();
  });

  it('falls back to its own words when the server gives none', () => {
    expect(shareFailure(new ApiError(409, 'duplicate', 'Conflict')).message).toMatch(/already been shared/);
    expect(shareFailure(new ApiError(429, 'http_error', 'Too Many Requests')).message).toMatch(
      /today’s limit/,
    );
    expect(
      shareFailure(new ApiError(429, 'rate_limited', '', { error: { code: 'rate_limited', message: '  ' } }))
        .message,
    ).toMatch(/today’s limit/);
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
