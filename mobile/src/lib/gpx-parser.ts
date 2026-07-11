/**
 * React Native GPX Parser
 *
 * Replaces the browser DOMParser-based parser with fast-xml-parser
 * for use in React Native. Produces the same output types as
 * src/lib/gpx-parser.ts (GpxData with tracks, routes, waypoints).
 *
 * Handles common GPX variations:
 * - Single <trk> with multiple <trkseg>
 * - Multiple <trk> elements
 * - Waypoints as <wpt> (standard) and as <rtept> (route points)
 * - GPX 1.0 vs 1.1 differences
 * - Missing <ele> elements (elevation optional)
 * - Extensions from Garmin, Strava, etc. (ignored gracefully)
 */

import { XMLParser } from 'fast-xml-parser';
import type { GpxData, GpxTrack, GpxRoute, GpxWaypoint, GpxPoint } from '@lib/types';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

/** Errors specific to GPX parsing */
export class GpxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpxParseError';
  }
}

/**
 * Normalize a value that may be a single object or an array into an array.
 * fast-xml-parser returns a single object when there's one element,
 * and an array when there are multiple.
 */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Safely parse a number, returning 0 for invalid/missing values. */
function safeFloat(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return isNaN(n) ? 0 : n;
}

/** Safely extract a string value. */
function safeString(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

/** Parse a single track point (<trkpt> or <rtept>) into a GpxPoint. */
function parsePoint(pt: Record<string, unknown>): GpxPoint {
  // Attributes are stored with @ prefix by fast-xml-parser
  return {
    lat: safeFloat(pt['@_lat']),
    lon: safeFloat(pt['@_lon']),
    ele: safeFloat(pt.ele),
    time: pt.time ? safeString(pt.time) : null,
  };
}

/** Parse a <wpt> element into a GpxWaypoint. */
function parseWaypoint(wpt: Record<string, unknown>): GpxWaypoint {
  return {
    lat: safeFloat(wpt['@_lat']),
    lon: safeFloat(wpt['@_lon']),
    ele: safeFloat(wpt.ele),
    name: safeString(wpt.name),
    desc: safeString(wpt.desc),
    // Explicit <type> (e.g. our own exports) — preferred over name-based
    // classification downstream so round trips preserve the type.
    ...(wpt.type != null && safeString(wpt.type) !== '' ? { type: safeString(wpt.type) } : {}),
  };
}

/**
 * Parse GPX XML content into structured data.
 *
 * @param xml - GPX file contents as a string
 * @returns Parsed GPX data with tracks, routes, and waypoints
 * @throws GpxParseError on invalid input
 */
export function parseGpx(xml: string): GpxData {
  // Input validation
  if (!xml || xml.trim().length === 0) {
    throw new GpxParseError('GPX content cannot be empty');
  }

  // File size check (approximate - string length in UTF-16 chars)
  // For a more precise check, the caller should check byte length before
  // converting to string.
  const estimatedBytes = xml.length * 2; // rough upper bound for UTF-16
  if (estimatedBytes > MAX_FILE_SIZE_BYTES * 2) {
    throw new GpxParseError(
      `File appears to exceed the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`
    );
  }

  // Quick check that this looks like XML
  const trimmed = xml.trimStart();
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<gpx') && !trimmed.startsWith('<GPX')) {
    throw new GpxParseError("This doesn't appear to be a GPX file");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Preserve text values as strings (not numbers) for name/desc
    // but let ele/lat/lon be parsed as numbers
    parseTagValue: true,
    parseAttributeValue: true,
    // Don't trim whitespace from text content
    trimValues: true,
    // Handle arrays: force certain tags to always be arrays
    isArray: (name) => {
      return ['trk', 'trkseg', 'trkpt', 'rte', 'rtept', 'wpt'].includes(name);
    },
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    throw new GpxParseError(`Invalid XML: ${msg}`);
  }

  // Navigate to the gpx root element
  const gpx = (parsed.gpx || parsed.GPX) as Record<string, unknown> | undefined;
  if (!gpx) {
    throw new GpxParseError("This doesn't appear to be a GPX file (no <gpx> root element)");
  }

  // Parse tracks
  const tracks: GpxTrack[] = toArray(gpx.trk as Record<string, unknown>[]).map(
    (trk: Record<string, unknown>) => {
      const segments = toArray(trk.trkseg as Record<string, unknown>[]).map(
        (seg: Record<string, unknown>) => ({
          points: toArray(seg.trkpt as Record<string, unknown>[]).map(parsePoint),
        })
      );

      return {
        name: safeString(trk.name),
        segments,
      };
    }
  );

  // Parse routes
  const routes: GpxRoute[] = toArray(gpx.rte as Record<string, unknown>[]).map(
    (rte: Record<string, unknown>) => ({
      name: safeString(rte.name),
      points: toArray(rte.rtept as Record<string, unknown>[]).map(parsePoint),
    })
  );

  // Parse waypoints
  const waypoints: GpxWaypoint[] = toArray(gpx.wpt as Record<string, unknown>[]).map(
    parseWaypoint
  );

  return { tracks, routes, waypoints };
}

/**
 * Check raw byte length before parsing.
 * Call this on the ArrayBuffer before converting to string.
 *
 * @param byteLength - Size of the file in bytes
 * @throws GpxParseError if file exceeds 50MB limit
 */
export function validateFileSize(byteLength: number): void {
  if (byteLength > MAX_FILE_SIZE_BYTES) {
    throw new GpxParseError(
      `File size (${(byteLength / 1024 / 1024).toFixed(1)}MB) exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`
    );
  }
}
