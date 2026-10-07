/**
 * The owner's list: signed-out and unconfigured states, the list itself, the
 * words for offline and a refused token, a failed refresh keeping what was
 * shown, and delete reaching both the server and the phone.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError, NetworkError } from '../../../api/client';
import { AUTH_ERROR_MESSAGE, NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { deleteCommunityRoute, listMyCommunityRoutes } from '../../../api/community';
import { forgetCommunityRoute } from '../../../services/community-routes';
import { useIdentityStore } from '../../../state/identity-store';
import { useMySharedRoutes, type UseMySharedRoutes } from '../useMySharedRoutes';
import { ownRoute } from './fixtures';

let mockBaseUrl: string | undefined = 'https://api.test';
jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  getBaseUrl: () => mockBaseUrl,
}));

jest.mock('../../../api/community', () => ({
  listMyCommunityRoutes: jest.fn(),
  deleteCommunityRoute: jest.fn(),
}));

jest.mock('../../../services/community-routes', () => ({
  forgetCommunityRoute: jest.fn(),
}));

const mockList = listMyCommunityRoutes as jest.Mock;
const mockDelete = deleteCommunityRoute as jest.Mock;
const mockForget = forgetCommunityRoute as jest.Mock;

const SESSION = { userId: 'u1', token: 'tok-1', displayName: 'Sam' };

describe('useMySharedRoutes', () => {
  let hook!: UseMySharedRoutes;
  function Probe() {
    hook = useMySharedRoutes();
    return null;
  }

  let mounted: ReactTestRenderer | null = null;

  async function mount(): Promise<void> {
    await act(async () => {
      mounted = TestRenderer.create(<Probe />);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockBaseUrl = 'https://api.test';
    useIdentityStore.setState({
      status: 'registered',
      session: SESSION as never,
      authError: false,
      hydrate: jest.fn(async () => undefined),
    });
    mockForget.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    const tree = mounted;
    mounted = null;
    if (tree) act(() => tree.unmount());
  });

  it('lists the account’s routes with its token, hidden ones included', async () => {
    const hidden = ownRoute({ id: 'c_BBBBBBBBBBBBBBBB', status: 'hidden', hiddenReason: 'reports', trailUrl: null });
    mockList.mockResolvedValue([ownRoute(), hidden]);
    await mount();
    expect(mockList).toHaveBeenCalledWith({ baseUrl: 'https://api.test', token: 'tok-1' });
    expect(hook.state).toEqual({ kind: 'ready', routes: [ownRoute(), hidden], error: null });
  });

  it('is signed out on a phone with no account, and asks nothing', async () => {
    useIdentityStore.setState({ status: 'anonymous', session: null });
    await mount();
    expect(hook.state).toEqual({ kind: 'signed-out' });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('is unconfigured without an API', async () => {
    mockBaseUrl = undefined;
    await mount();
    expect(hook.state).toEqual({ kind: 'unconfigured' });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('says a refused token is about identity', async () => {
    mockList.mockRejectedValue(new ApiError(401, 'unauthorized', 'Invalid token'));
    await mount();
    expect(hook.state).toEqual({ kind: 'error', message: AUTH_ERROR_MESSAGE });
  });

  it('says offline is offline', async () => {
    mockList.mockRejectedValue(new NetworkError('offline'));
    await mount();
    expect(hook.state).toEqual({ kind: 'error', message: NETWORK_ERROR_MESSAGE });
  });

  it('keeps the routes shown when a refresh fails', async () => {
    mockList.mockResolvedValueOnce([ownRoute()]);
    await mount();
    mockList.mockRejectedValueOnce(new NetworkError('offline'));
    await act(async () => {
      await hook.refresh();
    });
    expect(hook.state).toEqual({ kind: 'ready', routes: [ownRoute()], error: NETWORK_ERROR_MESSAGE });
    expect(hook.refreshing).toBe(false);
  });

  it('deletes on the server and on the phone, then drops the row', async () => {
    const other = ownRoute({ id: 'c_BBBBBBBBBBBBBBBB', name: 'Other' });
    mockList.mockResolvedValue([ownRoute(), other]);
    await mount();
    await act(async () => {
      await hook.remove('c_AAAAAAAAAAAAAAAA');
    });
    expect(mockDelete).toHaveBeenCalledWith(
      { baseUrl: 'https://api.test', token: 'tok-1' },
      'c_AAAAAAAAAAAAAAAA',
    );
    expect(mockForget).toHaveBeenCalledWith('c_AAAAAAAAAAAAAAAA');
    expect(hook.state).toEqual({ kind: 'ready', routes: [other], error: null });
  });

  it('keeps the row and forgets nothing when the delete fails', async () => {
    mockList.mockResolvedValue([ownRoute()]);
    mockDelete.mockRejectedValue(new ApiError(500, 'internal', 'boom'));
    await mount();
    let thrown: unknown;
    await act(async () => {
      await hook.remove('c_AAAAAAAAAAAAAAAA').catch((err: unknown) => {
        thrown = err;
      });
    });
    expect(thrown).toBeInstanceOf(ApiError);
    expect(mockForget).not.toHaveBeenCalled();
    expect(hook.state).toEqual({ kind: 'ready', routes: [ownRoute()], error: null });
  });
});
