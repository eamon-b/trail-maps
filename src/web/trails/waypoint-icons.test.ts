import { describe, it, expect } from 'vitest';
import { WAYPOINT_ICONS, waypointIcon } from './waypoint-icons';

describe('waypointIcon', () => {
  it('draws a type with its own glyph', () => {
    expect(waypointIcon('hut')).toBe(WAYPOINT_ICONS.hut);
    expect(waypointIcon('gap')).toBe(WAYPOINT_ICONS.gap);
  });

  it('draws a turn-off with the glyph of the place it serves', () => {
    expect(waypointIcon('hut-access')).toBe(WAYPOINT_ICONS.hut);
    expect(waypointIcon('town-access')).toBe(WAYPOINT_ICONS.town);
  });

  it('falls back to the plain pin for an unknown or missing type', () => {
    expect(waypointIcon('something-new')).toBe(WAYPOINT_ICONS.waypoint);
    expect(waypointIcon(undefined)).toBe(WAYPOINT_ICONS.waypoint);
    expect(waypointIcon('')).toBe(WAYPOINT_ICONS.waypoint);
  });
});
