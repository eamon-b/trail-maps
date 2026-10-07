import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CommunityRouteDetail, CommunityRouteSummary } from '@lib/community-types';
import { ApiError } from './api/client';
import type { ImportedTrailSummary } from './imported-trails-db';
import { UNVERIFIED_EXPLANATION, VERIFIED_EXPLANATION } from './community-labels';
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
  renderMyRouteCard,
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

function mine(over: Partial<CommunityRouteDetail>): CommunityRouteDetail {
  return {
    ...route({}),
    description: 'A route',
    credit: null,
    licence: 'CC0-1.0',
    checks: [],
    isOwner: true,
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
    expect(groups.map((g) => g.querySelector('summary')!.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
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

  it('uses the shared status explanations as the badge tooltip', () => {
    expect(renderCommunityCard(route({ status: 'verified' }))).toContain(`title="${VERIFIED_EXPLANATION}"`);
    expect(renderCommunityCard(route({}))).toContain(`title="${UNVERIFIED_EXPLANATION}"`);
  });

  it('keeps headings out of the group summaries', () => {
    const { html } = renderCommunity([route({})], base);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const summary = doc.querySelector('summary')!;
    expect(summary.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(summary.querySelector('.country-heading')!.textContent).toBe('Australia');
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

describe('Shared by me cards', () => {
  it('escapes the name, links by encoded id and shows the shared badge', () => {
    const html = renderMyRouteCard(mine({ id: 'c_AB&CD', name: 'Mine <img src=x>', status: 'verified' }));
    expect(html).toContain('Mine &lt;img src=x&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="./community-route.html?id=c_AB%26CD"');
    expect(html).toContain('community-badge-verified');
    expect(html).toContain('Victoria, Australia');
    expect(html).not.toContain('my-route-reason');
  });

  it('says why a hidden route is hidden, with the review summary escaped', () => {
    const html = renderMyRouteCard(
      mine({
        status: 'hidden',
        hiddenReason: 'review',
        trailUrl: null,
        review: { status: 'done', verdict: 'reject', summary: 'Looks like <b>spam</b>\nline two' },
      })
    );
    expect(html).toContain('community-badge-hidden');
    expect(html).toContain('>Hidden<');
    expect(html).toContain('Hidden by the automatic review');
    expect(html).toContain('Looks like &lt;b&gt;spam&lt;/b&gt;<br>line two');
  });

  it('words each reason, and leaves an unknown one out', () => {
    expect(renderMyRouteCard(mine({ status: 'hidden', hiddenReason: 'reports' }))).toContain(
      'Hidden after reports from other users'
    );
    expect(renderMyRouteCard(mine({ status: 'hidden', hiddenReason: 'admin' }))).toContain('Hidden by a moderator');
    const odd = renderMyRouteCard(mine({ status: 'hidden', hiddenReason: 'toString' as never }));
    expect(odd).not.toContain('my-route-reason');
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

  it('gives up on a stalled community list, so "No trails match" can still show', async () => {
    let signal: AbortSignal | undefined;
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: (s) => {
        signal = s;
        return new Promise(() => {}); // never answers
      },
      fetchImported: async () => [],
      communityTimeoutMs: 20,
    });
    expect(signal?.aborted).toBe(true);
    expect($('community-note').textContent).toBe('Community routes could not be loaded.');

    const search = $('trail-search') as HTMLInputElement;
    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect($('no-match').hidden).toBe(false);
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

  it('leaves "Shared by me" out when the browser is not linked', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => [route({})],
      fetchImported: async () => imports,
      fetchMyRoutes: async () => null,
    });
    expect($('my-community').hidden).toBe(true);
    // The default (no API in the test build, no session) is the same.
    document.body.innerHTML = readFileSync(resolve(__dirname, 'index.html'), 'utf-8').split('<body>')[1].split('</body>')[0];
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => null,
      fetchImported: async () => [],
    });
    expect($('my-community').hidden).toBe(true);
  });

  it('lists the reader’s own routes, hidden ones with why, and filters them', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => [route({ name: 'Live one' })],
      fetchImported: async () => [],
      fetchMyRoutes: async () => [
        mine({ id: 'c_1', name: 'Live one' }),
        mine({ id: 'c_2', name: 'Taken <down>', status: 'hidden', hiddenReason: 'reports', trailUrl: null }),
      ],
    });
    const block = $('my-community');
    expect(block.hidden).toBe(false);
    const cards = block.querySelectorAll('.trail-card');
    expect(cards).toHaveLength(2);
    const hidden = [...cards].find((c) => c.getAttribute('href')!.includes('c_2'))!;
    expect(hidden.querySelector('.community-badge')!.textContent).toBe('Hidden');
    expect(hidden.textContent).toContain('Hidden after reports from other users');
    expect(hidden.innerHTML).toContain('Taken &lt;down&gt;');
    // The empty-imports invitation stays alongside.
    expect($('no-my-trails').hidden).toBe(false);

    const search = $('trail-search') as HTMLInputElement;
    search.value = 'taken';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(block.querySelectorAll('.trail-card')).toHaveLength(1);
    expect($('my-trails-section').hidden).toBe(false);
    expect($('no-match').hidden).toBe(true);

    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(block.hidden).toBe(true);
    expect($('my-trails-section').hidden).toBe(true);
  });

  it('keeps the other tiers when the my-routes fetch fails', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => [route({ name: 'Live one' })],
      fetchImported: async () => imports,
      fetchMyRoutes: async () => {
        throw new Error('offline');
      },
    });
    expect($('trail-list').querySelectorAll('.trail-card')).toHaveLength(5);
    expect($('community-list').querySelectorAll('.trail-card')).toHaveLength(1);
    expect($('community-note').hidden).toBe(true);
    expect($('my-trail-list').querySelectorAll('.trail-card')).toHaveLength(2);
    expect($('my-community').hidden).toBe(false);
    expect($('my-community-note').textContent).toBe('Your shared routes could not be loaded.');
    expect($('my-community-link').hidden).toBe(true);
  });

  it('gives up on a stalled my-routes list at the deadline', async () => {
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => [],
      fetchImported: async () => [],
      fetchMyRoutes: () => new Promise(() => {}),
      communityTimeoutMs: 20,
    });
    expect($('my-community-note').textContent).toBe('Your shared routes could not be loaded.');
    expect($('community-note').textContent).toBe('No community routes yet.');
  });

  it('says a revoked link is unlinked and offers to link again, then lists the routes', async () => {
    let calls = 0;
    let onLinked: ((s: { userId: string; token: string; displayName: string; expiresAt: null }) => void) | undefined;
    await initLandingPage(document, {
      storage: memoryStorage(),
      fetchCurated: async () => curated,
      fetchCommunity: async () => [],
      fetchImported: async () => [],
      fetchMyRoutes: async () => {
        calls++;
        if (calls === 1) throw new ApiError(401, 'unauthorized', 'Unauthorized');
        return [mine({ id: 'c_9', name: 'Back again' })];
      },
      renderLinkForm: (container, _intro, linked) => {
        container.innerHTML = '<form class="community-link-form"></form>';
        onLinked = linked;
      },
    });
    expect($('my-community').hidden).toBe(false);
    expect($('my-community-note').textContent).toContain('no longer linked');
    expect($('my-community-link').hidden).toBe(false);

    $('my-community-link-btn').click();
    expect($('my-community-link-form').hidden).toBe(false);
    expect($('my-community-link-form').querySelector('form')).not.toBeNull();

    onLinked!({ userId: 'u1', token: 't', displayName: 'R', expiresAt: null });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect($('my-community-link-form').hidden).toBe(true);
    expect($('my-community-note').hidden).toBe(true);
    expect($('my-community-list').textContent).toContain('Back again');
  });

  describe('the default my-routes source', () => {
    const SESSION = { userId: 'u1', token: 'tok_mine', displayName: 'Robin', expiresAt: null };
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      window.localStorage.clear();
    });

    function stubMine(status: number, body: unknown): Array<{ url: string; init: RequestInit }> {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
          calls.push({ url, init });
          return { ok: status < 300, status, statusText: '', text: async () => JSON.stringify(body) };
        })
      );
      return calls;
    }

    const boot = () =>
      initLandingPage(document, {
        storage: memoryStorage(),
        fetchCurated: async () => curated,
        fetchCommunity: async () => [],
        fetchImported: async () => [],
      });

    it('asks nothing of the API for an unlinked browser', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
      const calls = stubMine(200, { routes: [] });
      await boot();
      expect(calls).toHaveLength(0);
      expect($('my-community').hidden).toBe(true);
    });

    it('lists a linked browser’s routes with its token', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
      window.localStorage.setItem('tracknotes.webSession', JSON.stringify(SESSION));
      const calls = stubMine(200, { routes: [mine({ id: 'c_1', name: 'Mine', status: 'hidden', hiddenReason: 'admin' })] });
      await boot();
      expect(calls[0].url).toBe('https://api.example.test/v1/me/community/routes');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok_mine');
      expect($('my-community').hidden).toBe(false);
      expect($('my-community-list').textContent).toContain('Hidden by a moderator');
    });

    it('forgets a revoked token and says so', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
      window.localStorage.setItem('tracknotes.webSession', JSON.stringify(SESSION));
      stubMine(401, { error: { code: 'unauthorized', message: 'Unauthorized' } });
      await boot();
      expect(window.localStorage.getItem('tracknotes.webSession')).toBeNull();
      expect($('my-community-note').textContent).toContain('no longer linked');
    });
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
