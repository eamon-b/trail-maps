import { describe, expect, it } from 'vitest';
import {
  HANDOFF_EXTENSION,
  HANDOFF_FORMAT,
  HANDOFF_VERSION,
  handoffFileName,
  handoffImportReport,
  looksLikeHandoffJson,
  parseHandoffJson,
  serializeTrailHandoff,
  trailSlug,
  wrapTrailForHandoff,
} from './trail-handoff';
import type { ProcessedTrail } from './trail-types';

function makeTrail(overrides: Partial<ProcessedTrail> = {}): ProcessedTrail {
  const points = [
    { lat: -33.8688, lon: 151.2093, ele: 10, dist: 0 },
    { lat: -33.87, lon: 151.21, ele: 25, dist: 0.15 },
    { lat: -33.875, lon: 151.215, ele: 40, dist: 0.85 },
  ];
  return {
    config: {
      id: 'u_abc123',
      name: 'Weekend Loop',
      shortName: 'Weekend Loop',
      region: 'Imported',
      lengthKm: 0.85,
      gpxFile: '',
      source: 'imported',
    },
    track: {
      points,
      displayPoints: points,
      totalDistance: 0.85,
      totalAscent: 30,
      totalDescent: 0,
    },
    waypoints: [],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: { default: 'Start → End', reversed: 'End → Start' },
    ...overrides,
  };
}

/** Round-trip a trail through the envelope and back. */
function roundTrip(trail: ProcessedTrail): ProcessedTrail {
  return parseHandoffJson(serializeTrailHandoff(trail));
}

describe('wrapTrailForHandoff', () => {
  it('wraps the trail verbatim in a versioned envelope', () => {
    const trail = makeTrail();
    const wrapped = wrapTrailForHandoff(trail);
    expect(wrapped.format).toBe(HANDOFF_FORMAT);
    expect(wrapped.version).toBe(HANDOFF_VERSION);
    expect(wrapped.trail).toBe(trail);
  });

  it('serializes to JSON the parser accepts', () => {
    expect(roundTrip(makeTrail()).config.id).toBe('u_abc123');
  });
});

describe('trailSlug / handoffFileName', () => {
  it('slugifies the name for imported ids', () => {
    expect(trailSlug({ id: 'u_abc123', name: 'Weekend Loop!' })).toBe('weekend-loop');
  });

  it('keeps a bundled trail id as-is', () => {
    expect(trailSlug({ id: 'bibbulmun-track', name: 'Bibbulmun Track' })).toBe('bibbulmun-track');
  });

  it('falls back when the name has nothing slug-shaped in it', () => {
    expect(trailSlug({ id: 'u_x', name: '???' })).toBe('u_x');
    expect(trailSlug({})).toBe('trail');
  });

  it('names the download with the double extension', () => {
    expect(handoffFileName(makeTrail())).toBe(`weekend-loop${HANDOFF_EXTENSION}`);
  });
});

describe('looksLikeHandoffJson', () => {
  it('recognises JSON regardless of leading whitespace', () => {
    expect(looksLikeHandoffJson('  \n {"format":"x"}')).toBe(true);
  });

  it('rejects XML', () => {
    expect(looksLikeHandoffJson('<?xml version="1.0"?><gpx/>')).toBe(false);
  });
});

describe('parseHandoffJson', () => {
  it('round-trips a full trail', () => {
    const trail = makeTrail();
    const parsed = roundTrip(trail);
    expect(parsed.track.points).toEqual(trail.track.points);
    expect(parsed.track.totalAscent).toBe(30);
    expect(parsed.config.name).toBe('Weekend Loop');
    expect(parsed.direction).toEqual({ default: 'Start → End', reversed: 'End → Start' });
  });

  it('always marks the result as imported', () => {
    const parsed = roundTrip(makeTrail());
    expect(parsed.config.source).toBe('imported');
  });

  it('mints a fresh u_ id when the file carries a non-imported one', () => {
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: makeTrail({
        config: { ...makeTrail().config, id: 'bibbulmun-track', source: undefined },
      }),
    });
    const parsed = parseHandoffJson(text);
    expect(parsed.config.id).toMatch(/^u_[a-z0-9]+$/);
    // Deterministic: the same bytes always land on the same trail.
    expect(parseHandoffJson(text).config.id).toBe(parsed.config.id);
  });

  it('keeps an existing u_ id so re-importing is not a duplicate', () => {
    expect(roundTrip(makeTrail()).config.id).toBe('u_abc123');
  });

  it('falls back to the full track when displayPoints is missing', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: { ...trail, track: { ...trail.track, displayPoints: undefined } },
    });
    expect(parseHandoffJson(text).track.displayPoints).toEqual(trail.track.points);
  });

  it('defaults the optional collections rather than failing', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: {
        config: trail.config,
        track: trail.track,
        waypoints: [],
      },
    });
    const parsed = parseHandoffJson(text);
    expect(parsed.alternates).toEqual([]);
    expect(parsed.sideTrips).toEqual([]);
    expect(parsed.offTrailWaypoints).toEqual([]);
    expect(parsed.climate).toBeNull();
  });

  it('derives lengthKm from the track when the config omits it', () => {
    const trail = makeTrail();
    const text = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 1,
      trail: { ...trail, config: { ...trail.config, lengthKm: undefined } },
    });
    expect(parseHandoffJson(text).config.lengthKm).toBe(0.85);
  });

  describe('rejections', () => {
    const cases: [string, unknown, RegExp][] = [
      ['a non-object payload', '"hello"', /expected a JSON object/],
      [
        'a foreign format',
        JSON.stringify({ format: 'gaia-trail', version: 1, trail: {} }),
        /not a Tracknotes trail file \(format "gaia-trail"/,
      ],
      [
        'a missing format',
        JSON.stringify({ version: 1, trail: {} }),
        /format missing/,
      ],
      [
        'a non-integer version',
        JSON.stringify({ format: HANDOFF_FORMAT, version: '1', trail: {} }),
        /invalid version/,
      ],
      [
        'a future version',
        JSON.stringify({ format: HANDOFF_FORMAT, version: 99, trail: {} }),
        /newer version of Tracknotes/,
      ],
      [
        'a missing trail',
        JSON.stringify({ format: HANDOFF_FORMAT, version: 1 }),
        /missing its "trail" object/,
      ],
      [
        'a missing config',
        JSON.stringify({ format: HANDOFF_FORMAT, version: 1, trail: { track: {} } }),
        /missing "trail.config"/,
      ],
    ];

    it.each(cases)('rejects %s', (_label, text, pattern) => {
      expect(() => parseHandoffJson(text as string)).toThrow(pattern);
    });

    it('rejects text that is not JSON at all', () => {
      expect(() => parseHandoffJson('<gpx/>')).toThrow(/not valid JSON/);
    });

    it('rejects an empty track', () => {
      const trail = makeTrail();
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points: [] } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/no track points/);
    });

    it('rejects a point with a non-numeric dist rather than zeroing it', () => {
      const trail = makeTrail();
      const points = trail.track.points.map(p => ({ ...p }) as Record<string, unknown>);
      delete points[1].dist;
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/non-numeric track\.points\[1\]\.dist/);
    });

    it('rejects an out-of-range latitude', () => {
      const trail = makeTrail();
      const points = trail.track.points.map(p => ({ ...p }));
      points[0].lat = 991;
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { ...trail, track: { ...trail.track, points } },
      });
      expect(() => parseHandoffJson(text)).toThrow(/out-of-range track\.points\[0\]\.lat/);
    });

    it('rejects a missing waypoints array', () => {
      const trail = makeTrail();
      const text = JSON.stringify({
        format: HANDOFF_FORMAT,
        version: 1,
        trail: { config: trail.config, track: trail.track },
      });
      expect(() => parseHandoffJson(text)).toThrow(/missing its "waypoints" array/);
    });
  });
});

describe('handoffImportReport', () => {
  it('reports counts from the already-built trail', () => {
    const trail = makeTrail();
    const report = handoffImportReport(trail);
    expect(report).toMatchObject({
      trailId: 'u_abc123',
      name: 'Weekend Loop',
      hasElevation: true,
      elevationLooksNoisy: false,
      pointCount: 3,
      sourcePointCount: 3,
      waypointCount: 0,
      tracksFound: 1,
      tracksCombined: 1,
      simplified: false,
      warnings: [],
      gapWarnings: [],
    });
  });

  it('flags a flat profile as having no elevation', () => {
    const trail = makeTrail();
    const flat = makeTrail({
      track: {
        ...trail.track,
        points: trail.track.points.map(p => ({ ...p, ele: 0 })),
      },
    });
    expect(handoffImportReport(flat).hasElevation).toBe(false);
  });

  it('counts variants', () => {
    const variant = {
      name: 'Alt',
      type: 'alternate' as const,
      points: [],
      distance: 1,
      elevation: { ascent: 0, descent: 0 },
    };
    const report = handoffImportReport(makeTrail({ alternates: [variant], sideTrips: [variant] }));
    expect(report.alternateCount).toBe(1);
    expect(report.sideTripCount).toBe(1);
  });
});
