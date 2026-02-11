/**
 * Shared utilities for the plan system.
 */

import type { StopData } from './plan-calculator-types';

/** Generate a unique ID using crypto.randomUUID or a hex fallback. */
export function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: 16 random hex chars
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Migrate legacy stops JSON — backfill id field and nullable waypointName. */
export function migrateStopsJson(json: string | null): StopData[] {
  if (!json) return [];
  const parsed = JSON.parse(json);
  return parsed.map((s: Record<string, unknown>) => ({
    ...s,
    id: (s.id as string) ?? generateId(),
    waypointName: s.waypointName ?? null,
  }));
}
