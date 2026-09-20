/**
 * The pure half of Settings' "Linked browsers" section: how a link code, a
 * countdown and a device row are turned into text.
 *
 * Kept apart from the component so the fiddly parts — a code grouped for
 * reading aloud, a countdown that must never render "-1:-3", a device line
 * that says different things for the phone and for a browser — can be tested
 * without a renderer or a clock.
 *
 * The date formatting is deliberately a local eight-liner rather than an import
 * from another feature slice (slices never import each other) or `Intl`, which
 * Hermes ships without full ICU on Android.
 */

import type { DeviceTokenSummary } from '@lib/comments-api-types';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `2027-03-20T…` → `20 Mar 2027`. Empty string for anything unparseable. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The code as it is read off the screen: two groups of four.
 *
 * The server's alphabet already excludes 0/O and 1/I; the gap is the other half
 * of getting eight characters typed into another device correctly. The exchange
 * endpoint strips spaces, so the grouping is display-only.
 */
export function groupCode(code: string): string {
  const clean = code.replace(/\s+/g, '');
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)} ${clean.slice(4)}`;
}

/** Whole seconds left until `expiresAt`, never negative. */
export function secondsUntil(expiresAt: string, nowMs: number): number {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - nowMs) / 1000));
}

/** `m:ss` for a countdown. A code lives ten minutes, so no hours case. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** The name shown for a device: what the linking browser called itself, or its kind. */
export function deviceTitle(device: DeviceTokenSummary): string {
  const label = device.label?.trim();
  if (label) return label;
  return device.kind === 'primary' ? 'This phone' : 'A browser';
}

/**
 * The line under a device's name.
 *
 * The phone says so explicitly, because it is the one row with no Remove
 * button and the reason has to be visible rather than inferred. A linked
 * browser leads with when it was last used (is this still me?) and ends with
 * when it stops working by itself (the 180-day expiry).
 *
 * `nowMs` defaults to the system clock so the component can call this without
 * reading the clock during render (which React's purity rule rightly forbids);
 * the tests pass one explicitly, which is the only reason the parameter exists.
 */
export function deviceSubtitle(device: DeviceTokenSummary, nowMs: number = Date.now()): string {
  const parts: string[] = [];
  if (device.kind === 'primary') {
    parts.push(device.current ? 'This phone' : 'The phone that owns this account');
  } else if (device.current) {
    parts.push('This device');
  }
  const seen = device.lastSeenAt ? shortDate(device.lastSeenAt) : '';
  if (seen) parts.push(`last used ${seen}`);
  if (device.expiresAt) {
    const expired = Date.parse(device.expiresAt) <= nowMs;
    parts.push(`${expired ? 'expired' : 'expires'} ${shortDate(device.expiresAt)}`);
  }
  if (parts.length === 0) parts.push(`added ${shortDate(device.createdAt)}`);
  return parts.join(' · ');
}

/** Whether this row offers a Remove button (only a linked browser can be revoked). */
export function isRemovable(device: DeviceTokenSummary): boolean {
  return device.kind === 'linked';
}
