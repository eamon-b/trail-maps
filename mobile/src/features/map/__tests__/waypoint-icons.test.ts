/**
 * The type → glyph mapping, and the promise that every glyph it can return is
 * actually registered with MapLibre. A marker whose `icon` names an image the
 * style never received renders as nothing at all, so the registry check is the
 * important one.
 */

import {
  FALLBACK_WAYPOINT_ICON,
  WAYPOINT_ICON_NAMES,
  waypointIconName,
} from '../waypoint-icons';
import { WAYPOINT_ICON_IMAGES } from '../waypoint-icon-images';

/**
 * Every `type` string the six bundled trails currently use (aawt, bibbulmun,
 * cape_to_cape, heysen, hume-and-hovell, larapinta). Hardcoded rather than read
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
];

describe('waypointIconName', () => {
  it('gives every type in the bundled data a registered glyph', () => {
    for (const type of BUNDLED_TYPES) {
      const icon = waypointIconName(type);
      expect(WAYPOINT_ICON_NAMES).toContain(icon);
      expect(WAYPOINT_ICON_IMAGES[icon]).toBeDefined();
    }
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
