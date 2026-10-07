import { ApiError, NetworkError } from '../../../api/client';
import { AUTH_ERROR_MESSAGE, NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import {
  HIDDEN_REASON_TEXT,
  HIDDEN_UNKNOWN_TEXT,
  MY_ROUTES_LOAD_FAILED,
  deleteMySharedRoute,
  deleteSharedRouteMessage,
  hiddenReasonText,
  isLiveRoute,
  mySharedRoutesError,
} from '../my-shared-routes';
import { ownRoute } from './fixtures';

jest.mock('../../../services/community-routes', () => ({
  forgetCommunityRoute: jest.fn(),
}));

describe('hiddenReasonText', () => {
  it('says why a hidden route is hidden', () => {
    expect(hiddenReasonText({ status: 'hidden', hiddenReason: 'review' })).toBe(
      'Hidden by the automatic review',
    );
    expect(hiddenReasonText({ status: 'hidden', hiddenReason: 'reports' })).toBe(
      'Hidden after reports from other users',
    );
    expect(hiddenReasonText({ status: 'hidden', hiddenReason: 'admin' })).toBe(
      'Hidden by a moderator',
    );
    expect(Object.keys(HIDDEN_REASON_TEXT).sort()).toEqual(['admin', 'reports', 'review']);
  });

  it('falls back when the server gives no reason, and says nothing for a shared route', () => {
    expect(hiddenReasonText({ status: 'hidden' })).toBe(HIDDEN_UNKNOWN_TEXT);
    expect(hiddenReasonText({ status: 'verified', hiddenReason: 'review' })).toBeNull();
    expect(hiddenReasonText({ status: 'unverified' })).toBeNull();
  });
});

describe('isLiveRoute', () => {
  it('is live only when shared and downloadable', () => {
    expect(isLiveRoute(ownRoute())).toBe(true);
    expect(isLiveRoute(ownRoute({ status: 'verified' }))).toBe(true);
    expect(isLiveRoute(ownRoute({ status: 'hidden', trailUrl: null }))).toBe(false);
    expect(isLiveRoute(ownRoute({ trailUrl: null }))).toBe(false);
  });
});

describe('mySharedRoutesError', () => {
  it('words offline, a refused token and anything else', () => {
    expect(mySharedRoutesError(new NetworkError('offline'))).toBe(NETWORK_ERROR_MESSAGE);
    expect(mySharedRoutesError(new ApiError(401, 'unauthorized', 'nope'))).toBe(AUTH_ERROR_MESSAGE);
    expect(mySharedRoutesError(new ApiError(500, 'internal', 'boom'))).toBe(MY_ROUTES_LOAD_FAILED);
  });
});

describe('deleteMySharedRoute', () => {
  const ctx = { baseUrl: 'https://api.test', token: 'tok' };

  it('deletes on the server, then forgets the route on this phone', async () => {
    const calls: string[] = [];
    const deleteRoute = jest.fn(async () => {
      calls.push('server');
    });
    const forget = jest.fn(async () => {
      calls.push('local');
    });
    await deleteMySharedRoute(ctx, 'c_AAAAAAAAAAAAAAAA', { deleteRoute, forget });
    expect(deleteRoute).toHaveBeenCalledWith(ctx, 'c_AAAAAAAAAAAAAAAA');
    expect(forget).toHaveBeenCalledWith('c_AAAAAAAAAAAAAAAA');
    expect(calls).toEqual(['server', 'local']);
  });

  it('treats a 404 as already deleted', async () => {
    const forget = jest.fn(async () => undefined);
    await deleteMySharedRoute(ctx, 'c_AAAAAAAAAAAAAAAA', {
      deleteRoute: jest.fn(async () => {
        throw new ApiError(404, 'not_found', 'gone');
      }),
      forget,
    });
    expect(forget).toHaveBeenCalledWith('c_AAAAAAAAAAAAAAAA');
  });

  it('touches nothing local when the server refuses', async () => {
    const forget = jest.fn(async () => undefined);
    await expect(
      deleteMySharedRoute(ctx, 'c_AAAAAAAAAAAAAAAA', {
        deleteRoute: jest.fn(async () => {
          throw new NetworkError('offline');
        }),
        forget,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(forget).not.toHaveBeenCalled();
  });
});

describe('deleteSharedRouteMessage', () => {
  it('says the downloaded community copy and its plan leave this phone', () => {
    const text = deleteSharedRouteMessage('Ridge Loop');
    expect(text).toContain('“Ridge Loop”');
    expect(text).toMatch(/community copy is downloaded on this phone, it is removed too/);
    expect(text).toMatch(/plan/);
    expect(text).toMatch(/guide you imported and shared from stays/);
  });

  it('reads without a name', () => {
    expect(deleteSharedRouteMessage()).toMatch(/^Remove this route from the community/);
  });
});
