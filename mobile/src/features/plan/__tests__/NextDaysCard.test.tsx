/**
 * The "Plan the next few days" card: its steppers and mode switch patch the
 * prefs, the ranges are switchable, a search that cannot run says why, and
 * each suggested option can be applied. Presentational — the screen runs the
 * search — so every test drives props and reads callbacks.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import type { SuggestDaysResult, SuggestedPlan } from '@lib/day-suggest';
import { NextDaysCard } from '../NextDaysCard';
import {
  MAX_ALTERNATIVES_SHOWN,
  MAX_SUGGEST_DAYS,
  type SearchCandidate,
  type SuggestPrefs,
} from '../plan-suggest';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('');
}

/**
 * A Pressable surfaces the same props on its element, its component and the
 * host node it renders, so lookups are narrowed to host nodes. The local
 * `react-test-renderer` shim does not declare `type`, hence the cast.
 */
function isHost(node: TestInstance): boolean {
  return typeof (node as unknown as { type?: unknown }).type === 'string';
}

function hostByLabel(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll((n) => isHost(n) && n.props.accessibilityLabel === label);
}

function one(tree: ReactTestRenderer, label: string): TestInstance {
  const found = hostByLabel(tree, label);
  expect(found).toHaveLength(1);
  return found[0];
}

/**
 * The element that owns the handlers. Host nodes do not keep `onPress` or
 * `onValueChange` (the Pressable and Switch turn them into responder props),
 * so this takes the first, outermost, match that still carries the handler.
 */
function handler(tree: ReactTestRenderer, label: string, prop = 'onPress'): TestInstance {
  one(tree, label);
  return tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props[prop] === 'function',
  )[0];
}

function press(tree: ReactTestRenderer, label: string): void {
  act(() => (handler(tree, label).props.onPress as () => void)());
}

function disabled(node: TestInstance): boolean {
  return (node.props.accessibilityState as { disabled: boolean }).disabled;
}

function prefs(overrides: Partial<SuggestPrefs> = {}): SuggestPrefs {
  return {
    mode: 'hours',
    days: 3,
    alternatives: 3,
    distance: { on: true, min: 20, max: 30 },
    ascent: { on: false, min: 0, max: 1000 },
    hours: { on: false, min: 7, max: 9 },
    ...overrides,
  };
}

function candidate(name: string, km: number): SearchCandidate {
  return {
    km,
    candidate: { key: `w_${name}`, waypointId: `w_${name}`, name, type: 'campsite', activeKm: km, noboKm: km },
  };
}

function plan(stops: SearchCandidate[], reachesEnd = false): SuggestedPlan<SearchCandidate> {
  let startKm = 0;
  const days = stops.map((end) => {
    const day = {
      startKm,
      endKm: end.km,
      end,
      distanceKm: end.km - startKm,
      ascentM: 400,
      descentM: 300,
      hours: 7.46,
      cost: 0,
    };
    startKm = end.km;
    return day;
  });
  return { days, stops, score: 0, reachesEnd };
}

const noop = () => {};

function render(overrides: Partial<React.ComponentProps<typeof NextDaysCard>> = {}) {
  const props: React.ComponentProps<typeof NextDaysCard> = {
    prefs: prefs(),
    onPrefs: noop,
    start: { kind: 'stop', km: 42, name: 'Ellery Creek' },
    hasFix: false,
    preferLastStop: false,
    onPreferLastStop: noop,
    dailyHours: 8,
    units: 'km',
    result: undefined,
    blocked: null,
    onSuggest: noop,
    onApply: noop,
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<NextDaysCard {...props} />);
  });
  return tree;
}

describe('NextDaysCard', () => {
  it('shows where the plan starts from', () => {
    const text = allText(render());
    expect(text).toContain('Plan the next few days');
    expect(text).toContain('Ellery Creek · 42.0 km');
    expect(allText(render({ start: { kind: 'here', km: 12, name: 'ignored' } }))).toContain(
      'Here · 12.0 km',
    );
  });

  describe('steppers', () => {
    it('patches days and options, keeping the rest of the prefs', () => {
      const onPrefs = jest.fn();
      const tree = render({ onPrefs });

      press(tree, 'More days');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...prefs(), days: 4 });
      press(tree, 'Less days');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...prefs(), days: 2 });
      press(tree, 'More options');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...prefs(), alternatives: 4 });
      press(tree, 'Less options');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...prefs(), alternatives: 2 });
    });

    it('disables the buttons at their bounds', () => {
      const low = render({ prefs: prefs({ days: 1, alternatives: 1 }) });
      expect(disabled(one(low, 'Less days'))).toBe(true);
      expect(disabled(one(low, 'More days'))).toBe(false);
      expect(disabled(one(low, 'Less options'))).toBe(true);
      expect(disabled(one(low, 'More options'))).toBe(false);

      const high = render({
        prefs: prefs({ days: MAX_SUGGEST_DAYS, alternatives: MAX_ALTERNATIVES_SHOWN }),
      });
      expect(disabled(one(high, 'More days'))).toBe(true);
      expect(disabled(one(high, 'Less days'))).toBe(false);
      expect(disabled(one(high, 'More options'))).toBe(true);
      expect(disabled(one(high, 'Less options'))).toBe(false);
    });
  });

  describe('mode', () => {
    function tabs(tree: ReactTestRenderer) {
      return tree.root.findAll((n) => isHost(n) && n.props.accessibilityRole === 'tab');
    }

    it('switches to Distance & climb', () => {
      const onPrefs = jest.fn();
      const tree = render({ onPrefs });
      const [hours, ranges] = tabs(tree);
      expect((hours.props.accessibilityState as { selected: boolean }).selected).toBe(true);
      expect((ranges.props.accessibilityState as { selected: boolean }).selected).toBe(false);

      const tab = tree.root.findAll(
        (n) =>
          n.props.accessibilityRole === 'tab' &&
          typeof n.props.onPress === 'function' &&
          (n.props.accessibilityState as { selected: boolean }).selected === false,
      )[0];
      act(() => (tab.props.onPress as () => void)());
      expect(onPrefs).toHaveBeenCalledWith({ ...prefs(), mode: 'ranges' });
    });

    it('describes the hours mode from the daily hours, with no range rows', () => {
      const tree = render({ dailyHours: 8 });
      expect(allText(tree)).toContain('Days of about 8.0 h at your pace');
      expect(hostByLabel(tree, 'Use distance range')).toHaveLength(0);
    });
  });

  describe('range rows', () => {
    it('shows min/max steppers only for the ranges switched on', () => {
      const tree = render({ prefs: prefs({ mode: 'ranges' }) });
      expect(one(tree, 'Use distance range').props.value).toBe(true);
      expect(one(tree, 'Use ascent range').props.value).toBe(false);
      expect(one(tree, 'Use hours range').props.value).toBe(false);

      expect(hostByLabel(tree, 'More minimum distance')).toHaveLength(1);
      expect(hostByLabel(tree, 'Less maximum distance')).toHaveLength(1);
      expect(hostByLabel(tree, 'More minimum ascent')).toHaveLength(0);
      expect(hostByLabel(tree, 'More minimum hours')).toHaveLength(0);
      expect(allText(tree)).toContain('20 km');
      expect(allText(tree)).toContain('30 km');
    });

    it('switches a range on through its switch', () => {
      const onPrefs = jest.fn();
      const tree = render({ prefs: prefs({ mode: 'ranges' }), onPrefs });
      act(() =>
        (handler(tree, 'Use ascent range', 'onValueChange').props.onValueChange as (
          v: boolean,
        ) => void)(true),
      );
      expect(onPrefs).toHaveBeenCalledWith({
        ...prefs({ mode: 'ranges' }),
        ascent: { on: true, min: 0, max: 1000 },
      });
    });

    it('steps a range by its unit and keeps min at or below max', () => {
      const onPrefs = jest.fn();
      const base = prefs({ mode: 'ranges' });
      const tree = render({ prefs: base, onPrefs });

      press(tree, 'More minimum distance');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...base, distance: { on: true, min: 21, max: 30 } });
      press(tree, 'More maximum distance');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...base, distance: { on: true, min: 20, max: 31 } });

      const tight = render({
        prefs: prefs({ mode: 'ranges', distance: { on: true, min: 25, max: 25 } }),
      });
      expect(disabled(one(tight, 'More minimum distance'))).toBe(true);
      expect(disabled(one(tight, 'Less maximum distance'))).toBe(true);

      const floor = render({
        prefs: prefs({ mode: 'ranges', distance: { on: true, min: 0, max: 10 } }),
      });
      expect(disabled(one(floor, 'Less minimum distance'))).toBe(true);
    });

    it('steps ascent by 100 m', () => {
      const onPrefs = jest.fn();
      const base = prefs({ mode: 'ranges', ascent: { on: true, min: 200, max: 800 } });
      const tree = render({ prefs: base, onPrefs });
      press(tree, 'Less maximum ascent');
      expect(onPrefs).toHaveBeenLastCalledWith({ ...base, ascent: { on: true, min: 200, max: 700 } });
    });
  });

  describe('Suggest plans', () => {
    it('calls onSuggest when nothing blocks it', () => {
      const onSuggest = jest.fn();
      const tree = render({ onSuggest });
      const button = one(tree, 'Suggest plans');
      expect(disabled(button)).toBe(false);
      press(tree, 'Suggest plans');
      expect(onSuggest).toHaveBeenCalledTimes(1);
    });

    it('is disabled and says why when blocked', () => {
      const tree = render({ blocked: 'Switch on at least one range with a maximum' });
      expect(disabled(one(tree, 'Suggest plans'))).toBe(true);
      expect(handler(tree, 'Suggest plans').props.disabled).toBe(true);
      expect(allText(tree)).toContain('Switch on at least one range with a maximum');
    });
  });

  describe('results', () => {
    const a = plan([candidate('Alpha', 20), candidate('Bravo', 45)]);
    const b = plan([candidate('Charlie', 22), candidate('Delta', 48)]);

    it('renders nothing before a search', () => {
      const tree = render();
      expect(hostByLabel(tree, 'Option 1')).toHaveLength(0);
      expect(allText(tree)).not.toContain('Use this plan');
    });

    it('renders one block per option, the first marked as closest', () => {
      const result: SuggestDaysResult<SearchCandidate> = { plans: [a, b] };
      const tree = render({ result });
      expect(hostByLabel(tree, 'Option 1')).toHaveLength(1);
      expect(hostByLabel(tree, 'Option 2')).toHaveLength(1);
      const text = allText(tree);
      expect(text).toContain('Option 1 · closest to your targets');
      expect(text).toContain('Option 2');
      expect(text).not.toContain('Option 2 · closest');
      expect(text).toContain('Day 1 → Alpha');
      expect(text).toContain('Day 2 → Delta');
      expect(text).toContain('25.0 km');
      expect(text).toContain('7.5 h');
    });

    it('names a day that walks out to the end of the section', () => {
      const out: SuggestedPlan<SearchCandidate> = {
        ...a,
        days: [a.days[0], { ...a.days[1], end: null }],
        reachesEnd: true,
      };
      expect(allText(render({ result: { plans: [out] } }))).toContain('Day 2 → End of section');
    });

    it('applies the plan whose button was tapped', () => {
      const onApply = jest.fn();
      const tree = render({ result: { plans: [a, b] }, onApply });
      press(tree, 'Use option 1');
      expect(onApply).toHaveBeenLastCalledWith(a);
      press(tree, 'Use option 2');
      expect(onApply).toHaveBeenLastCalledWith(b);
    });

    it('warns when the settings run out before the days asked for', () => {
      expect(allText(render({ result: { plans: [a], shortOf: 2 } }))).toContain(
        'Only 2 days fit these settings from this start.',
      );
      expect(allText(render({ result: { plans: [a], shortOf: 1 } }))).toContain(
        'Only 1 day fit these settings from this start.',
      );
      expect(allText(render({ result: { plans: [a] } }))).not.toContain('Only ');
    });

    it('says nothing fits when the search came back empty', () => {
      const tree = render({ result: { plans: [] } });
      expect(allText(tree)).toContain('No camp, hut or town fits a first day on those settings.');
      expect(allText(tree)).not.toContain('Use this plan');
    });
  });

  describe('start switch', () => {
    it('offers "Use my location" without a fix when the screen can start GPS', () => {
      const onUseLocation = jest.fn();
      const tree = render({ hasFix: false, onUseLocation });
      press(tree, 'Use my location');
      expect(onUseLocation).toHaveBeenCalledTimes(1);
      expect(hostByLabel(tree, 'Start from my last stop')).toHaveLength(0);
    });

    it('offers nothing without a fix or a way to get one', () => {
      const tree = render({ hasFix: false });
      expect(hostByLabel(tree, 'Use my location')).toHaveLength(0);
      expect(allText(tree)).not.toContain('From last stop');
      expect(allText(tree)).not.toContain('From here');
    });

    it('toggles between here and the last stop with a fix', () => {
      const onPreferLastStop = jest.fn();
      const here = render({ hasFix: true, preferLastStop: false, onPreferLastStop, onUseLocation: noop });
      expect(hostByLabel(here, 'Use my location')).toHaveLength(0);
      expect(allText(here)).toContain('From last stop');
      press(here, 'Start from my last stop');
      expect(onPreferLastStop).toHaveBeenLastCalledWith(true);

      const last = render({ hasFix: true, preferLastStop: true, onPreferLastStop });
      expect(allText(last)).toContain('From here');
      press(last, 'Start from my location');
      expect(onPreferLastStop).toHaveBeenLastCalledWith(false);
    });
  });
});
