import {
  processGpx,
  processGpxBytes,
  douglasPeucker,
  removeElevationSpikes,
  smoothElevation,
  GpxParseError,
} from '../gpx-processor';
import type { GpxPoint } from '@lib/types';

// ---------------------------------------------------------------------------
// Helper: build GPX XML
// ---------------------------------------------------------------------------

function gpxWrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"
  xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;
}

/** Generate a line of track points between two lat/lon pairs. */
function makeTrackXml(
  points: { lat: number; lon: number; ele: number }[],
  name = 'Test Track',
): string {
  const trkpts = points
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`)
    .join('\n          ');
  return `
    <trk>
      <name>${name}</name>
      <trkseg>
        ${trkpts}
      </trkseg>
    </trk>`;
}

/** Create a simple linear trail along a latitude line. */
function makeLinearTrail(count: number, startLat = -33.0, startLon = 151.0): { lat: number; lon: number; ele: number }[] {
  const points: { lat: number; lon: number; ele: number }[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: startLat - i * 0.001,
      lon: startLon + i * 0.001,
      ele: 100 + i * 2,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Douglas-Peucker
// ---------------------------------------------------------------------------

describe('douglasPeucker', () => {
  const makePoint = (lat: number, lon: number, ele = 0): GpxPoint => ({
    lat,
    lon,
    ele,
    time: null,
  });

  it('returns input when 2 or fewer points', () => {
    const p = [makePoint(0, 0), makePoint(1, 1)];
    expect(douglasPeucker(p, 100)).toHaveLength(2);
    expect(douglasPeucker([makePoint(0, 0)], 100)).toHaveLength(1);
  });

  it('keeps endpoints of a straight line', () => {
    // Points on a straight line should simplify to just the endpoints
    const points = [
      makePoint(-33.0, 151.0),
      makePoint(-33.001, 151.001),
      makePoint(-33.002, 151.002),
      makePoint(-33.003, 151.003),
    ];
    const result = douglasPeucker(points, 50);
    expect(result.length).toBeLessThanOrEqual(points.length);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
  });

  it('preserves corners with tight tolerance', () => {
    // L-shaped path: go east then south
    const points = [
      makePoint(-33.0, 151.0),
      makePoint(-33.0, 151.01),
      makePoint(-33.0, 151.02), // corner
      makePoint(-33.01, 151.02),
      makePoint(-33.02, 151.02),
    ];
    const result = douglasPeucker(points, 1); // 1 meter tolerance
    expect(result.length).toBeGreaterThanOrEqual(3); // at least start, corner, end
  });

  it('reduces points with large tolerance', () => {
    const points = makeLinearTrail(100).map((p) => ({ ...p, time: null as string | null }));
    const result = douglasPeucker(points, 1000);
    expect(result.length).toBeLessThan(points.length);
    expect(result.length).toBeGreaterThanOrEqual(2); // always keeps start+end
  });
});

// ---------------------------------------------------------------------------
// Elevation spike removal
// ---------------------------------------------------------------------------

describe('removeElevationSpikes', () => {
  const makePoint = (ele: number): GpxPoint => ({
    lat: -33,
    lon: 151,
    ele,
    time: null,
  });

  it('returns unchanged points when no spikes', () => {
    const points = [makePoint(100), makePoint(110), makePoint(120)];
    const { points: result, spikeCount } = removeElevationSpikes(points, 50);
    expect(spikeCount).toBe(0);
    expect(result).toBe(points); // same reference when no changes
  });

  it('detects and interpolates spikes', () => {
    const points = [
      makePoint(100),
      makePoint(500), // spike: 400m above both neighbors
      makePoint(110),
    ];
    const { points: result, spikeCount } = removeElevationSpikes(points, 50);
    expect(spikeCount).toBe(1);
    // Interpolated value should be between neighbors
    expect(result[1].ele).toBeCloseTo(105, 0);
  });

  it('handles consecutive spikes', () => {
    // Point at index 2 is higher than both neighbors (500 and 110) -> spike
    // Point at index 1 is between 100 and 600, so rises from prev and drops to next
    //   -> NOT same-direction deviation, so only index 2 is a spike
    const points = [
      makePoint(100),
      makePoint(500),
      makePoint(600), // spike: higher than both neighbors
      makePoint(110),
    ];
    const { points: result, spikeCount } = removeElevationSpikes(points, 50);
    expect(spikeCount).toBe(1);
    // Index 2 should be interpolated between neighbors
    expect(result[2].ele).toBeGreaterThan(109);
    expect(result[2].ele).toBeLessThan(501);
  });

  it('handles true consecutive spikes (both deviate from neighbors)', () => {
    // Two isolated spikes separated by non-spike points
    const points = [
      makePoint(100),
      makePoint(500), // higher than 100 and 105 -> spike
      makePoint(105),
      makePoint(108),
      makePoint(600), // higher than 108 and 112 -> spike
      makePoint(112),
    ];
    const { spikeCount } = removeElevationSpikes(points, 50);
    expect(spikeCount).toBe(2);
  });

  it('leaves legitimate elevation changes alone', () => {
    // Gradual climb - each step is within threshold
    const points = [
      makePoint(100),
      makePoint(140),
      makePoint(180),
      makePoint(220),
    ];
    const { spikeCount } = removeElevationSpikes(points, 50);
    expect(spikeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Elevation smoothing
// ---------------------------------------------------------------------------

describe('smoothElevation', () => {
  const makePoint = (ele: number): GpxPoint => ({
    lat: -33,
    lon: 151,
    ele,
    time: null,
  });

  it('smooths noisy elevation data', () => {
    const points = [
      makePoint(100),
      makePoint(110),
      makePoint(90),
      makePoint(105),
      makePoint(95),
      makePoint(100),
      makePoint(110),
    ];
    const result = smoothElevation(points, 3);
    // Middle points should be averaged
    expect(result[1].ele).toBeCloseTo(100, 0); // avg of 100, 110, 90
    expect(result.length).toBe(points.length);
  });

  it('returns input when fewer points than window', () => {
    const points = [makePoint(100), makePoint(200)];
    const result = smoothElevation(points, 5);
    expect(result).toBe(points);
  });

  it('preserves lat/lon while smoothing ele', () => {
    const points: GpxPoint[] = [
      { lat: -33.0, lon: 151.0, ele: 100, time: null },
      { lat: -33.1, lon: 151.1, ele: 200, time: null },
      { lat: -33.2, lon: 151.2, ele: 300, time: null },
    ];
    const result = smoothElevation(points, 3);
    expect(result[0].lat).toBe(-33.0);
    expect(result[1].lon).toBe(151.1);
  });
});

// ---------------------------------------------------------------------------
// Full processing pipeline
// ---------------------------------------------------------------------------

describe('processGpx', () => {
  it('processes a simple single-track GPX', () => {
    const points = makeLinearTrail(20);
    const xml = gpxWrap(makeTrackXml(points));

    const { trail } = processGpx(xml);

    expect(trail.config.name).toBe('Test Track');
    expect(trail.track.points.length).toBe(20);
    expect(trail.track.totalDistance).toBeGreaterThan(0);
    expect(trail.track.totalAscent).toBeGreaterThan(0);
    // Points should have cumulative distance
    expect(trail.track.points[0].dist).toBe(0);
    expect(trail.track.points[19].dist).toBeGreaterThan(0);
  });

  it('handles a GPX with only routes (no tracks)', () => {
    const xml = gpxWrap(`
      <rte>
        <name>Route Only</name>
        <rtept lat="-33.0" lon="151.0"><ele>100</ele></rtept>
        <rtept lat="-33.01" lon="151.01"><ele>200</ele></rtept>
        <rtept lat="-33.02" lon="151.02"><ele>300</ele></rtept>
      </rte>
    `);

    const { trail } = processGpx(xml);
    expect(trail.track.points.length).toBe(3);
    expect(trail.track.totalDistance).toBeGreaterThan(0);
  });

  it('merges multiple track segments', () => {
    const xml = gpxWrap(`
      <trk><name>Multi</name>
        <trkseg>
          <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
          <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="-33.002" lon="151.002"><ele>120</ele></trkpt>
          <trkpt lat="-33.003" lon="151.003"><ele>130</ele></trkpt>
        </trkseg>
      </trk>
    `);

    const { trail } = processGpx(xml);
    expect(trail.track.points.length).toBe(4);
  });

  it('chains a contiguous second track into the main line', () => {
    // "Part 1"/"Part 2" of one continuous recording: Part 2 starts ~140 m from
    // where Part 1 ended, so it is a continuation, not a separate alternate.
    const xml = gpxWrap(`
      <trk><name>Part 1</name><trkseg>
        <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
        <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
      </trkseg></trk>
      <trk><name>Part 2</name><trkseg>
        <trkpt lat="-33.002" lon="151.002"><ele>120</ele></trkpt>
        <trkpt lat="-33.003" lon="151.003"><ele>130</ele></trkpt>
      </trkseg></trk>
    `);

    const { trail, warnings } = processGpx(xml);
    // Both tracks merged into one main line; nothing left as an alternate.
    expect(trail.track.points.length).toBe(4);
    expect(trail.alternates ?? []).toHaveLength(0);
    expect(warnings.some((w) => w.type === 'alternates_preserved')).toBe(false);
  });

  it('keeps a divergent secondary track as an alternate', () => {
    // A second track that does NOT continue from the first (far from its end)
    // is preserved as a dashed alternate rather than folded into the main line.
    const xml = gpxWrap(`
      <trk><name>Main</name><trkseg>
        <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
        <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
      </trkseg></trk>
      <trk><name>Detour</name><trkseg>
        <trkpt lat="-33.5" lon="151.5"><ele>120</ele></trkpt>
        <trkpt lat="-33.501" lon="151.501"><ele>130</ele></trkpt>
      </trkseg></trk>
    `);

    const { trail, warnings } = processGpx(xml);
    expect(trail.track.points.length).toBe(2);
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Detour');
    expect(trail.alternates![0].type).toBe('alternate');
    expect(trail.alternates![0].points).toHaveLength(2);
    expect(warnings.some((w) => w.type === 'alternates_preserved' && w.count === 1)).toBe(true);
  });

  it('produces display points for large tracks', () => {
    const points = makeLinearTrail(5000);
    const xml = gpxWrap(makeTrackXml(points));

    const { trail } = processGpx(xml, { targetDisplayPoints: 100 });
    expect(trail.track.displayPoints!.length).toBeLessThan(5000);
    expect(trail.track.displayPoints!.length).toBeGreaterThanOrEqual(2);
  });

  it('warns when no elevation data', () => {
    const xml = gpxWrap(`
      <trk><name>Flat</name><trkseg>
        <trkpt lat="-33.0" lon="151.0"></trkpt>
        <trkpt lat="-33.1" lon="151.1"></trkpt>
      </trkseg></trk>
    `);

    const { warnings } = processGpx(xml);
    expect(warnings.some((w) => w.type === 'no_elevation')).toBe(true);
  });

  it('warns when no waypoints', () => {
    const points = makeLinearTrail(5);
    const xml = gpxWrap(makeTrackXml(points));

    const { warnings } = processGpx(xml);
    expect(warnings.some((w) => w.type === 'no_waypoints')).toBe(true);
  });

  it('uses custom trail name when provided', () => {
    const points = makeLinearTrail(5);
    const xml = gpxWrap(makeTrackXml(points));

    const { trail } = processGpx(xml, { trailName: 'My Custom Trail' });
    expect(trail.config.name).toBe('My Custom Trail');
    expect(trail.config.id).toBe('my-custom-trail');
  });

  it('calls progress callback', () => {
    const points = makeLinearTrail(5);
    const xml = gpxWrap(makeTrackXml(points));

    const stages: string[] = [];
    processGpx(xml, {
      onProgress: (stage) => stages.push(stage),
    });

    expect(stages).toContain('Parsing GPX');
    expect(stages).toContain('Complete');
    expect(stages.length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Waypoint processing
// ---------------------------------------------------------------------------

describe('waypoint processing', () => {
  it('snaps waypoints to track and enriches with distance', () => {
    // A trail going south along 151.0 longitude
    const trackPts = [];
    for (let i = 0; i < 50; i++) {
      trackPts.push({ lat: -33.0 - i * 0.001, lon: 151.0, ele: 100 + i });
    }

    // A waypoint near the track at about index 25
    const xml = gpxWrap(`
      ${makeTrackXml(trackPts)}
      <wpt lat="${-33.025}" lon="151.0001">
        <name>W Creek Crossing</name>
        <desc>Fresh water</desc>
      </wpt>
    `);

    const { trail, warnings } = processGpx(xml, { waypointMaxDistance: 500 });
    expect(trail.waypoints.length).toBe(1);
    expect(trail.waypoints[0].name).toBe('Creek Crossing'); // cleaned prefix
    expect(trail.waypoints[0].type).toBe('water'); // classified from W prefix
    expect(trail.waypoints[0].totalDistance).toBeGreaterThan(0);
    expect(trail.waypoints[0].elevation).toBeDefined();
    expect(trail.waypoints[0].trackIndex).toBeDefined();
    expect(warnings.some((w) => w.type === 'orphaned_waypoints')).toBe(false);
  });

  it('reports orphaned waypoints far from track', () => {
    const trackPts = makeLinearTrail(10);
    const xml = gpxWrap(`
      ${makeTrackXml(trackPts)}
      <wpt lat="-40.0" lon="140.0">
        <name>Far Away</name>
      </wpt>
    `);

    const { trail, warnings } = processGpx(xml);
    expect(trail.waypoints.length).toBe(0); // not snapped
    expect(warnings.some((w) => w.type === 'orphaned_waypoints')).toBe(true);
  });

  it('handles multiple waypoints along a track', () => {
    const trackPts = [];
    for (let i = 0; i < 100; i++) {
      trackPts.push({ lat: -33.0 - i * 0.001, lon: 151.0, ele: 100 + i });
    }

    const xml = gpxWrap(`
      ${makeTrackXml(trackPts)}
      <wpt lat="${-33.01}" lon="151.0"><name>C Camp 1</name></wpt>
      <wpt lat="${-33.05}" lon="151.0"><name>W Water</name></wpt>
      <wpt lat="${-33.09}" lon="151.0"><name>C Camp 2</name></wpt>
    `);

    const { trail } = processGpx(xml, { waypointMaxDistance: 500 });
    expect(trail.waypoints.length).toBe(3);
    // Waypoints should be in track order
    expect(trail.waypoints[0].totalDistance).toBeLessThan(trail.waypoints[1].totalDistance!);
    expect(trail.waypoints[1].totalDistance!).toBeLessThan(trail.waypoints[2].totalDistance!);
    // Segment distances should be positive
    expect(trail.waypoints[1].distance).toBeGreaterThan(0);
  });

  it('ignores an unknown third-party <type> and falls back to name classification', () => {
    // OsmAnd writes the category ("Favorites") into <type>. Trusting it verbatim
    // would skip the name classifier and drop this water source out of the
    // water-carry calculator's allow-list.
    const trackPts = [];
    for (let i = 0; i < 50; i++) {
      trackPts.push({ lat: -33.0 - i * 0.001, lon: 151.0, ele: 100 + i });
    }
    const xml = gpxWrap(`
      ${makeTrackXml(trackPts)}
      <wpt lat="-33.025" lon="151.0001">
        <name>W Ephemeral Creek</name>
        <type>Favorites</type>
      </wpt>
    `);

    const { trail } = processGpx(xml, { waypointMaxDistance: 500 });
    expect(trail.waypoints.length).toBe(1);
    expect(trail.waypoints[0].type).toBe('water');
    expect(trail.waypoints[0].name).toBe('Ephemeral Creek');
  });

  it('honors a <type> that matches a registry type', () => {
    const trackPts = [];
    for (let i = 0; i < 50; i++) {
      trackPts.push({ lat: -33.0 - i * 0.001, lon: 151.0, ele: 100 + i });
    }
    const xml = gpxWrap(`
      ${makeTrackXml(trackPts)}
      <wpt lat="-33.025" lon="151.0001">
        <name>Rockfall zone</name>
        <type>hazard</type>
      </wpt>
    `);

    const { trail } = processGpx(xml, { waypointMaxDistance: 500 });
    expect(trail.waypoints.length).toBe(1);
    expect(trail.waypoints[0].type).toBe('hazard');
    // Registry <type> wins, so the name is preserved untouched.
    expect(trail.waypoints[0].name).toBe('Rockfall zone');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('processGpx error handling', () => {
  it('throws on empty GPX', () => {
    expect(() => processGpx('')).toThrow(GpxParseError);
  });

  it('throws on GPX with no tracks or routes', () => {
    const xml = gpxWrap(`
      <wpt lat="-33" lon="151"><name>Only Waypoints</name></wpt>
    `);
    expect(() => processGpx(xml)).toThrow('no track data');
  });

  it('throws on non-GPX XML', () => {
    expect(() => processGpx('<?xml version="1.0"?><root/>')).toThrow(GpxParseError);
  });
});

// ---------------------------------------------------------------------------
// processGpxBytes
// ---------------------------------------------------------------------------

describe('processGpxBytes', () => {
  it('processes from ArrayBuffer', () => {
    const points = makeLinearTrail(10);
    const xml = gpxWrap(makeTrackXml(points));
    const encoder = new TextEncoder();
    const bytes = encoder.encode(xml).buffer;

    const { trail } = processGpxBytes(bytes);
    expect(trail.track.points.length).toBe(10);
  });

  it('rejects oversized ArrayBuffers', () => {
    // Create a fake large buffer (we just need to check the length)
    const buf = new ArrayBuffer(51 * 1024 * 1024);
    expect(() => processGpxBytes(buf)).toThrow('exceeds');
  });
});

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

describe('gap detection', () => {
  it('warns about large gaps between segments', () => {
    const xml = gpxWrap(`
      <trk><name>Gapped</name>
        <trkseg>
          <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
          <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="-34.0" lon="152.0"><ele>200</ele></trkpt>
          <trkpt lat="-34.001" lon="152.001"><ele>210</ele></trkpt>
        </trkseg>
      </trk>
    `);

    const { warnings } = processGpx(xml);
    expect(warnings.some((w) => w.type === 'track_gaps')).toBe(true);
  });

  it('does not warn about small gaps', () => {
    const xml = gpxWrap(`
      <trk><name>Close</name>
        <trkseg>
          <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
          <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="-33.0011" lon="151.0011"><ele>111</ele></trkpt>
          <trkpt lat="-33.002" lon="151.002"><ele>120</ele></trkpt>
        </trkseg>
      </trk>
    `);

    const { warnings } = processGpx(xml);
    expect(warnings.some((w) => w.type === 'track_gaps')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trail output structure
// ---------------------------------------------------------------------------

describe('output structure matches Trail type', () => {
  it('has all required Trail fields', () => {
    const points = makeLinearTrail(10);
    const xml = gpxWrap(makeTrackXml(points));
    const { trail } = processGpx(xml);

    // config
    expect(trail.config.id).toBeDefined();
    expect(trail.config.name).toBeDefined();
    expect(trail.config.shortName).toBeDefined();
    expect(trail.config.region).toBe('Custom');
    expect(trail.config.lengthKm).toBeGreaterThan(0);
    expect(trail.config.direction).toEqual({
      default: 'Start to End',
      reversed: 'End to Start',
    });

    // track
    expect(trail.track.points.length).toBeGreaterThan(0);
    expect(trail.track.totalDistance).toBeGreaterThan(0);
    expect(typeof trail.track.totalAscent).toBe('number');
    expect(typeof trail.track.totalDescent).toBe('number');

    // waypoints (empty since none in GPX)
    expect(Array.isArray(trail.waypoints)).toBe(true);

    // alternates and sideTrips (empty for MVP)
    expect(trail.alternates).toEqual([]);
    expect(trail.sideTrips).toEqual([]);
  });

  it('track points have dist field with cumulative distance', () => {
    const points = makeLinearTrail(10);
    const xml = gpxWrap(makeTrackXml(points));
    const { trail } = processGpx(xml);

    expect(trail.track.points[0].dist).toBe(0);
    for (let i = 1; i < trail.track.points.length; i++) {
      expect(trail.track.points[i].dist).toBeGreaterThan(trail.track.points[i - 1].dist);
    }
  });
});
