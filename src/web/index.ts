/**
 * The landing page (index.html): every trail the site knows, in three tiers,
 * under one filter bar.
 *
 * 1. Curated trails (`data/generated/index.json`), with a Featured row for any
 *    marked `featured`, then grouped Country → State by `@lib/trail-regions`.
 * 2. Community routes, from the API when this build has one
 *    (`VITE_API_BASE_URL`), grouped the same way with a Verified/Unverified
 *    badge. Hidden entirely when there is no API.
 * 3. My trails: imports kept in this browser's IndexedDB.
 *
 * The search, length bands and sort apply to all three. Empty groups and
 * tiers disappear; when nothing matches at all the page says so. The filter
 * is remembered per browser in `localStorage` (a convenience: the page works
 * the same when storage is unavailable).
 *
 * Rendering is pure (`render*` functions return HTML strings, tested in
 * index.test.ts); `initLandingPage` wires it to the DOM. Every string that
 * reaches `innerHTML` goes through `escapeHtml` — community and imported
 * names are user-supplied.
 */

import type { CommunityRouteStatus, CommunityRouteSummary } from '@lib/community-types';
import {
  LENGTH_BANDS,
  countryName,
  groupTrails,
  matchesFilter,
  sortTrails,
  stateName,
  type GroupableTrail,
  type LengthBand,
  type TrailFilter,
  type TrailGroupCountry,
  type TrailSort,
} from '@lib/trail-regions';
import { communityRouteHref, listCommunityRoutes } from './api/community';
import { isIndexedDbAvailable, listTrailSummaries, type ImportedTrailSummary } from './imported-trails-db';
import { escapeHtml, formatKm } from './web-utils';

/** One entry of `data/generated/index.json` (written by scripts/build-trails.ts). */
export interface CuratedTrailEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  region?: string;
  country?: string | null;
  states?: string[];
  featured?: boolean;
}

export interface ListFilterState {
  query: string;
  bands: LengthBand[];
  sort: TrailSort;
}

export const DEFAULT_FILTER: ListFilterState = { query: '', bands: [], sort: 'name' };

export const FILTER_STORAGE_KEY = 'trail-maps-list-filter';

const SORTS: { id: TrailSort; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'length', label: 'Shortest first' },
  { id: 'length-desc', label: 'Longest first' },
];

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

/** Read a stored filter back, dropping anything unusable. Never throws. */
export function parseFilterState(raw: string | null | undefined): ListFilterState {
  if (!raw) return { ...DEFAULT_FILTER, bands: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof ListFilterState, unknown>>;
    const query = typeof parsed.query === 'string' ? parsed.query.slice(0, 200) : '';
    const bandIds = new Set<string>(LENGTH_BANDS.map((b) => b.id));
    const bands = Array.isArray(parsed.bands)
      ? LENGTH_BANDS.map((b) => b.id).filter((id) => (parsed.bands as unknown[]).includes(id) && bandIds.has(id))
      : [];
    const sort = SORTS.some((s) => s.id === parsed.sort) ? (parsed.sort as TrailSort) : 'name';
    return { query, bands, sort };
  } catch {
    return { ...DEFAULT_FILTER, bands: [] };
  }
}

export function loadFilterState(storage: Pick<Storage, 'getItem'> | null): ListFilterState {
  try {
    return parseFilterState(storage?.getItem(FILTER_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_FILTER, bands: [] };
  }
}

export function saveFilterState(storage: Pick<Storage, 'setItem'> | null, state: ListFilterState): void {
  try {
    storage?.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled or full: the filter just is not remembered.
  }
}

export function isFilterActive(state: ListFilterState): boolean {
  return state.query.trim() !== '' || state.bands.length > 0;
}

function toTrailFilter(state: ListFilterState): TrailFilter {
  return { query: state.query, bands: state.bands };
}

// ---------------------------------------------------------------------------
// Shapes the grouping works on
// ---------------------------------------------------------------------------

interface CommunityItem extends GroupableTrail {
  route: CommunityRouteSummary;
}

interface ImportedItem extends GroupableTrail {
  summary: ImportedTrailSummary;
}

export function filterCurated(trails: readonly CuratedTrailEntry[], state: ListFilterState): CuratedTrailEntry[] {
  const filter = toTrailFilter(state);
  return trails.filter((t) => matchesFilter(t, filter, `${t.shortName ?? ''} ${t.region ?? ''}`));
}

export function filterCommunity(
  routes: readonly CommunityRouteSummary[],
  state: ListFilterState
): CommunityItem[] {
  const filter = toTrailFilter(state);
  return routes
    .map((route) => ({
      name: route.name,
      lengthKm: route.lengthKm,
      country: route.country,
      states: route.state ? [route.state] : [],
      route,
    }))
    .filter((item) => matchesFilter(item, filter, item.route.submittedBy ?? ''));
}

export function filterImported(
  summaries: readonly ImportedTrailSummary[],
  state: ListFilterState
): ImportedItem[] {
  const filter = toTrailFilter(state);
  const items = summaries
    .map((summary) => ({ name: summary.name, lengthKm: summary.lengthKm, summary }))
    // An import has no country: search its name only, not the "Other" label.
    .filter((item) => matchesFilter(item, { bands: filter.bands }) && nameMatches(item.name, filter.query));
  return sortTrails(items, state.sort);
}

function nameMatches(name: string, query: string | undefined): boolean {
  const q = query?.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** "688.3 km", "426 km". */
export function lengthText(km: number): string {
  if (!Number.isFinite(km)) return '— km';
  return `${Number(km.toFixed(1)).toString()} km`;
}

/** "Victoria, New South Wales, ACT" for a trail; the country when it has no states. */
export function placeText(country: string | null | undefined, states: readonly string[] | null | undefined, withCountry = false): string {
  const names = (states ?? []).map((s) => stateName(country, s) ?? s);
  if (names.length === 0) return country ? countryName(country) : '';
  return withCountry && country ? `${names.join(', ')}, ${countryName(country)}` : names.join(', ');
}

export function renderCuratedCard(trail: CuratedTrailEntry, withCountry = false): string {
  const place = placeText(trail.country, trail.states, withCountry);
  return `
    <a href="./trails/${encodeURIComponent(trail.id)}/" class="trail-card list-card">
      <span class="list-card-title">${escapeHtml(trail.name)}</span>
      <span class="trail-meta">
        <span class="trail-length">${escapeHtml(lengthText(trail.lengthKm))}</span>
        ${place ? `<span class="trail-place">${escapeHtml(place)}</span>` : ''}
      </span>
    </a>`;
}

const STATUS_BADGES: Partial<Record<CommunityRouteStatus, { label: string; title: string }>> = {
  verified: { label: 'Verified', title: 'Checked and approved by a Tracknotes admin.' },
  unverified: {
    label: 'Unverified',
    title: 'Shared by a hiker and passed automatic checks; not yet checked by a person.',
  },
};

export function renderCommunityCard(route: CommunityRouteSummary): string {
  const badge = STATUS_BADGES[route.status] ?? STATUS_BADGES.unverified!;
  const place = placeText(route.country, route.state ? [route.state] : []);
  const statusClass = route.status === 'verified' ? 'verified' : 'unverified';
  return `
    <a href="./${escapeHtml(communityRouteHref(route.id))}" class="trail-card list-card">
      <span class="list-card-title">${escapeHtml(route.name)}<span class="list-badge list-badge-${statusClass}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.label)}</span></span>
      <span class="trail-meta">
        <span class="trail-length">${escapeHtml(lengthText(route.lengthKm))}</span>
        ${place ? `<span class="trail-place">${escapeHtml(place)}</span>` : ''}
        ${route.submittedBy ? `<span class="trail-by">by ${escapeHtml(route.submittedBy)}</span>` : ''}
      </span>
    </a>`;
}

export function renderImportedCard(trail: ImportedTrailSummary): string {
  return `
    <a href="./my-trail.html?id=${encodeURIComponent(trail.id)}" class="trail-card list-card">
      <span class="list-card-title">${escapeHtml(trail.name)}<span class="imported-badge">Imported</span></span>
      <span class="trail-meta">
        <span class="trail-length">${escapeHtml(formatKm(trail.lengthKm))} km</span>
        <span class="trail-added">Added ${escapeHtml(new Date(trail.createdAt).toLocaleDateString())}</span>
      </span>
    </a>`;
}

/** The key a country's `<details>` is remembered by while the page is open. */
export function groupKey(tier: string, country: string): string {
  return `${tier}:${country}`;
}

/**
 * Country → state groups as collapsible sections. `collapsed` holds the keys
 * (`groupKey`) the reader has closed, so a re-render keeps them closed.
 */
export function renderGroups<T>(
  groups: readonly TrailGroupCountry<T>[],
  card: (trail: T) => string,
  tier: string,
  collapsed: ReadonlySet<string> = new Set()
): string {
  return groups
    .map((country) => {
      const key = groupKey(tier, country.code);
      const showStateHeadings = country.states.some((s) => s.code !== null);
      const states = country.states
        .map((state) => {
          const heading =
            showStateHeadings && state.name
              ? `<h4 class="state-heading">${escapeHtml(state.name)}</h4>`
              : showStateHeadings
                ? `<h4 class="state-heading">Elsewhere in ${escapeHtml(country.name)}</h4>`
                : '';
          return `${heading}<div class="trail-grid list-grid">${state.trails.map(card).join('')}</div>`;
        })
        .join('');
      return `
      <details class="country-group" data-group="${escapeHtml(key)}"${collapsed.has(key) ? '' : ' open'}>
        <summary><h3 class="country-heading">${escapeHtml(country.name)} <span class="group-count">${country.count}</span></h3></summary>
        <div class="country-body">${states}</div>
      </details>`;
    })
    .join('');
}

export function renderFeatured(trails: readonly CuratedTrailEntry[], state: ListFilterState): string {
  const featured = sortTrails(
    filterCurated(
      trails.filter((t) => t.featured === true),
      state
    ),
    state.sort
  );
  return featured.map((t) => renderCuratedCard(t, true)).join('');
}

export function renderCurated(
  trails: readonly CuratedTrailEntry[],
  state: ListFilterState,
  collapsed?: ReadonlySet<string>
): { html: string; count: number } {
  const matched = filterCurated(trails, state);
  return {
    html: renderGroups(groupTrails(matched, state.sort), (t) => renderCuratedCard(t), 'curated', collapsed),
    count: matched.length,
  };
}

export function renderCommunity(
  routes: readonly CommunityRouteSummary[],
  state: ListFilterState,
  collapsed?: ReadonlySet<string>
): { html: string; count: number } {
  const matched = filterCommunity(routes, state);
  return {
    html: renderGroups(
      groupTrails(matched, state.sort),
      (item) => renderCommunityCard(item.route),
      'community',
      collapsed
    ),
    count: matched.length,
  };
}

export function renderImported(
  summaries: readonly ImportedTrailSummary[],
  state: ListFilterState
): { html: string; count: number } {
  const matched = filterImported(summaries, state);
  return { html: matched.map((item) => renderImportedCard(item.summary)).join(''), count: matched.length };
}

export function renderFilterBar(state: ListFilterState): string {
  const chips = LENGTH_BANDS.map((band) => {
    const on = state.bands.includes(band.id);
    return `<button type="button" class="filter-chip" data-band="${escapeHtml(band.id)}" aria-pressed="${on}">${escapeHtml(band.label)}</button>`;
  }).join('');
  const options = SORTS.map(
    (s) => `<option value="${escapeHtml(s.id)}"${s.id === state.sort ? ' selected' : ''}>${escapeHtml(s.label)}</option>`
  ).join('');
  return `
    <div class="filter-search">
      <label class="visually-hidden" for="trail-search">Search trails</label>
      <input type="search" id="trail-search" placeholder="Search by name, country or state" autocomplete="off" value="${escapeHtml(state.query)}">
    </div>
    <div class="filter-row">
      <div class="filter-chips" role="group" aria-label="Length">${chips}</div>
      <label class="filter-sort">Sort
        <select id="trail-sort">${options}</select>
      </label>
    </div>`;
}

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

export interface LandingDeps {
  fetchCurated?: () => Promise<CuratedTrailEntry[]>;
  fetchCommunity?: () => Promise<CommunityRouteSummary[] | null>;
  fetchImported?: () => Promise<ImportedTrailSummary[]>;
  storage?: Storage | null;
}

async function fetchCuratedDefault(): Promise<CuratedTrailEntry[]> {
  const response = await fetch('./data/generated/index.json');
  if (!response.ok) throw new Error('Trail index not found');
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as CuratedTrailEntry[]) : [];
}

async function fetchImportedDefault(): Promise<ImportedTrailSummary[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    return await listTrailSummaries();
  } catch {
    // Storage locked down: show the empty state.
    return [];
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function byId<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function setHidden(el: HTMLElement | null, hidden: boolean): void {
  if (!el) return;
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

/** Boot the landing page against `doc`. Resolves once every tier has loaded. */
export async function initLandingPage(doc: Document = document, deps: LandingDeps = {}): Promise<void> {
  const storage = deps.storage === undefined ? localStorageOrNull() : deps.storage;
  let state = loadFilterState(storage);
  const collapsed = new Set<string>();

  let curated: Load<CuratedTrailEntry[]> = { status: 'loading' };
  // null data = no API configured: the tier is not shown at all.
  let community: Load<CommunityRouteSummary[] | null> = { status: 'loading' };
  let imported: Load<ImportedTrailSummary[]> = { status: 'loading' };

  const filterBar = byId(doc, 'trail-filter');
  if (filterBar) filterBar.innerHTML = renderFilterBar(state);

  const render = () => {
    const active = isFilterActive(state);
    let total = 0;
    let settled = true;

    // Featured
    const featuredSection = byId(doc, 'featured-section');
    const featuredList = byId(doc, 'featured-list');
    const featuredHtml = curated.status === 'ready' ? renderFeatured(curated.data, state) : '';
    if (featuredList) featuredList.innerHTML = featuredHtml;
    setHidden(featuredSection, featuredHtml === '');

    // Curated
    const curatedSection = byId(doc, 'curated-section');
    const curatedList = byId(doc, 'trail-list');
    const noTrails = byId(doc, 'no-trails');
    if (curated.status === 'loading') {
      settled = false;
    } else if (curated.status === 'error' || curated.data.length === 0) {
      if (curatedList) curatedList.innerHTML = '';
      setHidden(noTrails, false);
      setHidden(curatedSection, active);
    } else {
      const { html, count } = renderCurated(curated.data, state, collapsed);
      total += count;
      if (curatedList) curatedList.innerHTML = html;
      setHidden(noTrails, true);
      setHidden(curatedSection, count === 0);
    }

    // Community
    const communitySection = byId(doc, 'community-section');
    const communityList = byId(doc, 'community-list');
    const communityNote = byId(doc, 'community-note');
    if (community.status === 'loading') {
      settled = false;
      setHidden(communitySection, true);
    } else if (community.status === 'error') {
      if (communityList) communityList.innerHTML = '';
      if (communityNote) communityNote.textContent = 'Community routes could not be loaded.';
      setHidden(communityNote, false);
      setHidden(communitySection, false);
    } else if (community.data === null) {
      setHidden(communitySection, true);
    } else {
      const { html, count } = renderCommunity(community.data, state, collapsed);
      total += count;
      if (communityList) communityList.innerHTML = html;
      const none = community.data.length === 0;
      if (communityNote) communityNote.textContent = none ? 'No community routes yet.' : '';
      setHidden(communityNote, !none);
      setHidden(communitySection, count === 0 && (active || !none));
    }

    // My trails
    const mySection = byId(doc, 'my-trails-section');
    const myList = byId(doc, 'my-trail-list');
    const myEmpty = byId(doc, 'no-my-trails');
    if (imported.status === 'loading') {
      settled = false;
    } else {
      const data = imported.status === 'ready' ? imported.data : [];
      const { html, count } = renderImported(data, state);
      total += count;
      if (myList) myList.innerHTML = html;
      setHidden(myList, count === 0);
      setHidden(myEmpty, data.length > 0);
      // With a filter on, a tier with nothing to show steps aside; without
      // one, the empty state's "Import a GPX" invitation stays.
      setHidden(mySection, active && count === 0);
    }

    const noMatch = byId(doc, 'no-match');
    setHidden(noMatch, !(settled && active && total === 0));
  };

  const update = (next: ListFilterState) => {
    state = next;
    saveFilterState(storage, state);
    render();
  };

  filterBar?.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'trail-search') update({ ...state, query: (target as HTMLInputElement).value });
  });
  filterBar?.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'trail-sort') update({ ...state, sort: (target as HTMLSelectElement).value as TrailSort });
  });
  filterBar?.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-band]');
    if (!chip) return;
    const band = chip.dataset.band as LengthBand;
    const bands = state.bands.includes(band) ? state.bands.filter((b) => b !== band) : [...state.bands, band];
    chip.setAttribute('aria-pressed', String(bands.includes(band)));
    update({ ...state, bands: LENGTH_BANDS.map((b) => b.id).filter((id) => bands.includes(id)) });
  });

  byId(doc, 'clear-filter')?.addEventListener('click', () => {
    const next = { ...DEFAULT_FILTER, bands: [], sort: state.sort };
    if (filterBar) filterBar.innerHTML = renderFilterBar(next);
    update(next);
  });

  // `toggle` does not bubble: listen in the capture phase to remember which
  // countries the reader closed, so typing in the search keeps them closed.
  doc.addEventListener(
    'toggle',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLDetailsElement)) return;
      const key = el.dataset.group;
      if (!key) return;
      if (el.open) collapsed.delete(key);
      else collapsed.add(key);
    },
    true
  );

  render();

  const fetchCurated = deps.fetchCurated ?? fetchCuratedDefault;
  const fetchCommunity = deps.fetchCommunity ?? (() => listCommunityRoutes());
  const fetchImported = deps.fetchImported ?? fetchImportedDefault;

  await Promise.all([
    fetchCurated().then(
      (data) => (curated = { status: 'ready', data }),
      () => (curated = { status: 'error' })
    ).then(render),
    fetchCommunity().then(
      (data) => (community = { status: 'ready', data }),
      () => (community = { status: 'error' })
    ).then(render),
    fetchImported().then(
      (data) => (imported = { status: 'ready', data }),
      () => (imported = { status: 'ready', data: [] })
    ).then(render),
  ]);
}

if (typeof document !== 'undefined' && document.getElementById('trail-filter')) {
  void initLandingPage();
}
