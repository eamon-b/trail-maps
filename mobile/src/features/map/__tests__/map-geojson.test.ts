import {
  buildTrailLine,
  buildVariantCollection,
  buildWaypointCollection,
  hasDrawableVariant,
  trailCameraBounds,
  variantFeatureId,
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
    const fc = buildVariantCollection(variants, 'alternate');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({
      id: 'alternate-0',
      kind: 'alternate',
      name: 'Alt A',
      type: 'alternate',
    });
  });

  it('returns an empty collection for no variants', () => {
    expect(buildVariantCollection([], 'alternate').features).toEqual([]);
  });

  it('preserves the classifier’s track type on every feature', () => {
    // `type` comes straight from track-classification via the bundled trail
    // JSON ('alternate' | 'side-trip'); the map draws each class in its own
    // source, and the property keeps the class identifiable on tap/inspection.
    const fc = buildVariantCollection(
      [
        { name: 'Razorback', type: 'alternate', points: [{ lat: -36.8, lon: 147.2 }, { lat: -36.9, lon: 147.3 }] },
        { name: 'Mt Skene spur', type: 'side-trip', points: [{ lat: -37.4, lon: 146.3 }, { lat: -37.5, lon: 146.4 }] },
      ],
      'alternate',
    );
    expect(fc.features.map((f) => f.properties!.type)).toEqual(['alternate', 'side-trip']);
    expect(fc.features.map((f) => f.properties!.name)).toEqual(['Razorback', 'Mt Skene spur']);
  });

  it('ids features by their index in the source list, not the drawn list', () => {
    // The id is how a tap finds its variant object again, so a dropped
    // degenerate variant must not renumber the ones behind it.
    const fc = buildVariantCollection(
      [
        { name: 'Degenerate', points: [{ lat: 0, lon: 0 }] },
        { name: 'Second', points: [{ lat: -35, lon: 138 }, { lat: -35.1, lon: 138.1 }] },
      ],
      'side-trip',
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].id).toBe('side-trip-1');
    expect(fc.features[0].properties!.id).toBe('side-trip-1');
    expect(fc.features[0].properties!.kind).toBe('side-trip');
  });

  it('namespaces ids by class so the two collections never collide', () => {
    expect(variantFeatureId('alternate', 0)).toBe('alternate-0');
    expect(variantFeatureId('side-trip', 0)).toBe('side-trip-0');
  });
});

describe('hasDrawableVariant', () => {
  const mixed: MapVariant[] = [
    { name: 'No points', type: 'side-trip' },
    { name: 'Drawable', type: 'side-trip', points: [{ lat: -35, lon: 138 }, { lat: -35.1, lon: 138.1 }] },
  ];

  it('is true only when some variant has enough points to draw', () => {
    expect(hasDrawableVariant(mixed)).toBe(true);
    expect(hasDrawableVariant([{ name: 'Degenerate', points: [{ lat: 0, lon: 0 }] }])).toBe(false);
    expect(hasDrawableVariant([])).toBe(false);
    expect(hasDrawableVariant(undefined)).toBe(false);
  });

  it('agrees with buildVariantCollection (the legend never lies)', () => {
    const cases: MapVariant[][] = [mixed, [], [{ name: 'No points' }]];
    for (const list of cases) {
      expect(hasDrawableVariant(list)).toBe(
        buildVariantCollection(list, 'side-trip').features.length > 0,
      );
    }
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

  it('carries the per-type glyph name so one SymbolLayer draws every marker', () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features.map((f) => f.properties!.icon)).toEqual(['water', 'campsite', 'town']);
  });

  it('defaults every feature to favorite:false when no set is given', () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features.map((f) => f.properties!.favorite)).toEqual([false, false, false]);
  });

  it('flags features whose id is in the favorite set', () => {
    const favoriteIds = new Set(['w_camp', 'Legacy-2']);
    const fc = buildWaypointCollection(waypoints, colorForType, favoriteIds);
    // Keyed by the same stable feature id (bundled id, or name+index fallback).
    expect(fc.features.map((f) => f.properties!.favorite)).toEqual([false, true, true]);
  });

  it("defaults waterStatus to '' when no lookup is given", () => {
    const fc = buildWaypointCollection(waypoints, colorForType);
    expect(fc.features.map((f) => f.properties!.waterStatus)).toEqual(['', '', '']);
  });

  it('carries the aggregated water status, keyed by the bundled waypoint id', () => {
    const waterStatusById = new Map([
      ['w_water', { status: 'dry' }],
      // A camp with a (nonsense) entry still gets it — the pane decides which
      // waypoints are water; the builder only copies the lookup through.
      ['w_camp', { status: 'flowing' }],
    ]);
    const fc = buildWaypointCollection(waypoints, colorForType, undefined, waterStatusById);
    expect(fc.features.map((f) => f.properties!.waterStatus)).toEqual(['dry', 'flowing', '']);
  });

  it("leaves an id-less waypoint's waterStatus empty (reports need a bundled id)", () => {
    // The legacy waypoint's feature id is "Legacy-2", but reports are filed
    // against bundled ids only, so that fallback must never match a report.
    const waterStatusById = new Map([['Legacy-2', { status: 'dry' }]]);
    const fc = buildWaypointCollection(waypoints, colorForType, undefined, waterStatusById);
    expect(fc.features[2].properties!.waterStatus).toBe('');
  });
});

describe('trailCameraBounds', () => {
  it('wires calculateTrailBounds into MapLibre [west, south, east, north]', () => {
    const bounds = trailCameraBounds([
      { lat: -35, lon: 138 },
      { lat: -34, lon: 139 },
    ]);
    expect(bounds).not.toBeNull();
    // MapLibre RN 11 takes bounds as one flat GeoJSON-RFC tuple; feeding it the
    // v10 {ne, sw} corner object silently fits the camera to nothing.
    expect(bounds).toEqual([138, -35, 139, -34]);
  });

  it('returns null when there is no geometry to fit', () => {
    expect(trailCameraBounds([])).toBeNull();
  });
});
