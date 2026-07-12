/**
 * GPX writer tests: golden output, XML escaping, and the round-trip
 * guarantee (export → import through the existing gpx-processor must
 * reproduce name/type/position).
 */
import {
  escapeXml,
  waypointsToGpx,
  trailToGpx,
  routeToGpx,
  waypointPlainText,
} from '../gpx-writer';
import { parseGpx } from '../gpx-parser';
import { processGpx } from '../gpx-processor';
import type { Trail, TrackPoint } from '../trail-utils';

function makeTrackPoints(): TrackPoint[] {
  const points: TrackPoint[] = [];
  // ~10 km of track heading south along lon 138 (0.009° lat ≈ 1 km)
  for (let i = 0; i <= 10; i++) {
    points.push({ lat: -35 - i * 0.009, lon: 138, ele: 100 + i * 10, dist: i });
  }
  return points;
}

function makeTrail(): Trail {
  const points = makeTrackPoints();
  return {
    config: {
      id: 'test-trail',
      name: 'Test Trail',
      shortName: 'TT',
      region: 'SA',
      lengthKm: 10,
      direction: { default: 'NOBO', reversed: 'SOBO' },
    },
    track: {
      points,
      totalDistance: 10,
      totalAscent: 100,
      totalDescent: 0,
    },
    waypoints: [
      { id: 'wp-0', name: 'Trailhead', lat: -35, lon: 138, type: 'trailhead', elevation: 100, totalDistance: 0 },
      { id: 'custom-abc', name: 'My spring', lat: -35.027, lon: 138, type: 'water', elevation: 130, totalDistance: 3, description: 'Reliable year round' },
      { id: 'custom-def', name: 'Washed-out crossing', lat: -35.063, lon: 138, type: 'hazard', elevation: 170, totalDistance: 7 },
    ],
    alternates: [
      {
        name: 'High Route',
        type: 'alternate',
        points: [
          { lat: -35.01, lon: 138.001, ele: 120, dist: 0 },
          { lat: -35.02, lon: 138.002, ele: 140, dist: 1.4 },
        ],
      },
    ],
    sideTrips: [],
  };
}

describe('escapeXml', () => {
  it('escapes all five XML special characters', () => {
    expect(escapeXml(`Tom & Jerry's <"tank">`)).toBe(
      'Tom &amp; Jerry&apos;s &lt;&quot;tank&quot;&gt;',
    );
  });

  it('strips XML-illegal control characters but keeps tab/newline/CR', () => {
    // A pasted bell (U+0007) and null (U+0000) would make strict parsers reject
    // the document; they are dropped.
    expect(escapeXml('Bell\u0007 and null\u0000 end')).toBe('Bell and null end');
    expect(escapeXml('vtab\u000b ff\u000c us\u001f x')).toBe('vtab ff us x');
    // Tab, LF, and CR are the only allowed C0 control characters — preserved.
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });
});

describe('waypointsToGpx', () => {
  it('emits a valid GPX 1.1 document with ele/time/name/desc/type', () => {
    const gpx = waypointsToGpx([
      {
        name: 'My spring',
        lat: -35.123456789,
        lon: 138.98765,
        ele: 412.34,
        type: 'water',
        description: 'Reliable year round',
        createdAt: '2026-07-11T04:30:00.000Z',
      },
    ], { name: 'Heysen — my waypoints' });

    expect(gpx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(gpx).toContain('<gpx version="1.1" creator="Trail Companion" xmlns="http://www.topografix.com/GPX/1/1">');
    expect(gpx).toContain('<name>Heysen — my waypoints</name>');
    expect(gpx).toContain('<wpt lat="-35.123457" lon="138.98765">');
    expect(gpx).toContain('<ele>412.3</ele>');
    expect(gpx).toContain('<time>2026-07-11T04:30:00.000Z</time>');
    expect(gpx).toContain('<name>My spring</name>');
    expect(gpx).toContain('<desc>Reliable year round</desc>');
    expect(gpx).toContain('<type>water</type>');
    expect(gpx.trim().endsWith('</gpx>')).toBe(true);
  });

  it('escapes XML in names and descriptions', () => {
    const gpx = waypointsToGpx([
      { name: 'Tank <2> & spring', lat: -35, lon: 138, description: `it's "iffy"` },
    ]);
    expect(gpx).toContain('<name>Tank &lt;2&gt; &amp; spring</name>');
    expect(gpx).toContain('<desc>it&apos;s &quot;iffy&quot;</desc>');
    expect(gpx).not.toContain('<name>Tank <2>');
  });

  it('omits optional elements when absent', () => {
    const gpx = waypointsToGpx([{ name: 'Bare', lat: -35, lon: 138 }]);
    expect(gpx).not.toContain('<ele>');
    expect(gpx).not.toContain('<time>');
    expect(gpx).not.toContain('<desc>');
    expect(gpx).not.toContain('<type>');
  });
});

describe('trailToGpx', () => {
  it('emits the main track, alternates as extra <trk>, and all waypoints', () => {
    const gpx = trailToGpx(makeTrail());
    // Two tracks: main + alternate
    expect(gpx.match(/<trk>/g)).toHaveLength(2);
    expect(gpx).toContain('<name>High Route</name>');
    // 11 main + 2 alternate points
    expect(gpx.match(/<trkpt /g)).toHaveLength(13);
    // All three waypoints
    expect(gpx.match(/<wpt /g)).toHaveLength(3);
    expect(gpx).toContain('<type>hazard</type>');
  });
});

describe('routeToGpx', () => {
  it('emits an <rte> with named <rtept> elements', () => {
    const gpx = routeToGpx('Lookout loop', [
      { lat: -35, lon: 138, ele: 100, name: 'Trailhead' },
      { lat: -35.027, lon: 138, ele: 130, name: 'My spring' },
    ]);
    expect(gpx).toContain('<rte>');
    expect(gpx).toContain('<name>Lookout loop</name>');
    expect(gpx.match(/<rtept /g)).toHaveLength(2);
    expect(gpx).toContain('<name>Trailhead</name>');
  });

  it('emits sketch points at their given lat/lon, with or without a name', () => {
    // A tap-to-sketch route (WS5.6): a named waypoint, a named on-track sketch
    // ("Point 2"), and an unnamed point (no <name> element at all).
    const gpx = routeToGpx('Detour', [
      { lat: -35, lon: 138, ele: 100, name: 'Trailhead' },
      { lat: -35.09, lon: 138, ele: 200, name: 'Point 2' },
      { lat: -35.135, lon: 138.01, ele: null, name: null },
    ]);
    expect(gpx.match(/<rtept /g)).toHaveLength(3);
    expect(gpx).toContain('<rtept lat="-35.09" lon="138">');
    expect(gpx).toContain('<name>Point 2</name>');
    // The unnamed off-track point keeps its true lat/lon and omits <name>/<ele>:
    // it serializes as a self-contained rtept with no children.
    expect(gpx).toContain('<rtept lat="-35.135" lon="138.01">\n    </rtept>');
    expect(gpx).not.toContain('<name>null</name>');
  });
});

describe('waypointPlainText', () => {
  it('formats the messaging one-liner', () => {
    expect(waypointPlainText({ name: 'My spring', lat: -35.123454, lon: 148.987654, kmPosition: 42.3 }))
      .toBe('My spring — -35.12345, 148.98765 (km 42.3)');
  });

  it('omits the km part when unknown', () => {
    expect(waypointPlainText({ name: 'Spot', lat: -35, lon: 148 }))
      .toBe('Spot — -35.00000, 148.00000');
  });
});

describe('round trip: export → parse → process', () => {
  it('the mobile parser reads back name/desc/type/position exactly', () => {
    const gpx = waypointsToGpx([
      {
        name: `Tom & Jerry's tank`,
        lat: -35.12345,
        lon: 138.98765,
        ele: 412,
        type: 'water-tank',
        description: 'Check <before> relying',
      },
    ]);
    const parsed = parseGpx(gpx);
    expect(parsed.waypoints).toHaveLength(1);
    expect(parsed.waypoints[0]).toMatchObject({
      name: `Tom & Jerry's tank`,
      desc: 'Check <before> relying',
      type: 'water-tank',
      lat: -35.12345,
      lon: 138.98765,
    });
  });

  it('a full trail export re-imports with names, types, and km positions intact', () => {
    const trail = makeTrail();
    const gpx = trailToGpx(trail);

    const { trail: reimported } = processGpx(gpx, { trailName: 'Test Trail' });

    // The main track (11 points) survives; the "High Route" alternate starts
    // ~9 km from the main line's end, so it is not chained in and stays a
    // separate alternate.
    expect(reimported.track.points.length).toBe(11);
    expect(reimported.track.totalDistance).toBeGreaterThanOrEqual(10);

    // Waypoints keep their exported name and explicit <type> (no name-based
    // reclassification), and land at the right spot along the track.
    const spring = reimported.waypoints.find(w => w.name === 'My spring');
    expect(spring).toBeDefined();
    expect(spring!.type).toBe('water');
    expect(spring!.totalDistance).toBeCloseTo(3, 0);

    const hazard = reimported.waypoints.find(w => w.name === 'Washed-out crossing');
    expect(hazard).toBeDefined();
    expect(hazard!.type).toBe('hazard');
    expect(hazard!.totalDistance).toBeCloseTo(7, 0);

    const trailhead = reimported.waypoints.find(w => w.name === 'Trailhead');
    expect(trailhead).toBeDefined();
    expect(trailhead!.type).toBe('trailhead');
  });

  it('preserves the variant kind (side-trip vs alternate) across a round trip', () => {
    const trail = makeTrail();
    // Add a side trip whose start is far from the main line's end so it stays a
    // separate variant rather than being chained into the main line.
    trail.sideTrips = [
      {
        name: 'Summit Spur',
        type: 'side-trip',
        points: [
          { lat: -35.2, lon: 138.2, ele: 300, dist: 0 },
          { lat: -35.21, lon: 138.21, ele: 350, dist: 1.4 },
        ],
      },
    ];

    const gpx = trailToGpx(trail);
    const { trail: reimported } = processGpx(gpx, { trailName: 'Test Trail' });

    // The exporter writes <trk><type>side-trip</type>; the importer must read
    // that back rather than flattening every secondary track to 'alternate'.
    const spur = (reimported.alternates ?? []).find((a) => a.name === 'Summit Spur');
    expect(spur).toBeDefined();
    expect(spur!.type).toBe('side-trip');

    const highRoute = (reimported.alternates ?? []).find((a) => a.name === 'High Route');
    expect(highRoute).toBeDefined();
    expect(highRoute!.type).toBe('alternate');
  });
});
