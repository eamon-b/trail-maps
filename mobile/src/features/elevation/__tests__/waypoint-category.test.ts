import { categoryToken, waypointColor } from '../waypoint-category';
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
