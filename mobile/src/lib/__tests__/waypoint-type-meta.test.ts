import {
  WAYPOINT_TYPE_META,
  CREATABLE_WAYPOINT_TYPES,
  getWaypointColor,
  getWaypointEmoji,
  getWaypointLabel,
} from '../waypoint-type-meta';

describe('WAYPOINT_TYPE_META registry', () => {
  it('exposes the full creatable set from the P1 plan (decision 3)', () => {
    expect(CREATABLE_WAYPOINT_TYPES).toEqual([
      'water',
      'water-tank',
      'campsite',
      'shelter',
      'town',
      'lookout',
      'junction',
      'hazard',
      'poi',
    ]);
  });

  it('defines label, emoji, and color for every creatable type', () => {
    for (const type of CREATABLE_WAYPOINT_TYPES) {
      const meta = WAYPOINT_TYPE_META[type];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.emoji.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.creatable).toBe(true);
    }
  });

  it('includes hazard end-to-end with an alert-amber color', () => {
    const hazard = WAYPOINT_TYPE_META.hazard;
    expect(hazard).toBeDefined();
    expect(hazard.creatable).toBe(true);
    expect(hazard.emoji).toBe('⚠️');
    // Amber family — must not collide with the water blue or campsite green
    expect(hazard.color).toBe('#FF8F00');
  });

  it('keeps the pre-registry map colors stable for bundled types', () => {
    // These exact values were previously hardcoded in TrailMap.WAYPOINT_COLORS;
    // the registry refactor must not silently recolor the map.
    expect(getWaypointColor('campsite')).toBe('#4CAF50');
    expect(getWaypointColor('water')).toBe('#2196F3');
    expect(getWaypointColor('water-tank')).toBe('#2196F3');
    expect(getWaypointColor('town')).toBe('#FF9800');
    expect(getWaypointColor('shelter')).toBe('#795548');
    expect(getWaypointColor('hut')).toBe('#795548');
    expect(getWaypointColor('trailhead')).toBe('#9C27B0');
    expect(getWaypointColor('poi')).toBe('#FFC107');
    expect(getWaypointColor('road-crossing')).toBe('#757575');
  });

  it('falls back to gray / pin / capitalized label for unknown types', () => {
    expect(getWaypointColor('mystery')).toBe('#757575');
    expect(getWaypointEmoji('mystery')).toBe('📍');
    expect(getWaypointLabel('mystery')).toBe('Mystery');
  });

  it('keeps the emoji set the old waypointEmojis record provided', () => {
    expect(getWaypointEmoji('water')).toBe('💧');
    expect(getWaypointEmoji('water-tank')).toBe('🚰');
    expect(getWaypointEmoji('campsite')).toBe('⛺');
    expect(getWaypointEmoji('town')).toBe('🏘️');
    expect(getWaypointEmoji('hut')).toBe('🛖');
    expect(getWaypointEmoji('lookout')).toBe('👁️');
    expect(getWaypointEmoji('poi')).toBe('📍');
  });
});
