/**
 * Water carry distance calculator.
 *
 * Analyzes water source spacing along a trail to identify dry stretches
 * and help hikers plan water carries. Safety-critical for Australian trails.
 *
 * Shared between the web planner and the mobile app.
 */

import type { PlanWaypoint, WaterGap } from './plan-types';

export type { WaterGap };

export interface WaterSource {
  name: string;
  km: number;
  type: string;
  seasonalNote?: string;
}

export interface WaterCarryAnalysis {
  sources: WaterSource[];
  gaps: WaterGap[];
  longestGapKm: number;
  dryStretchCount: number;
  hasWaterData: boolean;
}

const WATER_TYPES = new Set(['water', 'water-tank']);

/** Default threshold for a "dry stretch" warning in km */
export const DEFAULT_DRY_STRETCH_KM = 15;

const SEASONAL_KEYWORDS = ['seasonal', 'dry in summer', 'dries up', 'unreliable', 'not reliable', 'intermittent', 'may be dry', 'often dry'];

/**
 * Extract water sources from trail waypoints, sorted by km.
 */
export function extractWaterSources(waypoints: PlanWaypoint[]): WaterSource[] {
  return waypoints
    .filter(wp => wp.type && WATER_TYPES.has(wp.type))
    .map(wp => {
      let seasonalNote: string | undefined;
      if (wp.description) {
        const lower = wp.description.toLowerCase();
        if (SEASONAL_KEYWORDS.some(kw => lower.includes(kw))) {
          seasonalNote = wp.description;
        }
      }
      return {
        name: wp.name ?? 'Water',
        km: wp.totalDistance ?? 0,
        type: wp.type ?? 'water',
        seasonalNote,
      };
    })
    .sort((a, b) => a.km - b.km);
}

/**
 * Compute gaps between consecutive water sources, including trail start/end.
 */
export function computeWaterGaps(
  sources: WaterSource[],
  trailStartKm: number,
  trailEndKm: number,
  dryStretchThreshold: number = DEFAULT_DRY_STRETCH_KM,
): WaterGap[] {
  if (sources.length === 0) return [];

  const effectiveThreshold = Math.max(0, dryStretchThreshold);
  const gaps: WaterGap[] = [];

  // Deduplicate sources at the same km position
  const deduped = sources.filter(
    (s, i) => i === 0 || s.km !== sources[i - 1].km,
  );

  // Gap from trail start to first source
  const firstDist = deduped[0].km - trailStartKm;
  if (firstDist > 0) {
    gaps.push({
      fromName: 'Trail Start',
      toName: deduped[0].name,
      fromKm: trailStartKm,
      toKm: deduped[0].km,
      distanceKm: Math.round(firstDist * 10) / 10,
      isDryStretch: firstDist >= effectiveThreshold,
    });
  }

  // Gaps between consecutive sources
  for (let i = 0; i < deduped.length - 1; i++) {
    const dist = deduped[i + 1].km - deduped[i].km;
    if (dist <= 0) continue;
    gaps.push({
      fromName: deduped[i].name,
      toName: deduped[i + 1].name,
      fromKm: deduped[i].km,
      toKm: deduped[i + 1].km,
      distanceKm: Math.round(dist * 10) / 10,
      isDryStretch: dist >= effectiveThreshold,
    });
  }

  // Gap from last source to trail end
  const lastDist = trailEndKm - deduped[deduped.length - 1].km;
  if (lastDist > 0) {
    gaps.push({
      fromName: deduped[deduped.length - 1].name,
      toName: 'Trail End',
      fromKm: deduped[deduped.length - 1].km,
      toKm: trailEndKm,
      distanceKm: Math.round(lastDist * 10) / 10,
      isDryStretch: lastDist >= effectiveThreshold,
    });
  }

  return gaps;
}

/**
 * Full water carry analysis for a trail.
 *
 * Returns sources, gaps between them, dry stretch warnings, and whether
 * the trail has any water data at all.
 */
export function analyzeWaterCarry(
  waypoints: PlanWaypoint[],
  totalDistanceKm: number,
  dryStretchThreshold: number = DEFAULT_DRY_STRETCH_KM,
): WaterCarryAnalysis {
  const sources = extractWaterSources(waypoints);
  const hasWaterData = sources.length > 0;

  if (!hasWaterData) {
    return { sources: [], gaps: [], longestGapKm: 0, dryStretchCount: 0, hasWaterData: false };
  }

  const gaps = computeWaterGaps(sources, 0, totalDistanceKm, dryStretchThreshold);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const dryStretchCount = gaps.filter(g => g.isDryStretch).length;

  return { sources, gaps, longestGapKm, dryStretchCount, hasWaterData };
}

/**
 * Get water sources and gaps scoped to a section of trail.
 */
export function analyzeWaterCarryForSection(
  waypoints: PlanWaypoint[],
  startKm: number,
  endKm: number,
  dryStretchThreshold: number = DEFAULT_DRY_STRETCH_KM,
): WaterCarryAnalysis {
  const allSources = extractWaterSources(waypoints);
  const sectionSources = allSources.filter(s => s.km >= startKm && s.km <= endKm);

  if (sectionSources.length === 0) {
    return {
      sources: [],
      gaps: [],
      longestGapKm: 0,
      dryStretchCount: 0,
      hasWaterData: allSources.length > 0,
    };
  }

  const gaps = computeWaterGaps(sectionSources, startKm, endKm, dryStretchThreshold);
  const longestGapKm = gaps.reduce((max, g) => Math.max(max, g.distanceKm), 0);
  const dryStretchCount = gaps.filter(g => g.isDryStretch).length;

  return {
    sources: sectionSources,
    gaps,
    longestGapKm,
    dryStretchCount,
    hasWaterData: true,
  };
}
