/**
 * The type → glyph mapping, and the promise that every glyph it can return is
 * actually registered with MapLibre. A marker whose `icon` names an image the
 * style never received renders as nothing at all, so the registry check is the
 * important one.
 */

import {
  FALLBACK_WAYPOINT_ICON,
  WAYPOINT_ICON_NAMES,
  poiIconName,
  waypointIconName,
} from '../waypoint-icons';
import { WAYPOINT_ICON_IMAGES } from '../waypoint-icon-images';

/**
 * Every `type` string the bundled trails currently use (aawt, bibbulmun,
 * cape_to_cape, heysen, hume-and-hovell, larapinta, cdt). Hardcoded rather than read
 * off TRAIL_DATA so the test does not pull ~50 MB of trail JSON into Jest.
 */
const BUNDLED_TYPES = [
  'campsite',
  'water',
  'hut',
  'accommodation',
  'town',
  'water-tank',
  'trailhead',
  'poi',
  'beach',
  'road-crossing',
  'caravan-park',
  'food',
  'inlet-crossing',
  'resupply',
  'endpoint',
  'waypoint',
  'junction',
  'milestone',
];

describe('waypointIconName', () => {
  it('gives every type in the bundled data a registered glyph', () => {
    for (const type of BUNDLED_TYPES) {
      const icon = waypointIconName(type);
      expect(WAYPOINT_ICON_NAMES).toContain(icon);
      expect(WAYPOINT_ICON_IMAGES[icon]).toBeDefined();
    }
  });

  it('gives the CDT vocabulary its own ink rather than the generic dot', () => {
    // A distance post, an alternate's branch/rejoin point and a plain
    // unclassified waypoint must be tellable apart on the map.
    expect(waypointIconName('milestone')).toBe('milestone');
    expect(waypointIconName('junction')).toBe('junction');
    expect(waypointIconName('gap')).toBe('gap');
    expect(waypointIconName('ley-note')).toBe('note');
    for (const type of ['milestone', 'junction', 'gap', 'ley-note', 'ley-waypoint', 'camp-2018']) {
      const icon = waypointIconName(type);
      expect(icon).not.toBe(FALLBACK_WAYPOINT_ICON);
      // A glyph name with no registered image renders as nothing at all.
      expect(WAYPOINT_ICON_IMAGES[icon]).toBeDefined();
    }
    // ...and none of them borrow the generic waypoint's glyph.
    expect(waypointIconName('milestone')).not.toBe(waypointIconName('waypoint'));
  });

  it('distinguishes the categories a hiker acts on differently', () => {
    // Water you can drink from vs. a tank you might find empty; a free hut vs.
    // a bed you pay for; a resupply vs. the town it sits in.
    expect(waypointIconName('water')).toBe('water');
    expect(waypointIconName('water-tank')).toBe('water-tank');
    expect(waypointIconName('campsite')).toBe('campsite');
    expect(waypointIconName('hut')).toBe('hut');
    expect(waypointIconName('accommodation')).toBe('bed');
    expect(waypointIconName('town')).toBe('town');
    expect(waypointIconName('resupply')).toBe('resupply');
    expect(waypointIconName('trailhead')).toBe('trailhead');
    expect(waypointIconName('endpoint')).toBe('endpoint');
    expect(waypointIconName('road-crossing')).toBe('road');
    expect(waypointIconName('inlet-crossing')).toBe('ford');
    expect(waypointIconName('lookout')).toBe('summit');
    expect(waypointIconName('hazard')).toBe('hazard');
    expect(waypointIconName('beach')).toBe('beach');
  });

  it('gives the OSM POI vocabulary a glyph too', () => {
    // These types come from the classifier, not the bundled trails, but the POI
    // categories reuse the same two glyphs — keep them reachable from both.
    expect(waypointIconName('cafe')).toBe('restaurant');
    expect(waypointIconName('pub')).toBe('restaurant');
    expect(waypointIconName('bus-stop')).toBe('transport');
    expect(waypointIconName('ferry')).toBe('transport');
  });

  it('groups synonyms onto one glyph', () => {
    expect(waypointIconName('spring')).toBe(waypointIconName('water'));
    expect(waypointIconName('shelter')).toBe(waypointIconName('hut'));
    expect(waypointIconName('caravan-park')).toBe(waypointIconName('accommodation'));
    expect(waypointIconName('food')).toBe(waypointIconName('resupply'));
    expect(waypointIconName('summit')).toBe(waypointIconName('lookout'));
  });

  it('falls back to the generic point-of-interest glyph for unknown types', () => {
    expect(waypointIconName('something-new')).toBe(FALLBACK_WAYPOINT_ICON);
    expect(waypointIconName('')).toBe(FALLBACK_WAYPOINT_ICON);
  });
});

describe('poiIconName', () => {
  it('gives all six OpenStreetMap POI categories a registered glyph', () => {
    const categories = [
      'water',
      'camping',
      'resupply',
      'restaurant',
      'transport',
      'emergency',
    ] as const;
    for (const category of categories) {
      const icon = poiIconName(category);
      expect(WAYPOINT_ICON_NAMES).toContain(icon);
      expect(WAYPOINT_ICON_IMAGES[icon]).toBeDefined();
    }
  });

  it('maps each category to the glyph a hiker expects', () => {
    expect(poiIconName('water')).toBe('water');
    expect(poiIconName('camping')).toBe('campsite');
    expect(poiIconName('resupply')).toBe('resupply');
    expect(poiIconName('restaurant')).toBe('restaurant');
    expect(poiIconName('transport')).toBe('transport');
    expect(poiIconName('emergency')).toBe('emergency');
  });

  it('shares its glyphs with the equivalent waypoint types', () => {
    expect(poiIconName('water')).toBe(waypointIconName('water'));
    expect(poiIconName('camping')).toBe(waypointIconName('campsite'));
    expect(poiIconName('resupply')).toBe(waypointIconName('resupply'));
    expect(poiIconName('restaurant')).toBe(waypointIconName('restaurant'));
  });

  it('falls back for a category this build does not know', () => {
    // A newer trail JSON must still draw *something*: an `icon` naming an
    // unregistered image renders as nothing at all.
    expect(poiIconName('helipad')).toBe(FALLBACK_WAYPOINT_ICON);
    expect(poiIconName('')).toBe(FALLBACK_WAYPOINT_ICON);
  });
});

describe('WAYPOINT_ICON_IMAGES', () => {
  it('registers exactly the shipped glyph names', () => {
    expect(Object.keys(WAYPOINT_ICON_IMAGES).sort()).toEqual([...WAYPOINT_ICON_NAMES].sort());
  });

  it('resolves every glyph to a bundled asset (no missing PNG)', () => {
    for (const name of WAYPOINT_ICON_NAMES) {
      expect(WAYPOINT_ICON_IMAGES[name]).toBeTruthy();
    }
  });
});
