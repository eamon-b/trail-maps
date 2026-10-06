import { launchTrailId, orderWithCurrentFirst } from '../current-hike';

const trails = [{ id: 'aawt' }, { id: 'heysen' }, { id: 'larapinta' }];

describe('orderWithCurrentFirst', () => {
  it('moves the current trail to the front and keeps the rest in order', () => {
    expect(orderWithCurrentFirst(trails, 'larapinta').map((t) => t.id)).toEqual([
      'larapinta',
      'aawt',
      'heysen',
    ]);
  });

  it('returns the same list when there is no current trail', () => {
    expect(orderWithCurrentFirst(trails, null)).toBe(trails);
  });

  it('returns the same list when the current trail is already first or missing', () => {
    expect(orderWithCurrentFirst(trails, 'aawt')).toBe(trails);
    expect(orderWithCurrentFirst(trails, 'u_deleted')).toBe(trails);
  });
});

describe('launchTrailId', () => {
  it('opens the current trail when the phone still lists it', () => {
    expect(launchTrailId('heysen', ['aawt', 'heysen'], false)).toBe('heysen');
  });

  it('stays on the list with no current trail', () => {
    expect(launchTrailId(null, ['aawt'], false)).toBeNull();
  });

  it('stays on the list when the current trail is gone', () => {
    expect(launchTrailId('u_deleted', ['aawt'], false)).toBeNull();
  });

  it('stays on the list when the launch was for something else', () => {
    expect(launchTrailId('heysen', ['heysen'], true)).toBeNull();
  });
});
