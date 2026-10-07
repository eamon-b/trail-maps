import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CommunityRouteSummary } from '@lib/community-types';
import type { ImportedTrailSummary } from './imported-trails-db';
import {
  FILTER_STORAGE_KEY,
  initLandingPage,
  isFilterActive,
  lengthText,
  loadFilterState,
  parseFilterState,
  placeText,
  renderCommunity,
  renderCommunityCard,
  renderCurated,
  renderFeatured,
  renderImported,
  saveFilterState,
  type CuratedTrailEntry,
  type ListFilterState,
} from './index';

const curated: CuratedTrailEntry[] = [
  { id: 'aawt', name: 'Australian Alps Walking Track', shortName: 'AAWT', lengthKm: 688.3, region: 'Alps', country: 'AU', states: ['VIC', 'NSW', 'ACT'] },
  { id: 'six_foot_track', name: 'Six Foot Track', shortName: 'SFT', lengthKm: 44.5, country: 'AU', states: ['NSW'] },
  { id: 'royal', name: 'The Coast Track', shortName: 'Coast', lengthKm: 25.3, country: 'AU', states: ['NSW'], featured: true },
  { id: 'te_araroa', name: 'Te Araroa', shortName: 'TA', lengthKm: 3056.8, country: 'NZ', states: ['NI', 'SI'] },
  { id: 'cdt', name: 'Continental Divide Trail', shortName: 'CDT', lengthKm: 4874.7, country: 'US', states: [] },
];

function route(over: Partial<CommunityRouteSummary>): CommunityRouteSummary {
  return {
    id: 'c_AAAAAAAAAAAAAAAA',
    name: 'Route',
    status: 'unverified',
    country: 'AU',
    state: 'VIC',
    lengthKm: 12,
    ascentM: 100,
    hasElevation: true,
    waypointCount: 0,
    bbox: [0, 0, 1, 1],
    start: { lat: 0, lon: 0 },
    submittedBy: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    verifiedAt: null,
    reviewed: false,
    trailUrl: 'https://example.test/x.json',
    md5: '0'.repeat(32),
    bytes: 10,
    ...over,
  };
}

const imports: ImportedTrailSummary[] = [
  { id: 'u_abc', name: 'My <b>loop</b>', lengthKm: 18.24, createdAt: Date.UTC(2026, 0, 2) },
  { id: 'u_def', name: 'Big walk', lengthKm: 420, createdAt: Date.UTC(2026, 0, 3) },
];

const base: ListFilterState = { query: '', bands: [], sort: 'name' };

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('filter state', () => {
  it('reads back what it saved', () => {
    const storage = memoryStorage();
    const state: ListFilterState = { query: 'alps', bands: ['long', 'day'], sort: 'length-desc' };
    saveFilterState(storage, state);
    // Bands come back in LENGTH_BANDS order.
    expect(loadFilterState(storage)).toEqual({ query: 'alps', bands: ['day', 'long'], sort: 'length-desc' });
  });

  it('drops anything unusable', () => {
    expect(parseFilterState('not json')).toEqual(base);
    expect(parseFilterState(null)).toEqual(base);
    expect(parseFilterState(JSON.stringify({ query: 3, bands: ['huge', 'multi'], sort: 'region' }))).toEqual({
      query: '',
      bands: ['multi'],
      sort: 'name',
    });
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadFilterState(broken)).toEqual(base);
    expect(() => saveFilterState(broken, base)).not.toThrow();
    expect(loadFilterState(null)).toEqual(base);
  });

  it('knows when a filter is on', () => {
    expect(isFilterActive(base)).toBe(false);
    expect(isFilterActive({ ...base, query: '  ' })).toBe(false);
    expect(isFilterActive({ ...base, sort: 'length' })).toBe(false);
    expect(isFilterActive({ ...base, query: 'x' })).toBe(true);
    expect(isFilterActive({ ...base, bands: ['day'] })).toBe(true);
  });
});

describe('text helpers', () => {
  it('formats lengths', () => {
    expect(lengthText(688.3)).toBe('688.3 km');
    expect(lengthText(426)).toBe('426 km');
    expect(lengthText(12.04)).toBe('12 km');
  });

  it('names the places a trail passes', () => {
    expect(placeText('AU', ['VIC', 'NSW'])).toBe('Victoria, New South Wales');
    expect(placeText('AU', ['TAS'], true)).toBe('Tasmania, Australia');
    expect(placeText('US', [])).toBe('United States');
    expect(placeText(null, [])).toBe('');
  });
});

describe('renderCurated', () => {
  it('groups by country then state, with counts', () => {
    const { html, count } = renderCurated(curated, base);
    expect(count).toBe(5);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const groups = [...doc.querySelectorAll('details.country-group')];
    expect(groups.map((g) => g.querySelector('.country-heading')!.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Australia 3',
      'New Zealand 1',
      'United States 1',
    ]);
    expect(groups.every((g) => g.hasAttribute('open'))).toBe(true);
    expect([...groups[0].querySelectorAll('.state-heading')].map((h) => h.textContent)).toEqual([
      'New South Wales',
      'Victoria',
    ]);
    // A country without states gets no sub-heading.
    expect(groups[2].querySelector('.state-heading')).toBeNull();
    expect(groups[0].querySelector('a')!.getAttribute('href')).toBe('./trails/six_foot_track/');
  });

  it('drops groups the filter empties', () => {
    const { html, count } = renderCurated(curated, { ...base, query: 'south island' });
    expect(count).toBe(1);
    expect(html).toContain('Te Araroa');
    expect(html).not.toContain('Australia');
  });

  it('searches the short name and region', () => {
    expect(renderCurated(curated, { ...base, query: 'cdt' }).count).toBe(1);
    expect(renderCurated(curated, { ...base, query: 'alps' }).count).toBe(1);
  });

  it('filters by length band', () => {
    const { count } = renderCurated(curated, { ...base, bands: ['day', 'multi'] });
    expect(count).toBe(2);
  });

  it('keeps collapsed groups closed', () => {
    const html = renderCurated(curated, base, new Set(['curated:NZ'])).html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('[data-group="curated:NZ"]')!.hasAttribute('open')).toBe(false);
    expect(doc.querySelector('[data-group="curated:AU"]')!.hasAttribute('open')).toBe(true);
  });

  it('lists featured trails only', () => {
    expect(renderFeatured(curated, base)).toContain('The Coast Track');
    expect(renderFeatured(curated, base)).not.toContain('Six Foot');
    expect(renderFeatured(curated, { ...base, query: 'nothing' })).toBe('');
    expect(renderFeatured(curated.filter((t) => !t.featured), base)).toBe('');
  });
});

describe('community cards', () => {
  it('escapes user text and shows the badge and submitter', () => {
    const html = renderCommunityCard(
      route({ name: '<img src=x onerror=alert(1)>', submittedBy: 'Sam "the" <hiker>', status: 'verified' })
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('by Sam &quot;the&quot; &lt;hiker&gt;');
    expect(html).toContain('list-badge-verified');
    expect(html).toContain('href="./community-route.html?id=c_AAAAAAAAAAAAAAAA"');
  });

  it('labels an unverified route and leaves out a missing submitter', () => {
    const html = renderCommunityCard(route({}));
    expect(html).toContain('Unverified');
    expect(html).not.toContain('trail-by');
  });

  it('groups routes by country and state', () => {
    const routes = [
      route({ id: 'c_1111111111111111', name: 'Kiwi', country: 'NZ', state: 'SI' }),
      route({ id: 'c_2222222222222222', name: 'Aussie', country: 'AU', state: 'TAS' }),
      route({ id: 'c_3333333333333333', name: 'Alpine', country: 'CH', state: null }),
    ];
    const { html, count } = renderCommunity(routes, base);
    expect(count).toBe(3);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect([...doc.querySelectorAll('[data-group]')].map((d) => d.getAttribute('data-group'))).toEqual([
      'community:AU',
      'community:NZ',
      'community:CH',
    ]);
    expect(renderCommunity(routes, { ...base, query: 'tasmania' }).count).toBe(1);
  });
});

describe('renderImported', () => {
  it('escapes names and filters by name and band', () => {
    const all = renderImported(imports, base);
    expect(all.count).toBe(2);
    expect(all.html).toContain('My &lt;b&gt;loop&lt;/b&gt;');
    expect(all.html).toContain('./my-trail.html?id=u_abc');
    expect(all.html).toContain('Imported');
    expect(renderImported(imports, { ...base, query: 'loop' }).count).toBe(1);
    expect(renderImported(imports, { ...base, bands: ['long'] }).count).toBe(1);
    // An import has no country: "other" is not a match.
    expect(renderImported(imports, { ...base, query: 'other' }).count).toBe(0);
  });
});

describe('initLandingPage', () => {
  beforeEach(() => {
    const html = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  });

  const $ = (id: string) => document.getElementById(id)!;

  it('renders every tier and hides the community tier without an API', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => null,
      fetchImported: async () => imports,
    });
    expect($('trail-list').querySelectorAll('.trail-card')).toHaveLength(5);
    expect($('featured-section').hidden).toBe(false);
    expect($('community-section').hidden).toBe(true);
    expect($('my-trail-list').querySelectorAll('.trail-card')).toHaveLength(2);
    expect($('no-my-trails').hidden).toBe(true);
    expect($('no-match').hidden).toBe(true);
  });

  it('shows a note when community routes fail to load', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => {
        throw new Error('offline');
      },
      fetchImported: async () => [],
    });
    expect($('community-section').hidden).toBe(false);
    expect($('community-note').textContent).toBe('Community routes could not be loaded.');
    expect($('community-section').querySelector('a[href="./upload.html"]')!.textContent).toContain('Share a route');
  });

  it('filters all tiers, remembers the filter and says when nothing matches', async () => {
    const storage = memoryStorage();
    await initLandingPage(document, {
      storage,
      fetchCurated: async () => curated,
      fetchCommunity: async () => [route({ name: 'Wilsons Prom loop' })],
      fetchImported: async () => imports,
    });
    expect($('community-list').querySelectorAll('.trail-card')).toHaveLength(1);

    const search = $('trail-search') as HTMLInputElement;
    search.value = 'loop';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('curated-section').hidden).toBe(true);
    expect($('featured-section').hidden).toBe(true);
    expect($('community-section').hidden).toBe(false);
    expect($('my-trail-list').querySelectorAll('.trail-card')).toHaveLength(1);
    expect(JSON.parse(storage.getItem(FILTER_STORAGE_KEY)!).query).toBe('loop');

    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('no-match').hidden).toBe(false);
    expect($('my-trails-section').hidden).toBe(true);
    expect($('community-section').hidden).toBe(true);

    $('clear-filter').click();
    expect($('no-match').hidden).toBe(true);
    expect($('trail-list').querySelectorAll('.trail-card')).toHaveLength(5);
    expect(($('trail-search') as HTMLInputElement).value).toBe('');
  });

  it('toggles length chips and restores a saved filter', async () => {
    const storage = memoryStorage({ [FILTER_STORAGE_KEY]: JSON.stringify({ query: '', bands: ['long'], sort: 'length' }) });
    await initLandingPage(document, {
      storage,
      fetchCurated: async () => curated,
      fetchCommunity: async () => null,
      fetchImported: async () => [],
    });
    const chip = (band: string) => $('trail-filter').querySelector<HTMLButtonElement>(`[data-band="${band}"]`)!;
    expect(chip('long').getAttribute('aria-pressed')).toBe('true');
    expect($('trail-list').querySelectorAll('.trail-card')).toHaveLength(3);
    expect(($('trail-sort') as HTMLSelectElement).value).toBe('length');

    chip('long').click();
    expect(chip('long').getAttribute('aria-pressed')).toBe('false');
    expect($('trail-list').querySelectorAll('.trail-card')).toHaveLength(5);
    expect(JSON.parse(storage.getItem(FILTER_STORAGE_KEY)!).bands).toEqual([]);
  });

  it('shows the empty state when the trail index cannot be read', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => {
        throw new Error('404');
      },
      fetchCommunity: async () => null,
      fetchImported: async () => [],
    });
    expect($('no-trails').hidden).toBe(false);
    expect($('trail-list').textContent!.trim()).toBe('');
    expect($('no-my-trails').hidden).toBe(false);
  });
});
