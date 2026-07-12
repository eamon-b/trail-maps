/**
 * Fixtures for GPX alternate preservation (P2 decision 10): secondary <trk>s
 * and <rte>s become alternates instead of being folded into the main line.
 * Covers multi-trk, rte-only, and mixed files.
 */
import { processGpx } from '../gpx-processor';

function gpxWrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"
  xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;
}

const MAIN_TRACK = `
  <trk><name>Main Trail</name>
    <trkseg>
      <trkpt lat="-33.000" lon="151.000"><ele>100</ele></trkpt>
      <trkpt lat="-33.010" lon="151.010"><ele>150</ele></trkpt>
      <trkpt lat="-33.020" lon="151.020"><ele>200</ele></trkpt>
    </trkseg>
  </trk>`;

const SECOND_TRACK = `
  <trk><name>High Water Alternate</name>
    <trkseg>
      <trkpt lat="-33.005" lon="151.005"><ele>120</ele></trkpt>
      <trkpt lat="-33.015" lon="151.015"><ele>170</ele></trkpt>
    </trkseg>
  </trk>`;

const ROUTE = `
  <rte><name>Summit Route</name>
    <rtept lat="-33.001" lon="151.002"><ele>105</ele></rtept>
    <rtept lat="-33.011" lon="151.012"><ele>155</ele></rtept>
    <rtept lat="-33.021" lon="151.022"><ele>205</ele></rtept>
  </rte>`;

describe('gpx alternates preservation', () => {
  it('multi-trk: first track is main, later tracks become alternates', () => {
    const { trail, warnings } = processGpx(gpxWrap(MAIN_TRACK + SECOND_TRACK));

    expect(trail.track.points).toHaveLength(3);
    expect(trail.alternates).toHaveLength(1);

    const alt = trail.alternates![0];
    expect(alt.name).toBe('High Water Alternate');
    expect(alt.type).toBe('alternate');
    expect(alt.points).toHaveLength(2);
    // Alternate carries its own cumulative distance
    expect(alt.points![0].dist).toBe(0);
    expect(alt.points![1].dist).toBeGreaterThan(0);
    expect(alt.distance).toBeGreaterThan(0);

    expect(warnings.some((w) => w.type === 'alternates_preserved')).toBe(true);
  });

  it('mixed: <rte> in a track file becomes an alternate, not part of the main line', () => {
    const { trail } = processGpx(gpxWrap(MAIN_TRACK + ROUTE));

    // Previously the route points were appended to the main track (6 points)
    expect(trail.track.points).toHaveLength(3);
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Summit Route');
    expect(trail.alternates![0].points).toHaveLength(3);
  });

  it('rte-only: first route is the main line, later routes are alternates', () => {
    const secondRoute = `
      <rte><name>Return Leg</name>
        <rtept lat="-33.030" lon="151.030"><ele>210</ele></rtept>
        <rtept lat="-33.040" lon="151.040"><ele>190</ele></rtept>
      </rte>`;
    const { trail } = processGpx(gpxWrap(ROUTE + secondRoute));

    expect(trail.track.points).toHaveLength(3);
    expect(trail.config.name).toBe('Summit Route');
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Return Leg');
  });

  it('multi-segment first track still merges into one main line (pause splits)', () => {
    const segmented = `
      <trk><name>Segmented</name>
        <trkseg>
          <trkpt lat="-33.000" lon="151.000"><ele>100</ele></trkpt>
          <trkpt lat="-33.001" lon="151.001"><ele>110</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="-33.002" lon="151.002"><ele>120</ele></trkpt>
          <trkpt lat="-33.003" lon="151.003"><ele>130</ele></trkpt>
        </trkseg>
      </trk>`;
    const { trail } = processGpx(gpxWrap(segmented));

    expect(trail.track.points).toHaveLength(4);
    expect(trail.alternates ?? []).toHaveLength(0);
  });

  it('single-track single-route-free files produce no alternates and no warning', () => {
    const { trail, warnings } = processGpx(gpxWrap(MAIN_TRACK));
    expect(trail.alternates ?? []).toHaveLength(0);
    expect(warnings.some((w) => w.type === 'alternates_preserved')).toBe(false);
  });

  it('names unnamed secondary tracks and single-point extras are dropped', () => {
    const unnamed = `
      <trk><trkseg>
        <trkpt lat="-33.005" lon="151.005"><ele>120</ele></trkpt>
        <trkpt lat="-33.015" lon="151.015"><ele>170</ele></trkpt>
      </trkseg></trk>
      <trk><name>Lone Point</name><trkseg>
        <trkpt lat="-33.050" lon="151.050"><ele>300</ele></trkpt>
      </trkseg></trk>`;
    const { trail } = processGpx(gpxWrap(MAIN_TRACK + unnamed));

    // The unnamed track starts ~2.2 km from the main end, so it does not chain
    // and remains an alternate. Unnamed tracks are numbered per kind ("Track N").
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Track 1');
  });

  it('numbers unnamed fallback names per kind (Track N vs Route N)', () => {
    // An unnamed secondary track followed by an unnamed route: the shared
    // counter previously mislabeled the route as "Route 2".
    const unnamedTrack = `
      <trk><trkseg>
        <trkpt lat="-33.005" lon="151.005"><ele>120</ele></trkpt>
        <trkpt lat="-33.015" lon="151.015"><ele>170</ele></trkpt>
      </trkseg></trk>`;
    const unnamedRoute = `
      <rte>
        <rtept lat="-33.060" lon="151.060"><ele>250</ele></rtept>
        <rtept lat="-33.070" lon="151.070"><ele>260</ele></rtept>
      </rte>`;
    const { trail } = processGpx(gpxWrap(MAIN_TRACK + unnamedTrack + unnamedRoute));

    const names = (trail.alternates ?? []).map((a) => a.name);
    expect(names).toContain('Track 1');
    expect(names).toContain('Route 1');
    expect(names).not.toContain('Route 2');
  });
});

// ---------------------------------------------------------------------------
// Continuity chaining: one <trk> per day for a single continuous hike.
// Days whose start meets the previous day's end are merged into the main line
// (distance/elevation/waypoints all count); genuine spurs/alternates do not.
// ---------------------------------------------------------------------------

/** Build a <trk> from generated (lat, lon, ele) points. */
function trackXml(
  name: string,
  points: { lat: number; lon: number; ele: number }[],
): string {
  const pts = points
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele></trkpt>`)
    .join('\n      ');
  return `
  <trk><name>${name}</name>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>`;
}

/** Points marching south down a meridian from startLat, 0.005° (~0.55 km) apart. */
function southRun(startLat: number, count: number, startEle: number, lon = 151.0) {
  const out: { lat: number; lon: number; ele: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ lat: startLat - i * 0.005, lon, ele: startEle + i * 10 });
  }
  return out;
}

describe('gpx continuity chaining (multi-day recordings)', () => {
  it('(a) 3-track day split with meeting ends becomes one full-distance main line', () => {
    // Day 1 ends at -33.010; Day 2 starts ~110 m later; Day 3 likewise.
    const day1 = trackXml('Day 1', southRun(-33.0, 3, 100)); // -33.000,-33.005,-33.010
    const day2 = trackXml('Day 2', southRun(-33.011, 3, 130)); // -33.011,-33.016,-33.021
    const day3 = trackXml('Day 3', southRun(-33.022, 3, 160)); // -33.022,-33.027,-33.032
    const wpts = `
      <wpt lat="-33.016" lon="151.0"><name>W Day2 Spring</name></wpt>
      <wpt lat="-33.027" lon="151.0"><name>C Day3 Camp</name></wpt>`;
    const { trail } = processGpx(gpxWrap(day1 + day2 + day3 + wpts));

    // All nine points chained into one main line, no alternates.
    expect(trail.track.points).toHaveLength(9);
    expect(trail.alternates ?? []).toHaveLength(0);
    // Distance spans the whole hike (~3.5 km), not just day 1.
    expect(trail.track.totalDistance).toBeGreaterThan(3);

    // Waypoints on days 2 and 3 are matched against the merged main line.
    const spring = trail.waypoints.find((w) => w.name === 'Day2 Spring');
    const camp = trail.waypoints.find((w) => w.name === 'Day3 Camp');
    expect(spring?.type).toBe('water');
    expect(camp?.type).toBe('campsite');
  });

  it('(b) day split with a ~1 km camp offset still chains (and records the gap)', () => {
    const day1 = trackXml('Day 1', southRun(-33.0, 3, 100)); // ends -33.010
    // ~1 km offset (0.009°) from day 1's end to day 2's start.
    const day2 = trackXml('Day 2', southRun(-33.019, 3, 140)); // -33.019...
    const { trail, warnings } = processGpx(gpxWrap(day1 + day2));

    expect(trail.track.points).toHaveLength(6);
    expect(trail.alternates ?? []).toHaveLength(0);
    // The camp-to-camp offset (>500 m) is recorded like a pause-split gap.
    expect(warnings.some((w) => w.type === 'track_gaps')).toBe(true);
  });

  it('(c) a parallel alternate diverging mid-trail is NOT swallowed by chaining', () => {
    // Main line runs -33.00 → -33.10 (21 points).
    const mainPts: { lat: number; lon: number; ele: number }[] = [];
    for (let i = 0; i <= 20; i++) mainPts.push({ lat: -33.0 - i * 0.005, lon: 151.0, ele: 100 + i * 5 });
    const main = trackXml('Main', mainPts);
    // Alternate starts at the MIDDLE of the main line (-33.05) and diverges east.
    const alt = trackXml('Ridge Alternate', [
      { lat: -33.05, lon: 151.0, ele: 150 },
      { lat: -33.055, lon: 151.02, ele: 170 },
      { lat: -33.06, lon: 151.04, ele: 190 },
    ]);
    const { trail } = processGpx(gpxWrap(main + alt));

    // Its start is ~5.5 km from the main END, so it does not chain.
    expect(trail.track.points).toHaveLength(21);
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Ridge Alternate');
    // Documented limitation: an alternate whose start happens to sit within the
    // continuity threshold of the main END would be chained; the import
    // preview's include/exclude checklist is the user's correction path.
  });

  it('(d) a tiny prologue marker does not anchor the main line', () => {
    // 3-point "Start marker" before an 80-point real trail.
    const prologue = trackXml('Start marker', [
      { lat: -33.0, lon: 151.0, ele: 100 },
      { lat: -33.0005, lon: 151.0, ele: 101 },
      { lat: -33.001, lon: 151.0, ele: 102 },
    ]);
    const realPts: { lat: number; lon: number; ele: number }[] = [];
    for (let i = 0; i < 80; i++) realPts.push({ lat: -33.0 - i * 0.001, lon: 151.0, ele: 100 + i });
    const real = trackXml('Real Trail', realPts);
    const { trail } = processGpx(gpxWrap(prologue + real));

    // The long real trail anchors the main line; the marker becomes an alternate.
    expect(trail.track.points).toHaveLength(80);
    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Start marker');
  });
});
