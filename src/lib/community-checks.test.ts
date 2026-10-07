/**
 * `runCommunityChecks` — the automatic checks a shared route must pass.
 * Built from real GPX through `importGpx`, then mutated to trip each check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { importGpx } from './gpx-import';
import {
  gpxMovingSpeedKmh,
  hasFailures,
  runCommunityChecks,
  sanitiseCommunityTrail,
} from './community-checks';
import { haversineDistance } from './distance';
import { douglasPeuckerIndices } from './gpx-optimizer';
import { calculateAdaptiveTolerance, DEFAULT_TARGET_DISPLAY_POINTS } from './trail-ingest';
import type { CommunityCheck } from './community-types';
import type { ProcessedTrail, RouteVariant, TrackPoint } from './trail-types';

const ROOT = resolve(__dirname, '../..');
const THORSBORNE = readFileSync(resolve(ROOT, 'data/trails/thorsborne/Thorsborne_Trail.gpx'), 'utf-8');
const SIMPLE = readFileSync(resolve(ROOT, 'tests/fixtures/gpx/simple-trail.gpx'), 'utf-8');

const META = {
  name: 'Thorsborne Trail',
  description: 'Four days along the east coast of Hinchinbrook Island, beach to beach over rocky headlands.',
};

/** A fresh, JSON-round-tripped trail (what a client uploads). */
function thorsborne(): ProcessedTrail {
  return JSON.parse(JSON.stringify(importGpx(THORSBORNE).trail)) as ProcessedTrail;
}

function byId(checks: CommunityCheck[], id: string): CommunityCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe('runCommunityChecks on a real trail', () => {
  it('passes the Thorsborne Trail with no failures', () => {
    const result = runCommunityChecks(thorsborne(), META);
    expect(hasFailures(result.checks)).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      'shape',
      'length',
      'points',
      'distance-consistency',
      'speed',
      'elevation',
      'gaps',
      'metadata',
      'waypoints',
    ]);
    for (const c of result.checks) {
      expect(c.message.length).toBeGreaterThan(10);
    }
    expect(result.stats).toBeDefined();
    const stats = result.stats!;
    expect(stats.lengthKm).toBeGreaterThan(25);
    expect(stats.lengthKm).toBeLessThan(45);
    expect(stats.hasElevation).toBe(true);
    expect(stats.bbox[0]).toBeLessThanOrEqual(stats.bbox[2]);
    expect(stats.bbox[1]).toBeLessThanOrEqual(stats.bbox[3]);
    expect(stats.start.lat).toBeLessThan(0);
  });

  it('returns a rebuilt trail without fields the type does not define', () => {
    const raw = thorsborne() as unknown as Record<string, unknown>;
    raw.evil = '<script>';
    (raw.track as { points: Record<string, unknown>[] }).points[0].extra = 1;
    (raw.config as Record<string, unknown>).trackClassification = { mainPatterns: ['.*'] };
    raw.climate = { huge: 'x' };
    const { trail } = runCommunityChecks(raw, META);
    expect(trail).toBeDefined();
    expect('evil' in trail!).toBe(false);
    expect('extra' in trail!.track.points[0]).toBe(false);
    expect('trackClassification' in trail!.config).toBe(false);
    expect(trail!.climate).toBeNull();
    expect(trail!.config.lengthKm).toBe(Math.round(trail!.track.points.at(-1)!.dist * 10) / 10);
  });

  it('fails a short real fixture on points', () => {
    const trail = importGpx(SIMPLE).trail;
    const result = runCommunityChecks(trail, META);
    expect(byId(result.checks, 'points').level).toBe('fail');
    expect(result.ok).toBe(false);
  });
});

describe('shape', () => {
  it.each([
    ['not an object', () => 'hello'],
    ['missing track', () => ({ ...thorsborne(), track: undefined })],
    ['lat out of range', () => { const t = thorsborne(); t.track.points[3].lat = 91; return t; }],
    ['lon out of range', () => { const t = thorsborne(); t.track.points[3].lon = -181; return t; }],
    ['NaN dist', () => { const t = thorsborne() as unknown as { track: { points: { dist: unknown }[] } }; t.track.points[3].dist = 'NaN'; return t; }],
    ['waypoints not a list', () => ({ ...thorsborne(), waypoints: {} })],
    ['waypoint name not text', () => { const t = thorsborne() as unknown as { waypoints: { name: unknown }[] }; t.waypoints[0].name = 5; return t; }],
    ['trackIndex out of range', () => { const t = thorsborne(); t.waypoints[0].trackIndex = 1e6; return t; }],
    ['too many points', () => { const t = thorsborne(); t.track.points = new Array(100_001).fill(t.track.points[0]); return t; }],
    ['bad variant type', () => { const t = thorsborne() as unknown as { sideTrips: unknown[] }; t.sideTrips = [{ type: 'teleport' }]; return t; }],
  ])('fails on %s', (_label, make) => {
    const result = runCommunityChecks(make(), META);
    expect(result.ok).toBe(false);
    expect(byId(result.checks, 'shape').level).toBe('fail');
    expect(result.trail).toBeUndefined();
    expect(result.stats).toBeUndefined();
    // Metadata is still reported so the form can show both problems at once.
    expect(byId(result.checks, 'metadata').level).toBe('pass');
  });

  it('names the field that is wrong', () => {
    const t = thorsborne();
    t.track.points[7].lat = 123;
    const out = sanitiseCommunityTrail(t);
    expect('error' in out && out.error).toContain('track.points[7].lat');
  });
});

/** Scale a trail's coordinates around its first point (and its km to match). */
function scaled(factor: number): ProcessedTrail {
  const t = thorsborne();
  const { lat: lat0, lon: lon0 } = t.track.points[0];
  for (const list of [t.track.points, t.track.displayPoints]) {
    for (const p of list) {
      p.lat = lat0 + (p.lat - lat0) * factor;
      p.lon = lon0 + (p.lon - lon0) * factor;
      p.dist *= factor;
    }
  }
  t.track.totalDistance *= factor;
  return t;
}

describe('length', () => {
  it('fails under 1 km', () => {
    expect(byId(runCommunityChecks(scaled(0.02), META).checks, 'length').level).toBe('fail');
  });
  it('warns under 3 km', () => {
    expect(byId(runCommunityChecks(scaled(0.07), META).checks, 'length').level).toBe('warn');
  });
  it('fails over 5,000 km', () => {
    // A zigzag between two latitudes ~5,500 km apart: long by its geometry,
    // which is the only length the checks believe.
    const t = thorsborne();
    t.track.points.forEach((p, i) => {
      p.lat = i % 2 === 0 ? -10 : -60;
    });
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'length').level).toBe('fail');
    expect(result.trail!.track.totalDistance).toBeGreaterThan(5000);
  });
  it('measures a km ladder that starts far from 0 by its geometry', () => {
    // The probe: a 0.3 km route whose every dist is offset by 4,000.
    const t = scaled(0.01);
    for (const p of t.track.points) p.dist += 4000;
    t.track.totalDistance += 4000;
    const result = runCommunityChecks(t, META);
    expect(result.trail!.track.totalDistance).toBeLessThan(0.5);
    expect(result.trail!.track.points[0].dist).toBe(0);
    expect(result.trail!.config.lengthKm).toBeLessThan(0.5);
    expect(result.stats!.lengthKm).toBeLessThan(0.5);
    expect(byId(result.checks, 'length').level).toBe('fail');
    expect(byId(result.checks, 'distance-consistency').level).toBe('fail');
  });
});

describe('points', () => {
  it('warns when points are far apart', () => {
    const t = thorsborne();
    // Keep ~25 points and re-measure: a coarse but consistent line.
    const step = Math.max(2, Math.floor(t.track.points.length / 25));
    const kept = t.track.points.filter((_, i, a) => i % step === 0 || i === a.length - 1);
    let d = 0;
    t.track.points = kept.map((p, i) => {
      if (i > 0) {
        const a = kept[i - 1];
        const dLat = ((p.lat - a.lat) * Math.PI) / 180;
        const dLon = ((p.lon - a.lon) * Math.PI) / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        d += 2 * 6371 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      }
      return { ...p, dist: d };
    });
    t.track.totalDistance = d;
    t.waypoints = [];
    if (t.track.points.length < 20) throw new Error('fixture too short for this test');
    expect(byId(runCommunityChecks(t, META).checks, 'points').level).toBe('warn');
  });
});

describe('distance-consistency', () => {
  it('fails when km values are inflated', () => {
    const t = thorsborne();
    for (const p of t.track.points) p.dist *= 1.05;
    t.track.totalDistance *= 1.05;
    expect(byId(runCommunityChecks(t, META).checks, 'distance-consistency').level).toBe('fail');
  });
  it('fails when distances go backwards', () => {
    const t = thorsborne();
    const mid = Math.floor(t.track.points.length / 2);
    t.track.points[mid].dist = t.track.points[mid - 1].dist - 0.5;
    expect(byId(runCommunityChecks(t, META).checks, 'distance-consistency').level).toBe('fail');
  });
  it('fails when totalDistance disagrees with the points', () => {
    const t = thorsborne();
    t.track.totalDistance *= 3;
    expect(byId(runCommunityChecks(t, META).checks, 'distance-consistency').level).toBe('fail');
  });
  it('fails an offset km ladder even when totalDistance is honest, and stores the real km', () => {
    const t = thorsborne();
    const honest = t.track.points.map((p) => p.dist);
    for (const p of t.track.points) p.dist += 50;
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'distance-consistency').level).toBe('fail');
    result.trail!.track.points.forEach((p, i) => expect(p.dist).toBeCloseTo(honest[i], 9));
  });
});

/** A GPX recording of the Thorsborne Trail's points walked at a steady `kmh`. */
function timedGpx(kmh: number, points: TrackPoint[] = thorsborne().track.points): string {
  const start = Date.parse('2026-05-01T00:00:00Z');
  const rows = points.map(
    (p) =>
      `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${p.ele}</ele>` +
      `<time>${new Date(start + (p.dist / kmh) * 3_600_000).toISOString()}</time></trkpt>`
  );
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>\n${rows.join('\n')}\n</trkseg></trk></gpx>`;
}

describe('speed', () => {
  it('passes, and says so, when no GPX file is supplied', () => {
    const speed = byId(runCommunityChecks(thorsborne(), META).checks, 'speed');
    expect(speed.level).toBe('pass');
    expect(speed.message).toMatch(/No GPX file was supplied/);
  });
  it('passes a GPX file without timestamps', () => {
    const speed = byId(runCommunityChecks(thorsborne(), { ...META, gpxText: THORSBORNE }).checks, 'speed');
    expect(speed.level).toBe('pass');
    expect(speed.message).toMatch(/too few timestamps/);
  });
  it('warns when the GPX timestamps show driving speed', () => {
    const result = runCommunityChecks(thorsborne(), { ...META, gpxText: timedGpx(60) });
    expect(byId(result.checks, 'speed').level).toBe('warn');
  });
  it('passes walking-pace timestamps', () => {
    expect(byId(runCommunityChecks(thorsborne(), { ...META, gpxText: timedGpx(4) }).checks, 'speed').level).toBe('pass');
  });
  it('never reads or keeps a time on the processed points', () => {
    const t = thorsborne();
    const points = t.track.points as (TrackPoint & { time?: string })[];
    for (const p of points) p.time = new Date(Date.parse('2026-05-01T00:00:00Z') + p.dist * 60_000).toISOString();
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'speed').level).toBe('pass');
    expect('time' in result.trail!.track.points[0]).toBe(false);
  });
});

describe('gpxMovingSpeedKmh', () => {
  it('measures walking and driving', () => {
    expect(gpxMovingSpeedKmh(timedGpx(4))!.medianKmh).toBeCloseTo(4, 1);
    const drive = gpxMovingSpeedKmh(timedGpx(60))!;
    expect(drive.medianKmh).toBeCloseTo(60, 0);
    expect(drive.timedPoints).toBe(thorsborne().track.points.length);
  });
  it('reads a small hand-written file, with single quotes and whitespace', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      // ~111 m north every 100 s: 4 km/h.
      `<trkpt  lon='146.0' lat='${(-18 + i * 0.001).toFixed(3)}'>\n  <time> 2026-05-01T00:${String(Math.floor((i * 100) / 60)).padStart(2, '0')}:${String((i * 100) % 60).padStart(2, '0')}Z </time>\n</trkpt>`
    );
    const speed = gpxMovingSpeedKmh(`<gpx><trk><trkseg>${rows.join('')}</trkseg></trk></gpx>`)!;
    expect(speed.timedPoints).toBe(12);
    expect(speed.medianKmh).toBeGreaterThan(3.5);
    expect(speed.medianKmh).toBeLessThan(4.5);
  });
  it('returns null with too few timed points', () => {
    expect(gpxMovingSpeedKmh(THORSBORNE)).toBeNull();
    expect(gpxMovingSpeedKmh(timedGpx(60, thorsborne().track.points.slice(0, 9)))).toBeNull();
    expect(gpxMovingSpeedKmh('')).toBeNull();
  });
  it('does not time the drive between two track segments', () => {
    const pts = thorsborne().track.points;
    // Each half walked at 4 km/h, the second half starting 10 minutes after the
    // first ended but 40 km further on: one hop at 240 km/h if the segments ran together.
    const first = timedGpx(4, pts.slice(0, 200)).replace('</trkseg></trk></gpx>', '');
    const lastTime = Date.parse('2026-05-01T00:00:00Z') + (pts[199].dist / 4) * 3_600_000;
    const second = pts.slice(200).map((p) => {
      const t = lastTime + 600_000 + ((p.dist - pts[200].dist) / 4) * 3_600_000;
      return `<trkpt lat="${p.lat + 0.36}" lon="${p.lon}"><time>${new Date(t).toISOString()}</time></trkpt>`;
    });
    const gpx = `${first}</trkseg><trkseg>${second.join('')}</trkseg></trk></gpx>`;
    expect(gpxMovingSpeedKmh(gpx)!.medianKmh).toBeCloseTo(4, 1);
  });
  it('stays linear on unclosed and malformed points', () => {
    const junk = '<trkpt lat="1" lon="2"><time>x</time>'.repeat(200_000);
    const t0 = Date.now();
    expect(gpxMovingSpeedKmh(junk)).toBeNull();
    expect(gpxMovingSpeedKmh('<trkpt lat="1" lon="2">'.repeat(200_000))).toBeNull();
    expect(gpxMovingSpeedKmh('<trkptx/>'.repeat(200_000))).toBeNull();
    // Points without a time: the search for one must stop at the point's end.
    expect(gpxMovingSpeedKmh('<trkpt lat="1" lon="2"><ele>1</ele></trkpt>'.repeat(100_000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('elevation', () => {
  it('warns when there is none', () => {
    const t = thorsborne();
    for (const p of t.track.points) p.ele = 0;
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'elevation').level).toBe('warn');
    expect(result.stats!.hasElevation).toBe(false);
  });
  it('warns when elevationSource says none', () => {
    const t = thorsborne();
    t.config.elevationSource = 'none';
    expect(byId(runCommunityChecks(t, META).checks, 'elevation').level).toBe('warn');
  });
  it('warns when the climb is implausible', () => {
    const t = thorsborne();
    // A 400 m sawtooth on every other point: noise the recomputed climb sees.
    t.track.points.forEach((p, i) => {
      p.ele = i % 2 === 0 ? 0.5 : 400;
    });
    expect(byId(runCommunityChecks(t, META).checks, 'elevation').level).toBe('warn');
  });
  it('ignores a claimed climb and recomputes it from the points', () => {
    const t = thorsborne();
    const honest = runCommunityChecks(thorsborne(), META);
    // The import's own figure is what the recomputation reproduces.
    expect(honest.trail!.track.totalAscent).toBeCloseTo(t.track.totalAscent, 6);
    expect(honest.trail!.track.totalDescent).toBeCloseTo(t.track.totalDescent, 6);
    t.track.totalAscent = t.track.totalDistance * 400;
    t.track.totalDescent = 0;
    const forged = runCommunityChecks(t, META);
    expect(byId(forged.checks, 'elevation').level).toBe('pass');
    expect(forged.trail!.track.totalAscent).toBeCloseTo(honest.trail!.track.totalAscent, 6);
    expect(forged.trail!.track.totalDescent).toBeCloseTo(honest.trail!.track.totalDescent, 6);
    expect(forged.stats!.ascentM).toBe(honest.stats!.ascentM);
  });
  it('climbs a declared route break: a client cannot exempt a step', () => {
    const t = thorsborne();
    const pts = t.track.points;
    const mid = Math.floor(pts.length / 2);
    const before = runCommunityChecks(thorsborne(), META).trail!.track.totalAscent;
    for (let i = mid; i < pts.length; i++) pts[i].ele += 1000;
    t.track.breaks = [
      { index: mid, displayIndex: 1, km: pts[mid].dist, straightLineKm: 0, fromTrack: 'a', toTrack: 'b' },
    ];
    expect(runCommunityChecks(t, META).trail!.track.totalAscent).toBeGreaterThan(before + 900);
  });
  it('drops cumAscent/cumDescent from every point', () => {
    const t = thorsborne();
    t.track.points.forEach((p, i) => {
      p.cumAscent = i * 1000;
      p.cumDescent = 0;
    });
    const variant = slicedVariant(t, 100, 200, 'alternate') as RouteVariant & { points: Record<string, unknown>[] };
    for (const p of variant.points) p.cumAscent = 5;
    t.alternates = [variant];
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(true);
    for (const p of result.trail!.track.points) {
      expect('cumAscent' in p).toBe(false);
      expect('cumDescent' in p).toBe(false);
    }
    for (const p of result.trail!.alternates[0].points) expect('cumAscent' in p).toBe(false);
  });
});

describe('gaps', () => {
  it('warns about a jump over 2 km', () => {
    const t = thorsborne();
    // Move the second half of the route 3 km north (~0.027°), keeping km consistent.
    const mid = Math.floor(t.track.points.length / 2);
    const shift = 0.03;
    for (let i = mid; i < t.track.points.length; i++) t.track.points[i].lat += shift;
    const jump = (shift * Math.PI * 6371) / 180;
    for (let i = mid; i < t.track.points.length; i++) t.track.points[i].dist += jump;
    t.track.totalDistance += jump;
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'gaps').level).toBe('warn');
    expect(byId(result.checks, 'distance-consistency').level).toBe('pass');
  });
  it('ignores client route breaks: a 33 km jump warns even when declared', () => {
    const t = thorsborne();
    const pts = t.track.points;
    const mid = Math.floor(pts.length / 2);
    const shift = 0.3;
    const jump = (shift * Math.PI * 6371) / 180;
    for (let i = mid; i < pts.length; i++) {
      pts[i].lat += shift;
      pts[i].dist += jump;
    }
    t.track.totalDistance += jump;
    t.track.breaks = [
      { index: mid, displayIndex: 1, km: pts[mid].dist, straightLineKm: 33, fromTrack: 'a', toTrack: 'b' },
    ];
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'gaps').level).toBe('warn');
    expect(byId(result.checks, 'distance-consistency').level).toBe('pass');
    expect(result.trail!.track.breaks).toBeUndefined();
    expect('breaks' in result.trail!.track).toBe(false);
  });
  it('fails a declared break whose km skip the jump (the probe)', () => {
    const t = thorsborne();
    const pts = t.track.points;
    const mid = Math.floor(pts.length / 2);
    for (let i = mid; i < pts.length; i++) pts[i].lat += 0.3;
    t.track.breaks = [
      { index: mid, displayIndex: 1, km: pts[mid].dist, straightLineKm: 33, fromTrack: 'a', toTrack: 'b' },
    ];
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'gaps').level).toBe('warn');
    expect(byId(result.checks, 'distance-consistency').level).toBe('fail');
  });
});

describe('metadata', () => {
  it('fails a short name', () => {
    expect(byId(runCommunityChecks(thorsborne(), { ...META, name: 'ab' }).checks, 'metadata').level).toBe('fail');
  });
  it('fails a long name', () => {
    expect(byId(runCommunityChecks(thorsborne(), { ...META, name: 'x'.repeat(81) }).checks, 'metadata').level).toBe('fail');
  });
  it('fails a short description', () => {
    expect(byId(runCommunityChecks(thorsborne(), { ...META, description: 'Nice walk.' }).checks, 'metadata').level).toBe('fail');
  });
  it('fails a long description', () => {
    expect(byId(runCommunityChecks(thorsborne(), { ...META, description: 'x'.repeat(2001) }).checks, 'metadata').level).toBe('fail');
  });
  it('warns when the description is mostly links', () => {
    const description = 'See https://example.com/a-very-long-link-to-somewhere and https://example.org/another-one';
    expect(byId(runCommunityChecks(thorsborne(), { ...META, description }).checks, 'metadata').level).toBe('warn');
  });
  it('warns when the waypoint descriptions are mostly links', () => {
    const t = thorsborne();
    for (const w of t.waypoints) w.description = `https://spam.example/buy-now-${w.name.length}-cheap-deals`;
    const result = runCommunityChecks(t, META);
    const metadata = byId(result.checks, 'metadata');
    expect(metadata.level).toBe('warn');
    expect(metadata.message).toMatch(/waypoint descriptions/);
    expect(result.ok).toBe(true);
  });
  it('passes waypoint descriptions that mention a link among real text', () => {
    const t = thorsborne();
    for (const w of t.waypoints) {
      w.description = 'Tank water beside the shelter; reliable after rain, otherwise treat creek water. See www.parks.example';
    }
    expect(byId(runCommunityChecks(t, META).checks, 'metadata').level).toBe('pass');
  });
  it('reports a failing name before any waypoint-description warning', () => {
    const t = thorsborne();
    for (const w of t.waypoints) w.description = 'https://spam.example/buy-now';
    expect(byId(runCommunityChecks(t, { ...META, name: 'ab' }).checks, 'metadata').level).toBe('fail');
  });
});

describe('waypoints', () => {
  it('warns when there are none', () => {
    const t = thorsborne();
    t.waypoints = [];
    t.offTrailWaypoints = [];
    for (const v of [...t.alternates, ...t.sideTrips]) v.waypoints = [];
    expect(byId(runCommunityChecks(t, META).checks, 'waypoints').level).toBe('warn');
  });
  it('fails over 2,000', () => {
    const t = thorsborne();
    const w = t.waypoints[0];
    t.waypoints = new Array(2001).fill(w);
    expect(byId(runCommunityChecks(t, META).checks, 'waypoints').level).toBe('fail');
  });
  it('counts off-trail waypoints toward the limit', () => {
    const t = thorsborne();
    const w = t.waypoints[0];
    t.waypoints = new Array(1000).fill(w);
    t.offTrailWaypoints = new Array(1001).fill({ ...w, distanceFromTrail: 900 });
    expect(byId(runCommunityChecks(t, META).checks, 'waypoints').level).toBe('fail');
  });
  it('counts variant waypoints toward the limit, and in the stats', () => {
    const t = thorsborne();
    const variant = slicedVariant(t, 100, 200, 'side-trip');
    const vw = { ...t.waypoints[0], variantTrackIndex: 3 };
    variant.waypoints = new Array(1000).fill(vw);
    t.sideTrips = [variant];
    const under = runCommunityChecks(t, META);
    expect(byId(under.checks, 'waypoints').level).toBe('pass');
    expect(under.stats!.waypointCount).toBe(t.waypoints.length + 1000);
    variant.waypoints = new Array(1995).fill(vw);
    expect(byId(runCommunityChecks(t, META).checks, 'waypoints').level).toBe('fail');
  });
});

describe('the rebuild', () => {
  it('reproduces an honest import exactly', () => {
    const imported = thorsborne();
    const { trail } = runCommunityChecks(thorsborne(), META);
    expect(trail!.track.points).toEqual(imported.track.points);
    expect(trail!.track.displayPoints).toEqual(imported.track.displayPoints);
    expect(trail!.track.totalDistance).toBe(imported.track.totalDistance);
    expect(trail!.waypoints).toEqual(imported.waypoints);
    expect(trail!.config.direction).toEqual(imported.config.direction);
  });

  it('ignores client displayPoints', () => {
    const t = thorsborne();
    for (const p of t.track.displayPoints) {
      p.lat += 40;
      p.lon -= 100;
    }
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(true);
    const pointSet = new Set(result.trail!.track.points);
    for (const p of result.trail!.track.displayPoints) expect(pointSet.has(p)).toBe(true);
    expect(result.trail!.track.displayPoints).toEqual(thorsborne().track.displayPoints);
  });

  it('derives displayPoints for a long track the way buildTrail does', () => {
    const t = densified(20);
    expect(t.track.points.length).toBeGreaterThan(DEFAULT_TARGET_DISPLAY_POINTS);
    t.track.displayPoints = t.track.points.slice(0, 2);
    const { trail } = runCommunityChecks(t, META);
    const points = trail!.track.points;
    const tolerance = calculateAdaptiveTolerance(points, DEFAULT_TARGET_DISPLAY_POINTS, trail!.track.totalDistance);
    const expected = douglasPeuckerIndices(points, tolerance).map((i) => points[i]);
    expect(trail!.track.displayPoints.length).toBeLessThan(points.length);
    expect(trail!.track.displayPoints).toHaveLength(expected.length);
    trail!.track.displayPoints.forEach((p, i) => expect(p).toBe(expected[i]));
  });

  it('falls back to an even stride when Douglas-Peucker would run too long', () => {
    // A sawtooth whose teeth shrink by a metre a point: the point furthest
    // from every chord is the one next to its start, so Douglas-Peucker peels
    // one point per split, O(n²), which is the case the budget exists for.
    const t = thorsborne();
    const n = 20_000;
    const points: TrackPoint[] = [];
    for (let i = 0; i < n; i++) {
      points.push({ lat: -30 + ((i % 2 === 0 ? 1 : -1) * (n - i)) / 111_320, lon: 145 + i * 1e-4, ele: 0, dist: 0 });
    }
    t.track.points = points;
    t.waypoints = [];
    const { trail } = runCommunityChecks(t, META);
    const display = trail!.track.displayPoints;
    expect(display).toHaveLength(DEFAULT_TARGET_DISPLAY_POINTS);
    expect(display[0]).toBe(trail!.track.points[0]);
    expect(display.at(-1)).toBe(trail!.track.points.at(-1));
    const pointSet = new Set(trail!.track.points);
    for (const p of display) expect(pointSet.has(p)).toBe(true);
  });

  it('drops POIs', () => {
    const t = thorsborne();
    t.pois = [
      { id: 1, type: 'node', category: 'water', lat: -18.3, lon: 146.2, name: 'Fake tap', tags: {}, distanceAlongTrail: 1, distanceFromTrail: 0 },
    ];
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(true);
    expect('pois' in result.trail!).toBe(false);
    // Not even read: rubbish there is not a shape failure.
    (t as unknown as { pois: unknown }).pois = 'rubbish';
    expect(runCommunityChecks(t, META).ok).toBe(true);
  });

  it('forces the direction labels', () => {
    const t = thorsborne();
    t.config.direction = { default: 'Northbound <b>buy</b>', reversed: 'https://spam.example' };
    t.direction = t.config.direction;
    const { trail } = runCommunityChecks(t, META);
    expect(trail!.config.direction).toEqual({ default: 'Start → End', reversed: 'End → Start' });
    expect(trail!.direction).toEqual({ default: 'Start → End', reversed: 'End → Start' });
  });

  it('recomputes waypoint km, legs, climb and elevation from trackIndex', () => {
    const honest = thorsborne().waypoints;
    const t = thorsborne();
    for (const w of t.waypoints) {
      w.distance = 999;
      w.totalDistance = 4000;
      w.ascent = 5000;
      w.descent = 0;
      w.totalAscent = 9000;
      w.totalDescent = 0;
      w.elevation = 3000;
    }
    t.waypoints.reverse();
    const { trail } = runCommunityChecks(t, META);
    expect(trail!.waypoints).toEqual(honest);
    const w = trail!.waypoints[2];
    expect(w.totalDistance).toBe(Math.round(trail!.track.points[w.trackIndex].dist * 100) / 100);
    expect(w.elevation).toBe(Math.round(trail!.track.points[w.trackIndex].ele));
  });

  it('recomputes an off-trail waypoint\'s distance from the route', () => {
    const t = thorsborne();
    const p = t.track.points[50];
    t.offTrailWaypoints = [{ name: 'Far camp', type: 'campsite', lat: p.lat + 0.03, lon: p.lon, distanceFromTrail: 0 }];
    const { trail } = runCommunityChecks(t, META);
    const w = trail!.offTrailWaypoints[0];
    let nearest = Infinity;
    for (const q of trail!.track.points) nearest = Math.min(nearest, haversineDistance(w.lat, w.lon, q.lat, q.lon));
    expect(w.distanceFromTrail).toBe(Math.round(nearest));
    expect(w.distanceFromTrail).toBeGreaterThan(1000);
  });

  it('finds the true nearest point for off-trail waypoints near and far', () => {
    const t = thorsborne();
    const pts = t.track.points;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    t.offTrailWaypoints = Array.from({ length: 300 }, (_, k) => {
      const p = pts[Math.floor(rand() * pts.length)];
      // Two thirds within ~5 km of the route, the rest anywhere on Earth.
      const near = k % 3 !== 0;
      return {
        name: `w${k}`,
        type: 'campsite',
        lat: near ? p.lat + (rand() - 0.5) * 0.1 : (rand() - 0.5) * 179,
        lon: near ? p.lon + (rand() - 0.5) * 0.1 : (rand() - 0.5) * 359,
        distanceFromTrail: 0,
      };
    });
    const { trail } = runCommunityChecks(t, META);
    for (const w of trail!.offTrailWaypoints) {
      let nearest = Infinity;
      for (const q of trail!.track.points) nearest = Math.min(nearest, haversineDistance(w.lat, w.lon, q.lat, q.lon));
      expect(w.distanceFromTrail).toBe(Math.round(nearest));
    }
  });
});

describe('variants', () => {
  it('rebuilds an alternate\'s junctions, length, climb and waypoints', () => {
    const t = thorsborne();
    const variant = slicedVariant(t, 100, 200, 'alternate');
    variant.distance = 999;
    variant.elevation = { ascent: 99_999, descent: 0 };
    variant.startDistance = 0;
    variant.endDistance = 4000;
    variant.parent = { name: 'nonsense', index: 7 };
    variant.waypoints = [
      { ...t.waypoints[0], variantTrackIndex: 40, distance: 1, totalDistance: 9999, ascent: 1, descent: 1, totalAscent: 1, totalDescent: 1, elevation: 1 },
      { ...t.waypoints[1], variantTrackIndex: 10, distance: 1, totalDistance: 9999, ascent: 1, descent: 1, totalAscent: 1, totalDescent: 1, elevation: 1 },
    ];
    t.alternates = [variant];
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(true);
    const main = result.trail!.track.points;
    const alt = result.trail!.alternates[0];
    expect(alt.startDistance).toBe(Math.round(main[100].dist * 100) / 100);
    expect(alt.startTrackIndex).toBe(100);
    expect(alt.endDistance).toBe(Math.round(main[200].dist * 100) / 100);
    expect(alt.endTrackIndex).toBe(200);
    expect(alt.parent).toBeUndefined();
    const length = main[200].dist - main[100].dist;
    expect(alt.distance).toBeGreaterThan(length - 0.2);
    expect(alt.distance).toBeLessThan(length + 0.5);
    expect(alt.elevation.ascent).toBeLessThan(2000);
    // Sorted by index, km from the junction.
    expect(alt.waypoints!.map((w) => w.variantTrackIndex)).toEqual([10, 40]);
    const km10 = alongKm(alt.points, 10);
    expect(alt.waypoints![0].totalDistance).toBe(Math.round((alt.startDistance! + km10) * 100) / 100);
    expect(alt.waypoints![1].distance).toBe(Math.round((alongKm(alt.points, 40) - km10) * 100) / 100);
  });

  it('turns an alternate drawn backwards round, waypoints and all', () => {
    const t = thorsborne();
    const variant = slicedVariant(t, 100, 200, 'alternate');
    const n = variant.points.length;
    variant.points.reverse();
    variant.waypoints = [{ ...t.waypoints[0], variantTrackIndex: n - 1 - 10 }];
    t.alternates = [variant];
    const alt = runCommunityChecks(t, META).trail!.alternates[0];
    expect(alt.startTrackIndex).toBe(100);
    expect(alt.endTrackIndex).toBe(200);
    expect(alt.waypoints![0].variantTrackIndex).toBe(10);
  });

  it('fails shape when a variant starts 5 km from the route', () => {
    const t = thorsborne();
    const variant = slicedVariant(t, 100, 200, 'side-trip');
    for (const p of variant.points) p.lat += 0.045;
    t.sideTrips = [variant];
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(false);
    const shape = byId(result.checks, 'shape');
    expect(shape.level).toBe('fail');
    expect(shape.message).toMatch(/sideTrips\[0\] does not branch off the route/);
  });

  it('hangs a side trip off an alternate that leaves the route', () => {
    const t = thorsborne();
    // An alternate bulging ~1.1 km east of the route between points 100 and 200.
    const alternate = slicedVariant(t, 100, 200, 'alternate');
    alternate.points.forEach((p, k) => {
      p.lon += 0.0105 * Math.sin((Math.PI * k) / 100);
    });
    const tip = alternate.points[50];
    const sideTrip: RouteVariant = {
      name: 'Lookout',
      type: 'side-trip',
      points: Array.from({ length: 20 }, (_, k) => ({ lat: tip.lat, lon: tip.lon + k * 0.0005, ele: 10 })),
      distance: 0,
      elevation: { ascent: 0, descent: 0 },
    };
    t.alternates = [alternate];
    t.sideTrips = [sideTrip];
    const result = runCommunityChecks(t, META);
    expect(result.ok).toBe(true);
    const alt = result.trail!.alternates[0];
    const trip = result.trail!.sideTrips[0];
    expect(trip.parent).toEqual({ name: alt.name, index: 0 });
    expect(trip.startTrackIndex).toBeUndefined();
    expect(trip.startDistance).toBe(Math.round((alt.startDistance! + alongKm(alt.points, 50)) * 100) / 100);
  });

  it('gives a terminus no endDistance', () => {
    const t = thorsborne();
    const variant = slicedVariant(t, 100, 200, 'terminus');
    variant.endDistance = 5;
    t.sideTrips = [variant];
    const terminus = runCommunityChecks(t, META).trail!.sideTrips[0];
    expect(terminus.startTrackIndex).toBe(100);
    expect(terminus.endDistance).toBeUndefined();
  });
});

/** A variant along main points `from`..`to`, nudged ~50 m east so it is its own line. */
function slicedVariant(t: ProcessedTrail, from: number, to: number, type: RouteVariant['type']): RouteVariant {
  const points = t.track.points.slice(from, to + 1).map((p, k, all) => ({
    lat: p.lat,
    lon: p.lon + (k === 0 || k === all.length - 1 ? 0 : 0.0005),
    ele: p.ele,
  }));
  return { name: `Variant ${from}-${to}`, type, points, distance: 0, elevation: { ascent: 0, descent: 0 } };
}

/** Haversine km along `points` from the first to `index`. */
function alongKm(points: { lat: number; lon: number }[], index: number): number {
  let km = 0;
  for (let i = 1; i <= index; i++) km += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / 1000;
  return km;
}

/**
 * Thorsborne with `factor` points per original step: interpolated, with a
 * small deterministic wobble so Douglas-Peucker has something to keep, and km
 * that match the geometry.
 */
function densified(factor: number): ProcessedTrail {
  const t = thorsborne();
  const src = t.track.points;
  const points: TrackPoint[] = [];
  for (let i = 0; i < src.length - 1; i++) {
    for (let k = 0; k < factor; k++) {
      const f = k / factor;
      const wobble = 0.00003 * Math.sin(points.length * 0.7);
      points.push({
        lat: src[i].lat + (src[i + 1].lat - src[i].lat) * f + wobble,
        lon: src[i].lon + (src[i + 1].lon - src[i].lon) * f,
        ele: src[i].ele + (src[i + 1].ele - src[i].ele) * f,
        dist: 0,
      });
    }
  }
  points.push({ ...src[src.length - 1] });
  for (let i = 1; i < points.length; i++) {
    points[i].dist = points[i - 1].dist + alongKm([points[i - 1], points[i]], 1);
  }
  t.track.points = points;
  t.track.totalDistance = points[points.length - 1].dist;
  t.waypoints = [];
  return t;
}
