/**
 * The text of the trail page's two downloads — the datasheet CSV and the GPX —
 * kept apart from `trail-viewer.ts` so the formats can be tested without a map
 * or a page. The viewer decides *what* is exported (the view on screen); this
 * decides how it is written.
 */

import { escapeXml } from '@lib/gpx-parser';
import { splitAtRouteBreaks } from '@lib/route-breaks';
import type { RouteBreak } from '@lib/trail-types';

/**
 * A leading character a spreadsheet reads as the start of a formula. Tab and
 * CR are on the list because some spreadsheets strip them and then evaluate
 * what follows.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Quote a value for one CSV field: wrap in double quotes and double any inner
 * quote (RFC 4180). Every free-text column must go through this — waypoint
 * `type` is an editable, arbitrary string on imported trails, so an unquoted
 * comma in it would shift every later column in the row.
 *
 * Names and descriptions come from whatever GPX was imported, and quoting does
 * not stop Excel or Sheets running `=HYPERLINK(…)` as a formula when the file
 * is opened. So a value that starts like one gets the standard neutralisation,
 * a leading `'`, which the spreadsheet shows as plain text.
 */
export function csvQuote(value: unknown): string {
  const text = String(value ?? '');
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number | null;
}

interface GpxWaypoint {
  name?: string;
  type?: string;
  lat: number;
  lon: number;
  elevation?: number;
  description?: string;
}

interface GpxVariant {
  name: string;
  type: string;
  points?: GpxPoint[];
}

/** What the GPX export reads of a trail — structural, so the viewer's own type fits. */
export interface GpxExportTrail {
  config: { name: string; region?: string };
  track: { points: GpxPoint[]; totalDistance: number; breaks?: RouteBreak[] };
  waypoints?: GpxWaypoint[];
  offTrailWaypoints?: GpxWaypoint[];
  alternates?: GpxVariant[];
  sideTrips?: GpxVariant[];
}

function pushTrkpts(lines: string[], points: readonly GpxPoint[]): void {
  for (const pt of points) {
    lines.push(`      <trkpt lat="${pt.lat}" lon="${pt.lon}">`);
    if (pt.ele != null) lines.push(`        <ele>${pt.ele}</ele>`);
    lines.push(`      </trkpt>`);
  }
}

/**
 * The trail as a GPX 1.1 document.
 *
 * The main route is one `<trk>` with one `<trkseg>` per walkable stretch: a
 * route break (a ferry, an unbridged river) is where the route stops and
 * resumes, and a single segment would have every GPS app draw — and measure —
 * a straight line across it. Alternates and side trips (termini included)
 * follow as `<trk>`s of their own, typed, so they are not lost from the file.
 */
export function buildGpx(trail: GpxExportTrail): string {
  const { config, track, waypoints } = trail;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx version="1.1" creator="GPX Tools" xmlns="http://www.topografix.com/GPX/1/1">');
  lines.push(`  <metadata>`);
  lines.push(`    <name>${escapeXml(config.name)}</name>`);
  lines.push(`    <desc>${escapeXml(config.region)} - ${track.totalDistance.toFixed(1)} km</desc>`);
  lines.push(`  </metadata>`);

  for (const wp of waypoints || []) {
    lines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">`);
    if (wp.elevation != null) lines.push(`    <ele>${wp.elevation}</ele>`);
    lines.push(`    <name>${escapeXml(wp.name || 'Waypoint')}</name>`);
    if (wp.type) lines.push(`    <type>${escapeXml(wp.type)}</type>`);
    if (wp.description) lines.push(`    <desc>${escapeXml(wp.description)}</desc>`);
    lines.push(`  </wpt>`);
  }

  for (const wp of trail.offTrailWaypoints || []) {
    lines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">`);
    lines.push(`    <name>${escapeXml(wp.name || 'Waypoint')}</name>`);
    if (wp.type) lines.push(`    <type>${escapeXml(wp.type)}</type>`);
    if (wp.description) lines.push(`    <desc>${escapeXml(wp.description)}</desc>`);
    lines.push(`  </wpt>`);
  }

  lines.push(`  <trk>`);
  lines.push(`    <name>${escapeXml(config.name)}</name>`);
  for (const stretch of splitAtRouteBreaks(track.points || [], track.breaks, 'points')) {
    lines.push(`    <trkseg>`);
    pushTrkpts(lines, stretch);
    lines.push(`    </trkseg>`);
  }
  lines.push(`  </trk>`);

  for (const variant of [...(trail.alternates || []), ...(trail.sideTrips || [])]) {
    if (!variant.points || variant.points.length === 0) continue;
    lines.push(`  <trk>`);
    lines.push(`    <name>${escapeXml(variant.name || 'Unnamed')}</name>`);
    lines.push(`    <type>${escapeXml(variant.type)}</type>`);
    lines.push(`    <trkseg>`);
    pushTrkpts(lines, variant.points);
    lines.push(`    </trkseg>`);
    lines.push(`  </trk>`);
  }

  lines.push('</gpx>');
  return lines.join('\n');
}
