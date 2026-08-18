/**
 * Client-minted UUID v4.
 *
 * The comment id doubles as the server's idempotency key (see the PUT
 * /v1/comments/:id contract), so it MUST come from a cryptographically secure
 * random source — a colliding id would silently drop or misattribute a comment.
 * `Math.random()` is explicitly not acceptable here.
 *
 * Sources of randomness, in order:
 * 1. Web Crypto `crypto.getRandomValues` — Node provides it natively in the
 *    test environment (and some RN runtimes polyfill it).
 * 2. The Expo runtime's native `globalThis.expo.uuidv4` (what
 *    expo-modules-core's own `uuid.v4()` calls) — present in every Expo app,
 *    needed because Hermes ships no Web Crypto without the expo-crypto module.
 * We deliberately do NOT fall back to a weak PRNG — if no secure source exists
 * we throw, so a broken environment fails loudly rather than minting guessable
 * ids.
 */

const HEX: string[] = [];
for (let i = 0; i < 256; i++) {
  HEX.push((i + 0x100).toString(16).slice(1));
}

/** Mint a lowercase RFC-4122 version-4 UUID from a secure random source. */
export function uuidv4(): string {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== 'function') {
    const nativeUuidv4 = (
      globalThis as { expo?: { uuidv4?: () => string } }
    ).expo?.uuidv4;
    if (typeof nativeUuidv4 === 'function') {
      return nativeUuidv4().toLowerCase();
    }
    throw new Error('Secure random source unavailable; cannot mint a comment id');
  }
  const b = new Uint8Array(16);
  g.getRandomValues(b);
  // Set the version (4) and variant (10xx) bits.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return (
    HEX[b[0]] +
    HEX[b[1]] +
    HEX[b[2]] +
    HEX[b[3]] +
    '-' +
    HEX[b[4]] +
    HEX[b[5]] +
    '-' +
    HEX[b[6]] +
    HEX[b[7]] +
    '-' +
    HEX[b[8]] +
    HEX[b[9]] +
    '-' +
    HEX[b[10]] +
    HEX[b[11]] +
    HEX[b[12]] +
    HEX[b[13]] +
    HEX[b[14]] +
    HEX[b[15]]
  );
}
