import {
  buildTrailLine,
  buildVariantCollection,
  buildWaypointCollection,
  trailCameraBounds,
  waypointFeatureId,
  type MapVariant,
  type MapWaypoint,
} from '../map-geojson';

describe('buildTrailLine', () => {
  it('builds a LineString in [lon, lat] order', () => {
    const line = buildTrailLine([
      { lat: -35, lon: 138 },
      { lat: -34, lon: 139 },
    ]);
    expect(line).not.toBeNull();
    expect(line!.geometry.type).toBe('LineString');
    expect(line!.geometry.coordinates).toEqual([
      [138, -35],
      [139, -34],
    ]);
  });

  it('returns null when there is no line to draw', () => {
    expect(buildTrailLine([])).toBeNull();
    expect(buildTrailLine([{ lat: 0, lon: 0 }])).toBeNull();
  });
});

describe('buildVariantCollection', () => {
  const variants: MapVariant[] = [
    { name: 'Alt A', type: 'alternate', points: [{ lat: -35, lon: 138 }, { lat: -35.1, lon: 138.1 }] },
    { name: 'Degenerate', type: 'alternate', points: [{ lat: 0, lon: 0 }] },
    { name: 'No points', type: 'alternate' },
  ];

  it('drops variants that cannot form a line', () => {
    const fc = buildVariantCollection(variants);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({ name: 'Alt A', type: 'alternate' });
  });

  it('returns an empty collection for no variants', () => {
    expect(buildVariantCollection([]).features).toEqual([]);
  });
});

describe('waypointFeatureId', () => {
  it('prefers the stable bundled id', () => {
    expect(waypointFeatureId({ id: 'w_abc', name: 'Camp', lat: 0, lon: 0, type: 'camp' }, 3)).toBe('w_abc');
  });

  it('falls back to name+index when no id is present', () => {
    expect(waypointFeatureId({ name: 'Camp', lat: 0, lon: 0, type: 'camp' }, 3)).toBe('Camp-3');
  });
});

describe('buildWaypointCollection', () => {
  const waypoints: MapWaypoint[] = [
    { id: 'w_water', name: 'Spring', lat: -35, lon: 138, type: 'water' },
    { id: 'w_camp', name: 'Camp', lat: -35.1, lon: 138.1, type: 'campsite' },
    { name: 'Legacy', lat: -35.2, lon: 138.2, type: 'town' },
  ];

  // Fake theme resolver: one distinct color per category so mapping is checkable.
  const colorForType = (type: string) =>
    ({ water: 'WATER', campsite: 'CAMP', town: 'TOWN' })[type] ?? 'OTHER';

  it('colors each feature from the resolver (per-category color)', () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features.map((f) => f.properties!.color)).toEqual(['WATER', 'CAMP', 'TOWN']);
  });

  it('uses the stable waypoint id as the GeoJSON feature id', () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features[0].id).toBe('w_water');
    expect(fc.features[0].properties!.id).toBe('w_water');
    // Legacy waypoint with no id falls back to name+index, kept in sync.
    expect(fc.features[2].id).toBe('Legacy-2');
    expect(fc.features[2].properties!.id).toBe('Legacy-2');
  });

  it('places markers in [lon, lat] order and carries the name', () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features[0].geometry.coordinates).toEqual([138, -35]);
    expect(fc.features[0].properties!.name).toBe('Spring');
  });

  it('returns an empty collection for no waypoints', () => {
    expect(buildWaypointCollection([], colorForType).features).toEqual([]);
  });
});

describe('trailCameraBounds', () => {
  it('wires calculateTrailBounds into MapLibre [lon, lat] corners', () => {
    const bounds = trailCameraBounds([
      { lat: -35, lon: 138 },
      { lat: -34, lon: 139 },
    ]);
    expect(bounds).not.toBeNull();
    // ne is the max corner, sw the min, each as [lon, lat].
    expect(bounds!.ne).toEqual([139, -34]);
    expect(bounds!.sw).toEqual([138, -35]);
  });

  it('returns null when there is no geometry to fit', () => {
    expect(trailCameraBounds([])).toBeNull();
  });
});
