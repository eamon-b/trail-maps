/**
 * My Guides as sections — the pure half of `app/index.tsx`'s SectionList
 * (`plans/community-routes.md`, "Trail organisation"):
 *
 * 1. **Hiking now** — the pinned current trail, when it is listed.
 * 2. One section per **country** for the curated trails (bundled and
 *    catalog-only), in `@lib/trail-regions` order, grouped inside by state.
 * 3. **Community** — routes other hikers shared, ordered country → state → name.
 * 4. **Imported** — this phone's own imports, newest first (the order they came in).
 *
 * The search query filters every tier through `matchesFilter`, so a region name
 * ("victoria") finds the trails in it as well as a trail name does.
 */

import {
  countryName,
  groupTrails,
  matchesFilter,
  stateName,
} from '@lib/trail-regions';
import type { TrailSource } from '../../services/trail-loader';

/** What sectioning reads off a list entry (`TrailIndexEntry` fits). */
export interface SectionableTrail {
  id: string;
  name: string;
  shortName?: string;
  lengthKm: number;
  source: TrailSource;
  country?: string;
  states?: string[];
}

export type GuideSectionKind = 'current' | 'country' | 'community' | 'imported';

export interface GuideSection<T> {
  key: string;
  kind: GuideSectionKind;
  title: string;
  data: T[];
}

/** Region names for a card's subtitle. Curated: its states; community: country · state. */
export function regionSubtitle(trail: SectionableTrail): string | null {
  if (trail.source === 'imported') return null;
  const states = (trail.states ?? [])
    .map((s) => stateName(trail.country, s))
    .filter((s): s is string => !!s);
  if (trail.source === 'community') {
    if (!trail.country) return null;
    return [countryName(trail.country), ...states].join(' · ');
  }
  return states.length > 0 ? states.join(', ') : null;
}

function grouped<T extends SectionableTrail>(trails: T[]) {
  return groupTrails(
    trails.map((t) => ({ ...t, country: t.country ?? null, states: t.states ?? null, trail: t })),
  );
}

/**
 * The list's sections, empty ones left out. The current trail appears only in
 * "Hiking now", not again in its own section.
 */
export function buildGuideSections<T extends SectionableTrail>(
  trails: readonly T[],
  currentTrailId: string | null,
  query = '',
): GuideSection<T>[] {
  const visible = trails.filter((t) => matchesFilter(t, { query }, t.shortName ?? ''));
  const current = currentTrailId ? visible.find((t) => t.id === currentTrailId) : undefined;
  const rest = visible.filter((t) => t !== current);

  const sections: GuideSection<T>[] = [];
  if (current) {
    sections.push({ key: 'current', kind: 'current', title: 'Hiking now', data: [current] });
  }

  const curated = rest.filter((t) => t.source === 'bundled' || t.source === 'remote');
  for (const country of grouped(curated)) {
    sections.push({
      key: `country-${country.code}`,
      kind: 'country',
      title: country.name,
      data: country.states.flatMap((s) => s.trails.map((t) => t.trail)),
    });
  }

  const community = rest.filter((t) => t.source === 'community');
  if (community.length > 0) {
    sections.push({
      key: 'community',
      kind: 'community',
      title: 'Community',
      data: grouped(community).flatMap((c) => c.states.flatMap((s) => s.trails.map((t) => t.trail))),
    });
  }

  const imported = rest.filter((t) => t.source === 'imported');
  if (imported.length > 0) {
    sections.push({ key: 'imported', kind: 'imported', title: 'Imported', data: imported });
  }
  return sections;
}
