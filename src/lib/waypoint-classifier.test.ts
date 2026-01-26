import { describe, it, expect } from 'vitest';
import {
  classifyWaypoint,
  FOLDER_TYPE_MAP,
  DEFAULT_PREFIX_RULES,
  KNOWN_TOWNS,
} from './waypoint-classifier';

describe('waypoint-classifier', () => {
  describe('FOLDER_TYPE_MAP', () => {
    it('should have mappings for common folder names', () => {
      expect(FOLDER_TYPE_MAP['campsites']).toBe('campsite');
      expect(FOLDER_TYPE_MAP['huts']).toBe('hut');
      expect(FOLDER_TYPE_MAP['huts & shelters']).toBe('hut');
      expect(FOLDER_TYPE_MAP['water']).toBe('water');
      expect(FOLDER_TYPE_MAP['water sources']).toBe('water');
      expect(FOLDER_TYPE_MAP['water tanks']).toBe('water-tank');
      expect(FOLDER_TYPE_MAP['towns']).toBe('town');
      expect(FOLDER_TYPE_MAP['accommodation']).toBe('accommodation');
      expect(FOLDER_TYPE_MAP['trailheads']).toBe('trailhead');
      expect(FOLDER_TYPE_MAP['caravan parks']).toBe('caravan-park');
      expect(FOLDER_TYPE_MAP['other']).toBe('poi');
    });
  });

  describe('DEFAULT_PREFIX_RULES', () => {
    it('should have all prefixes with delimiters', () => {
      for (const rule of DEFAULT_PREFIX_RULES) {
        const hasDelimiter = rule.prefix.endsWith(' ') || rule.prefix.endsWith(':');
        expect(hasDelimiter).toBe(true);
      }
    });

    it('should not have bare single-character prefixes', () => {
      for (const rule of DEFAULT_PREFIX_RULES) {
        // No prefix should be a single letter without delimiter
        expect(rule.prefix.length).toBeGreaterThan(1);
      }
    });
  });

  describe('KNOWN_TOWNS', () => {
    it('should contain expected town names in lowercase', () => {
      expect(KNOWN_TOWNS.has('mt hotham')).toBe(true);
      expect(KNOWN_TOWNS.has('alice springs')).toBe(true);
      expect(KNOWN_TOWNS.has('albany')).toBe(true);
    });
  });

  describe('classifyWaypoint', () => {
    describe('GeoJSON folder-based classification (highest priority)', () => {
      it('should use folder name when provided', () => {
        const result = classifyWaypoint('Redbank', { folderName: 'Campsites' });
        expect(result.type).toBe('campsite');
        expect(result.cleanedName).toBe('Redbank');
        expect(result.source).toBe('folder');
      });

      it('should handle folder name case-insensitively', () => {
        expect(classifyWaypoint('X', { folderName: 'Water Sources' }).type).toBe('water');
        expect(classifyWaypoint('X', { folderName: 'water sources' }).type).toBe('water');
        expect(classifyWaypoint('X', { folderName: 'WATER SOURCES' }).type).toBe('water');
      });

      it('should handle various folder name variations', () => {
        expect(classifyWaypoint('X', { folderName: 'Official campsites' }).type).toBe('campsite');
        expect(classifyWaypoint('X', { folderName: 'Other campsites' }).type).toBe('campsite');
        expect(classifyWaypoint('X', { folderName: 'Huts' }).type).toBe('hut');
        expect(classifyWaypoint('X', { folderName: 'Huts & Shelters' }).type).toBe('hut');
        expect(classifyWaypoint('X', { folderName: 'Water' }).type).toBe('water');
        expect(classifyWaypoint('X', { folderName: 'Water Tanks' }).type).toBe('water-tank');
        expect(classifyWaypoint('X', { folderName: 'Trailheads' }).type).toBe('trailhead');
        expect(classifyWaypoint('X', { folderName: 'Caravan Parks' }).type).toBe('caravan-park');
        expect(classifyWaypoint('X', { folderName: 'Accommodation' }).type).toBe('accommodation');
        expect(classifyWaypoint('X', { folderName: 'Other' }).type).toBe('poi');
      });

      it('should clean prefix from name even when folder determines type', () => {
        const result = classifyWaypoint('C: Millers Flat', { folderName: 'Campsites' });
        expect(result.type).toBe('campsite');
        expect(result.cleanedName).toBe('Millers Flat');
        expect(result.source).toBe('folder');
      });

      it('should fall back to prefix if folder unknown', () => {
        const result = classifyWaypoint('C: Millers Flat', { folderName: 'Unknown Folder' });
        expect(result.type).toBe('campsite');
        expect(result.cleanedName).toBe('Millers Flat');
        expect(result.source).toBe('prefix');
      });

      it('should fall back if no folder provided', () => {
        const result = classifyWaypoint('C: Millers Flat');
        expect(result.type).toBe('campsite');
        expect(result.source).toBe('prefix');
      });
    });

    describe('Known towns classification (priority 2)', () => {
      it('should recognize known town names', () => {
        const result = classifyWaypoint('Mt Hotham');
        expect(result.type).toBe('town');
        expect(result.cleanedName).toBe('Mt Hotham');
        expect(result.source).toBe('known-town');
      });

      it('should be case-insensitive for town names', () => {
        expect(classifyWaypoint('ALICE SPRINGS').type).toBe('town');
        expect(classifyWaypoint('alice springs').type).toBe('town');
        expect(classifyWaypoint('Alice Springs').type).toBe('town');
      });

      it('should not modify known town names', () => {
        expect(classifyWaypoint('Jindabyne').cleanedName).toBe('Jindabyne');
        expect(classifyWaypoint('Falls Creek').cleanedName).toBe('Falls Creek');
      });

      it('should prefer folder over known town when folder provided', () => {
        const result = classifyWaypoint('Mt Hotham', { folderName: 'Resupply' });
        expect(result.type).toBe('resupply');
        expect(result.source).toBe('folder');
      });
    });

    describe('Prefix matching with required delimiters (priority 3)', () => {
      it('should match "C: Redbank" as campsite', () => {
        const result = classifyWaypoint('C: Redbank');
        expect(result.type).toBe('campsite');
        expect(result.cleanedName).toBe('Redbank');
        expect(result.matchedPrefix).toBe('C:');
      });

      it('should match "C Redbank" as campsite', () => {
        const result = classifyWaypoint('C Redbank');
        expect(result.type).toBe('campsite');
        expect(result.cleanedName).toBe('Redbank');
        expect(result.matchedPrefix).toBe('C ');
      });

      it('should match "R Highway 31" as road-crossing', () => {
        const result = classifyWaypoint('R Highway 31');
        expect(result.type).toBe('road-crossing');
        expect(result.cleanedName).toBe('Highway 31');
      });

      it('should match "WT: Tank Name" as water-tank', () => {
        const result = classifyWaypoint('WT: Ellery Creek North');
        expect(result.type).toBe('water-tank');
        expect(result.cleanedName).toBe('Ellery Creek North');
      });

      it('should match "TH: Trailhead Name" as trailhead', () => {
        const result = classifyWaypoint('TH: Stanley Chasm');
        expect(result.type).toBe('trailhead');
        expect(result.cleanedName).toBe('Stanley Chasm');
      });

      it('should match "W: Water Source" as water', () => {
        const result = classifyWaypoint('W: Spring Creek');
        expect(result.type).toBe('water');
        expect(result.cleanedName).toBe('Spring Creek');
      });

      it('should match "H: Hut Name" as hut', () => {
        const result = classifyWaypoint('H: Federation Hut');
        expect(result.type).toBe('hut');
        expect(result.cleanedName).toBe('Federation Hut');
      });

      it('should NOT match bare first letter without delimiter', () => {
        // These must NOT strip the first letter
        expect(classifyWaypoint('Redbank').cleanedName).toBe('Redbank');
        expect(classifyWaypoint('Telegraph').cleanedName).toBe('Telegraph');
        expect(classifyWaypoint('Finke').cleanedName).toBe('Finke');
        expect(classifyWaypoint('Campsite').cleanedName).toBe('Campsite');
        expect(classifyWaypoint('Water').cleanedName).toBe('Water');
      });
    });

    describe('Regression tests - names that should NOT be modified', () => {
      const preservedNames = [
        'Redbank Gorge Trailhead',
        'Telegraph Station Trailhead',
        'Finke River',
        'Mount Sonder',
        'Heavitree Gap',
        'Ellery Creek',
        'Frere Peak',
        'Campsite Area',
        'Water Source',
        'Hut Location',
        'Trailhead Access',
        'Food Store',
        'Road Crossing Point',
      ];

      for (const name of preservedNames) {
        it(`should preserve "${name}" unchanged`, () => {
          const result = classifyWaypoint(name);
          expect(result.cleanedName).toBe(name);
        });
      }
    });

    describe('Edge cases', () => {
      it('should handle empty string input', () => {
        const result = classifyWaypoint('');
        expect(result.type).toBe('waypoint');
        expect(result.cleanedName).toBe('');
        expect(result.source).toBe('default');
      });

      it('should handle whitespace-only input', () => {
        const result = classifyWaypoint('   ');
        expect(result.type).toBe('waypoint');
        expect(result.cleanedName).toBe('');
        expect(result.source).toBe('default');
      });

      it('should handle prefix-only input (no name after prefix)', () => {
        const result = classifyWaypoint('C:');
        expect(result.type).toBe('waypoint');
        expect(result.cleanedName).toBe('C:');
        expect(result.source).toBe('default');
      });

      it('should trim whitespace from names', () => {
        const result = classifyWaypoint('  C: Padded Name  ');
        expect(result.cleanedName).toBe('Padded Name');
      });

      it('should handle extra whitespace after prefix', () => {
        const result = classifyWaypoint('C:   Extra Spaces');
        expect(result.cleanedName).toBe('Extra Spaces');
      });

      it('should handle case sensitivity for folder lookup', () => {
        const result = classifyWaypoint('Test', { folderName: 'CAMPSITES' });
        expect(result.type).toBe('campsite');
      });
    });

    describe('Default classification', () => {
      it('should return "waypoint" for unrecognized names', () => {
        const result = classifyWaypoint('Some Random Location');
        expect(result.type).toBe('waypoint');
        expect(result.cleanedName).toBe('Some Random Location');
        expect(result.source).toBe('default');
        expect(result.matchedPrefix).toBe(null);
      });
    });

    describe('Real waypoint data from trails', () => {
      // Larapinta examples
      const larapintaTests: Array<{
        name: string;
        folder: string | undefined;
        expectedType: string;
        expectedCleanName: string;
      }> = [
        { name: 'Redbank Gorge Trailhead', folder: 'Trailheads', expectedType: 'trailhead', expectedCleanName: 'Redbank Gorge Trailhead' },
        { name: 'C: Redbank', folder: 'Campsites', expectedType: 'campsite', expectedCleanName: 'Redbank' },
        { name: 'WT: Ellery Creek North', folder: 'Water Tanks', expectedType: 'water-tank', expectedCleanName: 'Ellery Creek North' },
        { name: 'Telegraph Station', folder: undefined, expectedType: 'waypoint', expectedCleanName: 'Telegraph Station' },
        { name: 'Alice Springs', folder: undefined, expectedType: 'town', expectedCleanName: 'Alice Springs' },
      ];

      // AAWT examples
      const aawtTests: Array<{
        name: string;
        folder: string | undefined;
        expectedType: string;
        expectedCleanName: string;
      }> = [
        { name: 'Federation Hut', folder: 'Huts', expectedType: 'hut', expectedCleanName: 'Federation Hut' },
        { name: 'Diamantina River', folder: 'Water Sources', expectedType: 'water', expectedCleanName: 'Diamantina River' },
        { name: 'Mt Hotham', folder: 'Towns', expectedType: 'town', expectedCleanName: 'Mt Hotham' },
        { name: 'Mt Hotham', folder: undefined, expectedType: 'town', expectedCleanName: 'Mt Hotham' },
      ];

      // Heysen examples
      const heysenTests: Array<{
        name: string;
        folder: string | undefined;
        expectedType: string;
        expectedCleanName: string;
      }> = [
        { name: 'North Laura Hotel', folder: 'Accommodation', expectedType: 'accommodation', expectedCleanName: 'North Laura Hotel' },
        { name: 'Mylor Oval tank', folder: 'Water', expectedType: 'water', expectedCleanName: 'Mylor Oval tank' },
        { name: 'Rocky Creek Hut', folder: 'Huts & Shelters', expectedType: 'hut', expectedCleanName: 'Rocky Creek Hut' },
        { name: 'Hawker', folder: 'Towns', expectedType: 'town', expectedCleanName: 'Hawker' },
        { name: 'Rest area', folder: 'Other', expectedType: 'poi', expectedCleanName: 'Rest area' },
      ];

      for (const t of [...larapintaTests, ...aawtTests, ...heysenTests]) {
        it(`"${t.name}" with folder "${t.folder}" -> type: ${t.expectedType}, name: "${t.expectedCleanName}"`, () => {
          const result = classifyWaypoint(t.name, { folderName: t.folder });
          expect(result.type).toBe(t.expectedType);
          expect(result.cleanedName).toBe(t.expectedCleanName);
        });
      }
    });

    describe('Classification source tracking', () => {
      it('should track folder as source', () => {
        expect(classifyWaypoint('Test', { folderName: 'Campsites' }).source).toBe('folder');
      });

      it('should track known-town as source', () => {
        expect(classifyWaypoint('Jindabyne').source).toBe('known-town');
      });

      it('should track prefix as source', () => {
        expect(classifyWaypoint('C: Test').source).toBe('prefix');
      });

      it('should track default as source', () => {
        expect(classifyWaypoint('Unknown Place').source).toBe('default');
      });
    });
  });
});
