import { SELF, env } from 'cloudflare:test';
import { authHeaders, registerDevice, url } from './helpers';
import type { Env } from '../src/http';
import type { Device } from './helpers';
import type { ProcessedTrail, TrackPoint } from '../../../src/lib/trail-types';
import type { CommunitySubmitRequest } from '../../../src/lib/community-types';

const R_KM = 6371;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

let counter = 0;

/**
 * A plausible processed trail: ~`count` points ~110 m apart heading north, with
 * a gentle climb and three waypoints. Each call starts somewhere new (unless
 * `start` is given), so content hashes never collide between tests.
 */
export function makeTrail(
  options: { count?: number; start?: { lat: number; lon: number }; waypointName?: string } = {}
): ProcessedTrail {
  const count = options.count ?? 200;
  const n = counter++;
  const start = options.start ?? { lat: -38 + (n % 50) * 0.05, lon: 145 + Math.floor(n / 50) * 0.05 };
  const points: TrackPoint[] = [];
  let dist = 0;
  let ascent = 0;
  let descent = 0;
  for (let i = 0; i < count; i++) {
    const p = { lat: start.lat + i * 0.001, lon: start.lon + Math.sin(i / 10) * 0.0005 };
    const ele = 100 + Math.round(30 * Math.sin(i / 20));
    if (i > 0) {
      const prev = points[i - 1];
      dist += haversineKm(prev, p);
      const d = ele - prev.ele;
      if (d > 0) ascent += d;
      else descent -= d;
    }
    points.push({ lat: p.lat, lon: p.lon, ele, dist });
  }
  const wp = (i: number, name: string, type: string) => ({
    id: `uw_${n}_${i}`,
    name,
    type,
    lat: points[i].lat,
    lon: points[i].lon,
    elevation: points[i].ele,
    distance: points[i].dist,
    totalDistance: points[i].dist,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    trackIndex: i,
  });
  return {
    config: {
      id: `u_test${n}`,
      name: 'Test walk',
      shortName: 'Test walk',
      region: 'Imported',
      lengthKm: Math.round(dist * 10) / 10,
      gpxFile: '',
      direction: { default: 'Start → End', reversed: 'End → Start' },
      source: 'imported',
      elevationSource: 'gpx',
    },
    track: {
      points,
      displayPoints: points,
      totalDistance: dist,
      totalAscent: ascent,
      totalDescent: descent,
    },
    waypoints: [
      wp(0, 'Trailhead', 'trailhead'),
      wp(Math.floor(count / 2), options.waypointName ?? 'Creek camp', 'campsite'),
      wp(count - 1, 'Lookout', 'waypoint'),
    ],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: { default: 'Start → End', reversed: 'End → Start' },
  };
}

export function submitBody(overrides: Partial<CommunitySubmitRequest> & Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Ridge and river loop',
    description: 'A day along the ridge to the lookout, then down to the creek camp and out.',
    credit: null,
    country: 'AU',
    state: 'VIC',
    rightsConfirmed: true,
    trail: makeTrail(),
    ...overrides,
  };
}

export async function submitRoute(device: Device, body: unknown = submitBody()): Promise<Response> {
  return SELF.fetch(url('/v1/community/routes'), {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });
}

export const GPX_TEXT =
  '<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><trkseg><trkpt lat="-37" lon="145"/></trkseg></trk></gpx>';

export function base64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

/** Backdate an account's creation (the report hide counts only accounts a day old). */
export async function ageAccount(userId: string, ageMs = 2 * 24 * 60 * 60 * 1000): Promise<void> {
  await env.DB.prepare(`UPDATE users SET created_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() - ageMs).toISOString(), userId)
    .run();
}

/** A device whose account is old enough for its reports to count. */
export async function registerAgedDevice(): Promise<Device> {
  const device = await registerDevice();
  await ageAccount(device.userId);
  return device;
}

/**
 * The test env with its PHOTOS bucket wrapped: `hook` runs once, before the
 * first call of `method`, so a test can land a concurrent request in the
 * middle of a handler's R2 I/O. Pass the result to a handler called directly.
 */
export function envWithHook(method: 'put' | 'delete', hook: () => Promise<void>): Env {
  const photos = env.PHOTOS;
  let fired = false;
  const before = async () => {
    if (!fired) {
      fired = true;
      await hook();
    }
  };
  const PHOTOS = {
    put: async (...args: Parameters<R2Bucket['put']>) => {
      if (method === 'put') await before();
      return photos.put(...args);
    },
    delete: async (...args: Parameters<R2Bucket['delete']>) => {
      if (method === 'delete') await before();
      return photos.delete(...args);
    },
    get: (...args: Parameters<R2Bucket['get']>) => photos.get(...args),
    head: (...args: Parameters<R2Bucket['head']>) => photos.head(...args),
    list: (...args: Parameters<R2Bucket['list']>) => photos.list(...args),
  } as unknown as R2Bucket;
  return { ...(env as unknown as Env), PHOTOS };
}
