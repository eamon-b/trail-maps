/**
 * Community routes as a trail source — the pure half (no I/O).
 *
 * A community route is a hiker's import shared through the comments-api worker
 * (`plans/community-routes.md`). The app lists the public ones from
 * `GET /v1/community/routes`, keeps the last list on disk so My Guides shows it
 * offline, and downloads a route's `ProcessedTrail` JSON from its `trailUrl`
 * the first time it is opened (`community-routes.ts` does that I/O, mirroring
 * `trail-data-updates.ts` for catalog-only trails). What a fresh list means
 * for the downloads is {@link planCommunitySync}: absence from a list is never
 * evidence that a route was taken down — only its own detail's 404 is
 * ({@link classifyCommunityProbe}).
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
  /**
   * True once the server has said, positively, that the route is no longer
   * shared (its detail answered 404, or a status the public list does not
   * carry). The file is KEPT: the hiker may be walking it, with a plan and
   * favourites on it. A list that names the route again clears the flag.
   */
  takenDown?: boolean;
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
  return { summary, file: r.file, ...(r.takenDown === true ? { takenDown: true } : {}) };
}

/** A community route as My Guides lists it. */
export type CommunityRouteListing = CommunityRouteSummary & {
  downloaded: boolean;
  /** Downloaded, and the server has said it is no longer shared. */
  takenDown: boolean;
};

/**
 * The routes My Guides lists: the last fetched list, plus every downloaded
 * route it does not name — one opened from a link before the list was
 * fetched, one a truncated or stale list left out, and one the server has
 * since taken down (`takenDown`, kept on the phone until the hiker removes
 * it). A downloaded route reports the list's current name and status when the
 * list still has it.
 */
export function mergeCommunityRoutes(
  list: readonly CommunityRouteSummary[] | null,
  installed: Readonly<Record<string, InstalledCommunityRoute>>,
): CommunityRouteListing[] {
  const out: CommunityRouteListing[] = [];
  const seen = new Set<string>();
  for (const route of list ?? []) {
    seen.add(route.id);
    out.push({ ...route, downloaded: !!installed[route.id], takenDown: false });
  }
  for (const [id, copy] of Object.entries(installed)) {
    if (seen.has(id)) continue;
    out.push({ ...copy.summary, downloaded: true, takenDown: copy.takenDown === true });
  }
  return out;
}

/** At most this many unlisted downloads are asked about per refresh. */
export const MAX_COMMUNITY_PROBES = 20;

export interface CommunitySyncPlan {
  /** The downloads, with `takenDown` cleared on every route the list names. */
  installed: Record<string, InstalledCommunityRoute>;
  /**
   * Downloaded routes the list does not name, to ask the server about one by
   * one (at most {@link MAX_COMMUNITY_PROBES}; never-flagged ones first). Absence
   * from a list is NOT evidence: the list can be truncated, partly unreadable,
   * briefly empty or a cached copy, so nothing is deleted or flagged on it.
   */
  probe: string[];
  /** Listed routes whose downloaded copy is older than the list's (md5 differs). */
  stale: CommunityRouteSummary[];
}

/**
 * What a fresh, successfully fetched list means for the downloaded routes.
 * Pure: the caller does the probing and downloading.
 */
export function planCommunitySync(
  list: readonly CommunityRouteSummary[],
  installed: Readonly<Record<string, InstalledCommunityRoute>>,
): CommunitySyncPlan {
  const listed = new Map(list.map((r) => [r.id, r]));
  const next: Record<string, InstalledCommunityRoute> = {};
  const unflagged: string[] = [];
  const flagged: string[] = [];
  const stale: CommunityRouteSummary[] = [];
  for (const [id, entry] of Object.entries(installed)) {
    const row = listed.get(id);
    if (row) {
      next[id] = { summary: entry.summary, file: entry.file };
      if (row.md5 !== entry.summary.md5) stale.push(row);
    } else {
      next[id] = entry;
      (entry.takenDown ? flagged : unflagged).push(id);
    }
  }
  return {
    installed: next,
    probe: [...unflagged, ...flagged].slice(0, MAX_COMMUNITY_PROBES),
    stale,
  };
}

/** What asking the server about one route found. */
export type CommunityProbe =
  /** Shared and downloadable: the parsed summary. */
  | { kind: 'live'; summary: CommunityRouteSummary }
  /** Positively not shared: a 404, or a status the public list does not carry. */
  | { kind: 'gone' }
  /** No answer worth acting on (offline, 5xx, an unreadable body). */
  | { kind: 'unknown' };

/**
 * Classify the detail endpoint's answer. `status` is the HTTP status of a
 * failed request (undefined for a transport failure); `detail` the body of a
 * successful one.
 */
export function classifyCommunityProbe(
  outcome: { ok: true; detail: unknown } | { ok: false; status?: number },
): CommunityProbe {
  if (!outcome.ok) {
    return outcome.status === 404 || outcome.status === 410 ? { kind: 'gone' } : { kind: 'unknown' };
  }
  const detail = outcome.detail;
  if (!detail || typeof detail !== 'object') return { kind: 'unknown' };
  const status = (detail as { status?: unknown }).status;
  if (typeof status === 'string' && !LISTED_STATUSES.includes(status as CommunityRouteStatus)) {
    return { kind: 'gone' };
  }
  const summary = parseCommunitySummary(detail);
  return summary ? { kind: 'live', summary } : { kind: 'unknown' };
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
