/**
 * Variant junctions: loose ends, and alternates that hang off other alternates.
 *
 * The geometry here is synthetic and equatorial so the expected kilometres can
 * be derived by hand rather than from the code under test: at the equator
 * 0.01° of latitude or longitude is 1.1132 km, and every figure below is a
 * multiple of that.
 */

import { describe, it, expect } from 'vitest';
import { parseGpx } from './gpx-parser';
import { attachVariantsToParents, buildTrail, findVariantJunctions, flattenGpx } from './trail-ingest';
import type { RouteVariant, TrackPoint, TrailConfig } from './trail-types';

/** Kilometres per 0.01° at the equator, on the spherical earth `distance.ts` uses. */
const KM_PER_STEP = 1.11195;

/** A main route east along the equator, one point every 0.01° (1.112 km). */
function mainRoute(pointCount: number): TrackPoint[] {
  return Array.from({ length: pointCount }, (_, i) => ({
    lat: 0,
    lon: i * 0.01,
    ele: 100,
    dist: Math.round(i * KM_PER_STEP * 100) / 100,
  }));
}

/**
 * A variant drawn through `corners`, sampled every `stepDeg` along each leg.
 * Junctions are found by nearest *point*, so a sparsely drawn parent would put
 * a child's branch point kilometres from anything.
 */
function polyline(corners: [number, number][], stepDeg = 0.005): RouteVariant['points'] {
  const points = [{ lat: corners[0][0], lon: corners[0][1], ele: 100 }];
  for (let i = 1; i < corners.length; i++) {
    const [fromLat, fromLon] = corners[i - 1];
    const [toLat, toLon] = corners[i];
    const steps = Math.max(1, Math.round(Math.max(Math.abs(toLat - fromLat), Math.abs(toLon - fromLon)) / stepDeg));
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

function alternate(name: string, corners: [number, number][]): RouteVariant {
  return {
    name,
    type: 'alternate',
    points: polyline(corners),
    distance: 0,
    elevation: { ascent: 0, descent: 0 },
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

describe('findVariantJunctions with a loose end', () => {
  // Both ends sit 0.007° (778 m) north of the route — the way a hand-drawn
  // CalTopo alternate stops short of the line it belongs to.
  const loose = (): RouteVariant[] => [
    alternate('Loose Alternate', [
      [0.007, 0.02],
      [0.007, 0.05],
    ]),
  ];

  it('leaves an end beyond the default tolerance unattached', () => {
    const [variant] = findVariantJunctions(loose(), mainRoute(11));
    expect(variant.startDistance).toBeUndefined();
    expect(variant.endDistance).toBeUndefined();
    expect(variant.startOffsetMeters).toBeUndefined();
  });

  it('attaches it under a raised tolerance and records the residual', () => {
    const [variant] = findVariantJunctions(loose(), mainRoute(11), 1000);

    // Nearest route points are lon 0.02 (km 2.22) and lon 0.05 (km 5.56).
    expect(variant.startDistance).toBeCloseTo(2.22, 2);
    expect(variant.endDistance).toBeCloseTo(5.56, 2);
    expect(variant.startOffsetMeters).toBe(778);
    expect(variant.endOffsetMeters).toBe(778);
  });

  it('keeps the residual with its own end when the junctions read backwards', () => {
    // Drawn east-to-west, so the pass swaps the pair to read forwards. The
    // 778 m end has to travel with it.
    const backwards = alternate('Backwards', [
      [0.007, 0.05],
      [0.002, 0.02],
    ]);
    const [variant] = findVariantJunctions([backwards], mainRoute(11), 1000);

    expect(variant.startDistance).toBeCloseTo(2.22, 2);
    expect(variant.endDistance).toBeCloseTo(5.56, 2);
    expect(variant.startOffsetMeters).toBeUndefined(); // 222 m, inside the standard tolerance
    expect(variant.endOffsetMeters).toBe(778);
  });

  it('is threaded through buildTrail by trackClassification.maxJunctionDistanceMeters', () => {
    const point = (lat: number, lon: number): string => `<trkpt lat="${lat}" lon="${lon}"><ele>100</ele></trkpt>`;
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Main Route</name><trkseg>
    ${Array.from({ length: 11 }, (_, i) => point(0, i * 0.01)).join('\n    ')}
  </trkseg></trk>
  <trk><name>Alt Ridge</name><trkseg>
    ${Array.from({ length: 4 }, (_, i) => point(0.007, 0.02 + i * 0.01)).join('\n    ')}
  </trkseg></trk>
</gpx>`;
    const parsed = flattenGpx(parseGpx(gpx));
    const classification = { mainRoutePatterns: ['^Main'], alternatePatterns: ['^Alt'] };

    const asBuilt = buildTrail(parsed, { config: config({ trackClassification: classification }) });
    expect(asBuilt.alternates[0].startDistance).toBeUndefined();

    const loosened = buildTrail(parsed, {
      config: config({
        trackClassification: { ...classification, maxJunctionDistanceMeters: 1000 },
      }),
    });
    expect(loosened.alternates[0].startDistance).toBeCloseTo(2.22, 2);
    expect(loosened.alternates[0].startOffsetMeters).toBe(778);
  });
});

describe('attachVariantsToParents', () => {
  /**
   * A 33 km route along the equator with a lollipop parent off it:
   *
   *   parent  leaves at km 4.45 (lon 0.04), runs 11.12 km north to lat 0.10,
   *           6.67 km east to lon 0.10, then back south to the route at km 11.12.
   *   child   hangs off the parent's northern leg between lon 0.06 and 0.08.
   *   grandchild hangs off the child's own northern leg.
   *
   * Nothing but the parent touches the route, so without this pass the child
   * and grandchild have no place on the trail's km scale at all.
   */
  const route = mainRoute(31);
  const parent = (): RouteVariant =>
    alternate('Parent Alternate', [
      [0, 0.04],
      [0.1, 0.04],
      [0.1, 0.1],
      [0, 0.1],
    ]);
  const child = (): RouteVariant =>
    alternate('Child Alternate', [
      [0.1, 0.06],
      [0.14, 0.06],
      [0.14, 0.08],
      [0.1, 0.08],
    ]);
  const grandchild = (): RouteVariant =>
    alternate('Grandchild Alternate', [
      [0.14, 0.065],
      [0.16, 0.065],
      [0.16, 0.075],
      [0.14, 0.075],
    ]);

  function attach(variants: RouteVariant[]): RouteVariant[] {
    return attachVariantsToParents(findVariantJunctions(variants, route), [], route).alternates;
  }

  it('gives a child the parent junction km plus the walk along the parent', () => {
    const [attachedParent, attachedChild] = attach([parent(), child()]);

    expect(attachedParent.startDistance).toBeCloseTo(4.45, 2);
    expect(attachedParent.parent).toBeUndefined();

    // 4.45 (parent leaves the route) + 11.12 north + 2.22 east = 17.79;
    // the rejoin is 2.22 km further along the parent's northern leg.
    expect(attachedChild.parent).toEqual({ name: 'Parent Alternate', index: 0 });
    expect(attachedChild.startDistance).toBeCloseTo(17.79, 1);
    expect(attachedChild.endDistance).toBeCloseTo(20.02, 1);
    expect(attachedChild.startTrackIndex).toBeUndefined(); // no main-route index to point at
  });

  it('follows a chain, so a child of a child attaches too', () => {
    const [, attachedChild, attachedGrandchild] = attach([parent(), child(), grandchild()]);

    // 17.79 (where the child leaves the parent) + 4.45 north + 0.56 east.
    expect(attachedGrandchild.parent).toEqual({ name: 'Child Alternate', index: 1 });
    expect(attachedGrandchild.startDistance).toBeCloseTo(22.79, 1);
    expect(attachedGrandchild.endDistance).toBeCloseTo(23.91, 1);
    expect(attachedChild.startDistance).toBeCloseTo(17.79, 1);
  });

  it('attaches a chain drawn in any order', () => {
    // The grandchild is first in the file, so it can only attach on a later
    // round — the pass has to repeat rather than make a single sweep.
    const attached = attach([grandchild(), child(), parent()]);
    const byName = new Map(attached.map(v => [v.name, v]));

    expect(byName.get('Child Alternate')!.parent!.name).toBe('Parent Alternate');
    expect(byName.get('Grandchild Alternate')!.parent!.name).toBe('Child Alternate');
    expect(byName.get('Grandchild Alternate')!.startDistance).toBeCloseTo(22.79, 1);
  });

  it('measures from the right end when the parent was normalised backwards', () => {
    // Same parent drawn the other way round: findVariantJunctions swaps its
    // junction pair to read forwards but leaves `points` alone, so the walk to
    // the child's branch point runs from the last point, not the first.
    const backwards = alternate('Parent Alternate', [
      [0, 0.1],
      [0.1, 0.1],
      [0.1, 0.04],
      [0, 0.04],
    ]);
    const [attachedParent, attachedChild] = attach([backwards, child()]);

    expect(attachedParent.startDistance).toBeCloseTo(4.45, 2);
    expect(attachedChild.startDistance).toBeCloseTo(17.79, 1);
    expect(attachedChild.endDistance).toBeCloseTo(20.02, 1);
  });

  it('leaves a variant alone when nothing attached is near it', () => {
    const orphan = alternate('Orphan', [
      [0.5, 0.5],
      [0.5, 0.55],
    ]);
    const [, attachedOrphan] = attach([parent(), orphan]);

    expect(attachedOrphan.startDistance).toBeUndefined();
    expect(attachedOrphan.parent).toBeUndefined();
  });

  it('does not hang a route off a side trip, but does attach one to an alternate', () => {
    const sideTrip: RouteVariant = { ...child(), type: 'side-trip', name: 'Child Spur' };
    const result = attachVariantsToParents(
      findVariantJunctions([parent()], route),
      findVariantJunctions([sideTrip], route),
      route
    );

    // The spur starts on the parent, so it gets a junction; its far end is a
    // turnaround, not a rejoin, so no endDistance is invented for it.
    expect(result.sideTrips[0].startDistance).toBeCloseTo(17.79, 1);
    expect(result.sideTrips[0].endDistance).toBeUndefined();
    expect(result.sideTrips[0].parent!.name).toBe('Parent Alternate');
  });

  it('is a no-op for trails whose variants all meet the main route', () => {
    const onRoute = findVariantJunctions(
      [
        alternate('On Route', [
          [0, 0.02],
          [0.01, 0.03],
          [0, 0.05],
        ]),
      ],
      route
    );
    const { alternates } = attachVariantsToParents(onRoute, [], route);

    expect(alternates[0].parent).toBeUndefined();
    expect(alternates[0].startDistance).toBe(onRoute[0].startDistance);
    expect(alternates[0].endDistance).toBe(onRoute[0].endDistance);
  });
});
