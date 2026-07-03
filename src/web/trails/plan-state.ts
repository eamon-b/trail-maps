/**
 * Plan state persistence via localStorage.
 *
 * State shape is kept minimal and JSON-safe so that a future "share to phone"
 * feature can encode it in a URL parameter or QR code with no structural changes.
 */

import type { PlanState } from '@lib/plan-types';

const STORAGE_KEY = (trailId: string) => `trail-plan-${trailId}`;

function isValidPlanState(data: unknown): data is PlanState {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (obj.startDate !== null && typeof obj.startDate !== 'string') return false;
  if (!Array.isArray(obj.stops)) return false;
  // direction is optional (absent = NOBO); reject anything but the two enum values
  if (obj.direction !== undefined && obj.direction !== 'NOBO' && obj.direction !== 'SOBO') return false;
  return true;
}

export function loadPlanState(trailId: string): PlanState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(trailId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidPlanState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePlanState(trailId: string, state: PlanState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY(trailId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearPlanState(trailId: string): void {
  try {
    localStorage.removeItem(STORAGE_KEY(trailId));
  } catch {
    // ignore
  }
}
