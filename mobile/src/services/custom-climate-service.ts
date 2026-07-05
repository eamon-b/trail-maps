/**
 * Runtime climate fetch for custom (imported) trails.
 *
 * Bundled trails ship with build-time climate data; custom trails have none.
 * This service gives them parity: it picks a handful of sample points along
 * the track, queries the Open-Meteo historical archive (the same API the
 * build script uses), aggregates daily data into monthly averages via the
 * shared aggregator, and caches the result in the trails.climate_json column.
 *
 * Offline-first contract: nothing here runs automatically. Fetches are
 * strictly user-triggered (a button in the plan climate tab); cached data is
 * served without touching the network.
 */

import { aggregateDailyToMonthly, type DailyClimateSeries } from '@lib/climate-aggregate';
import {
  registerClimateData,
  ensureClimateData,
  type ClimateData,
  type ClimateLocation,
} from './climate-service';
import { TrailDataService } from './trail-data-service';
import { findNearestByDistance } from '../lib/trail-utils';

// ---------------------------------------------------------------------------
// Constants (mirrors scripts/fetch-climate.ts, adapted for on-device use)
// ---------------------------------------------------------------------------

const OPEN_METEO_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';

/** Historical range for runtime fetches. Shorter than the build script's
 * 30 years to keep response sizes and latency reasonable on-device. */
export const DATA_START_YEAR = 2014;
export const DATA_END_YEAR = 2023;

/** Max number of sample locations per trail. */
export const MAX_CLIMATE_LOCATIONS = 5;

/** Aim for roughly one interior sample per this many km. */
const KM_PER_SAMPLE = 100;

/** Delay between per-location requests (mirrors the build script). */
const DELAY_BETWEEN_QUERIES_MS = 1000;

/** Single retry with a short backoff — on-device we fail fast rather than
 * waiting out a 60s rate-limit window like the build script does. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Sample point selection
// ---------------------------------------------------------------------------

export interface ClimateSamplePoint {
  /** Display name, e.g. "km 0", "km 104" */
  name: string;
  lat: number;
  lon: number;
  /** Trail km this sample represents */
  distanceAlongTrail: number;
}

interface SampleTrackPoint {
  lat: number;
  lon: number;
  /** Cumulative distance along the trail in km */
  dist: number;
}

/**
 * Pick evenly spaced climate sample points along a track: both endpoints plus
 * interior points roughly every 100 km, capped at `maxLocations` total.
 * A short trail yields just its two endpoints.
 */
export function pickClimateSamplePoints(
  points: SampleTrackPoint[],
  totalDistance: number,
  maxLocations: number = MAX_CLIMATE_LOCATIONS,
): ClimateSamplePoint[] {
  if (points.length === 0) return [];
  if (points.length === 1 || totalDistance <= 0) {
    const p = points[0];
    return [{ name: 'km 0', lat: p.lat, lon: p.lon, distanceAlongTrail: 0 }];
  }

  const count = Math.min(
    Math.max(2, maxLocations),
    Math.max(2, Math.floor(totalDistance / KM_PER_SAMPLE) + 1),
  );

  const samples: ClimateSamplePoint[] = [];
  const seenKm = new Set<number>();

  for (let i = 0; i < count; i++) {
    const targetKm = (totalDistance * i) / (count - 1);
    const point = points[findNearestByDistance(points, targetKm)];
    const roundedKm = Math.round(targetKm);
    if (seenKm.has(roundedKm)) continue;
    seenKm.add(roundedKm);
    samples.push({
      name: `km ${roundedKm}`,
      lat: point.lat,
      lon: point.lon,
      distanceAlongTrail: Math.round(targetKm * 10) / 10,
    });
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Open-Meteo fetch
// ---------------------------------------------------------------------------

interface OpenMeteoArchiveResponse {
  elevation?: number;
  daily: DailyClimateSeries;
}

async function fetchHistoricalClimate(lat: number, lon: number): Promise<OpenMeteoArchiveResponse> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    start_date: `${DATA_START_YEAR}-01-01`,
    end_date: `${DATA_END_YEAR}-12-31`,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'auto',
  });

  const response = await fetch(`${OPEN_METEO_ENDPOINT}?${params}`);
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Open-Meteo API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as OpenMeteoArchiveResponse;
  if (!data.daily?.time) {
    throw new Error('Open-Meteo API returned no daily data');
  }
  return data;
}

async function fetchWithRetry(lat: number, lon: number): Promise<OpenMeteoArchiveResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchHistoricalClimate(lat, lon);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Climate fetch failed');
}

export interface ClimateFetchProgress {
  /** 1-based index of the location currently being fetched */
  current: number;
  total: number;
  locationName: string;
}

/**
 * Fetch climate data for a custom trail from the Open-Meteo archive.
 *
 * Network access — must only be called from a user-triggered action.
 * Throws if any sample location fails (partial climate data would silently
 * mislead; the caller surfaces an error with retry instead).
 */
export async function fetchCustomTrailClimate(
  trail: { track: { points: SampleTrackPoint[]; totalDistance: number } },
  onProgress?: (progress: ClimateFetchProgress) => void,
): Promise<ClimateData> {
  const samples = pickClimateSamplePoints(trail.track.points, trail.track.totalDistance);
  if (samples.length === 0) {
    throw new Error('Trail has no track points to sample climate for');
  }

  const locations: ClimateLocation[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    onProgress?.({ current: i + 1, total: samples.length, locationName: sample.name });

    const response = await fetchWithRetry(sample.lat, sample.lon);
    locations.push({
      name: sample.name,
      lat: sample.lat,
      lon: sample.lon,
      elevation: Math.round(response.elevation ?? 0),
      distanceAlongTrail: sample.distanceAlongTrail,
      monthly: aggregateDailyToMonthly(response.daily),
    });

    // Rate limiting between API calls (mirrors the build script)
    if (i < samples.length - 1) {
      await sleep(DELAY_BETWEEN_QUERIES_MS);
    }
  }

  return {
    locations,
    dataYears: { start: DATA_START_YEAR, end: DATA_END_YEAR },
  };
}

// ---------------------------------------------------------------------------
// Cache-first orchestration
// ---------------------------------------------------------------------------

/**
 * Load previously cached climate for a trail: registry-first, then the SQLite
 * `climate_json` cache (no network). Returns null if nothing is cached. Safe to
 * call on every trail load. Thin wrapper over the shared climate-service loader.
 */
export async function loadCachedCustomTrailClimate(trailId: string): Promise<ClimateData | null> {
  return ensureClimateData(trailId);
}

/**
 * Ensure climate data exists for a custom trail: cache-first, then a
 * user-triggered network fetch. On success the data is persisted to
 * trails.climate_json and registered with the climate service. On fetch
 * failure returns null and persists nothing.
 */
export async function ensureCustomTrailClimate(
  trailId: string,
  trail: { track: { points: SampleTrackPoint[]; totalDistance: number } },
  onProgress?: (progress: ClimateFetchProgress) => void,
): Promise<ClimateData | null> {
  // The whole body is guarded — including the SQLite cache read — so a storage
  // rejection can never escape as an unhandled rejection and leave the caller's
  // fetch state stuck on 'loading'. Any failure resolves to null instead.
  try {
    // Cache first — never hit the network when we already have data
    const cached = await loadCachedCustomTrailClimate(trailId);
    if (cached) return cached;

    const data = await fetchCustomTrailClimate(trail, onProgress);
    const service = await TrailDataService.create();
    await service.storeClimateJson(trailId, JSON.stringify(data));
    registerClimateData(trailId, data);
    return data;
  } catch (e) {
    console.warn('Custom trail climate fetch failed:', e);
    return null;
  }
}
