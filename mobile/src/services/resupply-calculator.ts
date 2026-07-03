/**
 * Resupply distance calculator.
 *
 * Identifies resupply points (towns, stores) along a trail and calculates
 * distances between them. Includes food carry weight estimation.
 */

import type { TrailWaypoint } from '../lib/trail-utils';
import type { ComputedDay } from './plan-calculator-types';

export interface ResupplyPoint {
  name: string;
  km: number;
  type: string;
}

export interface ResupplyGap {
  fromName: string;
  toName: string;
  fromKm: number;
  toKm: number;
  distanceKm: number;
  /** Estimated days between resupply at given pace */
  estimatedDays: number;
  isLong: boolean;
}

export interface FoodCarryEstimate {
  /** Weight in grams */
  weightGrams: number;
  /** Weight in kg (rounded to 1 decimal) */
  weightKg: number;
  /** Number of days of food */
  days: number;
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

/** Default grams of food per day for weight calculations */
export const DEFAULT_GRAMS_PER_DAY = 680;

/**
 * Extract resupply points from trail waypoints, sorted by km.
 */
export function extractResupplyPoints(waypoints: TrailWaypoint[]): ResupplyPoint[] {
  return waypoints
    .filter(wp => RESUPPLY_TYPES.has(wp.type))
    .map(wp => ({
      name: wp.name,
      km: wp.totalDistance ?? 0,
      type: wp.type,
    }))
    .sort((a, b) => a.km - b.km);
}

/**
 * Calculate food carry weight for a given number of days.
 */
export function calculateFoodWeight(
  days: number,
  gramsPerDay: number = DEFAULT_GRAMS_PER_DAY,
): FoodCarryEstimate {
  const weightGrams = Math.round(days * gramsPerDay);
  return {
    weightGrams,
    weightKg: Math.round(weightGrams / 100) / 10,
    days,
  };
}

/**
 * Compute gaps between consecutive resupply points, including trail start/end.
 */
export function computeResupplyGaps(
  points: ResupplyPoint[],
  trailStartKm: number,
  trailEndKm: number,
  dailyKm: number = DEFAULT_DAILY_KM,
  longThresholdDays: number = 5,
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
  waypoints: TrailWaypoint[],
  totalDistanceKm: number,
  dailyKm: number = DEFAULT_DAILY_KM,
): ResupplyAnalysis {
  const points = extractResupplyPoints(waypoints);
  const hasResupplyData = points.length > 0;

  if (!hasResupplyData) {
    return {
      points: [],
      gaps: [],
      longestGapKm: 0,
      longestGapDays: 0,
      hasResupplyData: false,
    };
  }

  const gaps = computeResupplyGaps(points, 0, totalDistanceKm, dailyKm);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const longestGapDays = gaps.reduce((max, g) => Math.max(max, g.estimatedDays), 0);

  return {
    points,
    gaps,
    longestGapKm,
    longestGapDays,
    hasResupplyData,
  };
}

/**
 * Section-scoped resupply analysis. Mirrors analyzeWaterCarryForSection.
 */
export function analyzeResupplyForSection(
  waypoints: TrailWaypoint[],
  startKm: number,
  endKm: number,
  dailyKm: number = DEFAULT_DAILY_KM,
  longThresholdDays: number = 5,
): ResupplyAnalysis {
  const allPoints = extractResupplyPoints(waypoints);
  const sectionPoints = allPoints.filter(p => p.km >= startKm && p.km <= endKm);

  if (sectionPoints.length === 0) {
    return {
      points: [],
      gaps: [],
      longestGapKm: 0,
      longestGapDays: 0,
      hasResupplyData: allPoints.length > 0,
    };
  }

  const gaps = computeResupplyGaps(sectionPoints, startKm, endKm, dailyKm, longThresholdDays);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const longestGapDays = gaps.reduce((max, g) => Math.max(max, g.estimatedDays), 0);

  return {
    points: sectionPoints,
    gaps,
    longestGapKm,
    longestGapDays,
    hasResupplyData: true,
  };
}

/**
 * Correlate resupply points with computed days.
 */
export interface ResupplyDayInfo {
  point: ResupplyPoint;
  arrivalDay: number;
  arrivalDate?: string;
}

export function correlateResupplyWithDays(
  points: ResupplyPoint[],
  days: ComputedDay[],
): ResupplyDayInfo[] {
  return points.map(point => {
    const day = days.find(d => point.km >= d.startKm && point.km <= d.endKm);
    return {
      point,
      arrivalDay: day?.dayNumber ?? 0,
      arrivalDate: day?.date,
    };
  });
}

/**
 * Find the next resupply point from a given position on the trail.
 * Useful for "I need to resupply by day X, which town?" queries.
 */
export function findNextResupply(
  waypoints: TrailWaypoint[],
  currentKm: number,
): ResupplyPoint | null {
  const points = extractResupplyPoints(waypoints);
  return points.find(p => p.km > currentKm) ?? null;
}

/**
 * Get food carry estimate for the gap between two resupply points.
 */
export function foodCarryForGap(
  gap: ResupplyGap,
  gramsPerDay: number = DEFAULT_GRAMS_PER_DAY,
): FoodCarryEstimate {
  return calculateFoodWeight(gap.estimatedDays, gramsPerDay);
}
