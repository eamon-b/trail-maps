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

    expect(trail.alternates).toHaveLength(1);
    expect(trail.alternates![0].name).toBe('Alternate 1');
  });
});
