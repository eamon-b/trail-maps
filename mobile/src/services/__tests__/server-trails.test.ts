/**
 * The server boundary. `server-trails` is deliberately a second, cheaper source
 * of the bundled id list (index.json rather than the multi-megabyte require()
 * map), so the load-bearing assertion is that the two agree — a trail added to
 * the bundle but missed in the index would silently lose its comments.
 */

import { isServerKnown, registerRemoteTrailIds, serverTrailIds } from '../server-trails';
import {
  hasTrail,
  isServerKnown as loaderIsServerKnown,
  listTrails,
} from '../trail-loader';

describe('isServerKnown', () => {
  it('accepts every bundled trail', () => {
    for (const entry of listTrails()) {
      expect(isServerKnown(entry.id)).toBe(true);
    }
  });

  it('rejects imported and unknown ids', () => {
    expect(isServerKnown('u_1a2b3c4d')).toBe(false);
    expect(isServerKnown('not-a-trail')).toBe(false);
    expect(isServerKnown('')).toBe(false);
  });

  it('agrees with the bundled require() map', () => {
    const ids = serverTrailIds();
    expect(ids).toEqual(listTrails().map((entry) => entry.id));
    for (const id of ids) expect(hasTrail(id)).toBe(true);
  });

  it('is what trail-loader re-exports', () => {
    // Same function object, so there is exactly one implementation of the gate
    // no matter which module a caller reaches for.
    expect(loaderIsServerKnown).toBe(isServerKnown);
  });
});

describe('registerRemoteTrailIds', () => {
  afterEach(() => {
    registerRemoteTrailIds([]);
  });

  it('makes catalog-only trails server-known', () => {
    expect(isServerKnown('catalog-only-trail')).toBe(false);
    registerRemoteTrailIds(['catalog-only-trail']);
    expect(isServerKnown('catalog-only-trail')).toBe(true);
  });

  it('replaces the previous set rather than adding to it', () => {
    registerRemoteTrailIds(['first-trail', 'second-trail']);
    registerRemoteTrailIds(new Set(['second-trail']));
    expect(isServerKnown('first-trail')).toBe(false);
    expect(isServerKnown('second-trail')).toBe(true);

    registerRemoteTrailIds([]);
    expect(isServerKnown('second-trail')).toBe(false);
  });

  it('refuses imported (u_) ids even when handed one', () => {
    registerRemoteTrailIds(['u_1a2b3c4d', 'catalog-only-trail']);
    expect(isServerKnown('u_1a2b3c4d')).toBe(false);
    expect(isServerKnown('catalog-only-trail')).toBe(true);
  });

  it('never removes the bundled trails', () => {
    registerRemoteTrailIds([]);
    for (const id of serverTrailIds()) expect(isServerKnown(id)).toBe(true);
    expect(serverTrailIds()).not.toContain('catalog-only-trail');
  });
});
