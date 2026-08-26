import { describe, it, expect } from 'vitest';
import {
  WAYPOINT_TYPES,
  WAYPOINT_TYPE_LABELS,
  waypointTypeLabel,
  isKnownWaypointType,
  WATER_TYPES,
  WATER_TYPE_ALIASES,
  RESUPPLY_TYPES,
  RESUPPLY_TYPE_ALIASES,
  isWaterWaypoint,
  isResupplyWaypoint,
  WAYPOINT_FAMILIES,
  matchesWaypointFamily,
} from './waypoint-taxonomy';

describe('waypoint-taxonomy', () => {
  describe('WAYPOINT_TYPES / WAYPOINT_TYPE_LABELS', () => {
    it('labels every canonical type', () => {
      for (const type of WAYPOINT_TYPES) {
        expect(WAYPOINT_TYPE_LABELS[type], `missing label for ${type}`).toBeTruthy();
      }
    });

    it('has no duplicate types', () => {
      expect(new Set(WAYPOINT_TYPES).size).toBe(WAYPOINT_TYPES.length);
    });

    it('includes every type the generated trail JSON uses', () => {
      // These are the types actually present in public/data/generated/*.json.
      // Adding a type to the classifier without adding it here means it has no
      // display label anywhere in the app.
      const typesInGeneratedOutput = [
        'accommodation',
        'beach',
        'campsite',
        'caravan-park',
        'endpoint',
        'food',
        'hut',
        'inlet-crossing',
        'poi',
        'resupply',
        'road-crossing',
        'town',
        'trailhead',
        'water',
        'water-tank',
        'waypoint',
      ];
      for (const type of typesInGeneratedOutput) {
        expect(isKnownWaypointType(type), `${type} is not in WAYPOINT_TYPES`).toBe(true);
      }
    });
  });

  describe('isKnownWaypointType', () => {
    it('accepts canonical types', () => {
      expect(isKnownWaypointType('campsite')).toBe(true);
      expect(isKnownWaypointType('water-tank')).toBe(true);
    });

    it('rejects unknown, empty and nullish types', () => {
      expect(isKnownWaypointType('fire-trail')).toBe(false);
      expect(isKnownWaypointType('')).toBe(false);
      expect(isKnownWaypointType(undefined)).toBe(false);
      expect(isKnownWaypointType(null)).toBe(false);
    });

    it('is exact — no case folding, unlike the family predicates', () => {
      expect(isKnownWaypointType('Campsite')).toBe(false);
    });
  });

  describe('waypointTypeLabel', () => {
    it('uses the curated label for a canonical type', () => {
      expect(waypointTypeLabel('water-tank')).toBe('Water tank');
      expect(waypointTypeLabel('hut')).toBe('Hut / shelter');
      expect(waypointTypeLabel('endpoint')).toBe('Start / end');
      expect(waypointTypeLabel('waypoint')).toBe('Unclassified');
    });

    it('prettifies an unknown slug from someone else’s GPX', () => {
      expect(waypointTypeLabel('fire-trail')).toBe('Fire trail');
      expect(waypointTypeLabel('gate_closed')).toBe('Gate closed');
      expect(waypointTypeLabel('bore')).toBe('Bore');
      expect(waypointTypeLabel('summit-cairn-marker')).toBe('Summit cairn marker');
    });

    it('falls back to the unclassified label for empty input', () => {
      expect(waypointTypeLabel(undefined)).toBe('Unclassified');
      expect(waypointTypeLabel(null)).toBe('Unclassified');
      expect(waypointTypeLabel('')).toBe('Unclassified');
      expect(waypointTypeLabel('---')).toBe('Unclassified');
      expect(waypointTypeLabel('   ')).toBe('Unclassified');
    });
  });

  describe('isWaterWaypoint', () => {
    it('accepts every canonical water type', () => {
      for (const type of WATER_TYPES) {
        expect(isWaterWaypoint(type), type).toBe(true);
      }
    });

    it('accepts the imported-GPX aliases', () => {
      for (const alias of WATER_TYPE_ALIASES) {
        expect(isWaterWaypoint(alias), alias).toBe(true);
      }
      // Spot-checks of the ones that matter for planning.
      expect(isWaterWaypoint('spring')).toBe(true);
      expect(isWaterWaypoint('creek')).toBe(true);
      expect(isWaterWaypoint('soak')).toBe(true);
    });

    it('normalises case and surrounding whitespace', () => {
      expect(isWaterWaypoint('Water-Tank')).toBe(true);
      expect(isWaterWaypoint('  WATER  ')).toBe(true);
    });

    it('rejects non-water types and empty input', () => {
      expect(isWaterWaypoint('campsite')).toBe(false);
      expect(isWaterWaypoint('town')).toBe(false);
      expect(isWaterWaypoint('waypoint')).toBe(false);
      expect(isWaterWaypoint('')).toBe(false);
      expect(isWaterWaypoint('   ')).toBe(false);
      expect(isWaterWaypoint(undefined)).toBe(false);
      expect(isWaterWaypoint(null)).toBe(false);
    });
  });

  describe('isResupplyWaypoint', () => {
    it('accepts every canonical resupply type', () => {
      for (const type of RESUPPLY_TYPES) {
        expect(isResupplyWaypoint(type), type).toBe(true);
      }
    });

    it('accepts the imported-GPX aliases', () => {
      for (const alias of RESUPPLY_TYPE_ALIASES) {
        expect(isResupplyWaypoint(alias), alias).toBe(true);
      }
      expect(isResupplyWaypoint('supermarket')).toBe(true);
      expect(isResupplyWaypoint('roadhouse')).toBe(true);
    });

    it('excludes shelter-only types — they do not reliably mean food', () => {
      // Load-bearing: including these would silently shorten planned food
      // carries. See the comment on RESUPPLY_TYPES.
      expect(isResupplyWaypoint('accommodation')).toBe(false);
      expect(isResupplyWaypoint('caravan-park')).toBe(false);
      expect(isResupplyWaypoint('hut')).toBe(false);
      expect(isResupplyWaypoint('campsite')).toBe(false);
    });

    it('rejects empty input', () => {
      expect(isResupplyWaypoint('')).toBe(false);
      expect(isResupplyWaypoint(undefined)).toBe(false);
      expect(isResupplyWaypoint(null)).toBe(false);
    });
  });

  describe('families are disjoint', () => {
    it('no type is both water and resupply', () => {
      const all = [
        ...WATER_TYPES,
        ...WATER_TYPE_ALIASES,
        ...RESUPPLY_TYPES,
        ...RESUPPLY_TYPE_ALIASES,
      ];
      for (const type of all) {
        expect(
          isWaterWaypoint(type) && isResupplyWaypoint(type),
          `${type} is in both families`
        ).toBe(false);
      }
    });
  });

  describe('matchesWaypointFamily', () => {
    it('delegates to the family predicate', () => {
      expect(matchesWaypointFamily('water-tank', 'water')).toBe(true);
      expect(matchesWaypointFamily('water-tank', 'resupply')).toBe(false);
      expect(matchesWaypointFamily('town', 'resupply')).toBe(true);
      expect(matchesWaypointFamily('town', 'water')).toBe(false);
    });

    it('handles aliases and nullish types', () => {
      expect(matchesWaypointFamily('spring', 'water')).toBe(true);
      expect(matchesWaypointFamily('supermarket', 'resupply')).toBe(true);
      expect(matchesWaypointFamily(undefined, 'water')).toBe(false);
      expect(matchesWaypointFamily(null, 'resupply')).toBe(false);
    });

    it('covers every declared family', () => {
      expect(WAYPOINT_FAMILIES).toEqual(['water', 'resupply']);
      for (const family of WAYPOINT_FAMILIES) {
        // Every family must reject an obviously unrelated type rather than
        // matching everything by accident.
        expect(matchesWaypointFamily('road-crossing', family), family).toBe(false);
      }
    });
  });
});
