/**
 * Every curated trail must say where it is: `trail.json` `country` and
 * `states` drive the grouping on the web landing page and the app's My Guides
 * list (`@lib/trail-regions`). A trail without them lands under "Other".
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { findCountry, isValidCountry, isValidState } from '../src/lib/trail-regions';
import type { TrailConfig } from '../src/lib/trail-types';

const DATA_DIR = path.resolve(__dirname, '../data/trails');

const trails = fs
  .readdirSync(DATA_DIR)
  .filter((dir) => fs.existsSync(path.join(DATA_DIR, dir, 'trail.json')))
  .map((dir) => ({
    dir,
    config: JSON.parse(fs.readFileSync(path.join(DATA_DIR, dir, 'trail.json'), 'utf-8')) as TrailConfig,
  }));

describe('trail.json country and states', () => {
  it('finds the trails', () => {
    expect(trails.length).toBeGreaterThan(0);
  });

  it.each(trails.map((t) => [t.dir, t.config] as const))('%s has a listed country and valid states', (_dir, config) => {
    expect(isValidCountry(config.country)).toBe(true);
    expect(config.country).toBe(config.country?.toUpperCase());
    // Curated trails use a country the list labels, not a bare code.
    const country = findCountry(config.country);
    expect(country).toBeDefined();

    expect(Array.isArray(config.states)).toBe(true);
    const states = config.states ?? [];
    expect(new Set(states).size).toBe(states.length);
    for (const state of states) {
      expect(typeof state).toBe('string');
      expect(isValidState(config.country!, state)).toBe(true);
    }
    // A country with listed states needs at least one, or the trail is not grouped.
    if (country!.states.length > 0) expect(states.length).toBeGreaterThan(0);
    else expect(states).toEqual([]);

    if (config.featured !== undefined) expect(config.featured).toBe(true);
  });
});
