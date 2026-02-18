import {
  computeAlertState,
  computeAlertDetail,
  formatBearing,
  getBearingToTrail,
  THRESHOLD_PRESETS,
} from '../off-trail-alert-service';

describe('computeAlertState', () => {
  const t = THRESHOLD_PRESETS.normal; // onTrail:50, drifting:200, warning:500

  it('returns noGps when distanceFromTrail is null', () => {
    expect(computeAlertState(null, null, t)).toBe('noGps');
    expect(computeAlertState(null, 5, t)).toBe('noGps');
  });

  it('returns onTrail when exactly at threshold', () => {
    expect(computeAlertState(50, null, t)).toBe('onTrail');
  });

  it('returns onTrail for small distances', () => {
    expect(computeAlertState(0, null, t)).toBe('onTrail');
    expect(computeAlertState(10, null, t)).toBe('onTrail');
    expect(computeAlertState(49, null, t)).toBe('onTrail');
  });

  it('returns drifting between onTrail and drifting thresholds', () => {
    expect(computeAlertState(51, null, t)).toBe('drifting');
    expect(computeAlertState(100, null, t)).toBe('drifting');
    expect(computeAlertState(200, null, t)).toBe('drifting');
  });

  it('returns warning between drifting and warning thresholds', () => {
    expect(computeAlertState(201, null, t)).toBe('warning');
    expect(computeAlertState(350, null, t)).toBe('warning');
    expect(computeAlertState(500, null, t)).toBe('warning');
  });

  it('returns offTrail beyond warning threshold', () => {
    expect(computeAlertState(501, null, t)).toBe('offTrail');
    expect(computeAlertState(1000, null, t)).toBe('offTrail');
  });

  it('credits accuracy to prevent false positives', () => {
    // distanceFromTrail=100, accuracy=100 → effectiveDistance = 100 - 50 = 50 → onTrail
    expect(computeAlertState(100, 100, t)).toBe('onTrail');
    // distanceFromTrail=200, accuracy=100 → effectiveDistance = 200 - 50 = 150 → drifting
    expect(computeAlertState(200, 100, t)).toBe('drifting');
  });

  it('does not credit accuracy when accuracy <= 20m', () => {
    // accuracy ≤ 20 → no credit applied
    expect(computeAlertState(60, 10, t)).toBe('drifting');
  });

  describe('tight thresholds', () => {
    const tight = THRESHOLD_PRESETS.tight; // 30/100/300
    it('triggers warning earlier', () => {
      expect(computeAlertState(101, null, tight)).toBe('warning');
      expect(computeAlertState(299, null, tight)).toBe('warning');
    });
    it('triggers offTrail at 300+m', () => {
      expect(computeAlertState(301, null, tight)).toBe('offTrail');
    });
  });

  describe('loose thresholds', () => {
    const loose = THRESHOLD_PRESETS.loose; // 100/300/750
    it('stays onTrail at 100m', () => {
      expect(computeAlertState(100, null, loose)).toBe('onTrail');
    });
    it('stays drifting until 300m', () => {
      expect(computeAlertState(300, null, loose)).toBe('drifting');
    });
    it('stays warning until 750m', () => {
      expect(computeAlertState(750, null, loose)).toBe('warning');
    });
    it('offTrail beyond 750m', () => {
      expect(computeAlertState(751, null, loose)).toBe('offTrail');
    });
  });
});

describe('computeAlertDetail', () => {
  it('returns km for onTrail state', () => {
    expect(computeAlertDetail('onTrail', 12.5, null)).toBe('km 12.5');
  });

  it('returns last known km for noGps state', () => {
    expect(computeAlertDetail('noGps', 8.3, null)).toBe('Last known: km 8.3');
  });

  it('returns undefined for noGps with no km', () => {
    expect(computeAlertDetail('noGps', null, null)).toBeUndefined();
  });

  it('returns meters from trail for drifting state', () => {
    expect(computeAlertDetail('drifting', 5, 150)).toBe('150m from trail');
  });

  it('returns meters from trail for warning state', () => {
    expect(computeAlertDetail('warning', 5, 350)).toBe('350m from trail');
  });

  it('includes bearing for offTrail state', () => {
    const detail = computeAlertDetail('offTrail', 5, 600, 247);
    expect(detail).toContain('600m from trail');
    expect(detail).toContain('247°');
  });

  it('returns just distance for offTrail without bearing', () => {
    expect(computeAlertDetail('offTrail', 5, 600)).toBe('600m from trail');
  });

  it('rounds meters to integer', () => {
    expect(computeAlertDetail('drifting', 1, 123.7)).toBe('124m from trail');
  });
});

describe('formatBearing', () => {
  it('formats 0 as North', () => {
    expect(formatBearing(0)).toContain('N');
  });

  it('formats 90 as East', () => {
    expect(formatBearing(90)).toContain('E');
    expect(formatBearing(90)).not.toContain('NE');
    expect(formatBearing(90)).not.toContain('SE');
  });

  it('formats 180 as South', () => {
    expect(formatBearing(180)).toContain('S');
    expect(formatBearing(180)).not.toContain('SE');
    expect(formatBearing(180)).not.toContain('SW');
  });

  it('formats 270 as West', () => {
    expect(formatBearing(270)).toContain('W');
    expect(formatBearing(270)).not.toContain('NW');
    expect(formatBearing(270)).not.toContain('SW');
  });

  it('includes degrees', () => {
    expect(formatBearing(247)).toContain('247°');
  });
});

describe('getBearingToTrail', () => {
  it('returns bearing roughly north for point directly north', () => {
    // User at -33.0, trail point at -32.0 (north)
    const bearing = getBearingToTrail(-33.0, 115.0, -32.0, 115.0);
    expect(Math.round(bearing)).toBe(0); // Due north
  });

  it('returns bearing roughly east for point directly east', () => {
    const bearing = getBearingToTrail(-33.0, 115.0, -33.0, 116.0);
    expect(Math.round(bearing)).toBe(90); // Due east
  });

  it('returns bearing in range [0, 360)', () => {
    const bearing = getBearingToTrail(-34.0, 116.0, -35.0, 115.0);
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
  });

  it('handles southern hemisphere correctly', () => {
    // Two points in Western Australia
    const bearing = getBearingToTrail(-34.9, 117.8, -34.0, 117.8);
    // Trail is north of user → bearing should be roughly 0
    expect(Math.round(bearing)).toBe(0);
  });
});
