/**
 * Alternative trail ends on the map: the dash-dot line, the badge at the free
 * end, and the read-out that replaces an alternate's "Rejoins at".
 *
 * A terminus arrives inside the trail's `sideTrips` array and is told apart by
 * `type`, so the fixtures here are the shapes MapPane hands down after that
 * split. An older bundled asset simply has none, which is why every builder is
 * also exercised with an empty list.
 */

import {
  buildTerminusEndCollection,
  buildVariantCollection,
  hasDrawableVariant,
  terminusEndWaypoint,
  variantFeatureId,
  type MapVariant,
} from '../map-geojson';
import {
  variantInfo,
  variantJunctionLine,
  variantKindLabel,
} from '../variant-info';

/** The CDT's Chief Mountain Route: branches at km 55.9, ends at the border. */
const TERMINUS: MapVariant = {
  name: 'Terminus: Chief Mountain Route',
  type: 'terminus',
  distance: 42.5,
  elevation: { ascent: 1200, descent: 900 },
  startDistance: 55.87,
  points: [
    { lat: 48.8, lon: -113.65 },
    { lat: 48.9, lon: -113.65 },
    { lat: 48.99, lon: -113.66 },
  ],
  waypoints: [
    { name: 'Chief Mountain Route leaves the CDT', type: 'junction' },
    { name: 'Chief Mountain border crossing', type: 'endpoint' },
  ],
};

describe('terminusEndWaypoint', () => {
  it('prefers the endpoint waypoint', () => {
    expect(terminusEndWaypoint(TERMINUS)?.name).toBe('Chief Mountain border crossing');
  });

  it('falls back to the last waypoint when no endpoint is typed', () => {
    const v: MapVariant = {
      ...TERMINUS,
      waypoints: [{ name: 'First', type: 'junction' }, { name: 'Last', type: 'town' }],
    };
    expect(terminusEndWaypoint(v)?.name).toBe('Last');
  });

  it('returns nothing when the track brought no waypoints', () => {
    expect(terminusEndWaypoint({ ...TERMINUS, waypoints: [] })).toBeUndefined();
    expect(terminusEndWaypoint({ ...TERMINUS, waypoints: undefined })).toBeUndefined();
  });
});

describe('buildVariantCollection for termini', () => {
  it('draws the line with a terminus-prefixed feature id', () => {
    const collection = buildVariantCollection([TERMINUS], 'terminus');
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].id).toBe('terminus-0');
    expect(collection.features[0].properties?.kind).toBe('terminus');
    expect(collection.features[0].geometry.coordinates).toHaveLength(3);
  });

  it('is empty for a trail that has none', () => {
    expect(buildVariantCollection([], 'terminus').features).toEqual([]);
    expect(hasDrawableVariant([])).toBe(false);
    expect(hasDrawableVariant(undefined)).toBe(false);
  });
});

describe('buildTerminusEndCollection', () => {
  it('places a labelled badge at the free end, tapping through to the line', () => {
    const collection = buildTerminusEndCollection([TERMINUS]);
    expect(collection.features).toHaveLength(1);

    const [feature] = collection.features;
    // The LAST point: the ingest pass guarantees points[0] is the junction.
    expect(feature.geometry.coordinates).toEqual([-113.66, 48.99]);
    expect(feature.properties?.name).toBe('Chief Mountain border crossing');
    expect(feature.properties?.icon).toBe('endpoint');
    // Same id as the line, so the marker selects the same variant.
    expect(feature.properties?.id).toBe(variantFeatureId('terminus', 0));
  });

  it('names the badge after the variant when no endpoint waypoint came with it', () => {
    const [feature] = buildTerminusEndCollection([{ ...TERMINUS, waypoints: [] }]).features;
    expect(feature.properties?.name).toBe('Terminus: Chief Mountain Route');
  });

  it('keeps ids aligned with the line collection when a degenerate one is dropped', () => {
    const degenerate: MapVariant = { ...TERMINUS, points: [{ lat: 0, lon: 0 }] };
    const collection = buildTerminusEndCollection([degenerate, TERMINUS]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].properties?.id).toBe('terminus-1');
  });

  it('is empty for a trail that has none', () => {
    expect(buildTerminusEndCollection([]).features).toEqual([]);
  });
});

describe('variant-info for a terminus', () => {
  const info = variantInfo(TERMINUS, 'terminus', 'terminus-0');

  it('labels the class', () => {
    expect(variantKindLabel('terminus')).toBe('Alternative terminus');
  });

  it('says where it ends rather than where it rejoins', () => {
    expect(variantJunctionLine(info, 'km')).toBe(
      'Branches at 55.9 km · Ends at Chief Mountain border crossing (42.5 km)',
    );
  });

  it('never claims a terminus is out-and-back', () => {
    const noEnd = variantInfo({ ...TERMINUS, waypoints: [] }, 'terminus', 'terminus-0');
    const line = variantJunctionLine(noEnd, 'km');
    expect(line).not.toContain('out-and-back');
    expect(line).toContain('Ends at the trail end');
  });

  it('has nothing to say without a junction', () => {
    const loose = variantInfo({ ...TERMINUS, startDistance: undefined }, 'terminus', 'x');
    expect(variantJunctionLine(loose, 'km')).toBeNull();
  });
});
