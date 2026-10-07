/**
 * `runCommunityChecks` — the automatic checks a shared route must pass.
 * Built from real GPX through `importGpx`, then mutated to trip each check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { importGpx } from './gpx-import';
import { hasFailures, runCommunityChecks, sanitiseCommunityTrail } from './community-checks';
import type { CommunityCheck } from './community-types';
import type { ProcessedTrail } from './trail-types';

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
    // Stretched in km only: the distance check fails too, but length must say so first.
    const t = thorsborne();
    for (const p of t.track.points) p.dist *= 200;
    expect(byId(runCommunityChecks(t, META).checks, 'length').level).toBe('fail');
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
});

describe('speed', () => {
  it('passes without timestamps', () => {
    expect(byId(runCommunityChecks(thorsborne(), META).checks, 'speed').level).toBe('pass');
  });
  it('warns when timestamps show driving speed, and drops them from the trail', () => {
    const t = thorsborne();
    const start = Date.parse('2026-05-01T00:00:00Z');
    // 60 km/h
    const points = t.track.points as (typeof t.track.points[number] & { time?: string })[];
    for (const p of points) p.time = new Date(start + (p.dist / 60) * 3_600_000).toISOString();
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'speed').level).toBe('warn');
    expect('time' in result.trail!.track.points[0]).toBe(false);
  });
  it('passes walking-pace timestamps', () => {
    const t = thorsborne();
    const start = Date.parse('2026-05-01T00:00:00Z');
    const points = t.track.points as (typeof t.track.points[number] & { time?: string })[];
    for (const p of points) p.time = new Date(start + (p.dist / 4) * 3_600_000).toISOString();
    expect(byId(runCommunityChecks(t, META).checks, 'speed').level).toBe('pass');
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
    t.track.totalAscent = t.track.totalDistance * 400;
    expect(byId(runCommunityChecks(t, META).checks, 'elevation').level).toBe('warn');
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
  it('ignores a recorded route break', () => {
    const t = thorsborne();
    const mid = Math.floor(t.track.points.length / 2);
    for (let i = mid; i < t.track.points.length; i++) t.track.points[i].lat += 0.03;
    t.track.breaks = [
      { index: mid, displayIndex: 1, km: t.track.points[mid].dist, straightLineKm: 3.3, fromTrack: 'a', toTrack: 'b' },
    ];
    const result = runCommunityChecks(t, META);
    expect(byId(result.checks, 'gaps').level).toBe('pass');
    expect(byId(result.checks, 'distance-consistency').level).toBe('pass');
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
});
