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
  calculateAdaptiveTolerance,
  flattenGpx,
  recomputeTrailElevation,
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

  it('carries the GPX off-trail access fields onto route and variant waypoints', () => {
    const trail = buildTrail(load('waypoint-extensions'), {
      config: config({
        trackClassification: {
          mainRoutePatterns: ['^Main'],
          alternatePatterns: ['^Alt'],
        },
      }),
    });

    const salida = trail.waypoints.find(wp => wp.name === 'Salida')!;
    expect(salida).toMatchObject({
      type: 'town-access',
      offTrailKm: 35.4,
      accessMode: 'hitch',
      acceptsBoxes: true,
      accessName: 'Monarch Pass (US 50)',
    });

    // A waypoint the file says nothing about keeps no access keys at all, so
    // the generated JSON for every existing trail is unchanged.
    const garmin = trail.waypoints.find(wp => wp.name === 'Garmin Marker')!;
    for (const field of ['offTrailKm', 'accessMode', 'acceptsBoxes', 'accessName']) {
      expect(field in garmin).toBe(false);
    }

    const onAlternate = trail.alternates[0].waypoints!.find(wp => wp.name === 'Mesopotamia Station')!;
    expect(onAlternate).toMatchObject({
      offTrailKm: 2.5,
      accessMode: 'shuttle',
      acceptsBoxes: true,
      accessName: 'Rangitata road end',
    });
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

  it('suffixes revisited waypoints when trail.json asks, and the caller can still insist on throwing', () => {
    const collide = () => ['dup', 'dup', 'dup'];
    const revisiting = { ...config(), revisitedWaypointIds: 'suffix' as const };

    const suffixed = buildTrail(load('simple-trail'), { config: revisiting, mintWaypointIds: collide });
    expect(suffixed.waypoints.map(w => w.id)).toEqual(['dup', 'dup_2', 'dup_3']);

    expect(() =>
      buildTrail(load('simple-trail'), { config: revisiting, mintWaypointIds: collide, duplicateWaypointIds: 'throw' })
    ).toThrow(/revisitedWaypointIds/);
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
    expect(afterWaypointIds.mock.calls[0][0].map((w: { id?: string }) => w.id)).toEqual(['w_0', 'w_1', 'w_2']);
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
        resolveWaypoints: () => [{ name: 'Riverside Campground', lat: -33.9, lon: 151.25, type: 'waypoint' }],
      });
      expect(trail.waypoints[0].type).toBe('campsite');
    });
  });
});

describe('buildTrail with route breaks', () => {
  /**
   * Two stretches a few km apart on the same meridian, the far one 380 m
   * higher. 0.01 degrees of latitude is ~1.11 km.
   */
  function brokenRoute(): ParsedGpxResult {
    const stretch = (startLat: number, baseEle: number) =>
      [0, 1, 2].map(i => ({
        lat: startLat - i * 0.01,
        lon: 138,
        ele: baseEle + i * 10,
        time: null,
      }));
    return {
      tracks: [
        { name: 'Main 1/2', points: stretch(-34.0, 100) },
        { name: 'Main 2/2', points: stretch(-34.05, 500) },
      ],
      waypoints: [
        { name: 'Near shore', lat: -34.02, lon: 138, type: 'waypoint' },
        { name: 'Far shore', lat: -34.05, lon: 138, type: 'waypoint' },
        { name: 'End', lat: -34.07, lon: 138, type: 'waypoint' },
      ],
      name: null,
    };
  }

  const brokenConfig = (stretches: boolean) =>
    config({
      trackClassification: {
        mainRoutePatterns: ['^Main '],
        fallbackToLongest: false,
        ...(stretches ? { stretches: { minGapMeters: 250 } } : {}),
      },
    });

  it('leaves the crossing out of distance and climb', () => {
    const trail = buildTrail(brokenRoute(), { config: brokenConfig(true) });

    // Four 1.11 km legs walked; the 3.3 km between the stretches is not one.
    expect(trail.track.totalDistance).toBeCloseTo(4.45, 1);
    expect(Math.round(trail.track.totalAscent)).toBe(40);
    expect(Math.round(trail.track.totalDescent)).toBe(0);
  });

  it('counts the crossing when the trail has not declared its stretches', () => {
    const trail = buildTrail(brokenRoute(), { config: brokenConfig(false) });

    expect(trail.track.totalDistance).toBeGreaterThan(6);
    // The 400 → 500 m step across the gap is charged as climb.
    expect(Math.round(trail.track.totalAscent)).toBe(420);
    expect(trail.track.breaks).toBeUndefined();
  });

  it('records the break where the route resumes, at the km it left off', () => {
    const trail = buildTrail(brokenRoute(), { config: brokenConfig(true) });

    expect(trail.track.breaks).toHaveLength(1);
    const [routeBreak] = trail.track.breaks!;
    expect(routeBreak.index).toBe(3);
    expect(routeBreak.fromTrack).toBe('Main 1/2');
    expect(routeBreak.toTrack).toBe('Main 2/2');
    expect(routeBreak.straightLineKm).toBeCloseTo(3.34, 1);

    // The route does not advance across a break: both sides read the same km.
    const points = trail.track.points;
    expect(points[3].dist).toBe(points[2].dist);
    expect(routeBreak.km).toBeCloseTo(points[3].dist, 3);
  });

  it('keeps every point — a break is not a deletion', () => {
    const trail = buildTrail(brokenRoute(), { config: brokenConfig(true) });

    expect(trail.track.points).toHaveLength(6);
    expect(trail.track.points[3].ele).toBe(500);
  });

  it('reports the built length as what is walked', () => {
    const cfg = brokenConfig(true);
    const trail = buildTrail(brokenRoute(), { config: cfg });

    expect(trail.config.lengthKm).toBe(Math.round(trail.track.totalDistance * 10) / 10);
  });

  it('refuses a config that also extracts spurs, rather than misplacing the break', () => {
    expect(() =>
      buildTrail(brokenRoute(), {
        config: config({
          trackClassification: {
            mainRoutePatterns: ['^Main '],
            fallbackToLongest: false,
            stretches: { minGapMeters: 250 },
          },
          extractSpurs: [{ name: 'Spur', fromKm: 1 }],
        }),
      })
    ).toThrow(/not supported together/);
  });
});

describe('a loop that ends where it started', () => {
  /** A square loop of 4 x 0.05 deg sides, closed back on its first point. */
  function loopRoute(): ParsedGpxResult {
    const corners = [
      [-34.0, 138.0],
      [-34.0, 138.05],
      [-34.05, 138.05],
      [-34.05, 138.0],
      [-34.0, 138.0],
    ];
    const points = [];
    for (let c = 0; c < corners.length - 1; c++) {
      for (let i = 0; i < 10; i++) {
        const t = i / 10;
        points.push({
          lat: corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t,
          lon: corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t,
          ele: 100,
          time: null,
        });
      }
    }
    points.push({ lat: -34.0, lon: 138.0, ele: 100, time: null });
    return {
      tracks: [{ name: 'Loop', points }],
      waypoints: [
        { name: 'Trailhead', lat: -34.0001, lon: 138.0001, type: 'trailhead' },
        { name: 'Far corner', lat: -34.05, lon: 138.05, type: 'campsite' },
      ],
      name: null,
    };
  }

  it('lists the trailhead once, at km 0', () => {
    const trail = buildTrail(loopRoute(), { config: config() });

    expect(trail.waypoints.map(w => w.name)).toEqual(['Trailhead', 'Far corner']);
    expect(trail.waypoints[0].totalDistance).toBe(0);
  });

  it('lists a place walked to from just before the finish at the finish, not at km 0', () => {
    // Portland on the Great South West Walk: in range of both ends of the
    // loop, and its junction is on the last side, 330 m before the finish.
    const gpx = loopRoute();
    gpx.waypoints.push({ id: 'w_town', name: 'Town', lat: -34.002, lon: 137.998, type: 'town' });
    const trail = buildTrail(gpx, {
      config: config(),
      waypointAccess: new Map([['w_town', { junction: { lat: -34.003, lon: 138.0 }, offTrailKm: 0.4 }]]),
    });

    expect(trail.waypoints.map(w => w.name)).toEqual(['Trailhead', 'Far corner', 'Town']);
    const town = trail.waypoints[2];
    expect(trail.track.totalDistance - town.totalDistance).toBeCloseTo(0.33, 1);
    expect(town.offTrailKm).toBe(0.4);
  });

  it('gives every row of a waypoint the store its access entry names', () => {
    const gpx = loopRoute();
    gpx.waypoints.push(
      { id: 'w_town', name: 'Town', lat: -34.002, lon: 137.998, type: 'town' },
      // Far beyond the match radius: an off-trail row, which takes it too.
      { id: 'w_far', name: 'Far Town', lat: -34.5, lon: 138.5, type: 'town' }
    );
    gpx.waypoints[0].id = 'w_head';
    const trail = buildTrail(gpx, {
      config: config(),
      waypointStores: new Map([
        ['w_town', 'limited'],
        ['w_far', 'full'],
      ]),
    });
    expect(trail.waypoints.find(w => w.id === 'w_town')?.store).toBe('limited');
    expect(trail.offTrailWaypoints.find(w => w.id === 'w_far')?.store).toBe('full');
    // A waypoint no entry names gains no key, so the other trails' JSON is unchanged.
    expect('store' in trail.waypoints.find(w => w.id === 'w_head')!).toBe(false);
  });

  it('keeps a start waypoint at km 0 when the loop ends nearer it than it began', () => {
    // A recorded loop that finishes a few metres past its start.
    const gpx = loopRoute();
    gpx.tracks[0].points.push({ lat: -34.0001, lon: 138.0001, ele: 100, time: null });
    const trail = buildTrail(gpx, { config: config() });
    expect(trail.waypoints.map(w => w.name)).toEqual(['Trailhead', 'Far corner']);
    expect(trail.waypoints[0].totalDistance).toBe(0);
  });

  it('still lists the junction again at the end of an out-and-back side trip', () => {
    // 2 km of main route, and a side trip that leaves at its start, goes 1 km
    // east and comes back. The return to the junction is a datasheet row on
    // purpose; only the main route merges a closing pass into km 0.
    const main = [0, 1, 2, 3, 4].map(i => ({ lat: -34.0 - i * 0.0045, lon: 138.0, ele: 100, time: null }));
    const out = [0, 1, 2, 3, 4].map(i => ({ lat: -34.0, lon: 138.0 + i * 0.0027, ele: 100, time: null }));
    const trail = buildTrail(
      {
        tracks: [
          { name: 'Main', points: main },
          { name: 'Side trip: Lookout', points: [...out, ...out.slice(0, -1).reverse()] },
        ],
        waypoints: [
          { name: 'Junction', lat: -34.0, lon: 138.0, type: 'junction' },
          { name: 'Lookout', lat: -34.0, lon: 138.0108, type: 'poi' },
        ],
        name: null,
      },
      { config: config() }
    );

    expect(trail.sideTrips[0].waypoints?.map(w => w.name)).toEqual(['Junction', 'Lookout', 'Junction']);
  });

  it('does not report the loop as a retrace', () => {
    let diagnostics: BuildTrailDiagnostics | undefined;
    buildTrail(loopRoute(), { config: config(), onDiagnostics: d => (diagnostics = d) });

    expect(diagnostics?.selfRetraces).toEqual([]);
  });
});

describe('knownRetraces', () => {
  /** 3 km south, 3 km back north on itself, then 3 km east: a retrace turning at km 3. */
  function outAndBack(): ParsedGpxResult {
    const leg = (from: [number, number], dLat: number, dLon: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        lat: from[0] + dLat * (i / 30),
        lon: from[1] + dLon * (i / 30),
        ele: 100,
        time: null,
      }));
    const points = [
      ...leg([-34.0, 138.0], -0.027, 0),
      ...leg([-34.027, 138.0], 0.027, 0.0001),
      ...leg([-34.0, 138.0001], 0, 0.033),
      { lat: -34.0, lon: 138.0331, ele: 100, time: null },
    ];
    return { tracks: [{ name: 'Main', points }], waypoints: [], name: null };
  }

  function build(knownRetraces?: TrailConfig['knownRetraces']) {
    const warnings: string[] = [];
    const logs: string[] = [];
    buildTrail(outAndBack(), {
      config: config(knownRetraces ? { knownRetraces } : {}),
      warn: m => warnings.push(m),
      log: m => logs.push(m),
    });
    return { warnings: warnings.filter(w => /retrace/i.test(w)), logs };
  }

  it('warns about a retrace nothing explains', () => {
    expect(build().warnings).toEqual([expect.stringMatching(/retraces 3\.0 km around km 3\.0/)]);
  });

  it('logs the note instead for a retrace the config lists', () => {
    const { warnings, logs } = build([{ turnaroundKm: 3.4, lengthKm: 3, note: 'Into town and back' }]);

    expect(warnings).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(/\(known\): Into town and back$/));
  });

  it('warns about an entry the route no longer has', () => {
    const { warnings } = build([{ turnaroundKm: 6, lengthKm: 3, note: 'Moved' }]);

    expect(warnings).toEqual([
      expect.stringMatching(/knownRetraces lists a 3 km retrace at km 6/),
      expect.stringMatching(/retraces 3\.0 km around km 3\.0/),
    ]);
  });

  it('does not take a retrace of a different length turning at the same km for the known one', () => {
    const { warnings } = build([{ turnaroundKm: 3, lengthKm: 7, note: 'A longer walk-in' }]);

    expect(warnings).toEqual([
      expect.stringMatching(/knownRetraces lists a 7 km retrace at km 3/),
      expect.stringMatching(/retraces 3\.0 km around km 3\.0/),
    ]);
  });

  it('pairs one entry with one retrace, so a duplicate entry is stale', () => {
    const { warnings, logs } = build([
      { turnaroundKm: 3.2, lengthKm: 3, note: 'Second' },
      { turnaroundKm: 3, lengthKm: 3, note: 'First' },
    ]);

    expect(logs).toContainEqual(expect.stringMatching(/\(known\): First$/));
    expect(warnings).toEqual([expect.stringMatching(/knownRetraces lists a 3 km retrace at km 3\.2/)]);
  });
});

describe('waypoint km across a route break', () => {
  /** Same two stretches as above, with a waypoint either side of the break. */
  function brokenRoute(): ParsedGpxResult {
    const stretch = (startLat: number, baseEle: number) =>
      [0, 1, 2].map(i => ({
        lat: startLat - i * 0.01,
        lon: 138,
        ele: baseEle + i * 10,
        time: null,
      }));
    return {
      tracks: [
        { name: 'Main 1/2', points: stretch(-34.0, 100) },
        { name: 'Main 2/2', points: stretch(-34.05, 500) },
      ],
      waypoints: [
        { name: 'Near shore', lat: -34.02, lon: 138, type: 'waypoint' },
        { name: 'Far shore', lat: -34.05, lon: 138, type: 'waypoint' },
        { name: 'End', lat: -34.07, lon: 138, type: 'waypoint' },
      ],
      name: null,
    };
  }

  const withStretches = config({
    trackClassification: {
      mainRoutePatterns: ['^Main '],
      fallbackToLongest: false,
      stretches: { minGapMeters: 250 },
    },
  });

  it('does not charge the crossing to the waypoint on the far side', () => {
    const trail = buildTrail(brokenRoute(), { config: withStretches });
    const km = Object.fromEntries(trail.waypoints.map(w => [w.name, w.totalDistance]));

    expect(km['Near shore']).toBeCloseTo(2.22, 1);
    // Same km on both sides of the break — the crossing is not walked.
    expect(km['Far shore']).toBeCloseTo(km['Near shore'], 3);
    expect(km['End']).toBeCloseTo(4.45, 1);
  });

  it('keeps waypoint km on the same scale as the track it is measured along', () => {
    const trail = buildTrail(brokenRoute(), { config: withStretches });

    // This is the invariant that broke: waypoints accumulated the straight-line
    // crossings while track.points had stopped counting them, so Te Araroa's
    // last waypoint landed 100 km past the end of its own trail.
    for (const wp of trail.waypoints) {
      expect(wp.totalDistance).toBeCloseTo(trail.track.points[wp.trackIndex].dist, 2);
    }
    // The last waypoint is at the trail's end, so it lands on the total, give
    // or take the 2-decimal rounding — not 100 km beyond it.
    const last = trail.waypoints[trail.waypoints.length - 1];
    expect(last.totalDistance - trail.track.totalDistance).toBeLessThan(0.01);
  });

  it('does not charge the crossing as climb either', () => {
    const trail = buildTrail(brokenRoute(), { config: withStretches });
    const far = trail.waypoints.find(w => w.name === 'Far shore')!;

    // 400 m up across the water, if it counted.
    expect(far.totalAscent).toBe(20);
    expect(far.ascent).toBe(0);
  });
});

describe('waypointAccess', () => {
  /** A valley floor, then a climb to a summit; a camp off to the side of the summit. */
  function climb(): ParsedGpxResult {
    const points = [0, 1, 2, 3, 4, 5, 6].map(i => ({
      lat: -34 - i * 0.005,
      lon: 138,
      ele: i < 2 ? 50 : 50 + (i - 1) * 100,
      time: null,
    }));
    return {
      tracks: [{ name: 'Main', points }],
      waypoints: [
        { id: 'w_valley', name: 'Valley', lat: -34.005, lon: 138, type: 'waypoint' },
        // Nearest the summit in a straight line, reached from the valley.
        { id: 'w_camp', name: 'Camp', lat: -34.03, lon: 138.012, type: 'campsite' },
      ],
      name: null,
    };
  }
  const atValley = new Map([['w_camp', { junction: { lat: -34.005, lon: 138 }, offTrailKm: 2.5 }]]);

  it('places the waypoint at its junction and keeps its own position', () => {
    const plain = buildTrail(climb(), { config: config({ waypointMaxDistance: 3000 }) });
    expect(plain.waypoints.find(w => w.name === 'Camp')!.elevation).toBe(550);

    const trail = buildTrail(climb(), { config: config({ waypointMaxDistance: 3000 }), waypointAccess: atValley });
    const camp = trail.waypoints.find(w => w.name === 'Camp')!;
    expect(camp.trackIndex).toBe(1);
    expect(camp.elevation).toBe(50);
    expect(camp.totalAscent).toBe(0);
    expect([camp.lat, camp.lon]).toEqual([-34.03, 138.012]);
    expect(camp.offTrailKm).toBe(2.5);
    expect(camp.accessMode).toBe('foot');
    expect(camp).not.toHaveProperty('offTrailPath');
    expect(trail.offTrailWaypoints.map(w => w.name)).not.toContain('Camp');
  });

  it('measures the junction along the line, not at the nearest vertex', () => {
    // Halfway along the 556 m from the valley to the next point: the vertex
    // snap put it at one end of the segment or the other.
    const trail = buildTrail(climb(), {
      config: config({ waypointMaxDistance: 3000 }),
      waypointAccess: new Map([['w_camp', { junction: { lat: -34.0075, lon: 138 }, offTrailKm: 2.5 }]]),
    });
    const valley = trail.waypoints.find(w => w.name === 'Valley')!;
    const camp = trail.waypoints.find(w => w.name === 'Camp')!;
    const segment = trail.track.points[2].dist - trail.track.points[1].dist;
    expect(camp.totalDistance).toBeCloseTo(valley.totalDistance + segment / 2, 1);
    expect(camp.distance).toBeCloseTo(camp.totalDistance - valley.totalDistance, 2);
  });

  it('keeps the rows in km order when a junction falls just before a vertex', () => {
    const gpx = climb();
    // At the vertex 556 m on from the valley, listed first in the source.
    gpx.waypoints.unshift({ id: 'w_saddle', name: 'Saddle', lat: -34.01, lon: 138, type: 'waypoint' });
    const trail = buildTrail(gpx, {
      config: config({ waypointMaxDistance: 3000 }),
      // 55 m before that vertex, and nearest it.
      waypointAccess: new Map([['w_camp', { junction: { lat: -34.0095, lon: 138 }, offTrailKm: 2.5 }]]),
    });
    expect(trail.waypoints.map(w => w.name)).toEqual(['Valley', 'Camp', 'Saddle']);
    const [valley, camp, saddle] = trail.waypoints;
    expect(saddle.totalDistance - camp.totalDistance).toBeCloseTo(0.06, 1);
    expect(camp.distance).toBeCloseTo(camp.totalDistance - valley.totalDistance, 2);
    expect(saddle.distance).toBeCloseTo(saddle.totalDistance - camp.totalDistance, 2);
    // The climb to the vertex is charged to whichever row now comes first.
    expect(camp.ascent + saddle.ascent).toBe(100);
    expect(camp.ascent).toBe(camp.totalAscent - valley.totalAscent);
  });

  it('walks a place no way was found to as the straight line to the route', () => {
    const trail = buildTrail(climb(), {
      config: config({ waypointMaxDistance: 3000 }),
      waypointAccessUnrouted: new Set(['w_camp']),
    });
    const camp = trail.waypoints.find(w => w.name === 'Camp')!;
    // 0.012 deg of longitude at 34 deg S, from the summit at the end of the route.
    expect(camp.offTrailKm).toBeCloseTo(1.11, 2);
    expect(camp).not.toHaveProperty('accessMode');
    expect(trail.waypoints.find(w => w.name === 'Valley')).not.toHaveProperty('offTrailKm');
  });

  it('carries the routed walk in for the map to draw', () => {
    const path: Array<[number, number]> = [
      [-34.005, 138],
      [-34.02, 138.006],
      [-34.03, 138.012],
    ];
    const trail = buildTrail(climb(), {
      config: config({ waypointMaxDistance: 3000 }),
      waypointAccess: new Map([['w_camp', { ...atValley.get('w_camp')!, path }]]),
    });
    expect(trail.waypoints.find(w => w.name === 'Camp')!.offTrailPath).toEqual(path);
    expect(trail.waypoints.find(w => w.name === 'Valley')).not.toHaveProperty('offTrailPath');
  });

  it("gives the walk to the main route's row only, not a variant that passes the place", () => {
    const gpx = climb();
    // An alternative from the valley through the camp and back to the summit.
    gpx.tracks.push({
      name: 'Alternative: by the camp',
      points: [
        [-34.005, 138],
        [-34.03, 138.012],
        [-34.03, 138],
      ].map(([lat, lon]) => ({ lat, lon, ele: 50, time: null })),
    });
    const trail = buildTrail(gpx, {
      config: config({ waypointMaxDistance: 3000, trackClassification: { mainRoutePatterns: ['^Main$'] } }),
      waypointAccess: atValley,
    });
    expect(trail.waypoints.find(w => w.name === 'Camp')!.offTrailKm).toBe(2.5);
    const onAlternate = trail.alternates[0].waypoints!.find(w => w.name === 'Camp')!;
    expect(onAlternate.offTrailKm).toBeUndefined();
    expect(onAlternate.offTrailPath).toBeUndefined();
  });

  it('never pulls a place beyond the match radius onto the route when its walk falls short of it', () => {
    // The camp is 2.99 km from the valley in a straight line: a 2.5 km walk
    // in cannot reach it, so the place has moved since the entry was written.
    const warnings: string[] = [];
    const trail = buildTrail(climb(), { config: config(), waypointAccess: atValley, warn: m => warnings.push(m) });
    expect(trail.waypoints.map(w => w.name)).not.toContain('Camp');
    expect(trail.offTrailWaypoints.map(w => w.name)).toContain('Camp');
    expect(warnings.join('\n')).toMatch(
      /access for "Camp" \(w_camp\) ignored: the place is \d+m from the route and 299\dm from its junction, beyond its 2.5 km walk/
    );
  });

  it('places a place beyond the match radius that its walk does reach, without widening the radius', () => {
    const warnings: string[] = [];
    const trail = buildTrail(climb(), {
      config: config(),
      waypointAccess: new Map([['w_camp', { junction: { lat: -34.005, lon: 138 }, offTrailKm: 3.2 }]]),
      warn: m => warnings.push(m),
    });
    const camp = trail.waypoints.find(w => w.name === 'Camp')!;
    expect(camp.trackIndex).toBe(1);
    expect(camp.offTrailKm).toBe(3.2);
    expect([camp.lat, camp.lon]).toEqual([-34.03, 138.012]);
    expect(trail.offTrailWaypoints.map(w => w.name)).not.toContain('Camp');
    expect(warnings).toEqual([]);
  });

  it('ignores a junction the route no longer passes', () => {
    const warnings: string[] = [];
    const trail = buildTrail(climb(), {
      config: config({ waypointMaxDistance: 3000 }),
      waypointAccess: new Map([['w_camp', { junction: { lat: -34.005, lon: 138.01 }, offTrailKm: 2.5 }]]),
      warn: m => warnings.push(m),
    });
    const camp = trail.waypoints.find(w => w.name === 'Camp')!;
    const plain = buildTrail(climb(), { config: config({ waypointMaxDistance: 3000 }) });
    // Where it would be with no entry at all: not moved onto the stale junction's km.
    expect(camp.elevation).toBe(550);
    expect(camp.totalDistance).toBe(plain.waypoints.find(w => w.name === 'Camp')!.totalDistance);
    // Walked as the straight line, like a place no way was found to.
    expect(camp.offTrailKm).toBeCloseTo(1.11, 2);
    expect(camp).not.toHaveProperty('accessMode');
    expect(warnings.join('\n')).toMatch(/re-run fetch-access/);
  });

  it('never climbs a negative leg when a junction projects back past another row', () => {
    // A hairpin: up the road from the trailhead, across, and back down beside
    // it. The camp's junction is beside the first leg (25 m off it), but the
    // vertex nearest it is on the way back down, past the Saddle.
    const m = (x: number, y: number, ele: number) => ({
      lat: -34 + y / 111_320,
      lon: 138 + x / 92_288,
      ele,
      time: null,
    });
    const points = [m(0, -1000, 0), m(0, 0, 0), m(60, 0, 100), m(60, -480, 200), m(60, -1000, 200)];
    const junction = m(25, -500, 0);
    const trail = buildTrail(
      {
        tracks: [{ name: 'Main', points }],
        waypoints: [
          { id: 'w_saddle', name: 'Saddle', lat: points[2].lat, lon: points[2].lon, type: 'waypoint' },
          { id: 'w_camp', name: 'Camp', lat: m(-400, -500, 0).lat, lon: m(-400, -500, 0).lon, type: 'campsite' },
        ],
        name: null,
      },
      {
        config: config({ waypointMaxDistance: 3000 }),
        waypointAccess: new Map([['w_camp', { junction: { lat: junction.lat, lon: junction.lon }, offTrailKm: 0.4 }]]),
      }
    );
    expect(trail.waypoints.map(w => w.name)).toEqual(['Camp', 'Saddle']);
    const [camp, saddle] = trail.waypoints;
    expect(camp.totalDistance).toBeCloseTo(0.5, 2);
    expect(camp.trackIndex).toBeLessThanOrEqual(saddle.trackIndex);
    expect(camp.totalAscent).toBe(0);
    expect(saddle.ascent).toBe(100);
    for (const w of trail.waypoints) expect(Math.min(w.ascent, w.descent, w.distance)).toBeGreaterThanOrEqual(0);
  });
});

describe('variantWaypointAccess', () => {
  /**
   * A main route south along 138 E; an alternate that leaves it at km 1.1,
   * runs 2.8 km east, south and back west to rejoin it. A camp 556 m south of
   * the alternate's east leg (and 1.8 km from the main route), a hut 167 m
   * north of it.
   */
  function withAlternate(): ParsedGpxResult {
    const at = (lat: number, lon: number) => ({ lat, lon, ele: 0, time: null });
    const steps = (n: number) => Array.from({ length: n }, (_, i) => i);
    const alternate = [
      ...steps(15).map(i => at(-34.01, 138 + i * 0.002)),
      ...steps(10).map(i => at(-34.01 - i * 0.002, 138.03)),
      ...steps(16).map(i => at(-34.03, 138.03 - i * 0.002)),
    ];
    return {
      tracks: [
        { name: 'Main', points: steps(11).map(i => at(-34 - i * 0.005, 138)) },
        { name: 'Alternative: east loop', points: alternate },
      ],
      waypoints: [
        { id: 'w_camp', name: 'Camp', lat: -34.015, lon: 138.02, type: 'campsite' },
        { id: 'w_hut', name: 'Hut', lat: -34.0085, lon: 138.01, type: 'hut' },
        { id: 'w_end', name: 'End', lat: -34.05, lon: 138, type: 'waypoint' },
      ],
      name: null,
    };
  }
  const trailConfig = () => config({ trackClassification: { mainRoutePatterns: ['^Main$'] } });
  // On the east leg between two vertices, 0.021 deg (1.94 km) along it.
  const camp = { junction: { lat: -34.01, lon: 138.021 }, offTrailKm: 0.6 };
  const access = new Map([
    ['Alternative: east loop', { placements: new Map([['w_camp', camp]]), unrouted: new Set(['w_hut']) }],
  ]);

  it("lists the place on the alternate at its junction's km along it, with its walk in", () => {
    const plain = buildTrail(withAlternate(), { config: trailConfig() });
    expect(plain.alternates[0].waypoints!.map(w => w.name)).toEqual(['Hut']);

    const warnings: string[] = [];
    const trail = buildTrail(withAlternate(), {
      config: trailConfig(),
      variantWaypointAccess: access,
      warn: m => warnings.push(m),
    });
    const alternate = trail.alternates[0];
    expect(alternate.waypoints!.map(w => w.name)).toEqual(['Hut', 'Camp']);
    const [hut, field] = alternate.waypoints!;
    expect(field.totalDistance).toBeCloseTo(alternate.startDistance! + 1.938, 1);
    expect(field.distance).toBeCloseTo(field.totalDistance - hut.totalDistance, 2);
    expect(hut.distance).toBeCloseTo(hut.totalDistance - alternate.startDistance!, 2);
    expect(field.variantTrackIndex).toBeGreaterThanOrEqual(hut.variantTrackIndex);
    expect([field.lat, field.lon]).toEqual([-34.015, 138.02]);
    expect(field.offTrailKm).toBe(0.6);
    expect(field.accessMode).toBe('foot');
    // No way found: the straight line to the alternate.
    expect(hut.offTrailKm).toBeCloseTo(0.17, 2);
    expect(hut).not.toHaveProperty('accessMode');
    expect(warnings).toEqual([]);

    // The main route is untouched, and the off-trail list as it was.
    expect(trail.waypoints).toEqual(plain.waypoints);
    expect(trail.offTrailWaypoints).toEqual(plain.offTrailWaypoints);
  });

  it("never applies an alternate's entry to the main route, or the main route's to an alternate", () => {
    const trail = buildTrail(withAlternate(), {
      config: trailConfig(),
      waypointAccess: new Map(),
      variantWaypointAccess: access,
    });
    expect(trail.waypoints.map(w => w.name)).not.toContain('Camp');
    const byMain = buildTrail(withAlternate(), {
      config: trailConfig(),
      waypointAccess: new Map([['w_camp', camp]]),
    });
    expect(byMain.alternates[0].waypoints!.map(w => w.name)).toEqual(['Hut']);
  });

  it('ignores, with a warning, a junction off the alternate or an alternate the trail lacks', () => {
    const warnings: string[] = [];
    const stale = new Map([
      [
        'Alternative: east loop',
        { placements: new Map([['w_camp', { ...camp, junction: { lat: -34.02, lon: 138.021 } }]]) },
      ],
      ['Alternative: gone', { placements: new Map([['w_camp', camp]]) }],
    ]);
    const trail = buildTrail(withAlternate(), {
      config: trailConfig(),
      variantWaypointAccess: stale,
      warn: m => warnings.push(m),
    });
    expect(trail.alternates[0].waypoints!.map(w => w.name)).toEqual(['Hut']);
    expect(warnings.join('\n')).toMatch(
      /alternate "Alternative: east loop": access for "Camp" \(w_camp\) ignored: its junction is \d+m from the route/
    );
    expect(warnings.join('\n')).toMatch(/access for alternate "Alternative: gone" ignored/);
  });
});

describe('the display copy of an out-and-back route', () => {
  /**
   * 2,000 points north along a meander the simplification keeps some of, then
   * back over exactly the same coordinates: every coordinate is passed twice.
   * The shape of the Bibbulmun's walk into Denmark and back.
   */
  function outAndBack(): ParsedGpxResult {
    const out = Array.from({ length: 2000 }, (_, i) => ({
      lat: -35 + i * 0.0005,
      lon: 117 + 0.002 * Math.sin(i / 50),
      ele: 100 + i * 0.1,
      time: null,
    }));
    const back = out
      .slice(0, -1)
      .reverse()
      .map(p => ({ ...p }));
    return { tracks: [{ name: 'There and back', points: [...out, ...back] }], waypoints: [], name: null };
  }

  it('keeps each kept point on its own pass, so km never runs backwards', () => {
    const trail = buildTrail(outAndBack(), { config: config() });
    const display = trail.track.displayPoints;

    expect(display.length).toBeLessThan(trail.track.points.length);
    for (let i = 1; i < display.length; i++) {
      expect(display[i].dist).toBeGreaterThanOrEqual(display[i - 1].dist);
    }
    // Every display point is one of the track's own points, km included.
    const byDist = new Map(trail.track.points.map(p => [p.dist, p]));
    for (const p of display) expect(byDist.get(p.dist)).toBe(p);
  });

  it('re-attaches recomputed elevations to the pass each display point is on', () => {
    const trail = buildTrail(outAndBack(), { config: config() });
    // The two passes now differ in height: the return is 1 km higher. The
    // display copy names points on both passes at the same coordinates.
    const n = trail.track.points.length;
    const points = trail.track.points.map((p, i) => ({ ...p, ele: i < n / 2 ? p.ele : p.ele + 1000 }));
    const lifted = {
      ...trail,
      track: { ...trail.track, points, displayPoints: [0, 500, 1500, 1999, 2498, 3498, n - 1].map(i => points[i]) },
    };

    const recomputed = recomputeTrailElevation(lifted);
    expect(recomputed.track.displayPoints[1].ele).toBeLessThan(1000);
    expect(recomputed.track.displayPoints[5].ele).toBeGreaterThan(1000);
    const byDist = new Map(recomputed.track.points.map(p => [p.dist, p.ele]));
    for (const p of recomputed.track.displayPoints) expect(p.ele).toBe(byDist.get(p.dist));
  });
});

describe('calculateAdaptiveTolerance', () => {
  /** A dense north-running track: `count` points at `spacingMeters` apart. */
  function densePoints(count: number, spacingMeters: number) {
    const degPerMeter = 1 / 111320;
    return Array.from({ length: count }, (_, i) => ({
      lat: -25 + i * spacingMeters * degPerMeter,
      lon: 133,
    }));
  }

  it('never exceeds the 25 m ceiling, however long and dense the track', () => {
    // Roughly the CDT: ~86,000 points over ~4,800 km. Uncapped, the formula
    // returns ~263 m here, which is 1.5 km between display points.
    const cdtish = densePoints(86_000, 56);
    expect(calculateAdaptiveTolerance(cdtish, 3000, 4827)).toBeLessThanOrEqual(25);

    // And an absurd trail stays capped rather than growing further.
    expect(calculateAdaptiveTolerance(densePoints(500_000, 50), 3000, 25_000)).toBe(25);
  });

  it('leaves a short track on the uncapped formula', () => {
    const points = densePoints(12_000, 10);
    const tolerance = calculateAdaptiveTolerance(points, 3000, 120);

    expect(tolerance).toBeGreaterThan(5);
    expect(tolerance).toBeLessThan(25);
  });

  it('still returns zero when the track is already under target', () => {
    expect(calculateAdaptiveTolerance(densePoints(100, 10), 3000, 1)).toBe(0);
  });
});
