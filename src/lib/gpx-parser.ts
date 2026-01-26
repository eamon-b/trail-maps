import type { GpxData, GpxTrack, GpxRoute, GpxWaypoint, GpxPoint } from './types';

/**
 * Parse GPX XML content into structured data.
 *
 * Supports:
 * - <trk> elements (tracks with track segments)
 * - <rte> elements (routes with route points)
 * - <wpt> elements (waypoints)
 *
 * Routes (<rte>) are converted to a track-like structure for compatibility
 * with existing processing functions.
 */
export function parseGpx(xml: string): GpxData {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid GPX XML: ' + parseError.textContent);
  }

  // Parse tracks (<trk> elements with <trkseg> containing <trkpt>)
  const tracks: GpxTrack[] = Array.from(doc.querySelectorAll('trk')).map(trk => ({
    name: trk.querySelector('name')?.textContent || '',
    segments: Array.from(trk.querySelectorAll('trkseg')).map(seg => ({
      points: Array.from(seg.querySelectorAll('trkpt')).map(pt => ({
        lat: parseFloat(pt.getAttribute('lat') || '0'),
        lon: parseFloat(pt.getAttribute('lon') || '0'),
        ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
        time: pt.querySelector('time')?.textContent || null
      }))
    }))
  }));

  // Parse routes (<rte> elements with <rtept> children)
  const routes: GpxRoute[] = Array.from(doc.querySelectorAll('rte')).map(rte => ({
    name: rte.querySelector('name')?.textContent || '',
    points: Array.from(rte.querySelectorAll('rtept')).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat') || '0'),
      lon: parseFloat(pt.getAttribute('lon') || '0'),
      ele: parseFloat(pt.querySelector('ele')?.textContent || '0'),
      time: pt.querySelector('time')?.textContent || null
    }))
  }));

  // Parse waypoints (<wpt> elements)
  const waypoints: GpxWaypoint[] = Array.from(doc.querySelectorAll('wpt')).map(wpt => ({
    lat: parseFloat(wpt.getAttribute('lat') || '0'),
    lon: parseFloat(wpt.getAttribute('lon') || '0'),
    ele: parseFloat(wpt.querySelector('ele')?.textContent || '0'),
    name: wpt.querySelector('name')?.textContent || '',
    desc: wpt.querySelector('desc')?.textContent || ''
  }));

  return { tracks, routes, waypoints };
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
