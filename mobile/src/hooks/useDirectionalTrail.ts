import { useMemo } from 'react';
import { createReversedTrail, type Trail } from '../lib/trail-utils';

/**
 * Returns the trail oriented in the correct direction.
 *
 * When `isReversed` is true the trail is reversed using `createReversedTrail`.
 * The result is memoised on both `trail` and `isReversed`, so it recomputes
 * whenever the source trail identity changes — fixing the stale-cache bug
 * where the old `useEffect` + `useState` pattern skipped recomputation when
 * the underlying trail object changed.
 */
export function useDirectionalTrail(
  trail: Trail | null | undefined,
  isReversed: boolean,
): Trail | null {
  return useMemo(() => {
    if (!trail) return null;
    return isReversed ? createReversedTrail(trail) : trail;
  }, [trail, isReversed]);
}
