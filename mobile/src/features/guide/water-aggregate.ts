/**
 * Aggregated water status — a freshness-ranked verdict per water waypoint.
 *
 * A water source usually carries several conflicting reports ("flowing" three
 * months ago, "dry" last week). Rather than showing the raw newest row, this
 * module ranks the cached reports client-side: every report inside a 120-day
 * window contributes `exp(-ageDays / 30)` to its status, and the status with the
 * greatest total wins (ties broken by the more recent report). A single recent
 * "dry" therefore outweighs a stack of stale "flowing" without a lone outlier
 * overturning a well-corroborated recent consensus.
 *
 * Everything here is pure and React/DB-free: the rows come from
 * `db/water-status-repo` and the chips come from the list pane / map.
 */

import type { WaterStatus } from '@lib/comments-api-types';
import { waterStatusMeta } from './waypoint-detail';

/** Reports older than this are ignored entirely (a season-old flow tells us nothing). */
export const WATER_WINDOW_DAYS = 120;

/**
 * Exponential decay constant, in days: a report's weight is `exp(-age/30)`, so
 * it halves about every 21 days and is worth ~2% of a fresh report at the
 * 120-day window edge.
 */
export const WATER_DECAY_DAYS = 30;

const DAY_MS = 86_400_000;

/** One cached water report. `observedAt` wins over `createdAt` when present. */
export interface WaterReport {
  waterStatus: WaterStatus;
  observedAt: string | null;
  createdAt: string;
}

/** A water report tagged with the waypoint it belongs to. */
export interface WaypointWaterReport extends WaterReport {
  waypointId: string;
}

/** The ranked verdict for one waypoint. */
export interface WaterAggregate {
  /** Winning status — the one with the greatest summed freshness weight. */
  status: WaterStatus;
  /** Summed weight of the winning status (a rough confidence read-out). */
  weight: number;
  /** ISO time of the most recent report *for the winning status*. */
  latestAt: string;
  /** Age of `latestAt` in days (never negative). */
  ageDays: number;
  /** How many in-window reports carried the winning status. */
  reportCount: number;
}

/**
 * The freshness time of a report in epoch ms: the observation time when the
 * reporter gave one, else the row's creation time. Returns null for an
 * unparseable timestamp so callers can drop the row.
 */
export function reportTimeMs(report: WaterReport): number | null {
  const parsed = Date.parse(report.observedAt ?? report.createdAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** ISO cut-off for the freshness window — the `since` bound for the repo query. */
export function waterWindowStartIso(nowMs: number): string {
  return new Date(nowMs - WATER_WINDOW_DAYS * DAY_MS).toISOString();
}

interface Tally {
  weight: number;
  latestMs: number;
  latestIso: string;
  count: number;
}

/**
 * Rank a single waypoint's reports into one verdict, or null when none of them
 * fall inside the freshness window (or all timestamps are unparseable).
 *
 * A report timestamped in the future (clock skew) is kept but treated as
 * zero-age rather than given a weight above 1.
 */
export function aggregateWaterStatus(
  reports: readonly WaterReport[],
  nowMs: number,
): WaterAggregate | null {
  const tallies = new Map<WaterStatus, Tally>();

  for (const report of reports) {
    if (!report.waterStatus) continue;
    const timeMs = reportTimeMs(report);
    if (timeMs == null) continue;
    const ageDays = (nowMs - timeMs) / DAY_MS;
    if (ageDays > WATER_WINDOW_DAYS) continue;

    const weight = Math.exp(-Math.max(0, ageDays) / WATER_DECAY_DAYS);
    const iso = report.observedAt ?? report.createdAt;
    const existing = tallies.get(report.waterStatus);
    if (!existing) {
      tallies.set(report.waterStatus, {
        weight,
        latestMs: timeMs,
        latestIso: iso,
        count: 1,
      });
      continue;
    }
    existing.weight += weight;
    existing.count += 1;
    if (timeMs > existing.latestMs) {
      existing.latestMs = timeMs;
      existing.latestIso = iso;
    }
  }

  let winner: { status: WaterStatus; tally: Tally } | null = null;
  for (const [status, tally] of tallies) {
    if (winner == null) {
      winner = { status, tally };
      continue;
    }
    const diff = tally.weight - winner.tally.weight;
    // Float sums rarely tie exactly, so treat a hair's difference as a tie and
    // let recency decide — that keeps the verdict stable and explainable.
    const tied = Math.abs(diff) < 1e-9;
    if (diff > 0 || (tied && tally.latestMs > winner.tally.latestMs)) {
      winner = { status, tally };
    }
  }
  if (winner == null) return null;

  return {
    status: winner.status,
    weight: winner.tally.weight,
    latestAt: winner.tally.latestIso,
    ageDays: Math.max(0, (nowMs - winner.tally.latestMs) / DAY_MS),
    reportCount: winner.tally.count,
  };
}

/**
 * Rank every waypoint's reports in one pass. Waypoints whose reports all fall
 * outside the window are simply absent from the map (no chip is shown).
 */
export function buildWaterStatusMap(
  reports: readonly WaypointWaterReport[],
  nowMs: number,
): Map<string, WaterAggregate> {
  const byWaypoint = new Map<string, WaypointWaterReport[]>();
  for (const report of reports) {
    const list = byWaypoint.get(report.waypointId);
    if (list) list.push(report);
    else byWaypoint.set(report.waypointId, [report]);
  }

  const result = new Map<string, WaterAggregate>();
  for (const [waypointId, list] of byWaypoint) {
    const aggregate = aggregateWaterStatus(list, nowMs);
    if (aggregate) result.set(waypointId, aggregate);
  }
  return result;
}

interface AgeParts {
  /** null for "today" (under a day old). */
  count: number | null;
  unit: 'day' | 'week' | 'month';
}

function ageParts(ageDays: number): AgeParts {
  const days = Math.max(0, Math.floor(ageDays));
  if (days < 1) return { count: null, unit: 'day' };
  if (days < 7) return { count: days, unit: 'day' };
  if (days < 30) return { count: Math.floor(days / 7), unit: 'week' };
  return { count: Math.max(1, Math.floor(days / 30)), unit: 'month' };
}

const COMPACT_UNIT: Record<AgeParts['unit'], string> = {
  day: 'd',
  week: 'w',
  month: 'mo',
};

/**
 * Compact age for the chip: "today", "3d", "2w", "4mo". The waypoint detail
 * screen's `relativeDate` is deliberately not reused — it switches to absolute
 * dates past a week, which is too wide for an inline chip and hides how stale
 * the report is.
 */
export function formatWaterAge(ageDays: number): string {
  const { count, unit } = ageParts(ageDays);
  return count == null ? 'today' : `${count}${COMPACT_UNIT[unit]}`;
}

/** The chip's text: "Flowing · 3d". */
export function formatWaterStatusChip(aggregate: WaterAggregate): string {
  return `${waterStatusMeta(aggregate.status).label} · ${formatWaterAge(aggregate.ageDays)}`;
}

/** Screen-reader label: "Water status: Flowing, reported 3 days ago". */
export function waterStatusAccessibilityLabel(aggregate: WaterAggregate): string {
  const label = waterStatusMeta(aggregate.status).label;
  const { count, unit } = ageParts(aggregate.ageDays);
  if (count == null) return `Water status: ${label}, reported today`;
  const plural = count === 1 ? unit : `${unit}s`;
  return `Water status: ${label}, reported ${count} ${plural} ago`;
}
