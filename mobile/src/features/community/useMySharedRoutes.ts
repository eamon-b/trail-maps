/**
 * The owner's shared routes, any status (`GET /v1/me/community/routes`), for
 * `app/my-shared-routes.tsx`.
 *
 * The list needs this phone's account token, so a device that has never
 * posted (no account) is `signed-out` rather than an error, and a build with
 * no API is `unconfigured`. A failed refresh keeps the routes already shown
 * and reports the error beside them; a failed first load has nothing to show
 * but the error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommunityRouteDetail } from '@lib/community-types';
import { getBaseUrl } from '../../api/client';
import { listMyCommunityRoutes } from '../../api/community';
import { useIdentityStore } from '../../state/identity-store';
import { deleteMySharedRoute, mySharedRoutesError } from './my-shared-routes';

export type MySharedRoutesState =
  | { kind: 'unconfigured' }
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  /** `error` is a failed refresh; the routes are the last ones loaded. */
  | { kind: 'ready'; routes: CommunityRouteDetail[]; error: string | null };

interface Result {
  token: string;
  routes: CommunityRouteDetail[] | null;
  error: string | null;
}

export interface UseMySharedRoutes {
  state: MySharedRoutesState;
  refreshing: boolean;
  /** Pull-to-refresh. Never throws. */
  refresh: () => Promise<void>;
  /** Delete on the server and on this phone; throws on failure (the caller words it). */
  remove: (id: string) => Promise<void>;
}

export function useMySharedRoutes(): UseMySharedRoutes {
  const status = useIdentityStore((s) => s.status);
  const token = useIdentityStore((s) => s.session?.token ?? null);
  const baseUrl = getBaseUrl();
  const [result, setResult] = useState<Result | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void useIdentityStore.getState().hydrate();
  }, []);

  // Promise callbacks rather than `await`, so no setState runs synchronously
  // in an effect body (React's set-state-in-effect rule).
  const fetchList = useCallback(
    (url: string, tok: string) =>
      listMyCommunityRoutes({ baseUrl: url, token: tok }).then(
        (routes) => {
          if (mounted.current) setResult({ token: tok, routes, error: null });
        },
        (err: unknown) => {
          if (!mounted.current) return;
          const error = mySharedRoutesError(err);
          // Keep what was shown for the same account; never another account's.
          setResult((prev) => ({
            token: tok,
            routes: prev && prev.token === tok ? prev.routes : null,
            error,
          }));
        },
      ),
    [],
  );

  useEffect(() => {
    if (!baseUrl || status !== 'registered' || !token) return;
    void fetchList(baseUrl, token);
  }, [baseUrl, status, token, fetchList]);

  const refresh = useCallback(async () => {
    if (!baseUrl || !token) return;
    setRefreshing(true);
    try {
      await fetchList(baseUrl, token);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [baseUrl, token, fetchList]);

  const remove = useCallback(
    async (id: string) => {
      if (!baseUrl || !token) throw new Error('This phone has no account to delete with.');
      await deleteMySharedRoute({ baseUrl, token }, id);
      if (!mounted.current) return;
      setResult((prev) =>
        prev && prev.routes
          ? { ...prev, routes: prev.routes.filter((r) => r.id !== id) }
          : prev,
      );
    },
    [baseUrl, token],
  );

  let state: MySharedRoutesState;
  if (!baseUrl) state = { kind: 'unconfigured' };
  else if (status === 'unknown') state = { kind: 'loading' };
  else if (status === 'anonymous' || !token) state = { kind: 'signed-out' };
  else if (!result || result.token !== token) state = { kind: 'loading' };
  else if (result.routes) state = { kind: 'ready', routes: result.routes, error: result.error };
  else state = { kind: 'error', message: result.error ?? '' };

  return { state, refreshing, refresh, remove };
}
