/**
 * The plan page's "Plan the next few days" section — the web half of issue 81.
 *
 * The phone's Next days card, on the web: pick a start (your last stop, the
 * trail start, or your location), a number of days and what a good day is —
 * *Hours & pace* (the header's pace and hours/day) or *Distance & climb*
 * (km, ascent and hours ranges) — and get ranked alternative plans. Clicking
 * an option draws it on the map; "Use this plan" puts its stops into the
 * document, replacing only the stops inside its window.
 *
 * The search (`@lib/day-suggest`) and everything around it that the phone
 * shares (`@lib/plan-suggest`) are not re-implemented here: this module is
 * only the HTML and the browser's geolocation. It talks to the viewer through
 * `NextDaysHost`, so it can be driven in a test without Leaflet.
 *
 * Every element is rebuilt on render and every handler is delegated from the
 * container, which survives — the same idiom as the Stops and Resupply tabs.
 */

import { buildTimeIndex, type PlanTrail } from '@lib/day-calculator';
import { haversineDistance } from '@lib/distance';
import {
  MAX_SUGGEST_DAYS,
  isSearchable,
  suggestDays,
  type SuggestDaysResult,
  type SuggestedPlan,
} from '@lib/day-suggest';
import { overnightCandidates, type ToggleTarget } from '@lib/plan-editor';
import { toNoboKm } from '@lib/plan-direction';
import {
  MAX_ALTERNATIVES_SHOWN,
  applySuggestedPlan,
  defaultSuggestPrefs,
  suggestionCriteria,
  suggestionStart,
  type RangePref,
  type SuggestPrefs,
  type SuggestStart,
} from '@lib/plan-suggest';
import type { PlanDocument, PlanWaypoint, SectionConfig } from '@lib/plan-types';
import { buildPointIndex } from '@lib/point-index';
import { routeBreakStarts } from '@lib/route-breaks';
import { escapeHtml } from '../web-utils';

/** The trail as this section reads it: the direction-applied one the page shows. */
export type NextDaysTrail = PlanTrail & {
  track: PlanTrail['track'] & { points: Array<{ lat: number; lon: number; ele: number; dist: number }> };
  waypoints?: PlanWaypoint[];
};

/** A place a day can end, as the search sees it. */
export interface NextDaysCandidate {
  km: number;
  waypoint: PlanWaypoint;
}

export type NextDaysPlan = SuggestedPlan<NextDaysCandidate>;

/** What the section needs from the plan viewer. */
export interface NextDaysHost {
  /** The direction-applied trail. */
  trail(): NextDaysTrail;
  plan(): PlanDocument;
  baseKmh(): number;
  dailyHours(): number;
  /** The stored inputs, or undefined before the hiker changed any. */
  prefs(): SuggestPrefs | undefined;
  savePrefs(prefs: SuggestPrefs): void;
  /** Apply an edit through the viewer's refusal-aware path. */
  edit(edit: () => PlanDocument): void;
  /** Draw a suggested plan on the map (null clears it). */
  preview(plan: NextDaysPlan | null): void;
  /** The hiker's located km changed (null = forgotten). */
  onHere(km: number | null): void;
}

export interface NextDaysController {
  /** Re-render with the current plan, trail and inputs; drops a stale result. */
  render(): void;
  /** The located km (active), or null. */
  hereKm(): number | null;
}

type FromChoice = 'auto' | 'last-stop';

/** Where a browser fix lands on the trail. */
export interface LocatedPoint {
  km: number;
  /** Straight-line metres from the fix to that point of the track. */
  offTrailMeters: number;
}

/** Snap a coordinate to the nearest point of the (direction-applied) track. */
export function locateOnTrail(trail: NextDaysTrail, lat: number, lon: number): LocatedPoint | null {
  const point = buildPointIndex(trail.track.points).nearest(lat, lon);
  if (!point) return null;
  return { km: point.dist, offTrailMeters: haversineDistance(lat, lon, point.lat, point.lon) };
}

/** Run the search for the whole (direction-applied) trail. */
export function suggestForTrail(
  trail: NextDaysTrail,
  start: SuggestStart,
  prefs: SuggestPrefs,
  dailyHours: number,
  baseKmh: number,
): SuggestDaysResult<NextDaysCandidate> | null {
  const criteria = suggestionCriteria(prefs, dailyHours);
  if (!criteria || !isSearchable(criteria)) return null;
  const index = buildTimeIndex(trail.track.points, routeBreakStarts(trail.track.breaks, 'points'));
  const candidates = overnightCandidates(trail.waypoints ?? []).map(waypoint => ({
    km: waypoint.totalDistance ?? 0,
    waypoint,
  }));
  return suggestDays({
    index,
    candidates,
    fromKm: start.km,
    endKm: trail.track.totalDistance,
    days: prefs.days,
    alternatives: prefs.alternatives,
    criteria,
    baseKmh,
  });
}

/** Apply a chosen plan: its stops replace those between the start and its last day. */
export function applyNextDaysPlan(
  plan: PlanDocument,
  startKm: number,
  chosen: NextDaysPlan,
  totalDistance: number,
): PlanDocument {
  const targets: ToggleTarget[] = chosen.stops.map(stop => ({
    ...(stop.waypoint.id ? { id: stop.waypoint.id } : {}),
    km: toNoboKm(stop.km, plan.direction, totalDistance),
    name: stop.waypoint.name ?? 'Stop',
  }));
  const last = chosen.days[chosen.days.length - 1];
  return applySuggestedPlan(plan, startKm, last ? last.endKm : startKm, targets, totalDistance);
}

function wholeTrailSection(trail: NextDaysTrail): SectionConfig {
  const waypoints = trail.waypoints ?? [];
  return {
    startKm: 0,
    endKm: trail.track.totalDistance,
    startName: waypoints[0]?.name ?? `${trail.config.name} start`,
    endName: waypoints[waypoints.length - 1]?.name ?? `${trail.config.name} end`,
  };
}

const clampInt = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/**
 * Mount the section into `container` (its contents are replaced on every
 * render; its listeners are attached once).
 */
export function initNextDays(container: HTMLElement, host: NextDaysHost): NextDaysController {
  // The raw fix, not a km: the km depends on which way the page is walking the
  // trail, so it is re-snapped against whichever trail is current (cached).
  let fix: { lat: number; lon: number } | null = null;
  let snapped: { trail: NextDaysTrail; point: LocatedPoint | null } | null = null;
  const located = (): LocatedPoint | null => {
    if (!fix) return null;
    const trail = host.trail();
    if (!snapped || snapped.trail !== trail) {
      snapped = { trail, point: locateOnTrail(trail, fix.lat, fix.lon) };
    }
    return snapped.point;
  };
  let locating = false;
  let locateError: string | null = null;
  let from: FromChoice = 'auto';
  let result: { key: string; value: SuggestDaysResult<NextDaysCandidate> | null } | null = null;
  let previewIndex: number | null = null;

  const prefs = (): SuggestPrefs => host.prefs() ?? defaultSuggestPrefs(host.dailyHours(), host.baseKmh());

  const start = (): SuggestStart => {
    const trail = host.trail();
    return suggestionStart(
      host.plan(),
      wholeTrailSection(trail),
      trail.track.totalDistance,
      located()?.km ?? null,
      from === 'last-stop',
    );
  };

  /** Where a suggestion would start if the location were ignored. */
  const lastStopStart = (): SuggestStart => {
    const trail = host.trail();
    return suggestionStart(host.plan(), wholeTrailSection(trail), trail.track.totalDistance, null, true);
  };

  /** Everything a result depends on: when this changes the result is stale. */
  const searchKey = (): string => {
    const trail = host.trail();
    return JSON.stringify([
      prefs(),
      start().km,
      host.dailyHours(),
      host.baseKmh(),
      host.plan().direction,
      trail.track.totalDistance,
    ]);
  };

  const clearPreview = (): void => {
    if (previewIndex !== null) {
      previewIndex = null;
      host.preview(null);
    }
  };

  const setPrefs = (patch: Partial<SuggestPrefs>): void => {
    host.savePrefs({ ...prefs(), ...patch });
    render();
  };

  const currentResult = (): SuggestDaysResult<NextDaysCandidate> | null | undefined =>
    result && result.key === searchKey() ? result.value : undefined;

  function render(): void {
    const p = prefs();
    const s = start();
    const res = currentResult();
    if (res === undefined) clearPreview();
    const criteria = suggestionCriteria(p, host.dailyHours());
    const blocked =
      criteria === null
        ? 'Switch on at least one range to suggest plans.'
        : !isSearchable(criteria)
          ? 'Give at least one range a maximum.'
          : null;

    container.innerHTML = `
      <div class="next-days">
        ${fromHtml(s)}
        <div class="nd-row">
          <label class="nd-field">Days
            <input type="number" class="nd-input" data-nd="days" min="1" max="${MAX_SUGGEST_DAYS}" step="1" value="${p.days}" />
          </label>
          <label class="nd-field">Options
            <input type="number" class="nd-input" data-nd="alternatives" min="1" max="${MAX_ALTERNATIVES_SHOWN}" step="1" value="${p.alternatives}" />
          </label>
        </div>
        <div class="nd-modes" role="radiogroup" aria-label="How to suggest days">
          <label><input type="radio" name="nd-mode" data-nd="mode" value="hours"${p.mode === 'hours' ? ' checked' : ''} /> Hours &amp; pace</label>
          <label><input type="radio" name="nd-mode" data-nd="mode" value="ranges"${p.mode === 'ranges' ? ' checked' : ''} /> Distance &amp; climb</label>
        </div>
        ${
          p.mode === 'hours'
            ? `<p class="nd-hint">Days of about ${host.dailyHours()} h at your pace (set in the header), ending at a camp, hut or town.</p>`
            : `<div class="nd-ranges">
                ${rangeHtml('distance', 'Distance', 'km', p.distance, 1)}
                ${rangeHtml('ascent', 'Ascent', 'm', p.ascent, 50)}
                ${rangeHtml('hours', 'Hours', 'h', p.hours, 0.5)}
              </div>`
        }
        <button type="button" class="nd-suggest plan-header-btn is-primary" data-nd-action="suggest"${blocked ? ' disabled' : ''}>Suggest plans</button>
        ${blocked ? `<p class="nd-hint">${escapeHtml(blocked)}</p>` : ''}
        ${res === undefined ? '' : resultsHtml(res, previewIndex)}
      </div>`;
  }

  function fromHtml(s: SuggestStart): string {
    const here = located();
    const label = s.kind === 'here' ? 'Your location' : s.name;
    const off =
      s.kind === 'here' && here && here.offTrailMeters >= 1000
        ? `<p class="nd-hint">${(here.offTrailMeters / 1000).toFixed(1)} km from the trail — planning from its nearest point.</p>`
        : '';
    // Last stop vs location is only a choice when there is a stop to start from.
    const hasLastStop = lastStopStart().kind === 'stop';
    const toggle = here && hasLastStop
      ? `<button type="button" class="nd-link" data-nd-action="toggle-from">${from === 'last-stop' ? 'From my location' : 'From last stop'}</button>`
      : '';
    const locateLabel = locating ? 'Locating…' : here ? 'Update location' : 'Use my location';
    const locateBtn = `<button type="button" class="nd-link" data-nd-action="locate"${locating ? ' disabled' : ''}>${locateLabel}</button>`;
    return `
      <div class="nd-from">
        <span class="nd-label">From</span>
        <span class="nd-from-name">${escapeHtml(label)} · ${s.km.toFixed(1)} km</span>
        ${toggle}
        ${locateBtn}
      </div>
      ${off}
      ${locateError ? `<p class="nd-hint nd-warn">${escapeHtml(locateError)}</p>` : ''}`;
  }

  function rangeHtml(key: 'distance' | 'ascent' | 'hours', label: string, unit: string, range: RangePref, step: number): string {
    return `
      <div class="nd-range" data-range="${key}">
        <label class="nd-range-on"><input type="checkbox" data-nd="range-on"${range.on ? ' checked' : ''} /> ${label}</label>
        <input type="number" class="nd-input" data-nd="range-min" min="0" step="${step}" value="${range.min}" aria-label="Minimum ${label.toLowerCase()} (${unit})"${range.on ? '' : ' disabled'} />
        <span class="nd-to">to</span>
        <input type="number" class="nd-input" data-nd="range-max" min="0" step="${step}" value="${range.max}" aria-label="Maximum ${label.toLowerCase()} (${unit})"${range.on ? '' : ' disabled'} />
        <span class="nd-unit">${unit}</span>
      </div>`;
  }

  function resultsHtml(res: SuggestDaysResult<NextDaysCandidate> | null, selected: number | null): string {
    if (!res || res.plans.length === 0) {
      return '<p class="nd-hint nd-warn">No camp, hut or town fits a first day on those settings. Widen a range and try again.</p>';
    }
    const short =
      res.shortOf !== undefined
        ? `<p class="nd-hint nd-warn">Only ${res.shortOf} day${res.shortOf === 1 ? '' : 's'} fit these settings from this start. Nothing is in range after that.</p>`
        : '';
    return (
      short +
      res.plans
        .map(
          (plan, i) => `
        <div class="nd-option${selected === i ? ' is-previewed' : ''}" data-nd-option="${i}">
          <div class="nd-option-head">Option ${i + 1}${i === 0 ? ' · closest to your targets' : ''}</div>
          ${plan.days
            .map(
              (day, d) => `
            <div class="nd-day">
              <span class="nd-day-name">Day ${d + 1} → ${escapeHtml(day.end ? (day.end.waypoint.name ?? 'Stop') : 'Trail end')}</span>
              <span class="nd-day-stats">${day.distanceKm.toFixed(1)} km · +${day.ascentM} m · ${(Math.round(day.hours * 10) / 10).toFixed(1)} h</span>
            </div>`,
            )
            .join('')}
          <div class="nd-option-actions">
            <button type="button" class="nd-link" data-nd-action="preview">${selected === i ? 'Shown on map' : 'Show on map'}</button>
            <button type="button" class="plan-header-btn is-primary" data-nd-action="apply">Use this plan</button>
          </div>
        </div>`,
        )
        .join('')
    );
  }

  function runSuggest(): void {
    const trail = host.trail();
    const value = suggestForTrail(trail, start(), prefs(), host.dailyHours(), host.baseKmh());
    result = { key: searchKey(), value };
    clearPreview();
    // Show the best one straight away: the map is the quickest way to judge it.
    if (value && value.plans.length > 0) {
      previewIndex = 0;
      host.preview(value.plans[0]);
    }
    render();
  }

  function locate(): void {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) {
      locateError = 'This browser cannot share its location.';
      render();
      return;
    }
    locating = true;
    locateError = null;
    render();
    geo.getCurrentPosition(
      position => {
        locating = false;
        fix = { lat: position.coords.latitude, lon: position.coords.longitude };
        snapped = null;
        from = 'auto';
        host.onHere(located()?.km ?? null);
        render();
      },
      () => {
        locating = false;
        locateError = 'Could not get your location.';
        render();
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  container.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-nd-action]')?.dataset.ndAction;
    if (!action) return;
    const optionEl = target?.closest<HTMLElement>('[data-nd-option]');
    const optionIndex = optionEl ? Number(optionEl.dataset.ndOption) : null;
    const res = currentResult();
    const chosen = optionIndex !== null && res ? res.plans[optionIndex] : undefined;
    switch (action) {
      case 'suggest':
        runSuggest();
        return;
      case 'locate':
        locate();
        return;
      case 'toggle-from':
        from = from === 'last-stop' ? 'auto' : 'last-stop';
        render();
        return;
      case 'preview':
        if (chosen && optionIndex !== null) {
          previewIndex = optionIndex;
          host.preview(chosen);
          render();
        }
        return;
      case 'apply':
        if (chosen) {
          const startKm = start().km;
          const total = host.trail().track.totalDistance;
          result = null;
          clearPreview();
          host.edit(() => applyNextDaysPlan(host.plan(), startKm, chosen, total));
          render();
        }
        return;
    }
  });

  // `change`, not `input`: a re-render under the cursor would take the focus.
  container.addEventListener('change', event => {
    const target = event.target as HTMLInputElement | null;
    const field = target?.dataset.nd;
    if (!target || !field) return;
    const p = prefs();
    const value = Number(target.value);
    if (field === 'days') return setPrefs({ days: clampInt(value, 1, MAX_SUGGEST_DAYS, p.days) });
    if (field === 'alternatives') {
      return setPrefs({ alternatives: clampInt(value, 1, MAX_ALTERNATIVES_SHOWN, p.alternatives) });
    }
    if (field === 'mode' && (target.value === 'hours' || target.value === 'ranges')) {
      return setPrefs({ mode: target.value });
    }
    const key = target.closest<HTMLElement>('[data-range]')?.dataset.range as 'distance' | 'ascent' | 'hours' | undefined;
    if (!key) return;
    const range = p[key];
    if (field === 'range-on') return setPrefs({ [key]: { ...range, on: target.checked } });
    if (!Number.isFinite(value) || value < 0) return render();
    // Keep min ≤ max by moving the other end, rather than refusing the edit.
    if (field === 'range-min') return setPrefs({ [key]: { ...range, min: value, max: Math.max(range.max, value) } });
    if (field === 'range-max') return setPrefs({ [key]: { ...range, max: value, min: Math.min(range.min, value) } });
  });

  render();
  return { render, hereKm: () => located()?.km ?? null };
}
