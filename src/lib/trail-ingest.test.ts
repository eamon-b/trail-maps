/**
 * `buildTrail` — the pure ingestion pipeline lifted out of
 * scripts/build-trails.ts. The build script's own output is guarded by the
 * generated-JSON golden diff; these tests pin the behaviour the runtime
 * importer depends on.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseGpx } from './gpx-parser';
import { buildTrail, flattenGpx, type ParsedGpxResult } from './trail-ingest';
import type { TrailConfig } from './trail-types';

const FIXTURES = resolve(__dirname, '../../tests/fixtures/gpx');
const load = (name: string): ParsedGpxResult =>
  flattenGpx(parseGpx(readFileSync(resolve(FIXTURES, `${name}.gpx`), 'utf-8')));

function config(overrides: Partial<TrailConfig> = {}): TrailConfig {
  return {
    id: 'test-trail',
    name: 'Test Trail',
    shortName: 'TEST',
    region: 'Test',
    lengthKm: 0,
    gpxFile: 'test.gpx',
    ...overrides,
  };
}

describe('buildTrail', () => {
  it('builds a track with cumulative distance and elevation', () => {
    const trail = buildTrail(load('simple-trail'), { config: config() });

    expect(trail.track.points).toHaveLength(19);
    expect(trail.track.points[0].dist).toBe(0);
    expect(trail.track.totalDistance).toBeGreaterThan(9);
    expect(trail.track.totalDistance).toBeLessThan(13);
    // 10 → 50 up, 50 → 30 down
    expect(Math.round(trail.track.totalAscent)).toBe(40);
    expect(Math.round(trail.track.totalDescent)).toBe(20);
    // dist is monotonic and ends at totalDistance
    expect(trail.track.points[18].dist).toBeCloseTo(trail.track.totalDistance, 10);
  });

  it('writes the built length back onto the config', () => {
    const cfg = config();
    const trail = buildTrail(load('simple-trail'), { config: cfg });
    expect(trail.config.lengthKm).toBe(Math.round(trail.track.totalDistance * 10) / 10);
  });

  it('enriches waypoints with cumulative stats and track indices', () => {
    const trail = buildTrail(load('simple-trail'), { config: config() });

    expect(trail.waypoints.map(w => w.name)).toEqual(['Start', 'Campsite One', 'End']);
    expect(trail.waypoints[0].totalDistance).toBe(0);
    expect(trail.waypoints[1].type).toBe('campsite');
    expect(trail.waypoints[2].totalDistance).toBeCloseTo(trail.track.totalDistance, 1);
    for (const wp of trail.waypoints) {
      expect(trail.track.points[wp.trackIndex]).toBeDefined();
    }
    expect(trail.offTrailWaypoints).toEqual([]);
  });

  it('splits waypoints beyond the match radius into offTrailWaypoints', () => {
    const gpx = load('simple-trail');
    gpx.waypoints.push({ name: 'Far Away', lat: -34.5, lon: 152.5, type: 'waypoint' });

    const trail = buildTrail(gpx, { config: config() });
    expect(trail.waypoints).toHaveLength(3);
    expect(trail.offTrailWaypoints).toHaveLength(1);
    expect(trail.offTrailWaypoints[0].name).toBe('Far Away');
    expect(trail.offTrailWaypoints[0].distanceFromTrail).toBeGreaterThan(500);
  });

  it('classifies alternates and side trips and finds their junctions', () => {
    const trail = buildTrail(load('multi-track'), {
      config: config({
        trackClassification: {
          mainRoutePatterns: ['^Main'],
          alternatePatterns: ['^Alt'],
          sideTripPatterns: ['^ST:'],
        },
      }),
    });

    expect(trail.alternates.map(a => a.name)).toEqual(['Alt Detour']);
    expect(trail.sideTrips.map(s => s.name)).toEqual(['ST: Waterfall Lookout']);
    expect(trail.alternates[0].startDistance).toBeDefined();
    expect(trail.alternates[0].endDistance).toBeDefined();
    expect(trail.alternates[0].startDistance!).toBeLessThanOrEqual(trail.alternates[0].endDistance!);
  });

  it('reverses the route when reverseTrack is set', () => {
    const forward = buildTrail(load('simple-trail'), { config: config() });
    const reversed = buildTrail(load('simple-trail'), { config: config({ reverseTrack: true }) });

    expect(reversed.track.points[0].lat).toBe(forward.track.points[forward.track.points.length - 1].lat);
    expect(reversed.track.totalDistance).toBeCloseTo(forward.track.totalDistance, 6);
    expect(Math.round(reversed.track.totalAscent)).toBe(Math.round(forward.track.totalDescent));
    expect(reversed.waypoints.map(w => w.name)).toEqual(['End', 'Campsite One', 'Start']);
  });

  it('simplifies displayPoints once the track exceeds the target', () => {
    const gpx = load('simple-trail');
    const trail = buildTrail(gpx, { config: config(), targetDisplayPoints: 5 });

    expect(trail.track.displayPoints.length).toBeLessThan(trail.track.points.length);
    expect(trail.track.displayPoints[0]).toBe(trail.track.points[0]);
  });

  it('keeps displayPoints identical to points when under the target', () => {
    const trail = buildTrail(load('simple-trail'), { config: config() });
    expect(trail.track.displayPoints).toBe(trail.track.points);
  });

  it('uses the injected waypoint id minter', () => {
    const trail = buildTrail(load('simple-trail'), {
      config: config(),
      mintWaypointIds: waypoints => waypoints.map((_, i) => `zz_${i}`),
    });
    expect(trail.waypoints.map(w => w.id)).toEqual(['zz_0', 'zz_1', 'zz_2']);
  });

  it('throws on a duplicate waypoint id by default, and suffixes when asked', () => {
    const gpx = load('simple-trail');
    const collide = () => ['dup', 'dup', 'dup'];

    expect(() => buildTrail(gpx, { config: config(), mintWaypointIds: collide })).toThrow(
      /Duplicate waypoint id "dup"/
    );

    const suffixed = buildTrail(load('simple-trail'), {
      config: config(),
      mintWaypointIds: collide,
      duplicateWaypointIds: 'suffix',
    });
    expect(suffixed.waypoints.map(w => w.id)).toEqual(['dup', 'dup_2', 'dup_3']);
  });

  it('lets the caller replace the waypoint list and post-process ids', () => {
    const afterWaypointIds = vi.fn();
    const trail = buildTrail(load('simple-trail'), {
      config: config(),
      resolveWaypoints: waypoints => waypoints.map(wp => ({ ...wp, type: 'poi' })),
      mintWaypointIds: waypoints => waypoints.map((_, i) => `w_${i}`),
      afterWaypointIds,
    });

    expect(trail.waypoints.every(w => w.type === 'poi')).toBe(true);
    expect(afterWaypointIds).toHaveBeenCalledTimes(1);
    expect(afterWaypointIds.mock.calls[0][0].map((w: { id?: string }) => w.id)).toEqual([
      'w_0',
      'w_1',
      'w_2',
    ]);
  });

  it('lets the caller re-derive the config before distances are computed', () => {
    const trail = buildTrail(load('simple-trail'), {
      config: config(),
      finalizeConfig: current => ({ ...current, name: 'Regenerated', region: 'NSW' }),
    });
    expect(trail.config.name).toBe('Regenerated');
    expect(trail.config.region).toBe('NSW');
    expect(trail.config.lengthKm).toBeGreaterThan(0);
  });

  it('reports diagnostics', () => {
    const seen: unknown[] = [];
    buildTrail(load('multi-track'), {
      config: config({ trackClassification: { mainRoutePatterns: ['^Main'] } }),
      onDiagnostics: d => seen.push(d),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tracksFound: 3, mainTracksCombined: 1 });
  });

  it('cleans elevation only when asked', () => {
    const spiky = load('simple-trail');
    // Inject a 300m barometric spike that returns to the terrain immediately.
    spiky.tracks[0].points[5].ele += 300;

    const raw = buildTrail(spiky, { config: config() });
    const cleaned = buildTrail(
      (() => {
        const g = load('simple-trail');
        g.tracks[0].points[5].ele += 300;
        return g;
      })(),
      {
        config: config(),
        elevation: { removeSpikes: true, smooth: true, ascentThreshold: 3 },
      }
    );

    expect(raw.track.totalAscent).toBeGreaterThan(300);
    expect(cleaned.track.totalAscent).toBeLessThan(raw.track.totalAscent);
  });

  it('handles a bare single-track file with no waypoints', () => {
    const trail = buildTrail(load('no-waypoints'), { config: config() });
    expect(trail.waypoints).toEqual([]);
    expect(trail.offTrailWaypoints).toEqual([]);
    expect(trail.alternates).toEqual([]);
    expect(trail.track.points).toHaveLength(3);
  });

  it('handles a file with no track points at all', () => {
    const trail = buildTrail(load('empty-track'), { config: config() });
    expect(trail.track.points).toEqual([]);
    expect(trail.track.totalDistance).toBe(0);
    expect(trail.config.lengthKm).toBe(0);
  });

  it('carries climateLocations and direction onto the result', () => {
    const trail = buildTrail(load('simple-trail'), {
      config: config({
        direction: { default: 'Northbound', reversed: 'Southbound' },
        climateLocations: [{ name: 'Town', lat: -33.9, lon: 151.25 }],
      }),
    });
    expect(trail.direction).toEqual({ default: 'Northbound', reversed: 'Southbound' });
    expect(trail.climateLocations).toHaveLength(1);
    // Climate itself is file-system state; the build script stitches it on.
    expect(trail.climate).toBeNull();
  });
});
