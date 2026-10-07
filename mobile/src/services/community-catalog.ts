/**
 * Community routes as a trail source — the pure half (no I/O).
 *
 * A community route is a hiker's import shared through the comments-api worker
 * (`plans/community-routes.md`). The app lists the public ones from
 * `GET /v1/community/routes`, keeps the last list on disk so My Guides shows it
 * offline, and downloads a route's `ProcessedTrail` JSON from its `trailUrl`
 * the first time it is opened (`community-routes.ts` does that I/O, mirroring
 * `trail-data-updates.ts` for catalog-only trails).
 *
 * Everything here validates what came over the wire before it can become a
 * file name, a URL or a list row — the list is written by strangers.
 */

import {
  isCommunityRouteId,
  type CommunityRouteStatus,
  type CommunityRouteSummary,
} from '@lib/community-types';

const MD5 = /^[0-9a-f]{32}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Only http(s) URLs are fetched; anything else (file:, javascript:) is refused. */
export function isFetchableUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

const LISTED_STATUSES: readonly CommunityRouteStatus[] = ['unverified', 'verified'];

/**
 * Validate one list row. Returns null for anything unusable — a bad id (it
 * becomes a file name), a missing md5 (the download is checked against it), a
 * non-http URL, or a status that should not be listed — so one bad row cannot
 * take the others down.
 */
export function parseCommunitySummary(raw: unknown): CommunityRouteSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || !isCommunityRouteId(r.id)) return null;
  if (!isString(r.name) || r.name.trim().length === 0) return null;
  if (!isString(r.status) || !LISTED_STATUSES.includes(r.status as CommunityRouteStatus)) {
    return null;
  }
  if (!isString(r.country) || !/^[A-Za-z]{2}$/.test(r.country)) return null;
  if (!isFiniteNumber(r.lengthKm) || r.lengthKm < 0) return null;
  if (!isFetchableUrl(r.trailUrl)) return null;
  if (!isString(r.md5) || !MD5.test(r.md5)) return null;
  if (!isFiniteNumber(r.bytes) || r.bytes <= 0) return null;

  const bbox =
    Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every(isFiniteNumber)
      ? (r.bbox as [number, number, number, number])
      : ([0, 0, 0, 0] as [number, number, number, number]);
  const start =
    r.start &&
    typeof r.start === 'object' &&
    isFiniteNumber((r.start as { lat?: unknown }).lat) &&
    isFiniteNumber((r.start as { lon?: unknown }).lon)
      ? { lat: (r.start as { lat: number }).lat, lon: (r.start as { lon: number }).lon }
      : { lat: 0, lon: 0 };

  return {
    id: r.id,
    name: r.name.trim(),
    status: r.status as CommunityRouteStatus,
    country: r.country.toUpperCase(),
    state: isString(r.state) && r.state.length > 0 ? r.state : null,
    lengthKm: r.lengthKm,
    ascentM: isFiniteNumber(r.ascentM) ? r.ascentM : 0,
    hasElevation: r.hasElevation === true,
    waypointCount: isFiniteNumber(r.waypointCount) ? r.waypointCount : 0,
    bbox,
    start,
    submittedBy: isString(r.submittedBy) ? r.submittedBy : null,
    createdAt: isString(r.createdAt) ? r.createdAt : '',
    updatedAt: isString(r.updatedAt) ? r.updatedAt : '',
    verifiedAt: isString(r.verifiedAt) ? r.verifiedAt : null,
    reviewed: r.reviewed === true,
    trailUrl: r.trailUrl,
    md5: r.md5,
    bytes: r.bytes,
  };
}

/** Validate a list response (or the cached copy of one). Duplicated ids keep the first. */
export function parseCommunityList(raw: unknown): CommunityRouteSummary[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const routes = (raw as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) return null;
  const seen = new Set<string>();
  const out: CommunityRouteSummary[] = [];
  for (const row of routes) {
    const parsed = parseCommunitySummary(row);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/** A downloaded community route, as recorded in the on-device state file. */
export interface InstalledCommunityRoute {
  /** The summary it was downloaded under (name, status, region at that time). */
  summary: CommunityRouteSummary;
  /** File name under the community directory. */
  file: string;
}

/** `<id>.<md5[0..12]>.json` — content-addressed, like the trail catalog's keys. */
export function communityFileName(id: string, md5: string): string {
  return `${id}.${md5.slice(0, 12)}.json`;
}

export function parseInstalledCommunity(raw: unknown): InstalledCommunityRoute | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = parseCommunitySummary(r.summary);
  if (!summary) return null;
  if (r.file !== communityFileName(summary.id, summary.md5)) return null;
  return { summary, file: r.file };
}

/**
 * The routes My Guides lists: the last fetched list, plus any downloaded route
 * it does not name — one opened from a link before the list was fetched, or
 * listed while no fresh list has said otherwise. A route a fresh list has
 * dropped (hidden, removed) is pruned from the device by
 * {@link pruneInstalledCommunity} when that list arrives, so it does not
 * linger here. A downloaded route reports the list's current name and status
 * when the list still has it.
 */
export function mergeCommunityRoutes(
  list: readonly CommunityRouteSummary[] | null,
  installed: Readonly<Record<string, InstalledCommunityRoute>>,
): (CommunityRouteSummary & { downloaded: boolean })[] {
  const out: (CommunityRouteSummary & { downloaded: boolean })[] = [];
  const seen = new Set<string>();
  for (const route of list ?? []) {
    seen.add(route.id);
    out.push({ ...route, downloaded: !!installed[route.id] });
  }
  for (const [id, copy] of Object.entries(installed)) {
    if (seen.has(id)) continue;
    out.push({ ...copy.summary, downloaded: true });
  }
  return out;
}

/**
 * Apply a fresh, successfully fetched list to the downloaded routes: a route
 * the list no longer has was hidden or removed, so it is dropped from the
 * device rather than kept for offline use — what was taken down is not handed
 * on. Returns what to keep and the files to delete.
 */
export function pruneInstalledCommunity(
  list: readonly CommunityRouteSummary[],
  installed: Readonly<Record<string, InstalledCommunityRoute>>,
): { installed: Record<string, InstalledCommunityRoute>; droppedFiles: string[] } {
  const listed = new Set(list.map((r) => r.id));
  const kept: Record<string, InstalledCommunityRoute> = {};
  const droppedFiles: string[] = [];
  for (const [id, entry] of Object.entries(installed)) {
    if (listed.has(id)) kept[id] = entry;
    else droppedFiles.push(entry.file);
  }
  return { installed: kept, droppedFiles };
}

/**
 * Whether a downloaded file is a trail at all. The server re-checked it on
 * submit and the md5 proves these are the bytes it stored; this is the last
 * guard before the guide screens read it.
 */
export function isUsableCommunityTrail(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as { config?: unknown; waypoints?: unknown; track?: { points?: unknown } };
  return (
    !!t.config &&
    typeof t.config === 'object' &&
    Array.isArray(t.waypoints) &&
    !!t.track &&
    Array.isArray(t.track.points) &&
    t.track.points.length > 0
  );
}
