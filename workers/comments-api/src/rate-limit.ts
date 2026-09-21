/**
 * Rolling-window rate limits backed by the `rate_events` log.
 *
 * The comment and report limits count rows in their own tables, which works
 * because every accepted write leaves one. A plan PUT replaces a row rather
 * than adding one, and a failed device-link attempt stores nothing at all, so
 * those two limits need an explicit event log. `bucket` names the limit and
 * `key` the subject (a user id, an IP address).
 */

import { HttpError } from './http';
import type { Env } from './http';

/** Named limits. Add the constant here so every ceiling is in one place. */
export const RATE_BUCKETS = {
  /** Plan PUTs per user per day — each toggle is a debounced PUT, not a keystroke. */
  planPut: { bucket: 'plan_put', limit: 240, windowMs: 24 * 60 * 60 * 1000 },
  /** Device-link attempts per IP per hour (counted whether or not the code was valid). */
  deviceLink: { bucket: 'device_link', limit: 10, windowMs: 60 * 60 * 1000 },
} as const;

export type RateBucket = (typeof RATE_BUCKETS)[keyof typeof RATE_BUCKETS];

/**
 * The longest window any bucket counts over: a row older than this can never
 * be counted by anything, whatever bucket or key it belongs to.
 */
export const MAX_RATE_WINDOW_MS = Math.max(
  ...Object.values(RATE_BUCKETS).map((spec) => spec.windowMs)
);

/** Count the events for (bucket, key) still inside the window. */
export async function countRateEvents(
  env: Env,
  spec: RateBucket,
  key: string,
  nowMs: number
): Promise<number> {
  const windowStart = new Date(nowMs - spec.windowMs).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at >= ?`
  )
    .bind(spec.bucket, key, windowStart)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Record one event, and prune expired rows off the response path.
 *
 * Two sweeps, both cheap: this subject's own rows outside its window (the
 * common case, straight down the `(bucket, key, created_at)` index), and every
 * row anywhere older than the longest window — otherwise a subject that never
 * comes back, an IP that tried once, leaves its rows in the table for good.
 */
export async function recordRateEvent(
  env: Env,
  spec: RateBucket,
  key: string,
  nowMs: number,
  ctx?: ExecutionContext
): Promise<void> {
  const windowStart = new Date(nowMs - spec.windowMs).toISOString();
  const staleEverywhere = new Date(nowMs - MAX_RATE_WINDOW_MS).toISOString();
  await env.DB.prepare(`INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?)`)
    .bind(spec.bucket, key, new Date(nowMs).toISOString())
    .run();

  const prune = env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_events WHERE bucket = ? AND key = ? AND created_at < ?`).bind(
      spec.bucket,
      key,
      windowStart
    ),
    env.DB.prepare(`DELETE FROM rate_events WHERE created_at < ?`).bind(staleEverywhere),
  ]).catch(() => {
    /* pruning is housekeeping; never fail a request over it */
  });
  if (ctx) ctx.waitUntil(prune);
}

/** Throw 429 when (bucket, key) has already used its allowance. */
export async function assertUnderRateLimit(
  env: Env,
  spec: RateBucket,
  key: string,
  nowMs: number,
  message: string
): Promise<void> {
  const used = await countRateEvents(env, spec, key, nowMs);
  if (used >= spec.limit) {
    throw new HttpError(429, 'rate_limited', message);
  }
}
