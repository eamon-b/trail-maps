/**
 * Plan state persistence via localStorage.
 *
 * State shape is kept minimal and JSON-safe so that a future "share to phone"
 * feature can encode it in a URL parameter or QR code with no structural changes.
 */

import type { PlanState } from '@lib/plan-types';

const STORAGE_KEY = (trailId: string) => `trail-plan-${trailId}`;

export function loadPlanState(trailId: string): PlanState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(trailId));
    if (!raw) return null;
    return JSON.parse(raw) as PlanState;
  } catch {
    return null;
  }
}

export function savePlanState(trailId: string, state: PlanState): void {
  try {
    localStorage.setItem(STORAGE_KEY(trailId), JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded)
  }
}

export function clearPlanState(trailId: string): void {
  try {
    localStorage.removeItem(STORAGE_KEY(trailId));
  } catch {
    // ignore
  }
}
