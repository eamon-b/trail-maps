/**
 * The read-out behind VariantInfoCard. Fixtures are the real shapes from the
 * bundled trail JSON, including the awkward ones: a side trip with no rejoin
 * (Larapinta's Mt Sonder) and an alternate that never comes back (Bibbulmun's
 * hitch into Denmark).
 */

import type { MapVariant } from '../map-geojson';
import {
  variantElevationLine,
  variantInfo,
  variantJunctionLine,
  variantKindLabel,
  variantLengthLine,
  variantWaypointLine,
} from '../variant-info';

/** Larapinta: "Alternative High Route - Miller's Flat" — branches and rejoins. */
const ALTERNATE: MapVariant = {
  name: 'Alternative High Route - Miller’s Flat',
  type: 'alternate',
  distance: 5,
  elevation: { ascent: 536, descent: 511 },
  startDistance: 54.81,
  endDistance: 58.78,
  waypoints: [{}],
};

/** Larapinta: "Mt Sonder Summit (return)" — a spur with no rejoin. */
const SIDE_TRIP: MapVariant = {
  name: 'Mt Sonder Summit (return)',
  type: 'side-trip',
  distance: 14.7,
  elevation: { ascent: 973, descent: 962 },
  startDistance: 215.83,
  waypoints: [{}, {}, {}],
};

/** Bibbulmun: an alternate that leaves the trail and does not return. */
const ONE_WAY_ALTERNATE: MapVariant = {
  name: 'Alt: hitch into Denmark',
  type: 'alternate',
  distance: 8.1,
  elevation: { ascent: 59, descent: 67 },
  startDistance: 909.53,
};

describe('variantKindLabel', () => {
  it('names the two classes the way the legend does', () => {
    expect(variantKindLabel('alternate')).toBe('Alternate');
    expect(variantKindLabel('side-trip')).toBe('Side trip');
  });
});

describe('variantInfo', () => {
  it('lifts the bundled fields onto the display model', () => {
    expect(variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0')).toEqual({
      id: 'side-trip-0',
      kind: 'side-trip',
      name: 'Mt Sonder Summit (return)',
      distanceKm: 14.7,
      ascentM: 973,
      descentM: 962,
      startKm: 215.83,
      endKm: undefined,
      waypointCount: 3,
    });
  });

  it('falls back to the class name when a variant is unnamed', () => {
    expect(variantInfo({}, 'alternate', 'alternate-0').name).toBe('Alternate');
    expect(variantInfo({ name: '   ' }, 'side-trip', 'side-trip-0').name).toBe('Side trip');
  });

  it('drops non-finite numbers rather than showing NaN', () => {
    const info = variantInfo(
      { distance: Number.NaN, startDistance: undefined, elevation: {} },
      'alternate',
      'alternate-1',
    );
    expect(info.distanceKm).toBeUndefined();
    expect(info.startKm).toBeUndefined();
    expect(info.ascentM).toBeUndefined();
    expect(info.waypointCount).toBe(0);
  });
});

describe('variantLengthLine', () => {
  it('is unit-aware', () => {
    const info = variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0');
    expect(variantLengthLine(info, 'km')).toBe('14.7 km');
    expect(variantLengthLine(info, 'mi')).toBe('9.1 mi');
  });

  it('is null when the data has no length', () => {
    expect(variantLengthLine(variantInfo({}, 'alternate', 'a-0'), 'km')).toBeNull();
  });
});

describe('variantElevationLine', () => {
  it('shows gain and loss, in the unit that pairs with the distance unit', () => {
    const info = variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0');
    expect(variantElevationLine(info, 'km')).toBe('+973 m · −962 m');
    expect(variantElevationLine(info, 'mi')).toBe('+3,192 ft · −3,156 ft');
  });

  it('is null when neither figure is known', () => {
    expect(variantElevationLine(variantInfo({}, 'alternate', 'a-0'), 'km')).toBeNull();
  });
});

describe('variantJunctionLine', () => {
  it('gives an alternate both its branch and its rejoin point', () => {
    const info = variantInfo(ALTERNATE, 'alternate', 'alternate-0');
    expect(variantJunctionLine(info, 'km')).toBe('Branches at 54.8 km · Rejoins at 58.8 km');
  });

  it('calls a side trip out-and-back (it has no rejoin)', () => {
    const info = variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0');
    expect(variantJunctionLine(info, 'km')).toBe('Branches at 215.8 km · out-and-back');
  });

  it('treats start == end as out-and-back for either class', () => {
    const info = variantInfo(
      { startDistance: 40, endDistance: 40 },
      'alternate',
      'alternate-0',
    );
    expect(variantJunctionLine(info, 'km')).toBe('Branches at 40.0 km · out-and-back');
  });

  it('says only where an alternate leaves the trail when it never rejoins', () => {
    const info = variantInfo(ONE_WAY_ALTERNATE, 'alternate', 'alternate-0');
    expect(variantJunctionLine(info, 'km')).toBe('Branches at 909.5 km');
  });

  it('converts the junction distances too', () => {
    const info = variantInfo(ALTERNATE, 'alternate', 'alternate-0');
    expect(variantJunctionLine(info, 'mi')).toBe('Branches at 34.1 mi · Rejoins at 36.5 mi');
  });

  it('is null when the pipeline recorded no junction', () => {
    expect(variantJunctionLine(variantInfo({}, 'alternate', 'a-0'), 'km')).toBeNull();
  });
});

describe('variantWaypointLine', () => {
  it('counts the variant’s own waypoints, pluralised', () => {
    expect(variantWaypointLine(variantInfo(SIDE_TRIP, 'side-trip', 's-0'))).toBe('3 waypoints');
    expect(variantWaypointLine(variantInfo(ALTERNATE, 'alternate', 'a-0'))).toBe('1 waypoint');
  });

  it('is null when the variant carries none', () => {
    expect(variantWaypointLine(variantInfo(ONE_WAY_ALTERNATE, 'alternate', 'a-0'))).toBeNull();
  });
});
