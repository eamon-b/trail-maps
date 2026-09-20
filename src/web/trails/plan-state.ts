/**
 * Plan state persistence via localStorage.
 *
 * State shape is kept minimal and JSON-safe so that a future "share to phone"
 * feature can encode it in a URL parameter or QR code with no structural changes.
 */

import type { PlanState } from '@lib/plan-types';
import { isPace } from '@lib/plan-types';

const STORAGE_KEY = (trailId: string) => `trail-plan-${trailId}`;

/**
 * The fields a record must have to be a plan at all. A record missing one of
 * them, or holding the wrong kind of value in it, is not a plan we can repair —
 * there is no sensible stand-in for a stops array or a direction.
 *
 * `pace` and `dailyHours` are deliberately *not* checked here: they are the
 * initial values of two header inputs, so a bad one has an obvious fallback and
 * is dropped by {@link withUsableInputs} rather than costing the hiker the plan
 * around it.
 */
function isPlanStateShape(data: unknown): data is PlanState {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (obj.startDate !== null && typeof obj.startDate !== 'string') return false;
  if (!Array.isArray(obj.stops)) return false;
  // direction is optional (absent = NOBO); reject anything but the two enum values
  if (obj.direction !== undefined && obj.direction !== 'NOBO' && obj.direction !== 'SOBO') return false;
  // resupplyStops is optional (absent = every option ticked); when present it is
  // a list of waypoint ids, so anything else is a hand-edited or stale record.
  if (obj.resupplyStops !== undefined) {
    if (!Array.isArray(obj.resupplyStops)) return false;
    if (obj.resupplyStops.some(id => typeof id !== 'string')) return false;
  }
  return true;
}

/**
 * Drop a pace or hours figure the header inputs could never have produced, and
 * keep everything else.
 *
 * Both are optional (absent = the input's initial value, Average and 8 h), and
 * the calculators now refuse a pace they cannot walk at — so a hand-edited or
 * stale figure has to go. Throwing the whole record away with it would lose the
 * plan's name, its stops and its dates over a field the page can default, so
 * only the bad field is removed.
 */
function withUsableInputs(state: PlanState): PlanState {
  const cleaned: PlanState = { ...state };
  if (cleaned.pace !== undefined && !isPace(cleaned.pace)) delete cleaned.pace;
  const hours: unknown = cleaned.dailyHours;
  if (hours !== undefined && (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)) {
    delete cleaned.dailyHours;
  }
  return cleaned;
}

export function loadPlanState(trailId: string): PlanState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(trailId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlanStateShape(parsed)) return null;
    return withUsableInputs(parsed);
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
