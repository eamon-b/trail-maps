/**
 * GPX 1.1 writer for the mobile app (P1 PR B — export & share).
 *
 * Mobile-safe by construction: pure string building, no DOM APIs (the
 * existing src/lib/gpx-parser.ts on the web side is browser-only, which is
 * why this file lives in mobile/src/lib).
 *
 * Emits:
 * - `<wpt>` for waypoints (with `<ele>`, `<time>` from created_at, `<desc>`,
 *   and `<type>` from the type registry values)
 * - `<trk>` for trail tracks (main track + preserved alternates/side trips)
 * - `<rte>` for waypoint-sequence routes (PR D)
 *
 * Photos are NOT embedded — GPX has no sane standard for it.
 */

import type { Trail, TrackPoint } from './trail-utils';

const GPX_CREATOR = 'Trail Companion';

/** Escape the five XML special characters for element/attribute content. */
export function escapeXml(value: string): string {
  return value
    // Strip characters XML 1.0 forbids even when escaped (a pasted control
    // char in a note would otherwise produce GPX that strict parsers reject).
    // Tab (U+0009), LF (U+000A), and CR (U+000D) are the only allowed C0 chars.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A waypoint to serialize (CustomWaypoint and TrailWaypoint both satisfy it). */
export interface GpxWriterWaypoint {
  name: string;
  lat: number;
  lon: number;
  type?: string | null;
  /** Elevation in metres (either field name accepted) */
  ele?: number | null;
  elevation?: number | null;
  description?: string | null;
  /** ISO timestamp → `<time>` */
  createdAt?: string | null;
}

/** A point of a route leg or track (lat/lon + optional elevation). */
export interface GpxWriterPoint {
  lat: number;
  lon: number;
  ele?: number | null;
  name?: string | null;
}

function coord(n: number): string {
  // 6 dp ≈ 0.1 m — matches the processor's coordinate precision.
  return String(Math.round(n * 1e6) / 1e6);
}

function gpxHeader(name: string | undefined): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${GPX_CREATOR}" xmlns="http://www.topografix.com/GPX/1/1">`,
  ];
  if (name) {
    lines.push('  <metadata>', `    <name>${escapeXml(name)}</name>`, '  </metadata>');
  }
  return lines.join('\n');
}

function wptXml(wp: GpxWriterWaypoint, indent = '  '): string {
  const lines = [`${indent}<wpt lat="${coord(wp.lat)}" lon="${coord(wp.lon)}">`];
  const ele = wp.ele ?? wp.elevation;
  // GPX 1.1 wpt child order: ele, time, name, desc, type
  if (ele != null) lines.push(`${indent}  <ele>${Math.round(ele * 10) / 10}</ele>`);
  if (wp.createdAt) lines.push(`${indent}  <time>${escapeXml(wp.createdAt)}</time>`);
  lines.push(`${indent}  <name>${escapeXml(wp.name)}</name>`);
  if (wp.description) lines.push(`${indent}  <desc>${escapeXml(wp.description)}</desc>`);
  if (wp.type) lines.push(`${indent}  <type>${escapeXml(wp.type)}</type>`);
  lines.push(`${indent}</wpt>`);
  return lines.join('\n');
}

function trksegXml(points: TrackPoint[] | GpxWriterPoint[], indent = '    '): string {
  const lines = [`${indent}<trkseg>`];
  for (const p of points) {
    const ele = (p as TrackPoint).ele ?? (p as GpxWriterPoint).ele;
    if (ele != null) {
      lines.push(
        `${indent}  <trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}"><ele>${Math.round(ele * 10) / 10}</ele></trkpt>`,
      );
    } else {
      lines.push(`${indent}  <trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}"/>`);
    }
  }
  lines.push(`${indent}</trkseg>`);
  return lines.join('\n');
}

/**
 * Serialize waypoints as a GPX document of `<wpt>` elements.
 * Used for "Export my waypoints" and single-waypoint sharing.
 */
export function waypointsToGpx(
  waypoints: GpxWriterWaypoint[],
  options?: { name?: string },
): string {
  const parts = [gpxHeader(options?.name)];
  for (const wp of waypoints) {
    parts.push(wptXml(wp));
  }
  parts.push('</gpx>');
  return parts.join('\n');
}

/**
 * Serialize a full trail: main track as `<trk>`, alternates/side trips as
 * additional named `<trk>` elements, waypoints as `<wpt>`.
 */
export function trailToGpx(trail: Trail, options?: { name?: string }): string {
  const name = options?.name ?? trail.config.name;
  const parts = [gpxHeader(name)];

  for (const wp of trail.waypoints) {
    parts.push(wptXml({
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      ele: wp.elevation,
      type: wp.type,
      description: wp.description,
    }));
  }

  parts.push('  <trk>', `    <name>${escapeXml(name)}</name>`, trksegXml(trail.track.points), '  </trk>');

  for (const variant of [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])]) {
    if (!variant.points || variant.points.length < 2) continue;
    parts.push(
      '  <trk>',
      `    <name>${escapeXml(variant.name)}</name>`,
      variant.type ? `    <type>${escapeXml(variant.type)}</type>` : '',
      trksegXml(variant.points),
      '  </trk>',
    );
  }

  parts.push('</gpx>');
  return parts.filter(p => p !== '').join('\n');
}

/**
 * Serialize a waypoint-sequence route as a GPX `<rte>` (PR D). Each point
 * becomes an `<rtept>` with its name.
 */
export function routeToGpx(routeName: string, points: GpxWriterPoint[]): string {
  const parts = [gpxHeader(routeName), '  <rte>', `    <name>${escapeXml(routeName)}</name>`];
  for (const p of points) {
    const lines = [`    <rtept lat="${coord(p.lat)}" lon="${coord(p.lon)}">`];
    if (p.ele != null) lines.push(`      <ele>${Math.round(p.ele * 10) / 10}</ele>`);
    if (p.name) lines.push(`      <name>${escapeXml(p.name)}</name>`);
    lines.push('    </rtept>');
    parts.push(lines.join('\n'));
  }
  parts.push('  </rte>', '</gpx>');
  return parts.join('\n');
}

/**
 * Plain-text one-liner for messaging apps:
 * "Name — -35.12345, 148.98765 (km 42.3)"
 */
export function waypointPlainText(wp: {
  name: string;
  lat: number;
  lon: number;
  kmPosition?: number | null;
  totalDistance?: number | null;
}): string {
  const km = wp.kmPosition ?? wp.totalDistance;
  const kmPart = km != null ? ` (km ${km.toFixed(1)})` : '';
  return `${wp.name} — ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}${kmPart}`;
}
