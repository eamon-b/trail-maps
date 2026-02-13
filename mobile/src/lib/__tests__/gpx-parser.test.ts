import { parseGpx, validateFileSize, GpxParseError } from '../gpx-parser';

// ---------------------------------------------------------------------------
// Helper: minimal valid GPX
// ---------------------------------------------------------------------------

function gpxWrap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"
  xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;
}

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------

describe('parseGpx', () => {
  it('parses a single track with one segment', () => {
    const xml = gpxWrap(`
      <trk>
        <name>My Track</name>
        <trkseg>
          <trkpt lat="-33.8" lon="151.2"><ele>100</ele></trkpt>
          <trkpt lat="-33.9" lon="151.3"><ele>200</ele></trkpt>
        </trkseg>
      </trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].name).toBe('My Track');
    expect(result.tracks[0].segments).toHaveLength(1);
    expect(result.tracks[0].segments[0].points).toHaveLength(2);
    expect(result.tracks[0].segments[0].points[0]).toEqual({
      lat: -33.8,
      lon: 151.2,
      ele: 100,
      time: null,
    });
  });

  it('parses a track with multiple segments', () => {
    const xml = gpxWrap(`
      <trk>
        <name>Multi-Seg</name>
        <trkseg>
          <trkpt lat="-33.8" lon="151.2"><ele>100</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="-34.0" lon="151.5"><ele>300</ele></trkpt>
          <trkpt lat="-34.1" lon="151.6"><ele>400</ele></trkpt>
        </trkseg>
      </trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks[0].segments).toHaveLength(2);
    expect(result.tracks[0].segments[0].points).toHaveLength(1);
    expect(result.tracks[0].segments[1].points).toHaveLength(2);
  });

  it('parses multiple tracks', () => {
    const xml = gpxWrap(`
      <trk><name>Track 1</name><trkseg><trkpt lat="-33" lon="151"><ele>0</ele></trkpt></trkseg></trk>
      <trk><name>Track 2</name><trkseg><trkpt lat="-34" lon="150"><ele>0</ele></trkpt></trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0].name).toBe('Track 1');
    expect(result.tracks[1].name).toBe('Track 2');
  });

  it('parses waypoints', () => {
    const xml = gpxWrap(`
      <wpt lat="-33.5" lon="151.0">
        <ele>500</ele>
        <name>W Water Source</name>
        <desc>Reliable creek</desc>
      </wpt>
      <wpt lat="-33.6" lon="151.1">
        <name>C Camp Spot</name>
      </wpt>
    `);

    const result = parseGpx(xml);
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0]).toEqual({
      lat: -33.5,
      lon: 151.0,
      ele: 500,
      name: 'W Water Source',
      desc: 'Reliable creek',
    });
    expect(result.waypoints[1].name).toBe('C Camp Spot');
    expect(result.waypoints[1].ele).toBe(0); // missing ele defaults to 0
    expect(result.waypoints[1].desc).toBe(''); // missing desc defaults to ''
  });

  it('parses routes (<rte> with <rtept>)', () => {
    const xml = gpxWrap(`
      <rte>
        <name>My Route</name>
        <rtept lat="-33.0" lon="150.0"><ele>100</ele></rtept>
        <rtept lat="-33.1" lon="150.1"><ele>200</ele></rtept>
      </rte>
    `);

    const result = parseGpx(xml);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].name).toBe('My Route');
    expect(result.routes[0].points).toHaveLength(2);
    expect(result.routes[0].points[0].lat).toBe(-33.0);
  });

  it('parses time elements', () => {
    const xml = gpxWrap(`
      <trk><name>Timed</name><trkseg>
        <trkpt lat="-33" lon="151">
          <ele>100</ele>
          <time>2024-01-15T10:30:00Z</time>
        </trkpt>
      </trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks[0].segments[0].points[0].time).toBe('2024-01-15T10:30:00Z');
  });

  it('handles missing elevation gracefully', () => {
    const xml = gpxWrap(`
      <trk><name>No Ele</name><trkseg>
        <trkpt lat="-33" lon="151"></trkpt>
        <trkpt lat="-34" lon="152"></trkpt>
      </trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks[0].segments[0].points[0].ele).toBe(0);
    expect(result.tracks[0].segments[0].points[1].ele).toBe(0);
  });

  it('returns empty arrays for GPX with no data', () => {
    const xml = gpxWrap('');
    const result = parseGpx(xml);
    expect(result.tracks).toHaveLength(0);
    expect(result.routes).toHaveLength(0);
    expect(result.waypoints).toHaveLength(0);
  });

  it('handles Garmin extensions gracefully (ignores them)', () => {
    const xml = gpxWrap(`
      <trk><name>Garmin</name><trkseg>
        <trkpt lat="-33" lon="151">
          <ele>100</ele>
          <extensions>
            <gpxtpx:TrackPointExtension>
              <gpxtpx:hr>120</gpxtpx:hr>
            </gpxtpx:TrackPointExtension>
          </extensions>
        </trkpt>
      </trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks[0].segments[0].points[0].lat).toBe(-33);
    expect(result.tracks[0].segments[0].points[0].ele).toBe(100);
  });

  it('handles track with empty name', () => {
    const xml = gpxWrap(`
      <trk><trkseg>
        <trkpt lat="-33" lon="151"><ele>0</ele></trkpt>
      </trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks[0].name).toBe('');
  });
});

// ---------------------------------------------------------------------------
// GPX variations
// ---------------------------------------------------------------------------

describe('GPX format variations', () => {
  it('parses GPX without XML declaration', () => {
    const xml = `<gpx version="1.1">
      <trk><name>No Declaration</name><trkseg>
        <trkpt lat="-33" lon="151"><ele>0</ele></trkpt>
      </trkseg></trk>
    </gpx>`;

    const result = parseGpx(xml);
    expect(result.tracks).toHaveLength(1);
  });

  it('handles both tracks and routes in same file', () => {
    const xml = gpxWrap(`
      <wpt lat="-33.5" lon="151.0"><name>Waypoint</name></wpt>
      <rte><name>Route</name><rtept lat="-33" lon="151"><ele>0</ele></rtept></rte>
      <trk><name>Track</name><trkseg><trkpt lat="-34" lon="152"><ele>0</ele></trkpt></trkseg></trk>
    `);

    const result = parseGpx(xml);
    expect(result.tracks).toHaveLength(1);
    expect(result.routes).toHaveLength(1);
    expect(result.waypoints).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('parseGpx error handling', () => {
  it('throws on empty input', () => {
    expect(() => parseGpx('')).toThrow(GpxParseError);
    expect(() => parseGpx('')).toThrow('GPX content cannot be empty');
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseGpx('   \n  ')).toThrow(GpxParseError);
  });

  it('throws on non-XML input', () => {
    expect(() => parseGpx('Hello this is not XML')).toThrow(GpxParseError);
    expect(() => parseGpx('Hello this is not XML')).toThrow("doesn't appear to be a GPX file");
  });

  it('throws on HTML input', () => {
    expect(() => parseGpx('<html><body>Not GPX</body></html>')).toThrow(GpxParseError);
  });

  it('throws on valid XML that is not GPX', () => {
    expect(() => parseGpx('<?xml version="1.0"?><root><item>test</item></root>')).toThrow(
      GpxParseError,
    );
    expect(() => parseGpx('<?xml version="1.0"?><root><item>test</item></root>')).toThrow(
      'no <gpx> root element',
    );
  });

  it('throws on binary input', () => {
    // Simulate binary content (starts with non-printable characters)
    expect(() => parseGpx('\x00\x01\x02\x03')).toThrow(GpxParseError);
  });
});

// ---------------------------------------------------------------------------
// File size validation
// ---------------------------------------------------------------------------

describe('validateFileSize', () => {
  it('accepts files under 50MB', () => {
    expect(() => validateFileSize(10 * 1024 * 1024)).not.toThrow();
  });

  it('rejects files over 50MB', () => {
    expect(() => validateFileSize(51 * 1024 * 1024)).toThrow(GpxParseError);
    expect(() => validateFileSize(51 * 1024 * 1024)).toThrow('exceeds');
  });

  it('accepts files at exactly 50MB', () => {
    expect(() => validateFileSize(50 * 1024 * 1024)).not.toThrow();
  });
});
