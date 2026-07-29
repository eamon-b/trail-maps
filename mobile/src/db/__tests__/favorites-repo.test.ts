import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as favoritesRepo from '../favorites-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

const TRAIL = 'aawt';

describe('favorites-repo', () => {
  it('toggles a favorite on and off', async () => {
    const d = await db();
    expect(await favoritesRepo.isFavorite(d, TRAIL, 'w_1')).toBe(false);

    const on = await favoritesRepo.toggle(d, TRAIL, 'w_1');
    expect(on).toBe(true);
    expect(await favoritesRepo.isFavorite(d, TRAIL, 'w_1')).toBe(true);

    const off = await favoritesRepo.toggle(d, TRAIL, 'w_1');
    expect(off).toBe(false);
    expect(await favoritesRepo.isFavorite(d, TRAIL, 'w_1')).toBe(false);
  });

  it('lists favorites for a trail and is scoped by trail', async () => {
    const d = await db();
    await favoritesRepo.toggle(d, TRAIL, 'w_1');
    await favoritesRepo.toggle(d, TRAIL, 'w_2');
    await favoritesRepo.toggle(d, 'heysen', 'w_3');

    const ids = await favoritesRepo.list(d, TRAIL);
    expect(ids.sort()).toEqual(['w_1', 'w_2']);
    expect(await favoritesRepo.list(d, 'heysen')).toEqual(['w_3']);
  });
});
