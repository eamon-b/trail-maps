/**
 * Climate data service for loading and querying historical climate data
 * associated with trail locations.
 */

import type { ComputedDay } from './plan-calculator-types';
import { TrailDataService } from './trail-data-service';

export interface MonthlyClimate {
  month: number;
  avgTempMin: number;
  avgTempMax: number;
  avgPrecipitation: number;
  avgRainyDays: number;
}

export interface ClimateLocation {
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  distanceAlongTrail?: number;
  monthly: MonthlyClimate[];
}

export interface ClimateData {
  locations: ClimateLocation[];
  dataYears: { start: number; end: number };
}

export interface DayClimate {
  tempMin: number;
  tempMax: number;
  precipitation: number;
  rainyDays: number;
}

// Climate data map - populated by trail-loader
const CLIMATE_CACHE: Record<string, ClimateData | null> = {};

/**
 * Register climate data for a trail (called from trail-loader).
 */
export function registerClimateData(trailId: string, data: ClimateData): void {
  CLIMATE_CACHE[trailId] = data;
}

/**
 * Load climate data for a trail. Returns null if no data available.
 */
export function loadClimateData(trailId: string): ClimateData | null {
  return CLIMATE_CACHE[trailId] ?? null;
}

/** Parse a persisted climate_json string, returning null if malformed. */
function parseClimateJson(json: string): ClimateData | null {
  try {
    const data = JSON.parse(json) as ClimateData;
    if (Array.isArray(data?.locations) && data.dataYears) return data;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Ensure climate data is loaded for a trail: return the in-memory registry
 * entry if present (bundled trails register at startup), otherwise fall back to
 * the SQLite `climate_json` cache (custom trails), registering and returning it.
 * Returns null if nothing is cached. No network access.
 *
 * Single source of truth for the "registry-first, then SQLite" load so callers
 * (trail loader, plan screen) don't each re-implement the fallback dance.
 */
export async function ensureClimateData(trailId: string): Promise<ClimateData | null> {
  const registered = loadClimateData(trailId);
  if (registered) return registered;

  const service = await TrailDataService.create();
  const json = await service.getClimateJson(trailId);
  if (!json) return null;

  const data = parseClimateJson(json);
  if (!data) return null;

  registerClimateData(trailId, data);
  return data;
}

/**
 * Find the nearest climate location to a given km position along the trail.
 */
function findNearestLocation(climate: ClimateData, km: number): ClimateLocation | null {
  if (climate.locations.length === 0) return null;

  let nearest = climate.locations[0];
  let nearestDist = Math.abs((nearest.distanceAlongTrail ?? 0) - km);

  for (const loc of climate.locations) {
    const dist = Math.abs((loc.distanceAlongTrail ?? 0) - km);
    if (dist < nearestDist) {
      nearest = loc;
      nearestDist = dist;
    }
  }

  return nearest;
}

/**
 * Get climate data for a position and month.
 * Month is 1-indexed (1=January, 12=December).
 */
export function getClimateForPosition(
  climate: ClimateData,
  km: number,
  month: number,
): MonthlyClimate | null {
  const location = findNearestLocation(climate, km);
  if (!location) return null;

  return location.monthly.find(m => m.month === month) ?? null;
}

/**
 * Get interpolated climate data for a computed day.
 * Uses the day's midpoint km and the month from the day's date.
 */
export function getClimateForDay(
  climate: ClimateData,
  day: ComputedDay,
): DayClimate | null {
  if (!day.date) return null;

  const date = new Date(day.date + 'T12:00:00Z');
  if (isNaN(date.getTime())) return null;

  const month = date.getUTCMonth() + 1; // 1-indexed
  const midKm = (day.startKm + day.endKm) / 2;

  const monthly = getClimateForPosition(climate, midKm, month);
  if (!monthly) return null;

  return {
    tempMin: monthly.avgTempMin,
    tempMax: monthly.avgTempMax,
    precipitation: monthly.avgPrecipitation,
    rainyDays: monthly.avgRainyDays,
  };
}
