/**
 * Parity test: verify the mobile GPX parser (fast-xml-parser) produces
 * the same output as the web GPX parser (DOMParser) for identical input.
 *
 * Since we can't import the web parser in mobile's test environment
 * (it uses browser DOMParser), we hardcode the expected output that the
 * web parser produces and verify the mobile parser matches.
 */

import { parseGpx } from '../gpx-parser';

// ---------------------------------------------------------------------------
// Test GPX fixtures and their expected parsed output (verified against web parser)
// ---------------------------------------------------------------------------

const MULTI_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="-33.5" lon="151.0">
    <ele>500</ele>
    <name>W Water Source</name>
    <desc>Reliable creek</desc>
  </wpt>
  <wpt lat="-33.6" lon="151.1">
    <ele>0</ele>
    <name>C Camp Spot</name>
    <desc></desc>
  </wpt>
  <rte>
    <name>Detour</name>
    <rtept lat="-33.2" lon="150.8"><ele>80</ele></rtept>
    <rtept lat="-33.3" lon="150.9"><ele>90</ele></rtept>
  </rte>
  <trk>
    <name>Day 1</name>
    <trkseg>
      <trkpt lat="-33.8" lon="151.2"><ele>100</ele></trkpt>
      <trkpt lat="-33.9" lon="151.3"><ele>200</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="-34.0" lon="151.4"><ele>150</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Day 2</name>
    <trkseg>
      <trkpt lat="-34.1" lon="151.5"><ele>300</ele></trkpt>
      <trkpt lat="-34.2" lon="151.6"><ele>250</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

// This is the exact output the web DOMParser-based parser produces for the above GPX.
const EXPECTED_MULTI_TRACK = {
  tracks: [
    {
      name: 'Day 1',
      segments: [
        {
          points: [
            { lat: -33.8, lon: 151.2, ele: 100, time: null },
            { lat: -33.9, lon: 151.3, ele: 200, time: null },
          ],
        },
        {
          points: [{ lat: -34.0, lon: 151.4, ele: 150, time: null }],
        },
      ],
    },
    {
      name: 'Day 2',
      segments: [
        {
          points: [
            { lat: -34.1, lon: 151.5, ele: 300, time: null },
            { lat: -34.2, lon: 151.6, ele: 250, time: null },
          ],
        },
      ],
    },
  ],
  routes: [
    {
      name: 'Detour',
      points: [
        { lat: -33.2, lon: 150.8, ele: 80, time: null },
        { lat: -33.3, lon: 150.9, ele: 90, time: null },
      ],
    },
  ],
  waypoints: [
    { lat: -33.5, lon: 151.0, ele: 500, name: 'W Water Source', desc: 'Reliable creek' },
    { lat: -33.6, lon: 151.1, ele: 0, name: 'C Camp Spot', desc: '' },
  ],
};

const MINIMAL_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Simple</name>
    <trkseg>
      <trkpt lat="-35.0" lon="149.0"><ele>600</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const EXPECTED_MINIMAL = {
  tracks: [
    {
      name: 'Simple',
      segments: [
        {
          points: [{ lat: -35.0, lon: 149.0, ele: 600, time: null }],
        },
      ],
    },
  ],
  routes: [],
  waypoints: [],
};

const NO_ELEVATION_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>No Ele</name>
    <trkseg>
      <trkpt lat="-33.0" lon="151.0"></trkpt>
      <trkpt lat="-33.1" lon="151.1"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const EXPECTED_NO_ELEVATION = {
  tracks: [
    {
      name: 'No Ele',
      segments: [
        {
          points: [
            { lat: -33.0, lon: 151.0, ele: 0, time: null },
            { lat: -33.1, lon: 151.1, ele: 0, time: null },
          ],
        },
      ],
    },
  ],
  routes: [],
  waypoints: [],
};

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe('GPX parser parity with web parser', () => {
  it('matches web parser output for multi-track GPX with routes and waypoints', () => {
    const result = parseGpx(MULTI_TRACK_GPX);
    expect(result).toEqual(EXPECTED_MULTI_TRACK);
  });

  it('matches web parser output for minimal single-point track', () => {
    const result = parseGpx(MINIMAL_GPX);
    expect(result).toEqual(EXPECTED_MINIMAL);
  });

  it('matches web parser output for tracks without elevation', () => {
    const result = parseGpx(NO_ELEVATION_GPX);
    expect(result).toEqual(EXPECTED_NO_ELEVATION);
  });
});
