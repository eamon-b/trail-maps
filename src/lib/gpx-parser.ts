import type { GpxData, GpxTrack, GpxRoute, GpxWaypoint, GpxPoint } from './types';
import { parseCoordinate } from './parse-coordinate';
import { defaultXmlAdapter, type XmlAdapter, type XmlNode } from './xml-adapter';

/**
 * Maximum number of track/route points accepted from a single GPX file.
 * Also the `maxPointCount` default in `GPX_OPTIMIZER_DEFAULTS` (which imports
 * these constants from here — gpx-optimizer already depends on this module, so
 * keeping the limits here avoids an import cycle).
 */
export const GPX_MAX_POINT_COUNT = 100000;

/** Maximum accepted GPX source size, measured in UTF-16 code units. */
export const GPX_MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Size/point caps applied while parsing untrusted GPX. 0 disables a cap. */
export interface GpxParseLimits {
  maxFileSize?: number;
  maxPointCount?: number;
}

/**
 * Parse GPX XML content into structured data.
 *
 * Supports:
 * - `<trk>` elements (tracks with track segments)
 * - `<rte>` elements (routes with route points)
 * - `<wpt>` elements (waypoints, including `<ele>` and `<type>`)
 *
 * Platform-neutral: XML access goes through an injected {@link XmlAdapter}, so
 * the same code runs under DOMParser (web), jsdom (build scripts) and
 * fast-xml-parser (React Native). With no adapter the platform DOMParser is
 * used.
 *
 * Coordinates are parsed strictly — a missing or unparseable `lat`/`lon`
 * throws rather than silently plotting the point at 0°N 0°E. Elevations keep
 * the historical lenient behaviour (`<ele>` absent ⇒ 0) because a missing
 * elevation is normal, not corrupt.
 */
export function parseGpx(xml: string, adapter?: XmlAdapter, limits?: GpxParseLimits): GpxData {
  const maxFileSize = limits?.maxFileSize ?? GPX_MAX_FILE_SIZE;
  if (maxFileSize > 0 && xml.length > maxFileSize) {
    throw new Error(
      `GPX file too large: ${xml.length} characters exceeds the ${maxFileSize} character limit`
    );
  }

  const doc = (adapter ?? defaultXmlAdapter())(xml);
  const maxPointCount = limits?.maxPointCount ?? GPX_MAX_POINT_COUNT;
  let pointCount = 0;
  const countPoints = (n: number): void => {
    pointCount += n;
    if (maxPointCount > 0 && pointCount > maxPointCount) {
      throw new Error(
        `GPX file has too many points: more than ${maxPointCount} track/route points`
      );
    }
  };

  // Tracks (<trk> → <trkseg> → <trkpt>)
  const tracks: GpxTrack[] = doc.querySelectorAll('trk').map(trk => ({
    name: text(trk.querySelector('name')) ?? '',
    segments: trk.querySelectorAll('trkseg').map(seg => {
      const trkpts = seg.querySelectorAll('trkpt');
      countPoints(trkpts.length);
      return { points: trkpts.map(pt => parsePoint(pt, 'trkpt')) };
    }),
  }));

  // Routes (<rte> → <rtept>)
  const routes: GpxRoute[] = doc.querySelectorAll('rte').map(rte => {
    const rtepts = rte.querySelectorAll('rtept');
    countPoints(rtepts.length);
    return {
      name: text(rte.querySelector('name')) ?? '',
      points: rtepts.map(pt => parsePoint(pt, 'rtept')),
    };
  });

  // Waypoints (<wpt>)
  const waypoints: GpxWaypoint[] = doc.querySelectorAll('wpt').map(wpt => {
    const explicitType = text(wpt.querySelector('type'));
    return {
      lat: parseCoordinate(wpt.getAttribute('lat'), 'lat', 'wpt'),
      lon: parseCoordinate(wpt.getAttribute('lon'), 'lon', 'wpt'),
      ele: parseElevation(wpt),
      name: text(wpt.querySelector('name')) ?? '',
      desc: text(wpt.querySelector('desc')) ?? '',
      type: explicitType ? explicitType : undefined,
    };
  });

  const metadata = doc.querySelector('metadata');
  const metadataName = metadata ? text(metadata.querySelector('name')) : null;

  return { tracks, routes, waypoints, metadataName };
}

function text(node: XmlNode | null): string | null {
  return node ? node.textContent : null;
}

function parseElevation(node: XmlNode): number {
  return parseFloat(text(node.querySelector('ele')) || '0');
}

function parsePoint(pt: XmlNode, context: string): GpxPoint {
  return {
    lat: parseCoordinate(pt.getAttribute('lat'), 'lat', context),
    lon: parseCoordinate(pt.getAttribute('lon'), 'lon', context),
    ele: parseElevation(pt),
    time: text(pt.querySelector('time')) || null,
  };
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate GPX XML from structured data
 */
export function generateGpx(
  trackName: string,
  points: GpxPoint[],
  waypoints: GpxWaypoint[]
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tools"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
`;

  // Add waypoints
  for (const wpt of waypoints) {
    xml += `  <wpt lat="${wpt.lat}" lon="${wpt.lon}">
`;
    if (wpt.ele !== 0) {
      xml += `    <ele>${wpt.ele}</ele>
`;
    }
    if (wpt.name) {
      xml += `    <name>${escapeXml(wpt.name)}</name>
`;
    }
    // Emit the classified type so an export → import round trip keeps it
    // instead of re-deriving it from the (already cleaned) name.
    if (wpt.type) {
      xml += `    <type>${escapeXml(wpt.type)}</type>
`;
    }
    if (wpt.desc) {
      xml += `    <desc>${escapeXml(wpt.desc)}</desc>
`;
    }
    xml += `  </wpt>
`;
  }

  // Add track
  xml += `  <trk>
    <name>${escapeXml(trackName)}</name>
    <trkseg>
`;

  for (const pt of points) {
    xml += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
`;
    if (pt.ele !== 0) {
      xml += `        <ele>${pt.ele}</ele>
`;
    }
    if (pt.time) {
      xml += `        <time>${pt.time}</time>
`;
    }
    xml += `      </trkpt>
`;
  }

  xml += `    </trkseg>
  </trk>
</gpx>`;

  return xml;
}
