/**
 * Datasheet generation service.
 *
 * Generates a section-by-section breakdown between waypoints for a trail,
 * with per-section distance, elevation gain/loss, estimated time, and
 * cumulative totals.
 */

import type { Trail, TrailWaypoint, TrackPoint } from '../lib/trail-utils';
import { calculateElevationBetween } from './distance-calculator';
import { estimateHikingTime, countWaterSources } from '@lib/day-calculator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatasheetSection {
  /** Section number (1-based) */
  index: number;
  /** Start waypoint name */
  startName: string;
  /** End waypoint name */
  endName: string;
  /** Start km along trail */
  startKm: number;
  /** End km along trail */
  endKm: number;
  /** Section distance in km */
  distanceKm: number;
  /** Elevation gain in meters */
  ascentM: number;
  /** Elevation loss in meters */
  descentM: number;
  /** Estimated hiking time in hours */
  estimatedHours: number;
  /** Cumulative distance to end of section */
  cumulativeKm: number;
  /** Cumulative ascent to end of section */
  cumulativeAscentM: number;
  /** Cumulative descent to end of section */
  cumulativeDescentM: number;
  /** Number of water sources in section */
  waterSources: number;
  /** End waypoint type (for display icons) */
  endWaypointType: string;
}

export interface DatasheetSummary {
  /** Trail name */
  trailName: string;
  /** Total distance in km */
  totalDistanceKm: number;
  /** Total ascent in meters */
  totalAscentM: number;
  /** Total descent in meters */
  totalDescentM: number;
  /** Estimated total hiking hours */
  totalHours: number;
  /** Estimated number of days at given pace */
  estimatedDays: number;
  /** Daily pace used for estimation (km/day) */
  dailyPaceKm: number;
  /** Total water sources */
  totalWaterSources: number;
  /** Number of sections */
  sectionCount: number;
  /** Resupply points (towns) */
  resupplyPoints: { name: string; km: number }[];
  /** Whether trail has elevation data */
  hasElevation: boolean;
}

export interface Datasheet {
  summary: DatasheetSummary;
  sections: DatasheetSection[];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_PACE_KM = 20;

/**
 * Check if a trail has meaningful elevation data.
 * Returns false if all elevations are 0 or missing.
 */
export function hasElevationData(trackPoints: TrackPoint[]): boolean {
  if (trackPoints.length === 0) return false;
  return trackPoints.some(p => p.ele !== 0);
}

/**
 * Get waypoints that serve as section boundaries for the datasheet.
 * Filters to significant waypoints (towns, campsites, shelters, huts, trailheads, road crossings).
 * If fewer than 2 significant waypoints exist, falls back to all waypoints.
 * Always includes trail start and end as implicit boundaries.
 */
function getSectionBoundaryWaypoints(trail: Trail): TrailWaypoint[] {
  const significantTypes = new Set(['town', 'campsite', 'shelter', 'hut', 'trailhead', 'road']);

  let boundaries = trail.waypoints.filter(wp =>
    significantTypes.has(wp.type) && wp.totalDistance != null
  );

  // Fall back to all waypoints with distances if too few significant ones
  if (boundaries.length < 2) {
    boundaries = trail.waypoints.filter(wp => wp.totalDistance != null);
  }

  // Sort by distance
  return boundaries.sort((a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0));
}

/**
 * Generate a full datasheet for a trail.
 *
 * @param trail - Trail data with track points and waypoints
 * @param dailyPaceKm - Average km/day for estimating trip duration (default 20)
 */
export function generateDatasheet(trail: Trail, dailyPaceKm = DEFAULT_DAILY_PACE_KM): Datasheet {
  const boundaries = getSectionBoundaryWaypoints(trail);
  const trackPoints = trail.track.points;
  const waypoints = trail.waypoints;
  const totalDistance = trail.track.totalDistance;
  const withElevation = hasElevationData(trackPoints);

  const sections: DatasheetSection[] = [];
  let cumulativeKm = 0;
  let cumulativeAscent = 0;
  let cumulativeDescent = 0;
  let totalHours = 0;
  let totalWater = 0;

  // Build section list from trail start → waypoint boundaries → trail end
  const trailStartName = trail.config.name + ' Start';
  const trailEndName = trail.config.name + ' End';

  interface Boundary {
    name: string;
    km: number;
    type: string;
  }

  const allBoundaries: Boundary[] = [
    { name: trailStartName, km: 0, type: 'trailhead' },
    ...boundaries.map(wp => ({
      name: wp.name,
      km: wp.totalDistance ?? 0,
      type: wp.type,
    })),
    { name: trailEndName, km: totalDistance, type: 'trailhead' },
  ];

  // Deduplicate boundaries that are very close together (< 0.5 km)
  const deduped: Boundary[] = [allBoundaries[0]];
  for (let i = 1; i < allBoundaries.length; i++) {
    const prev = deduped[deduped.length - 1];
    const curr = allBoundaries[i];
    if (curr.km - prev.km < 0.5) {
      // Keep the waypoint with the more meaningful name (prefer non-start/end)
      if (prev.name.endsWith(' Start') || prev.name.endsWith(' End')) {
        deduped[deduped.length - 1] = curr;
      }
    } else {
      deduped.push(curr);
    }
  }

  for (let i = 0; i < deduped.length - 1; i++) {
    const start = deduped[i];
    const end = deduped[i + 1];
    const distanceKm = Math.round((end.km - start.km) * 10) / 10;

    let ascentM = 0;
    let descentM = 0;
    let estimatedHrs = 0;

    if (withElevation) {
      const { gain, loss } = calculateElevationBetween(start.km, end.km, trackPoints);
      ascentM = gain;
      descentM = loss;
      estimatedHrs = estimateHikingTime(distanceKm, gain, loss);
    } else {
      // Distance-only time estimate: 4 km/h flat
      estimatedHrs = Math.round((distanceKm / 4) * 10) / 10;
    }

    const water = countWaterSources(start.km, end.km, waypoints);

    cumulativeKm += distanceKm;
    cumulativeAscent += ascentM;
    cumulativeDescent += descentM;
    totalHours += estimatedHrs;
    totalWater += water;

    sections.push({
      index: i + 1,
      startName: start.name,
      endName: end.name,
      startKm: start.km,
      endKm: end.km,
      distanceKm,
      ascentM,
      descentM,
      estimatedHours: estimatedHrs,
      cumulativeKm: Math.round(cumulativeKm * 10) / 10,
      cumulativeAscentM: cumulativeAscent,
      cumulativeDescentM: cumulativeDescent,
      waterSources: water,
      endWaypointType: end.type,
    });
  }

  // Resupply points
  const resupplyPoints = trail.waypoints
    .filter(wp => wp.type === 'town' && wp.totalDistance != null)
    .map(wp => ({ name: wp.name, km: Math.round((wp.totalDistance ?? 0) * 10) / 10 }));

  const estimatedDays = dailyPaceKm > 0 ? Math.ceil(totalDistance / dailyPaceKm) : 1;

  return {
    summary: {
      trailName: trail.config.name,
      totalDistanceKm: Math.round(totalDistance * 10) / 10,
      totalAscentM: Math.round(trail.track.totalAscent),
      totalDescentM: Math.round(trail.track.totalDescent),
      totalHours: Math.round(totalHours * 10) / 10,
      estimatedDays,
      dailyPaceKm,
      totalWaterSources: totalWater,
      sectionCount: sections.length,
      resupplyPoints,
      hasElevation: withElevation,
    },
    sections,
  };
}

// ---------------------------------------------------------------------------
// Export / Share
// ---------------------------------------------------------------------------

/**
 * Format datasheet as shareable plain text.
 */
export function datasheetToText(datasheet: Datasheet): string {
  const { summary, sections } = datasheet;
  const lines: string[] = [];

  lines.push(`${summary.trailName} — Trail Datasheet`);
  lines.push('='.repeat(lines[0].length));
  lines.push('');

  // Summary
  lines.push(`Total distance: ${summary.totalDistanceKm} km`);
  if (summary.hasElevation) {
    lines.push(`Total ascent: +${summary.totalAscentM}m`);
    lines.push(`Total descent: -${summary.totalDescentM}m`);
    lines.push(`Estimated hiking time: ${formatHours(summary.totalHours)}`);
  }
  lines.push(`Estimated days (at ${summary.dailyPaceKm} km/day): ${summary.estimatedDays}`);
  lines.push(`Sections: ${summary.sectionCount}`);
  if (summary.totalWaterSources > 0) {
    lines.push(`Water sources: ${summary.totalWaterSources}`);
  }
  lines.push('');

  // Resupply points
  if (summary.resupplyPoints.length > 0) {
    lines.push('Resupply Points:');
    for (const rp of summary.resupplyPoints) {
      lines.push(`  ${rp.name} (km ${rp.km})`);
    }
    lines.push('');
  }

  // Sections
  lines.push('Section Breakdown:');
  lines.push('-'.repeat(40));

  for (const s of sections) {
    const elevStr = summary.hasElevation
      ? ` | +${s.ascentM}m -${s.descentM}m | ${formatHours(s.estimatedHours)}`
      : ` | ~${formatHours(s.estimatedHours)}`;
    const waterStr = s.waterSources > 0 ? ` | ${s.waterSources} water` : '';
    lines.push(
      `${s.index}. ${s.startName} → ${s.endName}` +
      ` | ${s.distanceKm} km${elevStr}${waterStr}` +
      ` | cum: ${s.cumulativeKm} km`
    );
  }

  lines.push('');
  if (summary.hasElevation) {
    lines.push('Times estimated via Naismith\'s Rule (4 km/h + 600m/h ascent).');
  }
  lines.push('Generated by Trail Companion');

  return lines.join('\n');
}

/**
 * Format datasheet as CSV for spreadsheet export.
 */
export function datasheetToCsv(datasheet: Datasheet): string {
  const { summary, sections } = datasheet;
  const lines: string[] = [];

  const headers = [
    'Section',
    'From',
    'To',
    'Distance (km)',
    ...(summary.hasElevation ? ['Ascent (m)', 'Descent (m)'] : []),
    'Est. Time',
    'Water Sources',
    'Cumulative (km)',
    ...(summary.hasElevation ? ['Cum. Ascent (m)', 'Cum. Descent (m)'] : []),
  ];

  lines.push(headers.join(','));

  for (const s of sections) {
    const row = [
      s.index,
      csvEscape(s.startName),
      csvEscape(s.endName),
      s.distanceKm,
      ...(summary.hasElevation ? [s.ascentM, s.descentM] : []),
      formatHours(s.estimatedHours),
      s.waterSources,
      s.cumulativeKm,
      ...(summary.hasElevation ? [s.cumulativeAscentM, s.cumulativeDescentM] : []),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
