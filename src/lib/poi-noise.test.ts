import { describe, it, expect } from 'vitest';

import { countNoiseByReason, dropNoisePois, noiseReason } from './poi-noise.js';
import type { TrailPOI } from './trail-types.js';

function poi(overrides: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'camping',
    lat: -35,
    lon: 138,
    name: null,
    tags: {},
    distanceAlongTrail: 10,
    distanceFromTrail: 0.2,
    ...overrides,
  };
}

describe('noiseReason: bus stops', () => {
  it('drops a bus stop', () => {
    expect(noiseReason(poi({ category: 'transport', tags: { highway: 'bus_stop' } }))).toBe(
      'bus-stop'
    );
  });

  it('keeps the rail and ferry POIs the category exists for', () => {
    expect(noiseReason(poi({ category: 'transport', tags: { railway: 'station' } }))).toBeNull();
    expect(noiseReason(poi({ category: 'transport', tags: { railway: 'halt' } }))).toBeNull();
    expect(
      noiseReason(poi({ category: 'transport', tags: { amenity: 'ferry_terminal' } }))
    ).toBeNull();
  });
});

describe('noiseReason: shelters', () => {
  it('drops a roof over a picnic table', () => {
    for (const shelter_type of ['picnic_shelter', 'gazebo', 'pavilion', 'sun_shelter']) {
      expect(noiseReason(poi({ tags: { amenity: 'shelter', shelter_type } }))).toBe('minor-shelter');
    }
  });

  it('keeps weather shelters, which are real trail infrastructure', () => {
    expect(
      noiseReason(poi({ tags: { amenity: 'shelter', shelter_type: 'weather_shelter' } }))
    ).toBeNull();
  });

  it('keeps huts and lean-tos', () => {
    expect(
      noiseReason(poi({ tags: { amenity: 'shelter', shelter_type: 'basic_hut' } }))
    ).toBeNull();
    expect(noiseReason(poi({ tags: { amenity: 'shelter', shelter_type: 'lean_to' } }))).toBeNull();
  });

  it('spares a campground OSM mis-tagged as a picnic shelter', () => {
    // Ponderosa and YHA on the Heysen: shelter_type=picnic_shelter, and nothing
    // but the name says they are campgrounds.
    for (const name of ['Ponderosa Campground', 'YHA Campground']) {
      expect(
        noiseReason(poi({ name, tags: { amenity: 'shelter', shelter_type: 'picnic_shelter' } }))
      ).toBeNull();
    }
  });

  it('does not spare a gazebo whose name agrees it is a gazebo', () => {
    expect(
      noiseReason(
        poi({ name: 'Centenary Gazebo', tags: { amenity: 'shelter', shelter_type: 'gazebo' } })
      )
    ).toBe('minor-shelter');
  });

  it('judges a wilderness hut that carries no amenity=shelter by the same rule', () => {
    // Opera House, Old Currango Homestead, William Bay all tag shelter_type
    // without amenity=shelter.
    expect(
      noiseReason(
        poi({ name: 'Opera House', tags: { shelter_type: 'basic_hut', tourism: 'wilderness_hut' } })
      )
    ).toBeNull();
  });
});

describe('noiseReason: emergency', () => {
  it('drops a hospital with no emergency department', () => {
    expect(
      noiseReason(
        poi({
          category: 'emergency',
          name: 'Stirling District Hospital',
          tags: { amenity: 'hospital', emergency: 'no' },
        })
      )
    ).toBe('no-emergency-department');
  });

  it('keeps hospitals that have one, and those that say nothing either way', () => {
    expect(
      noiseReason(poi({ category: 'emergency', tags: { amenity: 'hospital', emergency: 'yes' } }))
    ).toBeNull();
    expect(
      noiseReason(poi({ category: 'emergency', tags: { amenity: 'hospital' } }))
    ).toBeNull();
  });

  it('keeps the rest of the emergency category', () => {
    for (const amenity of ['fire_station', 'pharmacy', 'police', 'doctors', 'clinic']) {
      expect(noiseReason(poi({ category: 'emergency', tags: { amenity } }))).toBeNull();
    }
  });
});

describe('dropNoisePois', () => {
  it('passes undefined through, so "never fetched" stays distinct from "all noise"', () => {
    expect(dropNoisePois(undefined)).toBeUndefined();
    expect(dropNoisePois([])).toEqual([]);
  });

  it('removes only what a rule rejects, and does not mutate its input', () => {
    const input = [
      poi({ id: 1, tags: { highway: 'bus_stop' } }),
      poi({ id: 2, tags: { railway: 'station' } }),
      poi({ id: 3, tags: { shelter_type: 'gazebo' } }),
    ];
    const before = JSON.stringify(input);
    expect(dropNoisePois(input)?.map(p => p.id)).toEqual([2]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('countNoiseByReason', () => {
  it('counts each rule separately', () => {
    expect(
      countNoiseByReason([
        poi({ tags: { highway: 'bus_stop' } }),
        poi({ tags: { highway: 'bus_stop' } }),
        poi({ tags: { shelter_type: 'picnic_shelter' } }),
        poi({ tags: { emergency: 'no' } }),
        poi({ tags: { railway: 'station' } }),
      ])
    ).toEqual({ 'bus-stop': 2, 'minor-shelter': 1, 'no-emergency-department': 1 });
  });

  it('reports zeroes for no POIs at all', () => {
    expect(countNoiseByReason(undefined)).toEqual({
      'bus-stop': 0,
      'minor-shelter': 0,
      'no-emergency-department': 0,
    });
  });
});
