import {
  aggregateWaterStatus,
  buildWaterStatusMap,
  formatWaterAge,
  formatWaterStatusChip,
  reportTimeMs,
  waterStatusAccessibilityLabel,
  waterWindowStartIso,
  WATER_DECAY_DAYS,
  WATER_WINDOW_DAYS,
  type WaterReport,
} from '../water-aggregate';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');
const DAY = 86_400_000;

/** A report `ageDays` old, timestamped via created_at unless observedAt is given. */
function report(
  waterStatus: WaterReport['waterStatus'],
  ageDays: number,
  observedAt?: string | null,
): WaterReport {
  return {
    waterStatus,
    observedAt: observedAt ?? null,
    createdAt: new Date(NOW - ageDays * DAY).toISOString(),
  };
}

describe('reportTimeMs', () => {
  it('prefers observed_at over created_at', () => {
    const r = report('flowing', 10, '2026-08-18T00:00:00.000Z');
    expect(reportTimeMs(r)).toBe(Date.parse('2026-08-18T00:00:00.000Z'));
  });

  it('falls back to created_at (the usual case — nothing writes observed_at)', () => {
    expect(reportTimeMs(report('flowing', 1))).toBe(NOW - DAY);
  });

  it('returns null for an unparseable timestamp', () => {
    expect(reportTimeMs({ waterStatus: 'dry', observedAt: null, createdAt: 'garbage' })).toBeNull();
  });
});

describe('aggregateWaterStatus', () => {
  it('returns null with no reports', () => {
    expect(aggregateWaterStatus([], NOW)).toBeNull();
  });

  it('reports a single fresh observation with weight ~1', () => {
    const agg = aggregateWaterStatus([report('flowing', 0)], NOW)!;
    expect(agg.status).toBe('flowing');
    expect(agg.weight).toBeCloseTo(1, 6);
    expect(agg.ageDays).toBeCloseTo(0, 6);
    expect(agg.reportCount).toBe(1);
    expect(agg.latestAt).toBe(new Date(NOW).toISOString());
  });

  it('weights a report by exp(-age / 30)', () => {
    const agg = aggregateWaterStatus([report('low', 30)], NOW)!;
    expect(agg.weight).toBeCloseTo(Math.exp(-30 / WATER_DECAY_DAYS), 6);
    expect(agg.ageDays).toBeCloseTo(30, 6);
  });

  it('lets one recent report outweigh a stale opposite one', () => {
    const agg = aggregateWaterStatus([report('flowing', 90), report('dry', 2)], NOW)!;
    expect(agg.status).toBe('dry');
    expect(agg.ageDays).toBeCloseTo(2, 6);
  });

  it('lets a corroborated recent consensus outweigh a single fresher outlier', () => {
    // Three "flowing" over the last fortnight beat one day-old "dry".
    const agg = aggregateWaterStatus(
      [report('flowing', 3), report('flowing', 7), report('flowing', 14), report('dry', 1)],
      NOW,
    )!;
    expect(agg.status).toBe('flowing');
    expect(agg.reportCount).toBe(3);
    // latestAt is the winning status's most recent report, not the overall newest.
    expect(agg.latestAt).toBe(new Date(NOW - 3 * DAY).toISOString());
    expect(agg.ageDays).toBeCloseTo(3, 6);
  });

  it('ignores reports older than the 120-day window', () => {
    const agg = aggregateWaterStatus(
      [report('dry', WATER_WINDOW_DAYS + 1), report('flowing', WATER_WINDOW_DAYS - 1)],
      NOW,
    )!;
    expect(agg.status).toBe('flowing');
    expect(agg.reportCount).toBe(1);
  });

  it('returns null when every report is outside the window', () => {
    expect(aggregateWaterStatus([report('dry', 200), report('flowing', 365)], NOW)).toBeNull();
  });

  it('skips unparseable timestamps', () => {
    const agg = aggregateWaterStatus(
      [{ waterStatus: 'dry', observedAt: null, createdAt: 'not-a-date' }, report('low', 5)],
      NOW,
    )!;
    expect(agg.status).toBe('low');
  });

  it('prefers the more recent status when the two are otherwise equal', () => {
    const older = report('flowing', 10);
    const newer = report('dry', 10);
    newer.createdAt = new Date(NOW - 10 * DAY + 1000).toISOString();
    expect(aggregateWaterStatus([older, newer], NOW)!.status).toBe('dry');
  });

  it('is deterministic on an exact tie (same weight, same timestamp)', () => {
    const at = new Date(NOW - 10 * DAY).toISOString();
    const flowing: WaterReport = { waterStatus: 'flowing', observedAt: null, createdAt: at };
    const dry: WaterReport = { waterStatus: 'dry', observedAt: null, createdAt: at };
    expect(aggregateWaterStatus([flowing, dry], NOW)!.status).toBe('flowing');
    expect(aggregateWaterStatus([dry, flowing], NOW)!.status).toBe('dry');
  });

  it('treats a future timestamp as zero-age rather than over-weighting it', () => {
    const future = report('dry', -10);
    const agg = aggregateWaterStatus([future], NOW)!;
    expect(agg.weight).toBeCloseTo(1, 6);
    expect(agg.ageDays).toBe(0);
  });

  it('uses observed_at for freshness when the reporter supplied one', () => {
    // Written today, but observed three months ago → outweighed by a fresh row.
    const stale: WaterReport = {
      waterStatus: 'flowing',
      observedAt: new Date(NOW - 100 * DAY).toISOString(),
      createdAt: new Date(NOW).toISOString(),
    };
    expect(aggregateWaterStatus([stale, report('dry', 5)], NOW)!.status).toBe('dry');
  });
});

describe('buildWaterStatusMap', () => {
  it('ranks each waypoint independently and omits ones with no in-window reports', () => {
    const map = buildWaterStatusMap(
      [
        { waypointId: 'w_a', ...report('flowing', 1) },
        { waypointId: 'w_a', ...report('dry', 60) },
        { waypointId: 'w_b', ...report('dry', 4) },
        { waypointId: 'w_stale', ...report('flowing', 300) },
      ],
      NOW,
    );
    expect([...map.keys()].sort()).toEqual(['w_a', 'w_b']);
    expect(map.get('w_a')!.status).toBe('flowing');
    expect(map.get('w_b')!.status).toBe('dry');
  });

  it('is empty for no reports', () => {
    expect(buildWaterStatusMap([], NOW).size).toBe(0);
  });
});

describe('waterWindowStartIso', () => {
  it('is the window edge as an ISO string', () => {
    expect(waterWindowStartIso(NOW)).toBe(new Date(NOW - WATER_WINDOW_DAYS * DAY).toISOString());
  });
});

describe('age formatting', () => {
  it('formats a compact chip age', () => {
    expect(formatWaterAge(0)).toBe('today');
    expect(formatWaterAge(0.9)).toBe('today');
    expect(formatWaterAge(1)).toBe('1d');
    expect(formatWaterAge(3.6)).toBe('3d');
    expect(formatWaterAge(7)).toBe('1w');
    expect(formatWaterAge(20)).toBe('2w');
    expect(formatWaterAge(30)).toBe('1mo');
    expect(formatWaterAge(119)).toBe('3mo');
  });

  it('builds the chip label from status + age', () => {
    const agg = aggregateWaterStatus([report('flowing', 3)], NOW)!;
    expect(formatWaterStatusChip(agg)).toBe('Flowing · 3d');
  });

  it('builds a spoken accessibility label', () => {
    const today = aggregateWaterStatus([report('dry', 0)], NOW)!;
    expect(waterStatusAccessibilityLabel(today)).toBe('Water status: Dry, reported today');

    const oneDay = aggregateWaterStatus([report('low', 1)], NOW)!;
    expect(waterStatusAccessibilityLabel(oneDay)).toBe('Water status: Low, reported 1 day ago');

    const days = aggregateWaterStatus([report('flowing', 3)], NOW)!;
    expect(waterStatusAccessibilityLabel(days)).toBe('Water status: Flowing, reported 3 days ago');

    const weeks = aggregateWaterStatus([report('dry', 20)], NOW)!;
    expect(waterStatusAccessibilityLabel(weeks)).toBe('Water status: Dry, reported 2 weeks ago');

    const months = aggregateWaterStatus([report('low', 65)], NOW)!;
    expect(waterStatusAccessibilityLabel(months)).toBe('Water status: Low, reported 2 months ago');
  });
});
