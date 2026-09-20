/**
 * Plan persistence for the web planner — `localStorage`, and nothing else.
 *
 * Three keys per trail:
 *
 * - `trail-plan-doc-<trailId>` — the `PlanDocument` (`@lib/plan-types`), the
 *   one shape the planner reads and writes. It is also the wire shape the
 *   comments API will take (`PUT /v1/plans/:id`), so what is stored here is
 *   exactly what a later sync arm would send.
 * - `trail-plan-<trailId>` — the LEGACY `PlanState` the page saved before the
 *   day planner. Read once, by `loadOrMigratePlan`, and then left alone: it is
 *   a few hundred bytes, and leaving it means a user who opens an older build
 *   of the site (a cached tab, a rollback) still finds their stops.
 * - `trail-plan-ui-<trailId>` — view preferences that are NOT part of the plan
 *   (currently just "show all waypoints"). Deliberately outside the document:
 *   the document is size-capped and travels between devices, and which rows a
 *   browser lists is not something the phone should inherit.
 *
 * Every accessor swallows storage failures (private mode, blocked cookies,
 * a full quota) and reports them through a return value rather than throwing,
 * because the planner is still usable with nothing persisted.
 */

import type { PlanDirection } from '@lib/plan-direction';
import type { Pace, PlanDocument, PlanState, PlanWaypoint } from '@lib/plan-types';
import { isPace } from '@lib/plan-types';
import {
  assertPlanDocumentWithinLimits,
  isPlanDocument,
  migratePlanState,
  newPlan,
  type PlanCreateOptions,
} from '@lib/plan-editor';

const DOCUMENT_KEY = (trailId: string) => `trail-plan-doc-${trailId}`;
const LEGACY_KEY = (trailId: string) => `trail-plan-${trailId}`;
const UI_KEY = (trailId: string) => `trail-plan-ui-${trailId}`;

// ---------------------------------------------------------------------------
// The plan document
// ---------------------------------------------------------------------------

/**
 * The stored document for a trail, or null when there is none, the stored JSON
 * is unparseable, or it does not pass `isPlanDocument`.
 *
 * A malformed document is rejected whole rather than half-loaded: anyone can
 * edit `localStorage`, and a stop with a string km would sort into nonsense
 * several renders away from the cause.
 */
export function loadPlanDocument(trailId: string): PlanDocument | null {
  try {
    const raw = localStorage.getItem(DOCUMENT_KEY(trailId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPlanDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the document. Returns false when it could not be stored — a full or
 * disabled `localStorage`, or a document outside the limits the server also
 * enforces, which is caught here so an over-size plan never lands in storage
 * only to be rejected again on the next load.
 */
export function savePlanDocument(trailId: string, plan: PlanDocument): boolean {
  try {
    assertPlanDocumentWithinLimits(plan);
    localStorage.setItem(DOCUMENT_KEY(trailId), JSON.stringify(plan));
    return true;
  } catch {
    return false;
  }
}

/** Forget the stored document (the legacy key, if any, is left alone). */
export function clearPlanDocument(trailId: string): void {
  try {
    localStorage.removeItem(DOCUMENT_KEY(trailId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// The legacy PlanState
// ---------------------------------------------------------------------------

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

/** The legacy `PlanState` under `trail-plan-<trailId>`, or null. */
export function loadPlanState(trailId: string): PlanState | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY(trailId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlanStateShape(parsed)) return null;
    return withUsableInputs(parsed);
  } catch {
    return null;
  }
}

/**
 * Write a legacy `PlanState`. The planner no longer calls this — it exists so
 * a test (and, in a pinch, a console) can seed the pre-day-planner shape that
 * `loadOrMigratePlan` reads.
 */
export function savePlanState(trailId: string, state: PlanState): boolean {
  try {
    localStorage.setItem(LEGACY_KEY(trailId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearPlanState(trailId: string): void {
  try {
    localStorage.removeItem(LEGACY_KEY(trailId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** What `loadOrMigratePlan` needs of a trail: its name, and its waypoints. */
export interface PlanTrailSource {
  config: { id: string; name: string; shortName?: string };
  waypoints?: PlanWaypoint[];
}

/** How the document the planner booted with was arrived at. */
export type PlanOrigin = 'stored' | 'migrated' | 'new';

export interface LoadedPlan {
  plan: PlanDocument;
  origin: PlanOrigin;
}

/**
 * The plan to open this trail with: the stored document, a one-off migration
 * of the legacy `PlanState`, or a fresh empty plan.
 *
 * A migration is saved immediately, so it happens once however many times the
 * page is opened, and the legacy key is deliberately left where it is (see the
 * file header). `idFactory` reaches `newPlan`/`migratePlanState` — the browser
 * default (`crypto.randomUUID`) is right for both planner pages, and the
 * option is here so a test can mint predictable ids.
 *
 * Phase 3c (sync) starts here: a server copy newer than what this returns
 * replaces it before the first render, and is then written back with
 * `savePlanDocument`.
 */
export function loadOrMigratePlan(
  trailId: string,
  trail: PlanTrailSource,
  opts?: PlanCreateOptions,
): LoadedPlan {
  const stored = loadPlanDocument(trailId);
  if (stored) {
    // A record whose id drifted from the key it is stored under (an imported
    // trail re-imported under a new id) would otherwise save to one slot and
    // load from another.
    return { plan: stored.trailId === trailId ? stored : { ...stored, trailId }, origin: 'stored' };
  }

  const legacy = loadPlanState(trailId);
  if (legacy) {
    const migrated = migratePlanState(legacy, trailId, trail.waypoints ?? [], opts);
    savePlanDocument(trailId, migrated);
    // Pace and hours are not part of the document (see PlanUiPrefs), so they
    // move to this browser's view preferences rather than being lost.
    if (legacy.pace !== undefined || legacy.dailyHours !== undefined) {
      const prefs = loadPlanUiPrefs(trailId);
      if (legacy.pace !== undefined) prefs.pace = legacy.pace;
      if (legacy.dailyHours !== undefined) prefs.dailyHours = legacy.dailyHours;
      savePlanUiPrefs(trailId, prefs);
    }
    return { plan: migrated, origin: 'migrated' };
  }

  const name = `My ${trail.config.shortName ?? trail.config.name} plan`;
  const direction: PlanDirection = 'NOBO';
  return { plan: newPlan(trailId, name, direction, opts), origin: 'new' };
}

// ---------------------------------------------------------------------------
// View preferences
// ---------------------------------------------------------------------------

/**
 * Per-browser view settings for one trail's planner. Not part of the plan —
 * see the file header for why.
 */
export interface PlanUiPrefs {
  /** Stops tab: list every waypoint rather than only the overnight candidates. */
  showAllWaypoints: boolean;
  /**
   * The hiker's pace preset and hours per day — the header inputs. Absent =
   * the input's initial value (Average, 8 h). They live here rather than in
   * the document because the phone keeps its own in its inputs store, and a
   * shared plan should not say how fast its author walks.
   */
  pace?: Pace;
  dailyHours?: number;
}

const DEFAULT_UI_PREFS: PlanUiPrefs = { showAllWaypoints: false };

/** A pace or hours figure the header inputs could have produced, or undefined. */
function usablePace(value: unknown): Pace | undefined {
  return isPace(value) ? value : undefined;
}

function usableHours(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function loadPlanUiPrefs(trailId: string): PlanUiPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY(trailId));
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_UI_PREFS };
    const obj = parsed as Record<string, unknown>;
    const prefs: PlanUiPrefs = {
      showAllWaypoints:
        typeof obj.showAllWaypoints === 'boolean'
          ? obj.showAllWaypoints
          : DEFAULT_UI_PREFS.showAllWaypoints,
    };
    const pace = usablePace(obj.pace);
    if (pace !== undefined) prefs.pace = pace;
    const hours = usableHours(obj.dailyHours);
    if (hours !== undefined) prefs.dailyHours = hours;
    return prefs;
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function savePlanUiPrefs(trailId: string, prefs: PlanUiPrefs): void {
  try {
    localStorage.setItem(UI_KEY(trailId), JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Forget everything this browser holds about a trail's plan — the document,
 * the legacy save and the view preferences.
 *
 * Called when an imported trail is deleted. Its id is a content hash of the
 * GPX, so re-importing the very same file lands on the same id, and anything
 * left behind would reappear attached to what the user believes is a
 * brand-new trail.
 */
export function clearPlanStorage(trailId: string): void {
  clearPlanDocument(trailId);
  clearPlanState(trailId);
  try {
    localStorage.removeItem(UI_KEY(trailId));
  } catch {
    // ignore
  }
}
