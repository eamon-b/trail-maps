/**
 * Rolling-window rate limits backed by the `rate_events` log.
 *
 * The comment and report limits count rows in their own tables, which works
 * because every accepted write leaves one. A plan PUT replaces a row rather
 * than adding one, a failed device-link attempt stores nothing at all, and a
 * registration's only trace (`users`) carries no address, so those limits need
 * an explicit event log. `bucket` names the limit and `key` the subject (a user
 * id, or an address via `ipRateKey`).
 */

import { HttpError } from './http';
import type { Env } from './http';

/** Named limits. Add the constant here so every ceiling is in one place. */
export const RATE_BUCKETS = {
  /** Plan PUTs per user per day — each toggle is a debounced PUT, not a keystroke. */
  planPut: { bucket: 'plan_put', limit: 240, windowMs: 24 * 60 * 60 * 1000 },
  /** Device-link attempts per IP per hour (counted whether or not the code was valid). */
  deviceLink: { bucket: 'device_link', limit: 10, windowMs: 60 * 60 * 1000 },
  /**
   * Anonymous registrations (`POST /v1/devices`) per IP per hour. The route has
   * no credential to check, so without this one address could mint accounts —
   * and with them fresh comment/photo/plan allowances — as fast as it can post.
   * A household or a hut's shared wifi registering a handful of phones is far
   * below 20; a script is not.
   */
  deviceRegister: { bucket: 'device_register', limit: 20, windowMs: 60 * 60 * 1000 },
} as const;

export type RateBucket = (typeof RATE_BUCKETS)[keyof typeof RATE_BUCKETS];

/**
 * The longest window any bucket counts over: a row older than this can never
 * be counted by anything, whatever bucket or key it belongs to.
 */
export const MAX_RATE_WINDOW_MS = Math.max(
  ...Object.values(RATE_BUCKETS).map((spec) => spec.windowMs)
);

/** Dotted-quad IPv4, as it may trail an IPv4-mapped IPv6 address. */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/**
 * The first four hextets of an IPv6 address (its /64), or null when `ip` does
 * not parse as one. `::` is expanded first, so `2001:db8::1` and
 * `2001:0db8:0:0::2` land on the same prefix.
 */
function ipv6Prefix64(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...head, ...tail];
  if (!groups.every((g) => HEXTET_RE.test(g))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;
  const full = [...head, ...Array<string>(8 - groups.length).fill('0'), ...tail];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * The rate-limit key for a client address (`CF-Connecting-IP`).
 *
 * An IPv4 address is its own key. An IPv6 one is keyed by its /64: that is
 * the block a single subscriber is normally handed, so keying the full
 * address would let one client rotate through 2^64 keys and never hit a
 * limit. An IPv4-mapped address (`::ffff:198.51.100.7`) is keyed as the IPv4
 * it carries, not as the one /64 every such address shares. Anything that
 * parses as neither is used verbatim; a missing header is `unknown`.
 */
export function ipRateKey(raw: string | null): string {
  const ip = (raw ?? '').trim().toLowerCase();
  if (ip === '') return 'unknown';
  if (!ip.includes(':')) return ip;
  const zoneless = ip.split('%', 1)[0];
  const lastColon = zoneless.lastIndexOf(':');
  const trailing = zoneless.slice(lastColon + 1);
  if (IPV4_RE.test(trailing)) return trailing;
  return ipv6Prefix64(zoneless) ?? ip;
}

/**
 * Prune expired rows off the response path.
 *
 * Two sweeps, both cheap: this subject's own rows outside its window (the
 * common case, straight down the `(bucket, key, created_at)` index), and every
 * row anywhere older than the longest window — otherwise a subject that never
 * comes back, an IP that tried once, leaves its rows in the table for good.
 */
function pruneRateEvents(
  env: Env,
  spec: RateBucket,
  key: string,
  nowMs: number,
  ctx?: ExecutionContext
): void {
  const windowStart = new Date(nowMs - spec.windowMs).toISOString();
  const staleEverywhere = new Date(nowMs - MAX_RATE_WINDOW_MS).toISOString();
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

/**
 * Spend one unit of (bucket, key)'s allowance, or throw 429 when there is
 * none left.
 *
 * Insert first, count second, in one `batch` (a single D1 transaction). A
 * separate COUNT then INSERT lets N parallel requests all read "one below the
 * limit" before any of them writes, so all N pass; here each request's count
 * includes every row committed before its own, so at most `limit` of them can
 * see a count within the allowance. A refused request deletes its own row
 * again: the log records allowance spent, and a client retrying through a 429
 * must not keep pushing its own window forward.
 */
export async function consumeRateLimit(
  env: Env,
  spec: RateBucket,
  key: string,
  nowMs: number,
  message: string,
  ctx?: ExecutionContext
): Promise<void> {
  const windowStart = new Date(nowMs - spec.windowMs).toISOString();
  const [inserted, counted] = await env.DB.batch<{ id?: number; n?: number }>([
    env.DB.prepare(
      `INSERT INTO rate_events (bucket, key, created_at) VALUES (?, ?, ?) RETURNING id`
    ).bind(spec.bucket, key, new Date(nowMs).toISOString()),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND created_at >= ?`
    ).bind(spec.bucket, key, windowStart),
  ]);
  const used = counted.results[0]?.n ?? 0;
  if (used > spec.limit) {
    const id = inserted.results[0]?.id;
    if (id !== undefined) {
      await env.DB.prepare(`DELETE FROM rate_events WHERE id = ?`).bind(id).run();
    }
    throw new HttpError(429, 'rate_limited', message);
  }
  pruneRateEvents(env, spec, key, nowMs, ctx);
}
