/**
 * Behavioural test for useWaterStatus: the DB read is mocked so we can check the
 * mount read, the re-read on a comment-sync change, and the graceful empty map
 * when the database is unavailable.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useWaterStatus } from '../use-water-status';
import type { WaterAggregate } from '../water-aggregate';
import { emitSyncChange } from '../../../sync/sync-events';
import * as waterStatusRepo from '../../../db/water-status-repo';

jest.mock('../../../db/database', () => ({
  getDatabase: jest.fn(() => Promise.resolve({} as never)),
}));

jest.mock('../../../db/water-status-repo', () => ({
  listWaterReportsByTrail: jest.fn(),
}));

const listReports = waterStatusRepo.listWaterReportsByTrail as jest.MockedFunction<
  typeof waterStatusRepo.listWaterReportsByTrail
>;

function row(waypointId: string, waterStatus: 'flowing' | 'low' | 'dry') {
  return {
    waypointId,
    waterStatus,
    observedAt: null,
    createdAt: new Date().toISOString(),
  };
}

describe('useWaterStatus', () => {
  let latest: ReadonlyMap<string, WaterAggregate>;
  let renderer: ReactTestRenderer | null = null;

  function Harness({ trailId }: { trailId: string }) {
    latest = useWaterStatus(trailId);
    return null;
  }

  /** Mount the hook and let its first async read settle. */
  async function mount(trailId = 'aawt') {
    await act(async () => {
      renderer = TestRenderer.create(<Harness trailId={trailId} />);
    });
  }

  beforeEach(() => {
    listReports.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Unmount so a still-live sync subscription can't bleed into the next test.
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    jest.restoreAllMocks();
  });

  it("reads the trail's reports on mount and ranks them", async () => {
    listReports.mockResolvedValue([row('w_creek', 'dry')]);
    await mount();
    expect(listReports).toHaveBeenCalledWith(expect.anything(), 'aawt', expect.any(String));
    expect(latest.get('w_creek')!.status).toBe('dry');
  });

  it('re-reads when comment sync reports a change for this trail', async () => {
    listReports.mockResolvedValue([]);
    await mount();
    expect(latest.size).toBe(0);

    listReports.mockResolvedValue([row('w_tank', 'low')]);
    await act(async () => {
      emitSyncChange({ trailId: 'aawt' });
    });
    expect(latest.get('w_tank')!.status).toBe('low');
  });

  it('ignores a sync change for a different trail', async () => {
    listReports.mockResolvedValue([]);
    await mount();
    listReports.mockClear();

    await act(async () => {
      emitSyncChange({ trailId: 'heysen' });
    });
    expect(listReports).not.toHaveBeenCalled();
  });

  it('re-reads on an unscoped sync change', async () => {
    listReports.mockResolvedValue([]);
    await mount();
    listReports.mockClear();

    await act(async () => {
      emitSyncChange();
    });
    expect(listReports).toHaveBeenCalledTimes(1);
  });

  it('stays empty when the database is unavailable', async () => {
    listReports.mockRejectedValue(new Error('no such table: comments'));
    await mount();
    expect(latest.size).toBe(0);
  });
});
