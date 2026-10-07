/**
 * Countries and states/regions for grouping trails, and the grouping itself.
 * Shared by the web landing page, the app's My Guides list, the community
 * submit forms and the worker's validation. Spec: `plans/community-routes.md`.
 *
 * Codes, not names, go into data (`trail.json` `country`/`states`, community
 * routes' `country`/`state`), so a label can be fixed here without touching
 * any trail.
 */

export interface RegionDef {
  code: string;
  name: string;
}

export interface CountryDef {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  name: string;
  /** Sub-national regions trails are grouped by, in display order. Empty = none. */
  states: RegionDef[];
}

/**
 * Countries with a curated trail, or likely to get a community route soon,
 * in display order (Australia first: most trails are Australian). A country
 * not listed here is still accepted (`isValidCountry` takes any two letters)
 * and is labelled by its code until it is added.
 */
export const COUNTRIES: CountryDef[] = [
  {
    code: 'AU',
    name: 'Australia',
    states: [
      { code: 'NSW', name: 'New South Wales' },
      { code: 'ACT', name: 'Australian Capital Territory' },
      { code: 'VIC', name: 'Victoria' },
      { code: 'TAS', name: 'Tasmania' },
      { code: 'SA', name: 'South Australia' },
      { code: 'WA', name: 'Western Australia' },
      { code: 'NT', name: 'Northern Territory' },
      { code: 'QLD', name: 'Queensland' },
    ],
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    states: [
      { code: 'NI', name: 'North Island' },
      { code: 'SI', name: 'South Island' },
      { code: 'STI', name: 'Stewart Island / Rakiura' },
    ],
  },
  { code: 'JP', name: 'Japan', states: [] },
  { code: 'US', name: 'United States', states: [] },
  { code: 'CA', name: 'Canada', states: [] },
  { code: 'GB', name: 'United Kingdom', states: [] },
  { code: 'IE', name: 'Ireland', states: [] },
  { code: 'FR', name: 'France', states: [] },
  { code: 'ES', name: 'Spain', states: [] },
  { code: 'PT', name: 'Portugal', states: [] },
  { code: 'IT', name: 'Italy', states: [] },
  { code: 'CH', name: 'Switzerland', states: [] },
  { code: 'AT', name: 'Austria', states: [] },
  { code: 'DE', name: 'Germany', states: [] },
  { code: 'NO', name: 'Norway', states: [] },
  { code: 'SE', name: 'Sweden', states: [] },
  { code: 'NP', name: 'Nepal', states: [] },
  { code: 'CL', name: 'Chile', states: [] },
  { code: 'AR', name: 'Argentina', states: [] },
  { code: 'ZA', name: 'South Africa', states: [] },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function findCountry(code: string | null | undefined): CountryDef | undefined {
  return code ? COUNTRY_BY_CODE.get(code.toUpperCase()) : undefined;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return 'Other';
  return findCountry(code)?.name ?? code.toUpperCase();
}

export function stateName(country: string | null | undefined, state: string | null | undefined): string | null {
  if (!state) return null;
  return findCountry(country)?.states.find((s) => s.code === state)?.name ?? state;
}

/** Any two ASCII letters: a listed country, or one we have not labelled yet. */
export function isValidCountry(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z]{2}$/.test(code);
}

/**
 * A state code is valid when the country lists it. A country with no listed
 * states takes none (`null`).
 */
export function isValidState(country: string, state: unknown): boolean {
  const def = findCountry(country);
  if (state === null || state === undefined || state === '') return true;
  if (!def || typeof state !== 'string') return false;
  return def.states.some((s) => s.code === state);
}

/** Length bands for the filter bar. */
export type LengthBand = 'day' | 'multi' | 'long';

export const LENGTH_BANDS: { id: LengthBand; label: string; minKm: number; maxKm: number }[] = [
  { id: 'day', label: 'Day walk (< 30 km)', minKm: 0, maxKm: 30 },
  { id: 'multi', label: 'Multi-day (30-300 km)', minKm: 30, maxKm: 300 },
  { id: 'long', label: 'Long trail (> 300 km)', minKm: 300, maxKm: Infinity },
];

export function lengthBand(lengthKm: number): LengthBand {
  if (lengthKm < 30) return 'day';
  if (lengthKm <= 300) return 'multi';
  return 'long';
}

/** The fields grouping and filtering need; trails and community routes both fit. */
export interface GroupableTrail {
  name: string;
  lengthKm: number;
  country?: string | null;
  /** First entry is the group the trail is listed under. */
  states?: readonly string[] | null;
}

export interface TrailGroupState<T> {
  /** null = the country has no states, or the trail gave none. */
  code: string | null;
  name: string | null;
  trails: T[];
}

export interface TrailGroupCountry<T> {
  code: string;
  name: string;
  count: number;
  states: TrailGroupState<T>[];
}

export type TrailSort = 'name' | 'length' | 'length-desc';

export interface TrailFilter {
  /** Case-insensitive substring of the name (or any extra text the caller supplies). */
  query?: string;
  bands?: readonly LengthBand[];
}

export function matchesFilter(trail: GroupableTrail, filter: TrailFilter, extraText = ''): boolean {
  const q = filter.query?.trim().toLowerCase();
  if (q) {
    const hay = `${trail.name} ${extraText} ${countryName(trail.country)} ${
      trail.states?.map((s) => stateName(trail.country, s) ?? s).join(' ') ?? ''
    }`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filter.bands && filter.bands.length > 0 && !filter.bands.includes(lengthBand(trail.lengthKm))) {
    return false;
  }
  return true;
}

export function sortTrails<T extends GroupableTrail>(trails: readonly T[], sort: TrailSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const copy = [...trails];
  if (sort === 'name') return copy.sort(byName);
  if (sort === 'length') return copy.sort((a, b) => a.lengthKm - b.lengthKm || byName(a, b));
  return copy.sort((a, b) => b.lengthKm - a.lengthKm || byName(a, b));
}

/**
 * Country → state groups, in `COUNTRIES` order (unlisted countries after, by
 * name) and each country's state order, with trails sorted inside a group.
 * A trail with no states sits in a `code: null` group, listed last.
 */
export function groupTrails<T extends GroupableTrail>(
  trails: readonly T[],
  sort: TrailSort = 'name'
): TrailGroupCountry<T>[] {
  const countries = new Map<string, Map<string | null, T[]>>();
  for (const t of trails) {
    const c = (t.country ?? 'XX').toUpperCase();
    const s = t.states?.[0] ?? null;
    let byState = countries.get(c);
    if (!byState) countries.set(c, (byState = new Map()));
    const list = byState.get(s);
    if (list) list.push(t);
    else byState.set(s, [t]);
  }

  // Listed countries in list order, then unlisted ones by name, then "Other"
  // (trails that gave no country) last.
  const order = (code: string) => {
    if (code === 'XX') return COUNTRIES.length + 1;
    const i = COUNTRIES.findIndex((c) => c.code === code);
    return i === -1 ? COUNTRIES.length : i;
  };
  const codes = [...countries.keys()].sort(
    (a, b) => order(a) - order(b) || countryName(a).localeCompare(countryName(b))
  );

  return codes.map((code) => {
    const byState = countries.get(code)!;
    const def = findCountry(code);
    const stateOrder = (s: string | null) => {
      if (s === null) return Number.MAX_SAFE_INTEGER;
      const i = def?.states.findIndex((d) => d.code === s) ?? -1;
      return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
    };
    const states = [...byState.keys()]
      .sort((a, b) => stateOrder(a) - stateOrder(b) || String(a).localeCompare(String(b)))
      .map((s) => ({
        code: s,
        name: stateName(code, s),
        trails: sortTrails(byState.get(s)!, sort),
      }));
    return {
      code,
      name: code === 'XX' ? 'Other' : countryName(code),
      count: states.reduce((n, s) => n + s.trails.length, 0),
      states,
    };
  });
}
