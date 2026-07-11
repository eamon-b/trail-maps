/**
 * Typed navigation contract for the unified MapPointPicker screen
 * (app/plan/point-picker.tsx).
 *
 * Replaces the old dynamic-param contract (`mapSelected_${target}_km`) with
 * fixed, well-known param names plus a `pickerRequestId` correlation token:
 * the caller mints an id when launching the picker and only consumes a result
 * whose `pickerResultId` echoes it, so stale results from an earlier launch
 * can never be mistaken for the current one.
 */

export type PickerMode = 'add' | 'relocate' | 'day' | 'section' | 'single';

/** Request half of the contract — what a caller passes to the picker. */
export interface PickerRequest {
  mode: PickerMode;
  trailId: string;
  /** Required for modes that persist to a plan (add/relocate/day/section) */
  planId?: string;
  /** 'SOBO' reverses the trail before display (section mode) */
  direction?: string;
  /** relocate: the stop being moved */
  stopId?: string;
  /** relocate: the stop's current km (centres the highlight) */
  currentKm?: number;
  /** day: highlighted segment + title */
  highlightStartKm?: number;
  highlightEndKm?: number;
  dayLabel?: string;
  /** section: preselected range */
  currentStartKm?: number;
  currentEndKm?: number;
  /** single: correlation token minted by the caller */
  pickerRequestId?: string;
  /** single: route to navigate back to with the result params */
  returnTo?: string;
  /** single: which slot the result fills (e.g. 'start' | 'end') */
  target?: string;
}

/** Result half of the contract for 'single' mode. */
export interface SinglePointResult {
  target: string;
  km: number;
  name: string;
}

/** Mint a correlation id for a single-point request. */
export function createPickerRequestId(): string {
  return `pick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Serialize a request into router params (all values stringified). */
export function buildPickerParams(request: PickerRequest): Record<string, string> {
  const params: Record<string, string> = {
    mode: request.mode,
    trailId: request.trailId,
  };
  if (request.planId != null) params.planId = request.planId;
  if (request.direction != null) params.direction = request.direction;
  if (request.stopId != null) params.stopId = request.stopId;
  if (request.currentKm != null) params.currentKm = String(request.currentKm);
  if (request.highlightStartKm != null) params.highlightStartKm = String(request.highlightStartKm);
  if (request.highlightEndKm != null) params.highlightEndKm = String(request.highlightEndKm);
  if (request.dayLabel != null) params.dayLabel = request.dayLabel;
  if (request.currentStartKm != null) params.currentStartKm = String(request.currentStartKm);
  if (request.currentEndKm != null) params.currentEndKm = String(request.currentEndKm);
  if (request.pickerRequestId != null) params.pickerRequestId = request.pickerRequestId;
  if (request.returnTo != null) params.returnTo = request.returnTo;
  if (request.target != null) params.target = request.target;
  return params;
}

/** Parse router params back into a request (the picker screen's side). */
export function parsePickerRequest(
  params: Record<string, string | string[] | undefined>,
): PickerRequest | null {
  const get = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const mode = get('mode');
  const trailId = get('trailId');
  if (!trailId) return null;
  if (mode !== 'add' && mode !== 'relocate' && mode !== 'day' && mode !== 'section' && mode !== 'single') {
    return null;
  }
  const num = (key: string): number | undefined => {
    const v = get(key);
    if (v == null) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    mode,
    trailId,
    planId: get('planId'),
    direction: get('direction'),
    stopId: get('stopId'),
    currentKm: num('currentKm'),
    highlightStartKm: num('highlightStartKm'),
    highlightEndKm: num('highlightEndKm'),
    dayLabel: get('dayLabel'),
    currentStartKm: num('currentStartKm'),
    currentEndKm: num('currentEndKm'),
    pickerRequestId: get('pickerRequestId'),
    returnTo: get('returnTo'),
    target: get('target'),
  };
}

/** Serialize a single-point result into the return-navigation params. */
export function buildSinglePointResultParams(
  requestId: string,
  result: SinglePointResult,
): Record<string, string> {
  return {
    pickerResultId: requestId,
    pickerTarget: result.target,
    pickerKm: String(result.km),
    pickerName: result.name,
  };
}

/**
 * Parse a single-point result from route params. Returns null when the params
 * carry no result or when `pickerResultId` does not match `expectedRequestId`.
 */
export function parseSinglePointResult(
  params: Record<string, string | string[] | undefined>,
  expectedRequestId: string | null,
): SinglePointResult | null {
  const get = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const resultId = get('pickerResultId');
  if (!resultId || !expectedRequestId || resultId !== expectedRequestId) return null;
  const target = get('pickerTarget');
  const kmStr = get('pickerKm');
  if (!target || kmStr == null) return null;
  const km = parseFloat(kmStr);
  if (!Number.isFinite(km)) return null;
  return { target, km, name: get('pickerName') ?? `km ${km.toFixed(1)}` };
}
