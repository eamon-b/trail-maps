/**
 * Alternative trail ends ("termini"): a route that branches off the main line
 * at one end and stops somewhere else entirely - the CDT's Chief Mountain
 * border crossing, or its Columbus and Antelope Wells southern ends.
 *
 * These used to arrive as `Alternate:` tracks, which sent `findVariantJunctions`
 * looking for a rejoin 10-31 km away; it found none, left `endDistance`
 * undefined, and every reader drew a route with no end. The contract pinned here
 * is: one junction, at `points[0]`, never a rejoin, the free end carrying its
 * own `endpoint` waypoint, and nothing added to the trail's distance.
 *
 * Synthetic geometry is equatorial so the kilometres can be derived by hand:
 * 0.01° is 1.11195 km.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { classifyTracks, TRACK_CLASSIFICATION_DEFAULTS } from './track-classification';
import { parseGpx } from './gpx-parser';
import {
  attachVariantsToParents,
  buildTrail,
  enrichVariantWaypoints,
  findVariantJunctions,
  flattenGpx,
  type ParsedGpxResult,
} from './trail-ingest';
import { createReversedTrail } from './trail-reverse';
import type { RouteVariant, TrackPoint, TrailConfig, TrailWaypoint } from './trail-types';
import type { GpxPoint } from './types';

const FIXTURES = resolve(__dirname, '../../tests/fixtures/gpx');
const load = (name: string): ParsedGpxResult =>
  flattenGpx(parseGpx(readFileSync(resolve(FIXTURES, `${name}.gpx`), 'utf-8')));

const KM_PER_STEP = 1.11195;

/** A main route east along the equator, one point every 0.01°. */
function mainRoute(pointCount: number): TrackPoint[] {
  return Array.from({ length: pointCount }, (_, i) => ({
    lat: 0,
    lon: i * 0.01,
    ele: 100,
    dist: Math.round(i * KM_PER_STEP * 100) / 100,
  }));
}

function line(corners: [number, number][], stepDeg = 0.005): RouteVariant['points'] {
  const points = [{ lat: corners[0][0], lon: corners[0][1], ele: 100 }];
  for (let i = 1; i < corners.length; i++) {
    const [fromLat, fromLon] = corners[i - 1];
    const [toLat, toLon] = corners[i];
    const steps = Math.max(
      1,
      Math.round(Math.max(Math.abs(toLat - fromLat), Math.abs(toLon - fromLon)) / stepDeg)
    );
    for (let s = 1; s <= steps; s++) {
      points.push({
        lat: fromLat + ((toLat - fromLat) * s) / steps,
        lon: fromLon + ((toLon - fromLon) * s) / steps,
        ele: 100,
      });
    }
  }
  return points;
}

function terminus(name: string, corners: [number, number][]): RouteVariant {
  return {
    name,
    type: 'terminus',
    points: line(corners),
    distance: 0,
    elevation: { ascent: 40, descent: 5 },
  };
}

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

const track = (name: string, points: Array<{ lat: number; lon: number }>) => ({
  name,
  points: points.map(p => ({ ...p, ele: 0, time: null })) as GpxPoint[],
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifyTracks: terminus', () => {
  it('classifies a `Terminus: ` track into terminusTracks', () => {
    const result = classifyTracks(
      [
        track('CDT (SOBO) 1/2: mi 0.0-100.0', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }]),
        track('Terminus: Chief Mountain', [{ lat: 0.01, lon: 0 }, { lat: 0.05, lon: 0 }]),
      ],
      { mainRoutePatterns: ['^CDT '], fallbackToLongest: false }
    );

    expect(result.terminusTracks.map(t => t.name)).toEqual(['Terminus: Chief Mountain']);
    expect(result.terminusTracks[0].type).toBe('terminus');
    expect(result.mainTracks).toHaveLength(1);
    expect(result.unclassifiedTracks).toEqual([]);
  });

  it('ships a default pattern, so a user import needs no configuration', () => {
    expect(TRACK_CLASSIFICATION_DEFAULTS.terminusPatterns).toEqual([
      '^Terminus:',
      '\\bTerminus\\b',
    ]);
    const result = classifyTracks(
      [
        track('Day 1', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }]),
        track('Terminus: Antelope Wells', [{ lat: 0.01, lon: 0 }, { lat: 0.02, lon: 0 }]),
      ],
      {}
    );
    expect(result.terminusTracks.map(t => t.name)).toEqual(['Terminus: Antelope Wells']);
    // Fallback still promotes the longest *unclassified* track, not the terminus.
    expect(result.mainTracks.map(t => t.name)).toEqual(['Day 1']);
  });

  it('never steals a track a file already named as an alternate or side trip', () => {
    const result = classifyTracks(
      [
        track('Alternate: Southern Terminus Bypass', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]),
        track('Side trip: Terminus Monument', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]),
      ],
      {
        alternatePatterns: ['^Alternate: '],
        sideTripPatterns: ['^Side trip: '],
        fallbackToLongest: false,
      }
    );

    expect(result.alternateTracks).toHaveLength(1);
    expect(result.sideTripTracks).toHaveLength(1);
    expect(result.terminusTracks).toEqual([]);
  });

  it('leaves the other result lists untouched when nothing matches', () => {
    const result = classifyTracks([track('Main', [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }])], {});
    expect(result.terminusTracks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Junctions
// ---------------------------------------------------------------------------

describe('findVariantJunctions: terminus', () => {
  it('records exactly one junction, at points[0], and never a rejoin', () => {
    const [variant] = findVariantJunctions(
      [terminus('Terminus: Chief Mountain', [[0, 0.02], [0.09, 0.02]])],
      mainRoute(11)
    );

    expect(variant.startDistance).toBeCloseTo(2.22, 2);
    expect(variant.startTrackIndex).toBe(2);
    // The free end is ~10 km off the route; it must not become a rejoin.
    expect(variant.endDistance).toBeUndefined();
    expect(variant.endTrackIndex).toBeUndefined();
  });

  it('turns a backwards-drawn terminus round and swaps its ascent/descent', () => {
    const forwards = terminus('T', [[0, 0.02], [0.09, 0.02]]);
    const backwards: RouteVariant = {
      ...forwards,
      points: [...forwards.points].reverse(),
      elevation: { ascent: 5, descent: 40 },
    };

    const [variant] = findVariantJunctions([backwards], mainRoute(11));

    expect(variant.points[0].lat).toBeCloseTo(0, 6);
    expect(variant.points[variant.points.length - 1].lat).toBeCloseTo(0.09, 6);
    expect(variant.startDistance).toBeCloseTo(2.22, 2);
    expect(variant.endDistance).toBeUndefined();
    // Measured the way the line was drawn, so the pair travels with the points.
    expect(variant.elevation).toEqual({ ascent: 40, descent: 5 });
  });

  it('leaves a terminus whose junction end is out of tolerance unattached', () => {
    // Both ends 0.007° (778 m) north of the route: past the 500 m default.
    const [variant] = findVariantJunctions(
      [terminus('Loose', [[0.007, 0.02], [0.09, 0.02]])],
      mainRoute(11)
    );
    expect(variant.startDistance).toBeUndefined();
    expect(variant.endDistance).toBeUndefined();
  });

  it('records the residual when a raised tolerance takes a loose junction in', () => {
    const [variant] = findVariantJunctions(
      [terminus('Loose', [[0.007, 0.02], [0.09, 0.02]])],
      mainRoute(11),
      1000
    );
    expect(variant.startDistance).toBeCloseTo(2.22, 2);
    expect(variant.startOffsetMeters).toBe(778);
    expect(variant.endDistance).toBeUndefined();
  });
});

describe('attachVariantsToParents: terminus', () => {
  const parentAlternate = (): RouteVariant => ({
    name: 'High Route',
    type: 'alternate',
    points: line([[0, 0.02], [0.01, 0.03], [0, 0.05]]),
    distance: 0,
    elevation: { ascent: 0, descent: 0 },
  });

  it('hangs a terminus off an alternate when its junction is not on the main line', () => {
    const alternates = findVariantJunctions([parentAlternate()], mainRoute(11));
    // Branches from the parent's apex (0.01, 0.03) and runs away north.
    const child = terminus('Terminus: North Border', [[0.01, 0.03], [0.09, 0.03]]);

    const { sideTrips } = attachVariantsToParents(alternates, [child], 500);

    expect(sideTrips[0].parent).toEqual({ name: 'High Route', index: 0 });
    expect(sideTrips[0].startDistance).toBeGreaterThan(2.2);
    expect(sideTrips[0].endDistance).toBeUndefined();
  });

  it('repairs a backwards terminus that attaches to a parent', () => {
    const alternates = findVariantJunctions([parentAlternate()], mainRoute(11));
    const forwards = terminus('Terminus: North Border', [[0.01, 0.03], [0.09, 0.03]]);
    const backwards: RouteVariant = {
      ...forwards,
      points: [...forwards.points].reverse(),
      elevation: { ascent: 5, descent: 40 },
    };

    const { sideTrips } = attachVariantsToParents(alternates, [backwards], 500);

    expect(sideTrips[0].points[0].lat).toBeCloseTo(0.01, 6);
    expect(sideTrips[0].parent?.name).toBe('High Route');
    expect(sideTrips[0].elevation).toEqual({ ascent: 40, descent: 5 });
  });
});

describe('enrichVariantWaypoints: terminus', () => {
  it('counts waypoint km from the junction, like a side trip', () => {
    const [variant] = findVariantJunctions(
      [terminus('Terminus: Chief Mountain', [[0, 0.02], [0.09, 0.02]])],
      mainRoute(11)
    );
    const waypoints: TrailWaypoint[] = [
      { name: 'Chief Mountain', lat: 0.09, lon: 0.02, type: 'endpoint' },
    ];

    const [enriched] = enrichVariantWaypoints([variant], waypoints);

    expect(enriched.waypoints).toHaveLength(1);
    // 2.22 km junction + 0.09° (10.01 km) along the terminus.
    expect(enriched.waypoints![0].totalDistance).toBeCloseTo(12.23, 1);
    expect(enriched.waypoints![0].type).toBe('endpoint');
  });
});

// ---------------------------------------------------------------------------
// buildTrail, end to end from a GPX fixture
// ---------------------------------------------------------------------------

describe('buildTrail with a Terminus: track', () => {
  const built = () => buildTrail(load('terminus-trail'), { config: config() });

  it('carries the terminus in sideTrips, typed and with one junction', () => {
    const trail = built();

    expect(trail.alternates).toEqual([]);
    expect(trail.sideTrips).toHaveLength(1);
    const [t] = trail.sideTrips;
    expect(t.name).toBe('Terminus: Chief Mountain');
    expect(t.type).toBe('terminus');
    expect(t.startDistance).toBe(0);
    expect(t.startTrackIndex).toBe(0);
    expect(t.endDistance).toBeUndefined();
    expect(t.endTrackIndex).toBeUndefined();
    // Junction first, free end last.
    expect(t.points[0].lat).toBeCloseTo(-33.8688, 4);
    expect(t.points[t.points.length - 1].lat).toBeCloseTo(-33.8188, 4);
  });

  it('adds nothing to the main route', () => {
    const withTerminus = built();
    const withoutTerminus = buildTrail(load('simple-trail'), { config: config() });

    expect(withTerminus.track.totalDistance).toBeCloseTo(
      withoutTerminus.track.totalDistance,
      6
    );
    expect(withTerminus.waypoints.map(w => w.name)).toEqual(['Start', 'Campsite One', 'End']);
  });

  it('attaches the free-end endpoint waypoint to the terminus', () => {
    const [t] = built().sideTrips;
    const names = (t.waypoints ?? []).map(w => w.name);

    expect(names).toContain('Chief Mountain');
    expect(names).toContain('Border Road');
    const endpoint = t.waypoints!.find(w => w.name === 'Chief Mountain')!;
    expect(endpoint.type).toBe('endpoint');
    // Junction km (0) plus the walk out: ~5.6 km.
    expect(endpoint.totalDistance).toBeGreaterThan(5);
    expect(endpoint.totalDistance).toBeLessThan(6);
  });

  it('does not also list the terminus waypoints as off-trail', () => {
    const trail = built();
    expect(trail.offTrailWaypoints.map(w => w.name)).toEqual([]);
  });

  it('reports the terminus separately from the side trips', () => {
    let diagnostics: { sideTripCount: number; terminusCount: number } | null = null;
    buildTrail(load('terminus-trail'), {
      config: config(),
      onDiagnostics: d => {
        diagnostics = d;
      },
    });
    expect(diagnostics!.terminusCount).toBe(1);
    expect(diagnostics!.sideTripCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Direction reversal
// ---------------------------------------------------------------------------

describe('createReversedTrail with a terminus', () => {
  it('mirrors the junction km but keeps the line pointing at the free end', () => {
    const trail = buildTrail(load('terminus-trail'), { config: config() });
    const [forward] = trail.sideTrips;
    const total = trail.track.totalDistance;
    const endpointKm = forward.waypoints!.find(w => w.name === 'Chief Mountain')!.totalDistance;

    const reversed = createReversedTrail(trail);
    const [flipped] = reversed.sideTrips;

    expect(flipped.type).toBe('terminus');
    // The junction is mirrored about the trail total, like a side trip's.
    expect(flipped.startDistance).toBeCloseTo(total - forward.startDistance!, 6);
    expect(flipped.endDistance).toBeUndefined();
    // The points are NOT turned round: points[0] is still the junction.
    expect(flipped.points[0].lat).toBeCloseTo(forward.points[0].lat, 6);
    expect(flipped.points[flipped.points.length - 1].lat).toBeCloseTo(
      forward.points[forward.points.length - 1].lat,
      6
    );
    // Its waypoints ride along: the endpoint keeps its distance from the
    // junction, measured from the new start.
    const flippedEndpoint = flipped.waypoints!.find(w => w.name === 'Chief Mountain')!;
    expect(flippedEndpoint.totalDistance - flipped.startDistance!).toBeCloseTo(
      endpointKm - forward.startDistance!,
      2
    );
  });
});
