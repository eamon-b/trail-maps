import { describe, it, expect } from 'vitest';
import {
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  calculateTrackDistance,
  calculateElevationStats,
  truncateTrack,
  roundCoordinates,
  optimizeGpx,
  GPX_OPTIMIZER_DEFAULTS
} from './gpx-optimizer';
import type { GpxPoint } from './types';

describe('douglasPeucker', () => {
  it('should return same points when 2 or fewer points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 60, time: null }
    ];

    const result = douglasPeucker(points, 10);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(points[0]);
    expect(result[1]).toEqual(points[1]);
  });

  it('should preserve endpoints', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.8150, lon: 144.9650, ele: 55, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 60, time: null }
    ];

    const result = douglasPeucker(points, 1000);

    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });

  it('should remove collinear points within tolerance', () => {
    // Three collinear points (in a straight line)
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8168, lon: 144.9665, ele: 0, time: null }, // midpoint
      { lat: -37.8200, lon: 144.9700, ele: 0, time: null }
    ];

    const result = douglasPeucker(points, 100);

    // Should reduce to just endpoints
    expect(result).toHaveLength(2);
  });

  it('should preserve points outside tolerance', () => {
    // L-shaped path - middle point should be preserved
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8136, lon: 145.0000, ele: 0, time: null }, // significant deviation
      { lat: -37.8200, lon: 145.0000, ele: 0, time: null }
    ];

    const result = douglasPeucker(points, 10);

    // Should preserve all points due to large deviation
    expect(result).toHaveLength(3);
  });

  it('should handle switchback pattern', () => {
    // Switchback pattern - should preserve turn points
    const points: GpxPoint[] = [
      { lat: -37.8000, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8001, lon: 144.9010, ele: 0, time: null },
      { lat: -37.8002, lon: 144.9020, ele: 0, time: null },
      { lat: -37.8000, lon: 144.9030, ele: 0, time: null }, // turn
      { lat: -37.7998, lon: 144.9020, ele: 0, time: null },
      { lat: -37.7997, lon: 144.9010, ele: 0, time: null },
      { lat: -37.8000, lon: 144.9000, ele: 0, time: null }  // back to start
    ];

    const result = douglasPeucker(points, 5);

    // Should preserve enough points to maintain switchback shape
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThan(points.length);
  });
});

describe('removeElevationSpikes', () => {
  it('should return same points when less than 3 points', () => {
    const singlePoint: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null }
    ];
    expect(removeElevationSpikes(singlePoint, 50)).toHaveLength(1);
    expect(removeElevationSpikes(singlePoint, 50)[0].ele).toBe(50);

    const twoPoints: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 150, time: null }
    ];
    const result = removeElevationSpikes(twoPoints, 50);
    expect(result).toHaveLength(2);
    expect(result[0].ele).toBe(50);
    expect(result[1].ele).toBe(150); // Not modified - need 3+ points to detect spikes
  });

  it('should not modify points within threshold', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.8150, lon: 144.9650, ele: 55, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 60, time: null }
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(50);
    expect(result[1].ele).toBe(55);
    expect(result[2].ele).toBe(60);
  });

  it('should interpolate elevation spikes linearly', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 100, time: null },
      { lat: -37.8150, lon: 144.9650, ele: 200, time: null }, // spike (+100m)
      { lat: -37.8200, lon: 144.9700, ele: 105, time: null }
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(100);
    // Spike should be interpolated halfway between 100 and 105
    expect(result[1].ele).toBeCloseTo(102.5, 1);
    expect(result[2].ele).toBe(105);
  });

  it('should handle isolated spikes in sequence', () => {
    // Create a pattern with two isolated spikes separated by valid points
    // Each spike is higher than BOTH its immediate neighbors
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 100, time: null },  // valid
      { lat: -37.8110, lon: 144.9610, ele: 250, time: null },  // spike: 250 > 100 and 250 > 102
      { lat: -37.8120, lon: 144.9620, ele: 102, time: null },  // valid
      { lat: -37.8130, lon: 144.9630, ele: 103, time: null },  // valid
      { lat: -37.8140, lon: 144.9640, ele: 280, time: null },  // spike: 280 > 103 and 280 > 105
      { lat: -37.8150, lon: 144.9650, ele: 105, time: null }   // valid
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(100);
    // First spike interpolated between 100 and 102
    expect(result[1].ele).toBeCloseTo(101, 0);
    expect(result[2].ele).toBe(102);
    expect(result[3].ele).toBe(103);
    // Second spike interpolated between 103 and 105
    expect(result[4].ele).toBeCloseTo(104, 0);
    expect(result[5].ele).toBe(105);
  });

  it('should not treat gradual elevation changes as spikes', () => {
    // This tests the case where elevation steadily increases then drops -
    // the middle points should NOT be treated as spikes since they're part
    // of a consistent trend, not isolated outliers
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 100, time: null },
      { lat: -37.8120, lon: 144.9620, ele: 200, time: null }, // +100 from prev
      { lat: -37.8140, lon: 144.9640, ele: 300, time: null }, // +100 from prev
      { lat: -37.8160, lon: 144.9660, ele: 105, time: null }  // -195 from prev
    ];

    const result = removeElevationSpikes(points, 50);

    // Point 1 is NOT a spike: it's higher than point 0 but LOWER than point 2
    // (different directions), so it's part of a climb, not an outlier
    expect(result[0].ele).toBe(100);
    expect(result[1].ele).toBe(200); // Not modified - part of upward trend

    // Point 2 IS a spike: it's higher than BOTH neighbors (300 vs 200 and 105)
    // So it should be interpolated between 200 and 105
    expect(result[2].ele).toBeCloseTo(152.5, 0); // midpoint between 200 and 105

    expect(result[3].ele).toBe(105);
  });

  it('should handle downward spikes (dips)', () => {
    // Test that the algorithm also catches downward spikes (valleys)
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 200, time: null },
      { lat: -37.8120, lon: 144.9620, ele: 50, time: null },  // dip: 50 < 200 and 50 < 195
      { lat: -37.8140, lon: 144.9640, ele: 195, time: null }
    ];

    const result = removeElevationSpikes(points, 50);

    expect(result[0].ele).toBe(200);
    // Dip should be interpolated between 200 and 195
    expect(result[1].ele).toBeCloseTo(197.5, 1);
    expect(result[2].ele).toBe(195);
  });

  it('should preserve endpoints even if they look like spikes', () => {
    // First and last points should never be modified since they can't be
    // compared to both neighbors
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 500, time: null },  // high start
      { lat: -37.8120, lon: 144.9620, ele: 100, time: null },
      { lat: -37.8140, lon: 144.9640, ele: 600, time: null }   // high end
    ];

    const result = removeElevationSpikes(points, 50);

    // Endpoints should be preserved exactly
    expect(result[0].ele).toBe(500);
    expect(result[2].ele).toBe(600);
    // Middle point is a dip, should be interpolated
    expect(result[1].ele).toBeCloseTo(550, 0);
  });

  it('should handle all points at same elevation', () => {
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 100, time: null },
      { lat: -37.8120, lon: 144.9620, ele: 100, time: null },
      { lat: -37.8140, lon: 144.9640, ele: 100, time: null },
      { lat: -37.8160, lon: 144.9660, ele: 100, time: null }
    ];

    const result = removeElevationSpikes(points, 50);

    // All points should remain unchanged
    result.forEach(p => expect(p.ele).toBe(100));
  });
});

describe('smoothElevation', () => {
  it('should return same points when fewer than window size', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 50, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 60, time: null }
    ];

    const result = smoothElevation(points, 5);

    expect(result).toEqual(points);
  });

  it('should smooth elevation data with moving average', () => {
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 100, time: null },
      { lat: -37.8110, lon: 144.9610, ele: 100, time: null },
      { lat: -37.8120, lon: 144.9620, ele: 150, time: null }, // outlier
      { lat: -37.8130, lon: 144.9630, ele: 100, time: null },
      { lat: -37.8140, lon: 144.9640, ele: 100, time: null }
    ];

    const result = smoothElevation(points, 3);

    // Middle point should be smoothed
    expect(result[2].ele).toBeLessThan(150);
    expect(result[2].ele).toBeGreaterThan(100);
  });

  it('should preserve coordinates while smoothing', () => {
    const points: GpxPoint[] = [
      { lat: -37.8100, lon: 144.9600, ele: 100, time: '2024-01-01T10:00:00Z' },
      { lat: -37.8110, lon: 144.9610, ele: 110, time: '2024-01-01T10:01:00Z' },
      { lat: -37.8120, lon: 144.9620, ele: 120, time: '2024-01-01T10:02:00Z' }
    ];

    const result = smoothElevation(points, 3);

    expect(result[0].lat).toBe(-37.8100);
    expect(result[0].lon).toBe(144.9600);
    expect(result[0].time).toBe('2024-01-01T10:00:00Z');
  });
});

describe('calculateTrackDistance', () => {
  it('should return 0 for empty or single point track', () => {
    expect(calculateTrackDistance([])).toBe(0);
    expect(calculateTrackDistance([
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null }
    ])).toBe(0);
  });

  it('should calculate distance between two points', () => {
    // Melbourne to Sydney is approximately 714 km
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null }, // Melbourne
      { lat: -33.8688, lon: 151.2093, ele: 0, time: null }  // Sydney
    ];

    const distance = calculateTrackDistance(points);

    // Allow 10km tolerance
    expect(distance).toBeGreaterThan(704000);
    expect(distance).toBeLessThan(724000);
  });

  it('should sum distances for multiple points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 0, time: null },
      { lat: -37.8300, lon: 144.9800, ele: 0, time: null }
    ];

    const distance = calculateTrackDistance(points);

    expect(distance).toBeGreaterThan(0);
  });
});

describe('calculateElevationStats', () => {
  it('should return zero for empty or single point', () => {
    expect(calculateElevationStats([])).toEqual({ gain: 0, loss: 0 });
    expect(calculateElevationStats([
      { lat: 0, lon: 0, ele: 100, time: null }
    ])).toEqual({ gain: 0, loss: 0 });
  });

  it('should calculate elevation gain', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 110, time: null },
      { lat: 0, lon: 0, ele: 120, time: null }
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(20);
    expect(stats.loss).toBe(0);
  });

  it('should calculate elevation loss', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 120, time: null },
      { lat: 0, lon: 0, ele: 110, time: null },
      { lat: 0, lon: 0, ele: 100, time: null }
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(0);
    expect(stats.loss).toBe(20);
  });

  it('should calculate both gain and loss', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 150, time: null }, // +50 gain
      { lat: 0, lon: 0, ele: 130, time: null }, // -20 loss
      { lat: 0, lon: 0, ele: 160, time: null }  // +30 gain
    ];

    const stats = calculateElevationStats(points);

    expect(stats.gain).toBe(80);
    expect(stats.loss).toBe(20);
  });

  it('should filter out changes below threshold', () => {
    const points: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 100, time: null },
      { lat: 0, lon: 0, ele: 101, time: null }, // +1, below threshold
      { lat: 0, lon: 0, ele: 102, time: null }, // +1, below threshold
      { lat: 0, lon: 0, ele: 110, time: null }  // +8, above default threshold (3)
    ];

    const stats = calculateElevationStats(points, 3);

    // Only the 100->110 change should count, but it's calculated cumulatively
    expect(stats.gain).toBe(8);
  });
});

describe('truncateTrack', () => {
  it('should return same points when no truncation specified', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
      { lat: -37.8200, lon: 144.9700, ele: 0, time: null }
    ];

    const result = truncateTrack(points, 0, 0);

    expect(result).toEqual(points);
  });

  it('should return same points when fewer than 2 points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null }
    ];

    const result = truncateTrack(points, 100, 100);

    expect(result).toEqual(points);
  });

  it('should truncate from start', () => {
    // Create points about 1km apart
    const points: GpxPoint[] = [
      { lat: -37.8000, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8100, lon: 144.9000, ele: 0, time: null }, // ~1.1km from start
      { lat: -37.8200, lon: 144.9000, ele: 0, time: null }  // ~2.2km from start
    ];

    const result = truncateTrack(points, 500, 0); // truncate 500m from start

    expect(result.length).toBeLessThanOrEqual(points.length);
    expect(result[0].lat).not.toBe(-37.8000); // start should be removed
  });

  it('should truncate from end', () => {
    const points: GpxPoint[] = [
      { lat: -37.8000, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8100, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8200, lon: 144.9000, ele: 0, time: null }
    ];

    const result = truncateTrack(points, 0, 500);

    expect(result.length).toBeLessThanOrEqual(points.length);
  });

  it('should preserve at least 2 points', () => {
    const points: GpxPoint[] = [
      { lat: -37.8000, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8010, lon: 144.9000, ele: 0, time: null },
      { lat: -37.8020, lon: 144.9000, ele: 0, time: null }
    ];

    // Truncate more than track length
    const result = truncateTrack(points, 100000, 100000);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe('roundCoordinates', () => {
  it('should round coordinates to specified precision', () => {
    const points: GpxPoint[] = [
      { lat: -37.81361234567, lon: 144.96311234567, ele: 50.123, time: null }
    ];

    const result = roundCoordinates(points, 6);

    expect(result[0].lat).toBe(-37.813612);
    expect(result[0].lon).toBe(144.963112);
    expect(result[0].ele).toBe(50.1);
  });

  it('should preserve time values', () => {
    const points: GpxPoint[] = [
      { lat: -37.81361234567, lon: 144.96311234567, ele: 50, time: '2024-01-01T10:00:00Z' }
    ];

    const result = roundCoordinates(points, 6);

    expect(result[0].time).toBe('2024-01-01T10:00:00Z');
  });
});

describe('optimizeGpx', () => {
  const simpleGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Test Track</name>
    <trkseg>
      <trkpt lat="-37.8000" lon="144.9000">
        <ele>100</ele>
        <time>2024-01-01T10:00:00Z</time>
      </trkpt>
      <trkpt lat="-37.8010" lon="144.9010">
        <ele>105</ele>
        <time>2024-01-01T10:01:00Z</time>
      </trkpt>
      <trkpt lat="-37.8020" lon="144.9020">
        <ele>110</ele>
        <time>2024-01-01T10:02:00Z</time>
      </trkpt>
      <trkpt lat="-37.8030" lon="144.9030">
        <ele>115</ele>
        <time>2024-01-01T10:03:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

  it('should return optimization result with statistics', () => {
    const result = optimizeGpx(simpleGpx, 'test.gpx');

    expect(result.filename).toBe('test-optimized.gpx');
    expect(result.content).toBeTruthy();
    expect(result.original.pointCount).toBe(4);
    expect(result.optimized.pointCount).toBeGreaterThanOrEqual(2);
    expect(result.original.fileSize).toBeGreaterThan(0);
    expect(result.optimized.fileSize).toBeGreaterThan(0);
    expect(result.warnings).toBeInstanceOf(Array);
  });

  it('should reduce number of points', () => {
    // Create a GPX with many collinear points
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Linear Track</name>
    <trkseg>`;

    // Generate 100 points in a straight line
    for (let i = 0; i < 100; i++) {
      gpx += `
      <trkpt lat="${-37.8 + i * 0.001}" lon="${144.9 + i * 0.001}">
        <ele>100</ele>
      </trkpt>`;
    }

    gpx += `
    </trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(gpx, 'linear.gpx', { simplificationTolerance: 20 });

    // Should significantly reduce points
    expect(result.optimized.pointCount).toBeLessThan(result.original.pointCount);
    expect(result.optimized.pointCount).toBeLessThan(20); // collinear points should reduce dramatically
  });

  it('should preserve timestamps when option is enabled', () => {
    const result = optimizeGpx(simpleGpx, 'test.gpx', { preserveTimestamps: true });

    expect(result.content).toContain('<time>');
  });

  it('should strip timestamps when option is disabled', () => {
    const result = optimizeGpx(simpleGpx, 'test.gpx', { preserveTimestamps: false });

    expect(result.content).not.toContain('<time>');
  });

  it('should generate valid GPX output', () => {
    const result = optimizeGpx(simpleGpx, 'test.gpx');

    expect(result.content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.content).toContain('<gpx version="1.1"');
    expect(result.content).toContain('<trk>');
    expect(result.content).toContain('</gpx>');
  });

  it('should handle routes by converting to tracks', () => {
    const routeGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <rte>
    <name>Test Route</name>
    <rtept lat="-37.8000" lon="144.9000">
      <ele>100</ele>
    </rtept>
    <rtept lat="-37.8100" lon="144.9100">
      <ele>110</ele>
    </rtept>
  </rte>
</gpx>`;

    const result = optimizeGpx(routeGpx, 'route.gpx');

    expect(result.original.pointCount).toBe(2);
    expect(result.content).toContain('<trk>'); // converted to track format
  });

  it('should apply elevation smoothing', () => {
    const spikyGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Spiky Track</name>
    <trkseg>
      <trkpt lat="-37.8000" lon="144.9000"><ele>100</ele></trkpt>
      <trkpt lat="-37.8010" lon="144.9010"><ele>100</ele></trkpt>
      <trkpt lat="-37.8020" lon="144.9020"><ele>200</ele></trkpt>
      <trkpt lat="-37.8030" lon="144.9030"><ele>100</ele></trkpt>
      <trkpt lat="-37.8040" lon="144.9040"><ele>100</ele></trkpt>
      <trkpt lat="-37.8050" lon="144.9050"><ele>100</ele></trkpt>
      <trkpt lat="-37.8060" lon="144.9060"><ele>100</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(spikyGpx, 'spiky.gpx', {
      elevationSmoothing: true,
      spikeThreshold: 50
    });

    // Elevation gain should be reduced due to spike removal
    expect(result.optimized.elevationGain).toBeLessThan(100);
  });

  it('should use default options when none provided', () => {
    const result = optimizeGpx(simpleGpx, 'test.gpx');

    // Just verify it runs without error with defaults
    expect(result.filename).toBe('test-optimized.gpx');
    expect(result.passed || result.warnings.length >= 0).toBe(true);
  });

  it('should warn when distance changes significantly', () => {
    // Create GPX with a pronounced zigzag pattern that will lose significant
    // distance when simplified with high tolerance
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Zigzag Track</name>
    <trkseg>`;

    // Create a more aggressive zigzag pattern with larger lateral movements
    // Each zigzag adds ~2.2km of lateral distance that will be lost when simplified
    for (let i = 0; i < 20; i++) {
      // Main track point
      gpx += `
      <trkpt lat="${-37.8 + i * 0.002}" lon="144.9">
        <ele>100</ele>
      </trkpt>`;
      // Zigzag point - far lateral deviation
      gpx += `
      <trkpt lat="${-37.8 + i * 0.002 + 0.001}" lon="${144.9 + 0.02}">
        <ele>100</ele>
      </trkpt>`;
    }
    // End point
    gpx += `
      <trkpt lat="${-37.8 + 20 * 0.002}" lon="144.9">
        <ele>100</ele>
      </trkpt>`;

    gpx += `
    </trkseg>
  </trk>
</gpx>`;

    // Use high tolerance to aggressively simplify, which will remove zigzag points
    const result = optimizeGpx(gpx, 'zigzag.gpx', {
      simplificationTolerance: 500,     // Very high - will remove all zigzag points
      maxDistanceChangeRatio: 0.05,     // 5% threshold
      elevationSmoothing: false         // Disable to isolate the simplification effect
    });

    // Verify that simplification removed significant points
    expect(result.optimized.pointCount).toBeLessThan(result.original.pointCount);

    // Verify that a distance warning was generated (shows increased or decreased)
    const hasDistanceWarning = result.warnings.some(w => w.includes('Distance increased') || w.includes('Distance decreased'));
    expect(hasDistanceWarning).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('should handle multi-segment tracks', () => {
    const multiSegGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Multi-segment Track</name>
    <trkseg>
      <trkpt lat="-37.8000" lon="144.9000"><ele>100</ele></trkpt>
      <trkpt lat="-37.8010" lon="144.9010"><ele>105</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="-37.9000" lon="145.0000"><ele>200</ele></trkpt>
      <trkpt lat="-37.9010" lon="145.0010"><ele>205</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(multiSegGpx, 'multiseg.gpx');

    // Should contain both segments
    expect(result.content.match(/<trkseg>/g)?.length).toBe(2);
  });

  it('should handle empty track gracefully', () => {
    const emptyGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Empty Track</name>
    <trkseg></trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(emptyGpx, 'empty.gpx');

    expect(result.original.pointCount).toBe(0);
    expect(result.optimized.pointCount).toBe(0);
  });

  it('should preserve sea-level elevations (ele === 0)', () => {
    const seaLevelGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Sea Level Track</name>
    <trkseg>
      <trkpt lat="-37.8000" lon="144.9000"><ele>0</ele></trkpt>
      <trkpt lat="-37.8010" lon="144.9010"><ele>0</ele></trkpt>
      <trkpt lat="-37.8020" lon="144.9020"><ele>0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(seaLevelGpx, 'sealevel.gpx');

    // Verify elevation is included in output
    expect(result.content).toContain('<ele>0</ele>');
    expect(result.optimized.pointCount).toBeGreaterThanOrEqual(2);
  });

  it('should handle negative elevations (below sea level)', () => {
    const belowSeaGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Below Sea Level</name>
    <trkseg>
      <trkpt lat="31.5" lon="35.4"><ele>-400</ele></trkpt>
      <trkpt lat="31.51" lon="35.41"><ele>-405</ele></trkpt>
      <trkpt lat="31.52" lon="35.42"><ele>-410</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const result = optimizeGpx(belowSeaGpx, 'deadsea.gpx');

    // Verify negative elevations are preserved
    expect(result.content).toContain('<ele>-4');
    expect(result.optimized.elevationLoss).toBeGreaterThan(0);
  });

  it('should throw error on empty input', () => {
    expect(() => optimizeGpx('', 'empty.gpx')).toThrow('GPX content cannot be empty');
    expect(() => optimizeGpx('   ', 'whitespace.gpx')).toThrow('GPX content cannot be empty');
  });

  it('should throw error when file size exceeds limit', () => {
    const smallGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Test</name>
    <trkseg>
      <trkpt lat="-37.8" lon="144.9"><ele>100</ele></trkpt>
      <trkpt lat="-37.81" lon="144.91"><ele>105</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    expect(() =>
      optimizeGpx(smallGpx, 'test.gpx', { maxFileSize: 100 })
    ).toThrow('exceeds maximum allowed size');
  });

  it('should throw error when point count exceeds limit', () => {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Large Track</name>
    <trkseg>`;

    // Generate 100 points
    for (let i = 0; i < 100; i++) {
      gpx += `
      <trkpt lat="${-37.8 + i * 0.001}" lon="${144.9 + i * 0.001}">
        <ele>100</ele>
      </trkpt>`;
    }

    gpx += `
    </trkseg>
  </trk>
</gpx>`;

    expect(() =>
      optimizeGpx(gpx, 'large.gpx', { maxPointCount: 50 })
    ).toThrow('Point count');
  });
});

describe('GPX_OPTIMIZER_DEFAULTS', () => {
  it('should have reasonable default values', () => {
    expect(GPX_OPTIMIZER_DEFAULTS.simplificationTolerance).toBe(10);
    expect(GPX_OPTIMIZER_DEFAULTS.elevationSmoothing).toBe(true);
    expect(GPX_OPTIMIZER_DEFAULTS.elevationSmoothingWindow).toBe(7);
    expect(GPX_OPTIMIZER_DEFAULTS.spikeThreshold).toBe(50);
    expect(GPX_OPTIMIZER_DEFAULTS.truncateStart).toBe(0);
    expect(GPX_OPTIMIZER_DEFAULTS.truncateEnd).toBe(0);
    expect(GPX_OPTIMIZER_DEFAULTS.stripExtensions).toBe(true);
    expect(GPX_OPTIMIZER_DEFAULTS.preserveTimestamps).toBe(true);
    expect(GPX_OPTIMIZER_DEFAULTS.coordinatePrecision).toBe(6);
    expect(GPX_OPTIMIZER_DEFAULTS.maxDistanceChangeRatio).toBe(0.05);
    expect(GPX_OPTIMIZER_DEFAULTS.maxElevationChangeRatio).toBe(0.15);
    expect(GPX_OPTIMIZER_DEFAULTS.maxPointCount).toBe(100000);
    expect(GPX_OPTIMIZER_DEFAULTS.maxFileSize).toBe(50 * 1024 * 1024);
  });
});
