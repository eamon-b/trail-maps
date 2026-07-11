/**
 * Real-world GPX format tests.
 *
 * Tests GPX patterns from specific apps: Gaia GPS, AllTrails, Strava,
 * Garmin Connect, and CalTopo. Uses small synthetic files that reproduce
 * each app's structural quirks.
 */

import { parseGpx } from '../gpx-parser';
import { processGpx } from '../gpx-processor';

// ---------------------------------------------------------------------------
// Gaia GPS style: single <trk>, single <trkseg>, Garmin-style extensions
// ---------------------------------------------------------------------------

const GAIA_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Gaia GPS"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <name>Morning Hike</name>
    <time>2024-03-15T06:00:00Z</time>
  </metadata>
  <trk>
    <name>Morning Hike</name>
    <trkseg>
      <trkpt lat="-33.7274" lon="150.3118">
        <ele>823.4</ele>
        <time>2024-03-15T06:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>95</gpxtpx:hr>
            <gpxtpx:cad>72</gpxtpx:cad>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="-33.7280" lon="150.3125">
        <ele>830.1</ele>
        <time>2024-03-15T06:05:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>110</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="-33.7290" lon="150.3130">
        <ele>845.7</ele>
        <time>2024-03-15T06:10:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
  <wpt lat="-33.7280" lon="150.3125">
    <ele>830</ele>
    <name>W Creek Crossing</name>
    <desc>Seasonal water source</desc>
  </wpt>
</gpx>`;

describe('Gaia GPS style', () => {
  it('parses tracks while ignoring Garmin extensions', () => {
    const data = parseGpx(GAIA_STYLE);
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].name).toBe('Morning Hike');
    expect(data.tracks[0].segments[0].points).toHaveLength(3);
    expect(data.tracks[0].segments[0].points[0].ele).toBeCloseTo(823.4, 1);
    expect(data.tracks[0].segments[0].points[0].time).toBe('2024-03-15T06:00:00Z');
  });

  it('processes end-to-end', () => {
    const { trail, warnings } = processGpx(GAIA_STYLE);
    expect(trail.track.points).toHaveLength(3);
    expect(trail.waypoints).toHaveLength(1);
    expect(trail.waypoints[0].type).toBe('water');
  });
});

// ---------------------------------------------------------------------------
// AllTrails style: route-only export (<rte> with <rtept>, no <trk>)
// ---------------------------------------------------------------------------

const ALLTRAILS_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AllTrails https://www.alltrails.com"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Blue Mountains Walk</name>
    <desc>A scenic walk through the Blue Mountains</desc>
  </metadata>
  <rte>
    <name>Blue Mountains Walk</name>
    <rtept lat="-33.7100" lon="150.3100"><ele>900</ele></rtept>
    <rtept lat="-33.7110" lon="150.3110"><ele>895</ele></rtept>
    <rtept lat="-33.7120" lon="150.3120"><ele>885</ele></rtept>
    <rtept lat="-33.7130" lon="150.3130"><ele>870</ele></rtept>
    <rtept lat="-33.7140" lon="150.3140"><ele>860</ele></rtept>
  </rte>
</gpx>`;

describe('AllTrails style (route-only)', () => {
  it('parses route points', () => {
    const data = parseGpx(ALLTRAILS_STYLE);
    expect(data.tracks).toHaveLength(0);
    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].points).toHaveLength(5);
  });

  it('processes route-only GPX into a valid trail', () => {
    const { trail } = processGpx(ALLTRAILS_STYLE);
    expect(trail.track.points).toHaveLength(5);
    expect(trail.track.totalDistance).toBeGreaterThan(0);
    expect(trail.config.name).toBe('Blue Mountains Walk');
  });
});

// ---------------------------------------------------------------------------
// Strava style: single track, multiple segments (paused recording splits)
// ---------------------------------------------------------------------------

const STRAVA_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <metadata>
    <time>2024-06-01T07:00:00Z</time>
  </metadata>
  <trk>
    <name>Morning Run</name>
    <type>9</type>
    <trkseg>
      <trkpt lat="-33.8500" lon="151.2100">
        <ele>5.2</ele>
        <time>2024-06-01T07:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension><gpxtpx:hr>130</gpxtpx:hr></gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="-33.8510" lon="151.2110">
        <ele>6.1</ele>
        <time>2024-06-01T07:01:00Z</time>
      </trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="-33.8520" lon="151.2120">
        <ele>4.8</ele>
        <time>2024-06-01T07:10:00Z</time>
      </trkpt>
      <trkpt lat="-33.8530" lon="151.2130">
        <ele>5.5</ele>
        <time>2024-06-01T07:11:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('Strava style (paused segments)', () => {
  it('parses multiple segments within one track', () => {
    const data = parseGpx(STRAVA_STYLE);
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].segments).toHaveLength(2);
    expect(data.tracks[0].segments[0].points).toHaveLength(2);
    expect(data.tracks[0].segments[1].points).toHaveLength(2);
  });

  it('merges segments into continuous track', () => {
    const { trail } = processGpx(STRAVA_STYLE);
    expect(trail.track.points).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Garmin Connect style: multiple <trk> elements (multi-day or multi-activity)
// plus <type> elements and Garmin-specific metadata
// ---------------------------------------------------------------------------

const GARMIN_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3">
  <metadata>
    <link href="connect.garmin.com">
      <text>Garmin Connect</text>
    </link>
    <time>2024-04-20T05:30:00Z</time>
  </metadata>
  <trk>
    <name>Day 1 - Trailhead to Camp</name>
    <type>hiking</type>
    <trkseg>
      <trkpt lat="-36.0500" lon="148.3500">
        <ele>1200</ele>
        <time>2024-04-20T05:30:00Z</time>
        <extensions>
          <ns3:TrackPointExtension>
            <ns3:atemp>8.0</ns3:atemp>
          </ns3:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="-36.0510" lon="148.3510">
        <ele>1250</ele>
        <time>2024-04-20T06:00:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Day 2 - Camp to Summit</name>
    <type>hiking</type>
    <trkseg>
      <trkpt lat="-36.0520" lon="148.3520">
        <ele>1260</ele>
        <time>2024-04-21T06:00:00Z</time>
      </trkpt>
      <trkpt lat="-36.0530" lon="148.3530">
        <ele>1400</ele>
        <time>2024-04-21T08:00:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
  <wpt lat="-36.0510" lon="148.3510">
    <ele>1250</ele>
    <name>C Base Camp</name>
    <desc>Good tent platforms</desc>
    <sym>Campground</sym>
  </wpt>
</gpx>`;

describe('Garmin Connect style (multi-track, Garmin extensions)', () => {
  it('parses multiple tracks', () => {
    const data = parseGpx(GARMIN_STYLE);
    expect(data.tracks).toHaveLength(2);
    expect(data.tracks[0].name).toBe('Day 1 - Trailhead to Camp');
    expect(data.tracks[1].name).toBe('Day 2 - Camp to Summit');
  });

  it('ignores Garmin-specific elements like <type>, <sym>, <link>', () => {
    const data = parseGpx(GARMIN_STYLE);
    expect(data.waypoints[0].name).toBe('C Base Camp');
    expect(data.tracks[0].segments[0].points[0].ele).toBe(1200);
  });

  it('keeps the first track as main and preserves the second as an alternate', () => {
    const { trail } = processGpx(GARMIN_STYLE);
    // Day 1 is the main line; Day 2 is preserved as an alternate the import
    // preview can include/exclude (P2 decision 10)
    expect(trail.track.points).toHaveLength(2);
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Day 2 - Camp to Summit');
    expect(trail.alternates![0].points).toHaveLength(2);
    expect(trail.waypoints).toHaveLength(1);
    expect(trail.waypoints[0].type).toBe('campsite');
  });
});

// ---------------------------------------------------------------------------
// CalTopo style: waypoints with detailed names, high-precision coordinates
// ---------------------------------------------------------------------------

const CALTOPO_STYLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CalTopo"
  xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>PCT Section J</name>
    <trkseg>
      <trkpt lat="-33.123456789" lon="150.987654321"><ele>1523.456</ele></trkpt>
      <trkpt lat="-33.124567890" lon="150.988765432"><ele>1530.789</ele></trkpt>
      <trkpt lat="-33.125678901" lon="150.989876543"><ele>1528.123</ele></trkpt>
    </trkseg>
  </trk>
  <wpt lat="-33.1240" lon="150.9882">
    <ele>1527</ele>
    <name>WT:Tank - Seasonal</name>
    <desc>Tank at trail junction, check levels in summer</desc>
  </wpt>
  <wpt lat="-33.1255" lon="150.9895">
    <ele>1529</ele>
    <name>S:Southern Terminus</name>
    <desc>Trail endpoint marker</desc>
  </wpt>
</gpx>`;

describe('CalTopo style (high-precision, detailed waypoints)', () => {
  it('preserves high-precision coordinates', () => {
    const data = parseGpx(CALTOPO_STYLE);
    expect(data.tracks[0].segments[0].points[0].lat).toBeCloseTo(-33.123456789, 6);
    expect(data.tracks[0].segments[0].points[0].lon).toBeCloseTo(150.987654321, 6);
  });

  it('processes with coordinate rounding', () => {
    const { trail } = processGpx(CALTOPO_STYLE, { coordinatePrecision: 6 });
    const p = trail.track.points[0];
    // Should be rounded to 6 decimal places
    const decimals = p.lat.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it('classifies waypoint prefixes correctly', () => {
    const { trail } = processGpx(CALTOPO_STYLE, { waypointMaxDistance: 1000 });
    const waterTank = trail.waypoints.find((w) => w.name.includes('Tank'));
    const endpoint = trail.waypoints.find((w) => w.name.includes('Terminus'));
    if (waterTank) expect(waterTank.type).toBe('water-tank');
    if (endpoint) expect(endpoint.type).toBe('endpoint');
  });
});

// ---------------------------------------------------------------------------
// Edge case: GPX 1.0 format (slightly different structure)
// ---------------------------------------------------------------------------

const GPX_1_0 = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.0" creator="OldApp"
  xmlns="http://www.topografix.com/GPX/1/0">
  <trk>
    <name>Old Format Trail</name>
    <trkseg>
      <trkpt lat="-33.5" lon="151.0"><ele>100</ele></trkpt>
      <trkpt lat="-33.6" lon="151.1"><ele>200</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('GPX 1.0 format', () => {
  it('parses GPX 1.0 files', () => {
    const data = parseGpx(GPX_1_0);
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].segments[0].points).toHaveLength(2);
  });

  it('processes GPX 1.0 into valid trail', () => {
    const { trail } = processGpx(GPX_1_0);
    expect(trail.track.points).toHaveLength(2);
    expect(trail.track.totalDistance).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case: empty track name, no metadata
// ---------------------------------------------------------------------------

const BARE_BONES = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk>
    <trkseg>
      <trkpt lat="-33.0" lon="151.0"><ele>100</ele></trkpt>
      <trkpt lat="-33.1" lon="151.1"><ele>200</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('bare bones GPX (no names, no metadata)', () => {
  it('parses successfully', () => {
    const data = parseGpx(BARE_BONES);
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].name).toBe('');
  });

  it('assigns default trail name', () => {
    const { trail } = processGpx(BARE_BONES);
    expect(trail.config.name).toBe('Custom Trail');
  });
});
