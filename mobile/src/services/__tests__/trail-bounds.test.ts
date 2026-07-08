import type { TrackPoint } from '../../lib/trail-utils';
import { calculateTrailBounds } from '../trail-bounds';

function makeTrackPoints(
  latRange: [number, number],
  lonRange: [number, number],
  count = 100,
): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    points.push({
      lat: latRange[0] + frac * (latRange[1] - latRange[0]),
      lon: lonRange[0] + frac * (lonRange[1] - lonRange[0]),
      ele: 200,
      dist: frac * 100,
    });
  }
  return points;
}

describe('calculateTrailBounds', () => {
  it('calculates bounding box from track points', () => {
    const points = makeTrackPoints([-34, -33], [115, 116]);
    const bounds = calculateTrailBounds(points);

    expect(bounds.south).toBeLessThan(-34);
    expect(bounds.north).toBeGreaterThan(-33);
    expect(bounds.west).toBeLessThan(115);
    expect(bounds.east).toBeGreaterThan(116);
  });

  it('adds buffer around track', () => {
    const points = makeTrackPoints([-34, -33], [115, 116]);
    const bounds = calculateTrailBounds(points, 0.1);

    expect(bounds.south).toBeCloseTo(-34.1, 1);
    expect(bounds.north).toBeCloseTo(-32.9, 1);
    expect(bounds.west).toBeCloseTo(114.9, 1);
    expect(bounds.east).toBeCloseTo(116.1, 1);
  });

  it('throws for empty track', () => {
    expect(() => calculateTrailBounds([])).toThrow('empty track');
  });

  it('works with a single point', () => {
    const points: TrackPoint[] = [{
      lat: -33.5, lon: 115.5, ele: 200, dist: 0,
    }];
    const bounds = calculateTrailBounds(points);

    expect(bounds.south).toBeLessThan(-33.5);
    expect(bounds.north).toBeGreaterThan(-33.5);
    expect(bounds.west).toBeLessThan(115.5);
    expect(bounds.east).toBeGreaterThan(115.5);
  });

  it('uses custom buffer', () => {
    const points = makeTrackPoints([-34, -33], [115, 116]);
    const bounds = calculateTrailBounds(points, 0.5);

    expect(bounds.south).toBeCloseTo(-34.5, 1);
    expect(bounds.north).toBeCloseTo(-32.5, 1);
  });
});
