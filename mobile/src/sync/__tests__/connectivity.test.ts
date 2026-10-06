/**
 * `runSync` is single-flight: foregrounding a phone fires the AppState and the
 * reconnect edge together, and two overlapping syncs raced each other's SQLite
 * transactions.
 */

import type { DrainResult, PullResult } from '../comment-sync';
import { runSync } from '../connectivity';

jest.mock('expo-network', () => ({ addNetworkStateListener: jest.fn() }));

const DRAINED: DrainResult = { outcome: 'idle', sent: 0, failed: 0 };
const PULLED: PullResult = { outcome: 'pulled', applied: 0, syncedAt: 'T' };

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

describe('runSync', () => {
  it('joins a sync already running for the same trail', async () => {
    const { gate, release } = gated();
    const drain = jest.fn(async () => {
      await gate;
      return DRAINED;
    });
    const pullTrail = jest.fn(async () => PULLED);
    const pullPlans = jest.fn(async () => PULLED);

    const a = runSync('heysen', { drain, pullTrail, pullPlans });
    const b = runSync('heysen', { drain, pullTrail, pullPlans });
    expect(b).toBe(a);
    release();
    await Promise.all([a, b]);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(pullTrail).toHaveBeenCalledTimes(1);
    expect(pullPlans).toHaveBeenCalledTimes(1);
  });

  it('runs a sync for another trail after the running one, never alongside it', async () => {
    const { gate, release } = gated();
    const events: string[] = [];
    const drain = jest.fn(async () => {
      events.push('drain');
      await gate;
      return DRAINED;
    });
    const pullTrail = jest.fn(async (trailId: string) => {
      events.push(`pull:${trailId}`);
      return PULLED;
    });
    const pullPlans = jest.fn(async () => {
      events.push('plans');
      return PULLED;
    });

    const a = runSync('heysen', { drain, pullTrail, pullPlans });
    const b = runSync('larapinta', { drain, pullTrail, pullPlans });
    await Promise.resolve();
    expect(events).toEqual(['drain']);
    release();
    await Promise.all([a, b]);

    expect(events).toEqual(['drain', 'pull:heysen', 'plans', 'drain', 'pull:larapinta', 'plans']);
  });

  it('starts afresh once the previous sync has settled', async () => {
    const drain = jest.fn(async () => DRAINED);
    const deps = { drain, pullTrail: async () => PULLED, pullPlans: async () => PULLED };
    await runSync('heysen', deps);
    await runSync('heysen', deps);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('keeps the comment outcome when the plans pull throws', async () => {
    const res = await runSync(null, {
      drain: async () => DRAINED,
      pullPlans: async () => {
        throw new Error('boom');
      },
    });
    expect(res).toEqual({ drain: DRAINED, pull: null, plans: null });
  });
});
