/**
 * The UI's failure copy is derived from the same two error classes the sync
 * layer branches on, so pin the mapping: offline must read as offline, and
 * server-internal detail must never leak into a hiker-facing sentence.
 */

import { ApiError, NetworkError } from '../client';
import { AUTH_ERROR_MESSAGE, NETWORK_ERROR_MESSAGE, apiErrorMessage } from '../error-message';

const FALLBACK = 'Fallback copy.';

describe('apiErrorMessage', () => {
  it('maps a transport failure to the connection message', () => {
    const msg = apiErrorMessage(new NetworkError('Request to /v1/devices failed'), FALLBACK);
    expect(msg).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('maps 401/403 to the identity message', () => {
    expect(apiErrorMessage(new ApiError(401, 'unauthorized', 'nope'), FALLBACK)).toBe(
      AUTH_ERROR_MESSAGE,
    );
    expect(apiErrorMessage(new ApiError(403, 'forbidden', 'nope'), FALLBACK)).toBe(
      AUTH_ERROR_MESSAGE,
    );
  });

  it('surfaces 4xx validation messages verbatim', () => {
    const msg = apiErrorMessage(
      new ApiError(400, 'invalid_display_name', 'displayName must be at most 40 characters'),
      FALLBACK,
    );
    expect(msg).toBe('displayName must be at most 40 characters');
  });

  it('falls back for a 4xx with no message', () => {
    expect(apiErrorMessage(new ApiError(409, 'conflict', '   '), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for 5xx rather than leaking server detail', () => {
    expect(
      apiErrorMessage(new ApiError(500, 'internal', 'D1_ERROR: no such table'), FALLBACK),
    ).toBe(FALLBACK);
  });

  it('falls back for unexpected throws', () => {
    expect(apiErrorMessage(new Error('boom'), FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage('boom', FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
