/**
 * Resupply distance calculator for the web trip planner.
 *
 * Identifies resupply points (towns, stores) along a trail and calculates
 * distances between them.
 *
 * Ported from mobile/src/services/resupply-calculator.ts.
 */

import type { PlanWaypoint, ResupplyGap } from './plan-types';

export interface ResupplyPoint {
  name: string;
  km: number;
  type: string;
}

export interface ResupplyAnalysis {
  points: ResupplyPoint[];
  gaps: ResupplyGap[];
  longestGapKm: number;
  longestGapDays: number;
  hasResupplyData: boolean;
}

const RESUPPLY_TYPES = new Set(['town', 'food']);

/** Default daily hiking distance for estimating days between resupply */
export const DEFAULT_DAILY_KM = 20;

/** Default threshold for a "long" resupply gap in days */
export const DEFAULT_LONG_THRESHOLD_DAYS = 5;

/**
 * Extract resupply points from trail waypoints, sorted by km.
 */
export function extractResupplyPoints(waypoints: PlanWaypoint[]): ResupplyPoint[] {
  return waypoints
    .filter(wp => wp.type && RESUPPLY_TYPES.has(wp.type))
    .map(wp => ({
      name: wp.name ?? 'Resupply',
      km: wp.totalDistance ?? 0,
      type: wp.type ?? 'food',
    }))
    .sort((a, b) => a.km - b.km);
}

/**
 * Compute gaps between consecutive resupply points, including trail start/end.
 */
export function computeResupplyGaps(
  points: ResupplyPoint[],
  trailStartKm: number,
  trailEndKm: number,
  dailyKm: number = DEFAULT_DAILY_KM,
  longThresholdDays: number = DEFAULT_LONG_THRESHOLD_DAYS,
): ResupplyGap[] {
  if (points.length === 0) return [];

  const gaps: ResupplyGap[] = [];

  // Gap from trail start to first resupply
  const firstDist = points[0].km - trailStartKm;
  if (firstDist > 0) {
    const days = Math.ceil(firstDist / dailyKm);
    gaps.push({
      fromName: 'Trail Start',
      toName: points[0].name,
      fromKm: trailStartKm,
      toKm: points[0].km,
      distanceKm: Math.round(firstDist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  // Gaps between consecutive resupply points
  for (let i = 0; i < points.length - 1; i++) {
    const dist = points[i + 1].km - points[i].km;
    const days = Math.ceil(dist / dailyKm);
    gaps.push({
      fromName: points[i].name,
      toName: points[i + 1].name,
      fromKm: points[i].km,
      toKm: points[i + 1].km,
      distanceKm: Math.round(dist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  // Gap from last resupply to trail end
  const lastDist = trailEndKm - points[points.length - 1].km;
  if (lastDist > 0) {
    const days = Math.ceil(lastDist / dailyKm);
    gaps.push({
      fromName: points[points.length - 1].name,
      toName: 'Trail End',
      fromKm: points[points.length - 1].km,
      toKm: trailEndKm,
      distanceKm: Math.round(lastDist * 10) / 10,
      estimatedDays: days,
      isLong: days > longThresholdDays,
    });
  }

  return gaps;
}

/**
 * Full resupply analysis for a trail.
 */
export function analyzeResupply(
  waypoints: PlanWaypoint[],
  totalDistanceKm: number,
  dailyKm: number = DEFAULT_DAILY_KM,
): ResupplyAnalysis {
  const points = extractResupplyPoints(waypoints);
  const hasResupplyData = points.length > 0;

  if (!hasResupplyData) {
    return { points: [], gaps: [], longestGapKm: 0, longestGapDays: 0, hasResupplyData: false };
  }

  const gaps = computeResupplyGaps(points, 0, totalDistanceKm, dailyKm);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const longestGapDays = gaps.reduce((max, g) => Math.max(max, g.estimatedDays), 0);

  return { points, gaps, longestGapKm, longestGapDays, hasResupplyData };
}
