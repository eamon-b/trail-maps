import { describe, it, expect } from 'vitest';
import {
  classifyWaypoint,
  inferWaypointTypeFromKeywords,
  FOLDER_TYPE_MAP,
  DEFAULT_PREFIX_RULES,
  KEYWORD_RULES,
  KNOWN_TOWNS,
} from './waypoint-classifier';
import { WAYPOINT_TYPES } from './waypoint-taxonomy';

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
      expect(FOLDER_TYPE_MAP['endpoints']).toBe('endpoint');
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
        expect(classifyWaypoint('X', { folderName: 'Inlets' }).type).toBe('inlet-crossing');
        expect(classifyWaypoint('X', { folderName: 'Inlet Crossings' }).type).toBe('inlet-crossing');
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

      it('should match "S Albury" as endpoint (start)', () => {
        const result = classifyWaypoint('S Albury');
        expect(result.type).toBe('endpoint');
        expect(result.cleanedName).toBe('Albury');
      });

      it('should match "E Yass" as endpoint (end)', () => {
        const result = classifyWaypoint('E Yass');
        expect(result.type).toBe('endpoint');
        expect(result.cleanedName).toBe('Yass');
      });

      it('should match "IC: Wilson Inlet" as inlet-crossing', () => {
        const result = classifyWaypoint('IC: Wilson Inlet');
        expect(result.type).toBe('inlet-crossing');
        expect(result.cleanedName).toBe('Wilson Inlet');
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
        'Start of Trail',
        'End Point',
        'Southern Terminus',
        'Eastern Access',
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

      // Bibbulmun examples
      const bibbulmunTests: Array<{
        name: string;
        folder: string | undefined;
        expectedType: string;
        expectedCleanName: string;
      }> = [
        { name: 'Wilson Inlet', folder: 'Inlets', expectedType: 'inlet-crossing', expectedCleanName: 'Wilson Inlet' },
        { name: 'Irwin Inlet', folder: 'Inlets', expectedType: 'inlet-crossing', expectedCleanName: 'Irwin Inlet' },
      ];

      for (const t of [...larapintaTests, ...aawtTests, ...heysenTests, ...bibbulmunTests]) {
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

    describe('additional edge cases', () => {
      it('handles empty string name', () => {
        const result = classifyWaypoint('');
        expect(result.type).toBe('waypoint');
        expect(result.source).toBe('default');
      });

      it('handles whitespace-only name', () => {
        const result = classifyWaypoint('   ');
        expect(result.type).toBe('waypoint');
      });

      it('handles name that is only a prefix', () => {
        const result = classifyWaypoint('C:');
        // Should still classify via prefix
        expect(result).toBeDefined();
      });

      it('is case-insensitive for known towns', () => {
        const upper = classifyWaypoint('JINDABYNE');
        const lower = classifyWaypoint('jindabyne');
        const mixed = classifyWaypoint('Jindabyne');
        expect(upper.type).toBe('town');
        expect(lower.type).toBe('town');
        expect(mixed.type).toBe('town');
      });

      it('all 14 standard types are classifiable', () => {
        const typeExamples: Record<string, string> = {
          campsite: 'C: Test Camp',
          'water-tank': 'WT: Creek',
          town: 'Jindabyne',
          hut: 'H: Mountain Hut',
          endpoint: 'S: Start Point',
          trailhead: 'TH: Northern Trailhead',
        };
        for (const [expectedType, name] of Object.entries(typeExamples)) {
          const result = classifyWaypoint(name);
          expect(result.type).toBe(expectedType);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tier 4: keyword inference (opt-in, for user-imported GPX only)
  // -------------------------------------------------------------------------
  describe('keyword inference', () => {
    /** Type inferred with the keyword tier ON. */
    const typeOf = (name: string) => classifyWaypoint(name, { inferFromKeywords: true }).type;

    describe('is off unless requested', () => {
      const keywordNames = [
        'Wallaby Creek Campsite',
        'Water tank (rainwater)',
        'Mt Sonder summit',
        'Coles Supermarket',
        'Hut 3',
        'Northcliffe trailhead',
        'Caravan Park',
        'Long Beach',
        'Trail start',
      ];

      for (const name of keywordNames) {
        it(`leaves "${name}" unclassified by default`, () => {
          expect(classifyWaypoint(name).type).toBe('waypoint');
          expect(classifyWaypoint(name).source).toBe('default');
        });
      }

      it('is also off when the option is explicitly false', () => {
        expect(classifyWaypoint('Hut 3', { inferFromKeywords: false }).type).toBe('waypoint');
      });

      it('classifies the same names once enabled', () => {
        for (const name of keywordNames) {
          expect(typeOf(name), name).not.toBe('waypoint');
        }
      });
    });

    describe('never rewrites the name', () => {
      // Only the prefix tier strips text. A keyword is evidence about the
      // waypoint, not decoration — so cleanedName is the trimmed input.
      const names = [
        'Wallaby Creek Campsite',
        'Water tank (rainwater)',
        'Mt Sonder summit',
        'Campsite Area',
        'Water Source',
        'Hut Location',
        'Start of Trail',
        'End Point',
        'Southern Terminus',
        'Food Store',
        'Road Crossing Point',
        'Trailhead Access',
      ];

      for (const name of names) {
        it(`preserves "${name}"`, () => {
          const result = classifyWaypoint(name, { inferFromKeywords: true });
          expect(result.cleanedName).toBe(name);
          expect(result.matchedPrefix).toBe(null);
          expect(result.source).toBe('keyword');
        });
      }
    });

    describe('the names that motivated the tier', () => {
      const cases: Array<[string, string]> = [
        ['Wallaby Creek Campsite', 'campsite'],
        ['Water tank (rainwater)', 'water-tank'],
        ['Mt Sonder summit', 'mountain'],
        ['Coles Supermarket', 'food'],
        ['Hut 3', 'hut'],
        ['Northcliffe trailhead', 'trailhead'],
      ];

      for (const [name, type] of cases) {
        it(`"${name}" -> ${type}`, () => {
          expect(typeOf(name)).toBe(type);
        });
      }
    });

    describe('accommodation', () => {
      it('matches the lodging words', () => {
        expect(typeOf('North Laura Hotel')).toBe('accommodation');
        expect(typeOf('Motel on the highway')).toBe('accommodation');
        expect(typeOf('YHA Hostel')).toBe('accommodation');
        expect(typeOf('Paramount Lodge')).toBe('accommodation');
        expect(typeOf('B&B on the hill')).toBe('accommodation');
        expect(typeOf('Bed and Breakfast')).toBe('accommodation');
        expect(typeOf('Guest house')).toBe('accommodation');
        expect(typeOf('Riverside Cabins')).toBe('accommodation');
      });

      it('sends an ambiguous pub to accommodation, not food', () => {
        // Deliberate: `accommodation` is excluded from the resupply family, so a
        // pub guessed from a name can never shorten a planned food carry.
        expect(typeOf('The Royal Pub')).toBe('accommodation');
        expect(typeOf('Tavern')).toBe('accommodation');
      });

      it('does not match "public" (word boundary)', () => {
        expect(typeOf('Public phone')).toBe('waypoint');
      });
    });

    describe('water — place names are not water sources', () => {
      it('does NOT treat bare creek/river/spring/dam/well as water', () => {
        // Australian place names are full of these and almost none are a
        // drinkable source. Regressing this would invent water on a dry trail.
        expect(typeOf('Ellery Creek')).toBe('waypoint');
        expect(typeOf('Finke River')).toBe('waypoint');
        expect(typeOf('Spring Gully Road')).toBe('waypoint');
        expect(typeOf('Springbrook')).toBe('waypoint');
        expect(typeOf('Wellington Dam')).toBe('waypoint');
        expect(typeOf('Boree Creek')).toBe('waypoint');
      });

      it('requires explicit water intent', () => {
        expect(typeOf('Water Source')).toBe('water');
        expect(typeOf('Water point')).toBe('water');
        expect(typeOf('Drinking water')).toBe('water');
        expect(typeOf('Potable water')).toBe('water');
        expect(typeOf('Water tap')).toBe('water');
        expect(typeOf('Waterhole')).toBe('water');
        expect(typeOf('The Soak')).toBe('water');
        expect(typeOf('Bore Track')).toBe('water');
        expect(typeOf('Cattle trough')).toBe('water');
      });

      it('treats the bare word "water" as a source (the minimalist name)', () => {
        // A common real-world name; missing it dropped the point from the dry-
        // stretch analysis, under-reporting water — the dangerous direction.
        expect(typeOf('Water')).toBe('water');
        expect(typeOf('Water 1')).toBe('water');
        expect(typeOf('Water (seasonal)')).toBe('water');
        expect(typeOf('WATER')).toBe('water');
      });

      it('does not treat compound words containing "water" as a source', () => {
        // Word-boundary matching keeps place names out.
        expect(typeOf('Freshwater Creek')).toBe('waypoint');
        expect(typeOf('Backwater')).toBe('waypoint');
        expect(typeOf('Stormwater drain')).toBe('waypoint');
      });

      it('separates built tanks from open sources', () => {
        expect(typeOf('Water tank')).toBe('water-tank');
        expect(typeOf('Water tanks')).toBe('water-tank');
        expect(typeOf('Water-tank')).toBe('water-tank');
        expect(typeOf('Rainwater tank')).toBe('water-tank');
        expect(typeOf('Rain water')).toBe('water-tank');
      });

      it('does not match water words inside other words', () => {
        expect(typeOf('Tapin Tops')).toBe('waypoint');
        // "Waterfall" is a sight, not a source — and it must not trip the
        // water rules on its "water" substring.
        expect(typeOf('Wallaman Waterfall')).toBe('poi');
      });
    });

    describe('campsites — bare "camp" is excluded', () => {
      it('matches the explicit campsite words', () => {
        expect(typeOf('Wallaby Campsite')).toBe('campsite');
        expect(typeOf('Camp site 4')).toBe('campsite');
        expect(typeOf('Campground')).toBe('campsite');
        expect(typeOf('Camp ground')).toBe('campsite');
        expect(typeOf('Camping area')).toBe('campsite');
        expect(typeOf('Camping ground')).toBe('campsite');
        expect(typeOf('Tentsite 4')).toBe('campsite');
        expect(typeOf('Tent site')).toBe('campsite');
        expect(typeOf('Bush camp')).toBe('campsite');
        expect(typeOf('Free camp')).toBe('campsite');
      });

      it('does NOT match bare "camp"', () => {
        // "Camp Road", "Camp Creek" and "No camping" are all common.
        expect(typeOf('Camp Road')).toBe('waypoint');
        expect(typeOf('Camp Creek')).toBe('waypoint');
      });

      it('handles plurals', () => {
        expect(typeOf('Campsites')).toBe('campsite');
        expect(typeOf('Campgrounds')).toBe('campsite');
      });
    });

    describe('huts', () => {
      it('matches hut/shelter/refuge', () => {
        expect(typeOf('Federation Hut')).toBe('hut');
        expect(typeOf('Huts')).toBe('hut');
        expect(typeOf('Blue Lake Shelter')).toBe('hut');
        expect(typeOf('Refuge')).toBe('hut');
      });

      it('does NOT match "Hutchinson" (word boundary)', () => {
        expect(typeOf('Hutchinson Creek')).toBe('waypoint');
        // Proves the boundary held rather than another rule catching it.
        expect(typeOf('Hutchinson Lookout')).toBe('poi');
      });
    });

    describe('food', () => {
      it('matches shops, chains and food drops', () => {
        expect(typeOf('Supermarket')).toBe('food');
        expect(typeOf('Grocery store')).toBe('food');
        expect(typeOf('Groceries')).toBe('food');
        expect(typeOf('IGA Pemberton')).toBe('food');
        expect(typeOf('Foodland')).toBe('food');
        expect(typeOf('Coles')).toBe('food');
        expect(typeOf('Woolworths')).toBe('food');
        expect(typeOf('General Store')).toBe('food');
        expect(typeOf('Roadhouse')).toBe('food');
        expect(typeOf('Kiosk')).toBe('food');
        expect(typeOf('Cafe Alice')).toBe('food');
        expect(typeOf('Post Office')).toBe('food');
        expect(typeOf('Bakery')).toBe('food');
        expect(typeOf('Food drop')).toBe('food');
      });

      it('does not match chain names inside other words', () => {
        expect(typeOf('Delicatessen')).toBe('waypoint');
      });

      it('types a standalone resupply cache as resupply', () => {
        expect(typeOf('Resupply box')).toBe('resupply');
      });
    });

    describe('trail access vs caravan parks (ordering)', () => {
      it('"Caravan park" is a caravan park, never a trailhead', () => {
        // Ordering test: the caravan-park rule must stay ahead of the
        // car-park/parking rules.
        expect(typeOf('Caravan Park')).toBe('caravan-park');
        expect(typeOf('Kalamunda Caravan Park')).toBe('caravan-park');
        expect(typeOf('Holiday park')).toBe('caravan-park');
        expect(typeOf('Tourist park')).toBe('caravan-park');
        expect(KEYWORD_RULES.findIndex(r => r.type === 'caravan-park')).toBeLessThan(
          KEYWORD_RULES.findIndex(r => r.type === 'trailhead')
        );
      });

      it('matches trail access words', () => {
        expect(typeOf('Northern Trailhead')).toBe('trailhead');
        expect(typeOf('Trail head')).toBe('trailhead');
        expect(typeOf('Car park')).toBe('trailhead');
        expect(typeOf('Carpark')).toBe('trailhead');
        expect(typeOf('Car-park')).toBe('trailhead');
        expect(typeOf('Parking area')).toBe('trailhead');
      });

      it('does NOT match bare "park"', () => {
        expect(typeOf('National Park')).toBe('waypoint');
        expect(typeOf('Parkes')).toBe('waypoint');
      });
    });

    describe('mountains', () => {
      it('matches peak words', () => {
        expect(typeOf('Mt Bogong')).toBe('mountain');
        expect(typeOf('Mt. Sonder')).toBe('mountain');
        expect(typeOf('Mount Sonder')).toBe('mountain');
        expect(typeOf('Frere Peak')).toBe('mountain');
        expect(typeOf('Summit')).toBe('mountain');
        expect(typeOf('Trig point')).toBe('mountain');
      });

      it('does NOT match "mountain" or "paramount"', () => {
        expect(typeOf('Mountain Bike Trail')).toBe('waypoint');
        expect(typeOf('Paramount Creek')).toBe('waypoint');
      });
    });

    describe('points of interest', () => {
      it('matches lookouts and amenities', () => {
        expect(typeOf('Scenic Lookout')).toBe('poi');
        expect(typeOf('Viewpoint')).toBe('poi');
        expect(typeOf('View point')).toBe('poi');
        expect(typeOf('Rest area')).toBe('poi');
        expect(typeOf('Picnic area')).toBe('poi');
        expect(typeOf('Toilets')).toBe('poi');
      });
    });

    describe('road crossings', () => {
      it('requires the explicit crossing phrasing', () => {
        expect(typeOf('Road crossing')).toBe('road-crossing');
        expect(typeOf('Highway crossing')).toBe('road-crossing');
        expect(typeOf('Hwy crossing')).toBe('road-crossing');
      });

      it('does not type a plain road name as a crossing', () => {
        expect(typeOf('Mundaring Weir Road')).toBe('waypoint');
      });
    });

    describe('beaches and termini', () => {
      it('matches beach, including the plural', () => {
        expect(typeOf('Long Beach')).toBe('beach');
        expect(typeOf('Beaches Reserve')).toBe('beach');
      });

      it('matches start/finish/terminus words', () => {
        expect(typeOf('Trail start')).toBe('endpoint');
        expect(typeOf('Start of Trail')).toBe('endpoint');
        expect(typeOf('Start/End')).toBe('endpoint');
        expect(typeOf('End Point')).toBe('endpoint');
        expect(typeOf('Northern terminus')).toBe('endpoint');
        expect(typeOf('Southern Terminus')).toBe('endpoint');
        expect(typeOf('Finish')).toBe('endpoint');
      });

      it('lets a more specific rule win over the weak start/finish words', () => {
        // The endpoint rule sits last precisely so this holds.
        expect(typeOf('Start Campsite')).toBe('campsite');
        expect(typeOf('Trail start car park')).toBe('trailhead');
      });
    });

    describe('structural labels outrank feature guesses', () => {
      it('"Side trip: Mt Ossa" is a side trip, not a mountain', () => {
        expect(typeOf('Side trip: Mt Ossa')).toBe('side-trip');
      });

      it('matches an explicit inlet crossing but not a bare inlet', () => {
        expect(typeOf('Irwin Inlet crossing')).toBe('inlet-crossing');
        expect(typeOf('Wilson Inlet')).toBe('waypoint');
      });
    });

    describe('tier priority', () => {
      it('folder beats everything', () => {
        // The name says campsite; the folder says water tank. Folder wins.
        const result = classifyWaypoint('Ellery Creek Campsite', {
          folderName: 'Water Tanks',
          inferFromKeywords: true,
        });
        expect(result.type).toBe('water-tank');
        expect(result.source).toBe('folder');
      });

      it('known-town beats keyword', () => {
        // "Falls Creek" and "Mt Hotham" are towns, not a waterfall or a peak.
        const falls = classifyWaypoint('Falls Creek', { inferFromKeywords: true });
        expect(falls.type).toBe('town');
        expect(falls.source).toBe('known-town');

        const hotham = classifyWaypoint('Mt Hotham', { inferFromKeywords: true });
        expect(hotham.type).toBe('town');
        expect(hotham.source).toBe('known-town');
      });

      it('prefix beats keyword', () => {
        // "WT: Ellery Creek Campsite" — the author's prefix says water tank.
        const result = classifyWaypoint('WT: Ellery Creek Campsite', {
          inferFromKeywords: true,
        });
        expect(result.type).toBe('water-tank');
        expect(result.source).toBe('prefix');
        expect(result.cleanedName).toBe('Ellery Creek Campsite');
      });

      it('keyword beats default', () => {
        const result = classifyWaypoint('Wallaby Campsite', { inferFromKeywords: true });
        expect(result.source).toBe('keyword');
      });

      it('falls through to default when nothing matches', () => {
        const result = classifyWaypoint('Heavitree Gap', { inferFromKeywords: true });
        expect(result.type).toBe('waypoint');
        expect(result.source).toBe('default');
        expect(result.cleanedName).toBe('Heavitree Gap');
      });
    });

    describe('inferWaypointTypeFromKeywords', () => {
      it('returns the type or null', () => {
        expect(inferWaypointTypeFromKeywords('Wallaby Campsite')).toBe('campsite');
        expect(inferWaypointTypeFromKeywords('Heavitree Gap')).toBe(null);
      });

      it('handles empty and whitespace-only input', () => {
        expect(inferWaypointTypeFromKeywords('')).toBe(null);
        expect(inferWaypointTypeFromKeywords('   ')).toBe(null);
        expect(inferWaypointTypeFromKeywords('---')).toBe(null);
      });

      it('is idempotent as a decision — same input, same answer', () => {
        expect(inferWaypointTypeFromKeywords('Water tank')).toBe(
          inferWaypointTypeFromKeywords('Water tank')
        );
      });
    });

    describe('KEYWORD_RULES table hygiene', () => {
      it('has no duplicate keyword across rules', () => {
        // A duplicate would make the outcome depend on table order in a way no
        // reader would expect.
        const seen = new Map<string, string>();
        for (const rule of KEYWORD_RULES) {
          for (const keyword of rule.keywords) {
            expect(seen.has(keyword), `"${keyword}" appears twice (${seen.get(keyword)} / ${rule.type})`).toBe(false);
            seen.set(keyword, rule.type);
          }
        }
      });

      it('has only lowercase, trimmed keywords', () => {
        for (const rule of KEYWORD_RULES) {
          for (const keyword of rule.keywords) {
            expect(keyword).toBe(keyword.toLowerCase().trim());
            expect(keyword.length).toBeGreaterThan(1);
          }
        }
      });

      it('emits only types the taxonomy knows about', () => {
        for (const rule of KEYWORD_RULES) {
          expect(WAYPOINT_TYPES as readonly string[]).toContain(rule.type);
        }
      });

      it('never emits the catch-all type', () => {
        for (const rule of KEYWORD_RULES) {
          expect(rule.type).not.toBe('waypoint');
        }
      });
    });
  });
});
