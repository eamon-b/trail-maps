/**
 * The decisions behind over-the-air trail data: which catalog entries this
 * build accepts, which copy of a trail is newest, and what a check downloads.
 */

import {
  TRAIL_DATA_FORMAT,
  downloadSupersedesBundle,
  isCatalogTrailId,
  isNewer,
  isUsableTrailJson,
  parseCatalog,
  parseInstalled,
  planTrailDataSync,
  type CatalogEntry,
  type InstalledTrail,
  type TrailVersionInfo,
} from '../trail-catalog';

const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);
const MD5_C = 'c'.repeat(32);

function entry(id: string, updatedAt: string, md5: string): CatalogEntry {
  return {
    id,
    name: `${id} name`,
    shortName: id,
    lengthKm: 10,
    dataVersion: updatedAt.slice(0, 10),
    updatedAt,
    md5,
    bytes: 1234,
    key: `${id}.${md5.slice(0, 12)}.json`,
  };
}

function installed(id: string, updatedAt: string, md5: string): InstalledTrail {
  const e = entry(id, updatedAt, md5);
  return { ...e, file: e.key };
}

function bundled(id: string, updatedAt: string, md5: string): TrailVersionInfo {
  return { id, name: id, shortName: id, lengthKm: 10, updatedAt, md5 };
}

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-05T08:00:00.000Z';
const T3 = '2026-10-06T09:30:00.000Z';

describe('isCatalogTrailId', () => {
  it('accepts curated ids and refuses user-import and unsafe ones', () => {
    expect(isCatalogTrailId('shikoku')).toBe(true);
    expect(isCatalogTrailId('hume-and-hovell')).toBe(true);
    expect(isCatalogTrailId('u_abc123')).toBe(false);
    // Community routes are fetched from their own URL, never the catalog.
    expect(isCatalogTrailId('c_AbCdEfGhIjKlMnOp')).toBe(false);
    expect(isCatalogTrailId('../etc')).toBe(false);
    expect(isCatalogTrailId('a/b')).toBe(false);
    expect(isCatalogTrailId('')).toBe(false);
  });
});

describe('parseCatalog', () => {
  it('accepts a catalog in this build’s format', () => {
    const catalog = parseCatalog({
      format: TRAIL_DATA_FORMAT,
      generatedAt: T3,
      trails: [entry('shikoku', T3, MD5_A)],
    });
    expect(catalog?.trails).toEqual([entry('shikoku', T3, MD5_A)]);
    expect(catalog?.generatedAt).toBe(T3);
  });

  it('reads country and states leniently, never rejecting the entry for them', () => {
    const catalog = parseCatalog({
      format: TRAIL_DATA_FORMAT,
      trails: [
        { ...entry('aawt', T3, MD5_A), country: 'au', states: ['VIC', 'NSW', 42] },
        { ...entry('heysen', T3, MD5_B), country: 'Australia', states: 'SA' },
      ],
    });
    expect(catalog?.trails[0]).toEqual(
      expect.objectContaining({ country: 'AU', states: ['VIC', 'NSW'] }),
    );
    expect(catalog?.trails[1]).toEqual(entry('heysen', T3, MD5_B));
  });

  it('refuses another format and non-catalogs', () => {
    expect(parseCatalog({ format: 2, trails: [] })).toBeNull();
    expect(parseCatalog({ format: TRAIL_DATA_FORMAT })).toBeNull();
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog('catalog')).toBeNull();
  });

  it('drops malformed entries one by one and keeps the first of a duplicated id', () => {
    const good = entry('heysen', T2, MD5_A);
    const catalog = parseCatalog({
      format: TRAIL_DATA_FORMAT,
      trails: [
        good,
        { ...entry('bad-md5', T2, MD5_B), md5: 'xyz' },
        { ...entry('bad-key', T2, MD5_B), key: '../../evil.json' },
        { ...entry('state-key', T2, MD5_B), key: 'state.json' },
        { ...entry('other-key', T2, MD5_B), key: `other-key.${MD5_C.slice(0, 12)}.json` },
        { ...entry('bad-time', T2, MD5_B), updatedAt: 'yesterday' },
        { ...entry('no-bytes', T2, MD5_B), bytes: 0 },
        entry('u_import', T2, MD5_B),
        entry('heysen', T3, MD5_C),
        'not an object',
      ],
    });
    expect(catalog?.trails).toEqual([good]);
  });
});

describe('parseInstalled', () => {
  it('needs a safe file name on top of a valid entry', () => {
    expect(parseInstalled(installed('heysen', T2, MD5_A))).toEqual(installed('heysen', T2, MD5_A));
    expect(parseInstalled({ ...installed('heysen', T2, MD5_A), file: '../x.json' })).toBeNull();
    expect(parseInstalled({ ...installed('heysen', T2, MD5_A), file: 'state.json' })).toBeNull();
    expect(parseInstalled(entry('heysen', T2, MD5_A))).toBeNull();
  });
});

describe('isNewer', () => {
  it('orders by updatedAt, and the same bytes are never newer', () => {
    expect(isNewer(entry('t', T3, MD5_A), bundled('t', T2, MD5_B))).toBe(true);
    expect(isNewer(entry('t', T1, MD5_A), bundled('t', T2, MD5_B))).toBe(false);
    expect(isNewer(entry('t', T2, MD5_A), bundled('t', T2, MD5_B))).toBe(false);
    expect(isNewer(entry('t', T3, MD5_A), bundled('t', T1, MD5_A))).toBe(false);
  });

  it('treats a copy with no updatedAt as older than anything, and nothing as oldest', () => {
    expect(isNewer(entry('t', T1, MD5_A), { id: 't', name: 't', shortName: 't', lengthKm: 1 })).toBe(
      true,
    );
    expect(isNewer(entry('t', T1, MD5_A), null)).toBe(true);
  });
});

describe('downloadSupersedesBundle', () => {
  it('reads a download only while it is newer than the bundle', () => {
    expect(downloadSupersedesBundle(installed('t', T3, MD5_A), bundled('t', T2, MD5_B))).toBe(true);
    // An app update that bundles later data wins over the older download.
    expect(downloadSupersedesBundle(installed('t', T2, MD5_A), bundled('t', T3, MD5_B))).toBe(false);
    // A catalog-only trail has no bundle to lose to.
    expect(downloadSupersedesBundle(installed('t', T1, MD5_A), undefined)).toBe(true);
  });
});

describe('planTrailDataSync', () => {
  const catalogOf = (...trails: CatalogEntry[]) => ({
    format: TRAIL_DATA_FORMAT,
    generatedAt: T3,
    trails,
  });

  it('downloads a newer copy of a bundled trail', () => {
    const plan = planTrailDataSync(
      catalogOf(entry('shikoku', T3, MD5_B)),
      new Map([['shikoku', bundled('shikoku', T2, MD5_A)]]),
      {},
    );
    expect(plan.download.map((e) => e.id)).toEqual(['shikoku']);
    expect(plan.remove).toEqual([]);
  });

  it('leaves a bundle that is as new as the catalog, or newer (unpublished build data)', () => {
    const same = planTrailDataSync(
      catalogOf(entry('shikoku', T2, MD5_A)),
      new Map([['shikoku', bundled('shikoku', T2, MD5_A)]]),
      {},
    );
    expect(same.download).toEqual([]);
    const ahead = planTrailDataSync(
      catalogOf(entry('shikoku', T1, MD5_B)),
      new Map([['shikoku', bundled('shikoku', T2, MD5_A)]]),
      {},
    );
    expect(ahead.download).toEqual([]);
  });

  it('compares against the download when one is in use', () => {
    const bundles = new Map([['shikoku', bundled('shikoku', T1, MD5_A)]]);
    const upToDate = planTrailDataSync(catalogOf(entry('shikoku', T2, MD5_B)), bundles, {
      shikoku: installed('shikoku', T2, MD5_B),
    });
    expect(upToDate.download).toEqual([]);
    const behind = planTrailDataSync(catalogOf(entry('shikoku', T3, MD5_C)), bundles, {
      shikoku: installed('shikoku', T2, MD5_B),
    });
    expect(behind.download.map((e) => e.key)).toEqual([entry('shikoku', T3, MD5_C).key]);
  });

  it('removes a download the bundle has caught up with', () => {
    const plan = planTrailDataSync(
      catalogOf(entry('shikoku', T3, MD5_C)),
      new Map([['shikoku', bundled('shikoku', T3, MD5_C)]]),
      { shikoku: installed('shikoku', T2, MD5_B) },
    );
    expect(plan.remove).toEqual(['shikoku']);
    expect(plan.download).toEqual([]);
  });

  it('lists catalog-only trails without downloading them, but updates one already downloaded', () => {
    const notYet = planTrailDataSync(catalogOf(entry('new_trail', T2, MD5_A)), new Map(), {});
    expect(notYet.download).toEqual([]);
    const stale = planTrailDataSync(catalogOf(entry('new_trail', T3, MD5_B)), new Map(), {
      new_trail: installed('new_trail', T2, MD5_A),
    });
    expect(stale.download.map((e) => e.id)).toEqual(['new_trail']);
  });

  it('keeps a download the catalog no longer lists', () => {
    const plan = planTrailDataSync(catalogOf(), new Map(), {
      withdrawn: installed('withdrawn', T2, MD5_A),
    });
    expect(plan).toEqual({ download: [], remove: [] });
  });
});

describe('isUsableTrailJson', () => {
  const trail = {
    config: { id: 'shikoku' },
    waypoints: [],
    track: { points: [{ lat: 0, lon: 0 }] },
  };

  it('accepts the trail it claims to be', () => {
    expect(isUsableTrailJson(trail, 'shikoku')).toBe(true);
  });

  it('refuses another trail, a missing track, or an empty one', () => {
    expect(isUsableTrailJson(trail, 'heysen')).toBe(false);
    expect(isUsableTrailJson({ ...trail, track: undefined }, 'shikoku')).toBe(false);
    expect(isUsableTrailJson({ ...trail, track: { points: [] } }, 'shikoku')).toBe(false);
    expect(isUsableTrailJson({ ...trail, waypoints: undefined }, 'shikoku')).toBe(false);
    expect(isUsableTrailJson(null, 'shikoku')).toBe(false);
  });
});
