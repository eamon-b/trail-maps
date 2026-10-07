/**
 * Community routes' R2 objects (`community.ts` has the layout in its header):
 * encoding a trail, writing its private and public copies, and purging them.
 * Nothing here reads or writes D1; the row that names an object is the
 * caller's to keep in step.
 */

import { HttpError } from './http';
import type { Env } from './http';
import { COMMUNITY_LIMITS } from '../../../src/lib/community-types';
import type { ProcessedTrail } from '../../../src/lib/trail-types';

const TRAIL_PREFIX = 'community/v1/';
/** Under `<id>/`: the canonical JSON and the raw GPX, at random keys. */
const PRIVATE_PREFIX = 'community/private/';
/**
 * Content-addressed, so a key never changes meaning, but short-lived at the
 * edge: hiding a route deletes its public objects, and an edge copy must not
 * outlive that by more than a few minutes. Clients verify the md5 and keep
 * their own copy, so a short max-age costs little.
 */
const PUBLIC_TRAIL_CACHE = 'public, max-age=300';

function hex(buffer: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** md5 hex; Workers' `crypto.subtle` supports MD5 as a non-standard extension. */
async function md5Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('MD5', bytes));
}

/** 32 hex chars of randomness: the unguessable part of a private key. */
function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

export function privateKey(id: string, ext: 'json' | 'gpx'): string {
  return `${PRIVATE_PREFIX}${id}/${randomHex()}.${ext}`;
}

function publicKey(id: string, md5: string): string {
  return `${TRAIL_PREFIX}${id}.${md5.slice(0, 12)}.json`;
}

async function putPublic(env: Env, key: string, body: Uint8Array): Promise<void> {
  await env.PHOTOS.put(key, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: PUBLIC_TRAIL_CACHE },
  });
}

/** A trail serialised as it will be stored, measured and hashed. */
export interface EncodedTrail {
  body: Uint8Array<ArrayBuffer>;
  md5: string;
  bytes: number;
}

/**
 * Serialise and measure a trail, 413 when it is over the cap. Separate from
 * the write so a caller can refuse an oversized route before it spends any
 * allowance on it.
 */
export async function encodeTrail(trail: ProcessedTrail): Promise<EncodedTrail> {
  const body = new TextEncoder().encode(JSON.stringify(trail));
  if (body.byteLength > COMMUNITY_LIMITS.trailJsonMaxBytes) {
    throw new HttpError(
      413,
      'trail_too_large',
      `The processed route must be at most ${COMMUNITY_LIMITS.trailJsonMaxBytes} bytes`
    );
  }
  return { body, md5: await md5Hex(body), bytes: body.byteLength };
}

export interface StoredTrail {
  /** The public copy, or null when none was written (the route is not live). */
  publicKey: string | null;
  privateKey: string;
  md5: string;
  bytes: number;
}

/**
 * Write an encoded trail's canonical private copy and, when `publish`, its
 * public copy (the same bytes). Nothing is deleted here.
 */
export async function putTrail(env: Env, id: string, encoded: EncodedTrail, publish: boolean): Promise<StoredTrail> {
  const priv = privateKey(id, 'json');
  await env.PHOTOS.put(priv, encoded.body, { httpMetadata: { contentType: 'application/json' } });
  let pub: string | null = null;
  if (publish) {
    pub = publicKey(id, encoded.md5);
    await putPublic(env, pub, encoded.body);
  }
  return { publicKey: pub, privateKey: priv, md5: encoded.md5, bytes: encoded.bytes };
}

export async function readStoredTrail(env: Env, key: string): Promise<ProcessedTrail | null> {
  const object = await env.PHOTOS.get(key);
  if (!object) return null;
  try {
    return (await object.json()) as ProcessedTrail;
  } catch {
    return null;
  }
}

/**
 * Put a route back on the public domain from its private copy. Idempotent:
 * the key is content-addressed, so a second put rewrites the same object.
 * Returns the public key, or null when the private copy is gone.
 */
export async function publishFromPrivate(env: Env, id: string, privateObjectKey: string): Promise<string | null> {
  const object = await env.PHOTOS.get(privateObjectKey);
  if (!object) return null;
  const body = new Uint8Array(await object.arrayBuffer());
  const key = publicKey(id, await md5Hex(body));
  await putPublic(env, key, body);
  return key;
}

export function deleteObjects(env: Env, keys: (string | null | undefined)[]): Promise<void> {
  const live = keys.filter((k): k is string => !!k);
  if (live.length === 0) return Promise.resolve();
  return env.PHOTOS.delete(live).catch(() => {
    /* best-effort: an orphaned object costs storage, never correctness */
  });
}

/**
 * Delete every object under `prefix` except `keep` (paged; R2 deletes up to
 * 1,000 keys a call).
 */
async function purgePrefix(env: Env, prefix: string, keep?: string | null): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const listed = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((o) => o.key).filter((k) => k !== keep);
    if (keys.length > 0) await env.PHOTOS.delete(keys);
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

/**
 * Every public version of a route: the current one and any older ones a
 * republish left for cached lists. The trailing `.` keeps `c_abc` from
 * matching `c_abcd…`. Never throws.
 */
export function purgePublic(env: Env, id: string, keep?: string | null): Promise<void> {
  return purgePrefix(env, `${TRAIL_PREFIX}${id}.`, keep).catch((err) => {
    console.error(`Purging public copies of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Both prefixes: a removed route. Never throws. */
export function purgeAll(env: Env, id: string): Promise<void> {
  return Promise.all([
    purgePublic(env, id),
    purgePrefix(env, `${PRIVATE_PREFIX}${id}/`).catch((err) => {
      console.error(`Purging private copies of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }),
  ]).then(() => undefined);
}
