import { categoryToken, poiColor, poiColorToken, waypointColor } from '../waypoint-category';
import type { ThemeColors } from '../../../tokens';

describe('categoryToken', () => {
  it('maps water types to the water token', () => {
    expect(categoryToken('water')).toBe('waypointWater');
    expect(categoryToken('water-tank')).toBe('waypointWater');
  });

  it('maps camp/town/shelter/hazard families', () => {
    expect(categoryToken('campsite')).toBe('waypointCamp');
    expect(categoryToken('town')).toBe('waypointTown');
    expect(categoryToken('food')).toBe('waypointTown');
    expect(categoryToken('hut')).toBe('waypointShelter');
    expect(categoryToken('hazard')).toBe('waypointHazard');
  });

  it('falls back to junction for unknown types', () => {
    expect(categoryToken('nonsense')).toBe('waypointJunction');
    expect(categoryToken('')).toBe('waypointJunction');
  });
});

describe('waypointColor', () => {
  it('resolves the token against the theme colors', () => {
    const colors = {
      waypointWater: '#0000ff',
      waypointJunction: '#888888',
    } as unknown as ThemeColors;
    expect(waypointColor('water', colors)).toBe('#0000ff');
    expect(waypointColor('unknown', colors)).toBe('#888888');
  });
});

describe('poiColorToken', () => {
  it('reuses the waypoint palette, folding food in with resupply', () => {
    expect(poiColorToken('water')).toBe('waypointWater');
    expect(poiColorToken('camping')).toBe('waypointCamp');
    expect(poiColorToken('resupply')).toBe('waypointTown');
    expect(poiColorToken('restaurant')).toBe('waypointTown');
    expect(poiColorToken('transport')).toBe('waypointJunction');
    expect(poiColorToken('emergency')).toBe('waypointHazard');
  });

  it('falls back to junction for a category from a newer build', () => {
    expect(poiColorToken('ferry')).toBe('waypointJunction');
    expect(poiColorToken('')).toBe('waypointJunction');
  });
});

describe('poiColor', () => {
  it('resolves the token against the theme colors', () => {
    const colors = {
      waypointCamp: '#00ff00',
      waypointJunction: '#888888',
    } as unknown as ThemeColors;
    expect(poiColor('camping', colors)).toBe('#00ff00');
    expect(poiColor('ferry', colors)).toBe('#888888');
  });
});
