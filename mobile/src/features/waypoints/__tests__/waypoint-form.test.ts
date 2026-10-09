import {
  WAYPOINT_TYPE_CHOICES,
  initialWaypointForm,
  numberParam,
  summarisePosition,
} from '../waypoint-form';

// Due north along lon 138: ~1.112 km per 0.01° of latitude.
const points = Array.from({ length: 11 }, (_, i) => ({
  lat: -35 + i * 0.01,
  lon: 138,
  ele: 100,
  dist: i * 1.112,
}));

describe('numberParam', () => {
  it('reads numeric route params', () => {
    expect(numberParam('-34.5')).toBe(-34.5);
    expect(numberParam(['12', '13'])).toBe(12);
    expect(numberParam(undefined)).toBeNull();
    expect(numberParam('')).toBeNull();
    expect(numberParam('abc')).toBeNull();
  });
});

describe('initialWaypointForm', () => {
  it('starts a new waypoint private at the given position', () => {
    expect(initialWaypointForm(null, { lat: 1, lon: 2 })).toEqual({
      name: '',
      type: null,
      description: '',
      visibility: 'private',
      lat: 1,
      lon: 2,
    });
  });

  it('starts an edit from the waypoint', () => {
    const form = initialWaypointForm(
      {
        id: 'hw_x', trailId: 't', name: 'Tank', type: 'water', lat: 3, lon: 4, description: 'Full',
        visibility: 'shared', mine: true, authorName: 'Me', createdAt: '', updatedAt: '',
      },
      { lat: null, lon: null },
    );
    expect(form).toMatchObject({ name: 'Tank', type: 'water', visibility: 'shared', lat: 3, lon: 4 });
  });
});

describe('summarisePosition', () => {
  it('says where on the trail a spot is', () => {
    const on = summarisePosition(-34.95, 138, points, undefined, 'km');
    expect(on).toMatchObject({ ok: true, text: 'At 5.6 km along the trail, on the trail' });
    const off = summarisePosition(-34.95, 138.003, points, undefined, 'km');
    expect(off).toMatchObject({ ok: true });
    expect(off.text).toMatch(/^At 5\.6 km along the trail, 27\d m off the trail$/);
  });

  it('refuses a spot too far away, or none at all', () => {
    expect(summarisePosition(-34.95, 138.2, points, undefined, 'km')).toMatchObject({ ok: false });
    expect(summarisePosition(null, null, points, undefined, 'km')).toMatchObject({ ok: false });
  });
});

it('offers every hiker waypoint type with a label', () => {
  expect(WAYPOINT_TYPE_CHOICES.find((c) => c.value === 'water')?.label).toBe('Water source');
});
