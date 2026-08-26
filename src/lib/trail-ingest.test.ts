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
import {
  buildTrail,
  flattenGpx,
  type BuildTrailDiagnostics,
  type ParsedGpxResult,
} from './trail-ingest';
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

  describe('keyword type inference (inferWaypointTypesFromKeywords)', () => {
    // The build script must NOT set this: curated trails get their types from
    // CalTopo folders and hand-written prefixes, and the generated JSON is
    // pinned alongside data/waypoint-ids.json.
    it('is off by default — keyword-named waypoints stay unclassified', () => {
      const trail = buildTrail(load('keyword-waypoints'), { config: config() });
      const types = new Map(trail.waypoints.map(w => [w.name, w.type]));

      expect(types.get('Northcliffe trailhead')).toBe('waypoint');
      expect(types.get('Wallaby Creek Campsite')).toBe('waypoint');
      expect(types.get('Water tank (rainwater)')).toBe('waypoint');
      expect(types.get('Coles Supermarket')).toBe('waypoint');
      expect(types.get('Hut 3')).toBe('waypoint');
    });

    it('reports zero keyword-typed waypoints when off', () => {
      const seen: BuildTrailDiagnostics[] = [];
      buildTrail(load('keyword-waypoints'), {
        config: config(),
        onDiagnostics: d => seen.push(d),
      });
      expect(seen[0].keywordTypedWaypointCount).toBe(0);
      // Everything except the explicitly typed "Bay Lookout" is unclassified.
      expect(seen[0].unclassifiedWaypointCount).toBe(6);
    });

    it('types waypoints from their names when on', () => {
      const trail = buildTrail(load('keyword-waypoints'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
      });
      const types = new Map(trail.waypoints.map(w => [w.name, w.type]));

      expect(types.get('Northcliffe trailhead')).toBe('trailhead');
      expect(types.get('Wallaby Creek Campsite')).toBe('campsite');
      expect(types.get('Water tank (rainwater)')).toBe('water-tank');
      expect(types.get('Coles Supermarket')).toBe('food');
      expect(types.get('Hut 3')).toBe('hut');
      // No rule matches this one — it stays unclassified rather than guessing.
      expect(types.get('Heavitree Gap')).toBe('waypoint');
    });

    it('never overrides an explicit <wpt><type>', () => {
      const trail = buildTrail(load('keyword-waypoints'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
      });
      // "Lookout" would infer `poi`; the file said `mountain`.
      expect(trail.waypoints.find(w => w.name === 'Bay Lookout')?.type).toBe('mountain');
    });

    it('does not rename the waypoints it types', () => {
      const trail = buildTrail(load('keyword-waypoints'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
      });
      expect(trail.waypoints.map(w => w.name)).toEqual([
        'Northcliffe trailhead',
        'Wallaby Creek Campsite',
        'Water tank (rainwater)',
        'Coles Supermarket',
        'Hut 3',
        'Heavitree Gap',
        'Bay Lookout',
      ]);
    });

    it('counts what it typed and what it could not', () => {
      const seen: BuildTrailDiagnostics[] = [];
      buildTrail(load('keyword-waypoints'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
        onDiagnostics: d => seen.push(d),
      });
      expect(seen[0].keywordTypedWaypointCount).toBe(5);
      expect(seen[0].unclassifiedWaypointCount).toBe(1);
    });

    it('leaves waypoint ids untouched — the minter hashes name/lat/lon, not type', () => {
      const minter = (wps: { name: string }[]) => wps.map((wp, i) => `id_${i}_${wp.name}`);
      const off = buildTrail(load('keyword-waypoints'), {
        config: config(),
        mintWaypointIds: minter,
      });
      const on = buildTrail(load('keyword-waypoints'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
        mintWaypointIds: minter,
      });
      expect(on.waypoints.map(w => w.id)).toEqual(off.waypoints.map(w => w.id));
    });

    it('flattenGpx exposes the same flag for callers that stop at flattening', () => {
      const xml = readFileSync(resolve(FIXTURES, 'keyword-waypoints.gpx'), 'utf-8');
      const off = flattenGpx(parseGpx(xml));
      const on = flattenGpx(parseGpx(xml), { inferWaypointTypesFromKeywords: true });

      expect(off.waypoints.find(w => w.name === 'Hut 3')?.type).toBe('waypoint');
      expect(on.waypoints.find(w => w.name === 'Hut 3')?.type).toBe('hut');
      // Names are untouched either way.
      expect(on.waypoints.map(w => w.name)).toEqual(off.waypoints.map(w => w.name));
    });

    it('does not mutate the parsed GPX it was handed', () => {
      // With no resolveWaypoints hook, buildTrail's working array IS
      // gpx.waypoints. Typing in place would make a second build of the same
      // parsed file report nothing inferred, and would leak types back to a
      // caller that reuses the parse.
      const gpx = load('keyword-waypoints');
      const seen: BuildTrailDiagnostics[] = [];
      const opts = () => ({
        config: config(),
        inferWaypointTypesFromKeywords: true,
        onDiagnostics: (d: BuildTrailDiagnostics) => seen.push(d),
      });

      const first = buildTrail(gpx, opts());
      expect(gpx.waypoints.find(w => w.name === 'Hut 3')?.type).toBe('waypoint');

      const second = buildTrail(gpx, opts());
      expect(seen[0].keywordTypedWaypointCount).toBe(5);
      expect(seen[1].keywordTypedWaypointCount).toBe(5);
      expect(second.waypoints.map(w => w.type)).toEqual(first.waypoints.map(w => w.type));
    });

    it('also types waypoints a resolveWaypoints hook introduces', () => {
      const trail = buildTrail(load('simple-trail'), {
        config: config(),
        inferWaypointTypesFromKeywords: true,
        resolveWaypoints: () => [
          { name: 'Riverside Campground', lat: -33.9, lon: 151.25, type: 'waypoint' },
        ],
      });
      expect(trail.waypoints[0].type).toBe('campsite');
    });
  });
});
