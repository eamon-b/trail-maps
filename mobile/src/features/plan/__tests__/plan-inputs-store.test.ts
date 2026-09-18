import {
  usePlanInputsStore,
  selectPrefs,
  selectPaceBaseKmh,
  selectResupplyStopIds,
  clampHours,
  migratePlanInputs,
  DEFAULT_PREFS,
  MIN_DAILY_HOURS,
  MAX_DAILY_HOURS,
} from '../plan-inputs-store';

describe('plan-inputs-store', () => {
  beforeEach(() => {
    usePlanInputsStore.setState({ byTrail: {} });
  });

  it('falls back to defaults for an untouched trail', () => {
    expect(selectPrefs('aawt')(usePlanInputsStore.getState())).toEqual(DEFAULT_PREFS);
  });

  it('remembers pace and daily hours per trail independently', () => {
    const { setPace, setDailyHours } = usePlanInputsStore.getState();
    setPace('aawt', 'fast');
    setDailyHours('aawt', 10);
    setPace('heysen', 'slow');

    const aawt = selectPrefs('aawt')(usePlanInputsStore.getState());
    const heysen = selectPrefs('heysen')(usePlanInputsStore.getState());
    expect(aawt).toEqual({ pace: 'fast', dailyHours: 10 });
    expect(heysen.pace).toBe('slow');
    // heysen keeps default hours (independent).
    expect(heysen.dailyHours).toBe(DEFAULT_PREFS.dailyHours);
  });

  it('clamps daily hours to the allowed range', () => {
    expect(clampHours(1)).toBe(MIN_DAILY_HOURS);
    expect(clampHours(99)).toBe(MAX_DAILY_HOURS);
    expect(clampHours(8.4)).toBe(8);

    usePlanInputsStore.getState().setDailyHours('aawt', 100);
    expect(selectPrefs('aawt')(usePlanInputsStore.getState()).dailyHours).toBe(MAX_DAILY_HOURS);
  });

  it('clamps daily hours to the minimum through the store', () => {
    usePlanInputsStore.getState().setDailyHours('aawt', 1);
    expect(selectPrefs('aawt')(usePlanInputsStore.getState()).dailyHours).toBe(MIN_DAILY_HOURS);
  });

  describe('selectPrefs robustness', () => {
    it('returns a stable reference for the same stored entry', () => {
      usePlanInputsStore.getState().setPace('aawt', 'fast');
      const state = usePlanInputsStore.getState();
      const a = selectPrefs('aawt')(state);
      const b = selectPrefs('aawt')(state);
      // Same reference — required so useStore does not loop on a fresh object.
      expect(a).toBe(b);
    });

    it('back-fills a missing field from DEFAULT_PREFS', () => {
      // Simulate an entry persisted before `pace` existed (missing field).
      usePlanInputsStore.setState({
        byTrail: { aawt: { dailyHours: 10 } as never },
      });
      const prefs = selectPrefs('aawt')(usePlanInputsStore.getState());
      expect(prefs.dailyHours).toBe(10);
      expect(prefs.pace).toBe(DEFAULT_PREFS.pace);
    });

    it('returns DEFAULT_PREFS reference for an untouched trail', () => {
      expect(selectPrefs('unknown')(usePlanInputsStore.getState())).toBe(DEFAULT_PREFS);
    });
  });

  describe('selectPaceBaseKmh', () => {
    it('defaults to 4 km/h (Average) for an untouched trail', () => {
      expect(selectPaceBaseKmh('aawt')(usePlanInputsStore.getState())).toBe(4);
    });

    it('resolves the pace preset to its walking speed', () => {
      usePlanInputsStore.getState().setPace('aawt', 'slow');
      expect(selectPaceBaseKmh('aawt')(usePlanInputsStore.getState())).toBe(3);
      usePlanInputsStore.getState().setPace('aawt', 'fast');
      expect(selectPaceBaseKmh('aawt')(usePlanInputsStore.getState())).toBe(5);
    });

    it('is isolated per trail', () => {
      usePlanInputsStore.getState().setPace('aawt', 'slow');
      const state = usePlanInputsStore.getState();
      expect(selectPaceBaseKmh('aawt')(state)).toBe(3);
      // An untouched trail is unaffected — still the Average default.
      expect(selectPaceBaseKmh('heysen')(state)).toBe(4);
    });
  });

  describe('resupplyStops', () => {
    it('round-trips an explicit selection', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_a', 'w_b']);
      expect(selectPrefs('cdt')(usePlanInputsStore.getState()).resupplyStops).toEqual([
        'w_a',
        'w_b',
      ]);
    });

    it('is undefined for an entry saved before the field existed', () => {
      usePlanInputsStore.getState().setPace('cdt', 'fast');
      expect(selectPrefs('cdt')(usePlanInputsStore.getState()).resupplyStops).toBeUndefined();
    });

    it('keeps selectPrefs stable after setResupplyStops', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_a']);
      const state = usePlanInputsStore.getState();
      expect(selectPrefs('cdt')(state)).toBe(selectPrefs('cdt')(state));
    });

    it('collapses a non-string-array value to undefined', () => {
      usePlanInputsStore.setState({
        byTrail: { cdt: { dailyHours: 8, pace: 'average', resupplyStops: 'w_a' } as never },
      });
      expect(selectPrefs('cdt')(usePlanInputsStore.getState()).resupplyStops).toBeUndefined();

      usePlanInputsStore.setState({
        byTrail: { cdt: { dailyHours: 8, pace: 'average', resupplyStops: [1, 2] } as never },
      });
      expect(selectPrefs('cdt')(usePlanInputsStore.getState()).resupplyStops).toBeUndefined();
    });

    it('keeps pace and hours when the selection is cleared', () => {
      const { setPace, setDailyHours, setResupplyStops, clearResupplyStops } =
        usePlanInputsStore.getState();
      setPace('cdt', 'slow');
      setDailyHours('cdt', 10);
      setResupplyStops('cdt', ['w_a']);
      clearResupplyStops('cdt');

      const prefs = selectPrefs('cdt')(usePlanInputsStore.getState());
      expect(prefs).toEqual({ pace: 'slow', dailyHours: 10 });
      expect(prefs.resupplyStops).toBeUndefined();
    });

    it('is dropped with the whole entry by clearTrail', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_a']);
      usePlanInputsStore.getState().clearTrail('cdt');
      expect(usePlanInputsStore.getState().byTrail.cdt).toBeUndefined();
      expect(selectResupplyStopIds('cdt')(usePlanInputsStore.getState())).toBeNull();
    });

    it('is independent between two trails', () => {
      const { setResupplyStops } = usePlanInputsStore.getState();
      setResupplyStops('cdt', ['w_a']);
      setResupplyStops('te_araroa', ['w_z']);
      const state = usePlanInputsStore.getState();
      expect([...selectResupplyStopIds('cdt')(state)!]).toEqual(['w_a']);
      expect([...selectResupplyStopIds('te_araroa')(state)!]).toEqual(['w_z']);
    });
  });

  describe('selectResupplyStopIds', () => {
    it('is null until the first setResupplyStops', () => {
      expect(selectResupplyStopIds('cdt')(usePlanInputsStore.getState())).toBeNull();
      usePlanInputsStore.getState().setPace('cdt', 'fast');
      expect(selectResupplyStopIds('cdt')(usePlanInputsStore.getState())).toBeNull();
    });

    it('returns a stable Set for the same stored selection', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_a', 'w_b']);
      const state = usePlanInputsStore.getState();
      const a = selectResupplyStopIds('cdt')(state);
      const b = selectResupplyStopIds('cdt')(state);
      // Same reference — zustand compares selector output with Object.is.
      expect(a).toBe(b);
      expect(a!.has('w_b')).toBe(true);
    });

    it('is null again after clearResupplyStops', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', ['w_a']);
      usePlanInputsStore.getState().clearResupplyStops('cdt');
      expect(selectResupplyStopIds('cdt')(usePlanInputsStore.getState())).toBeNull();
    });

    it('gives an empty Set for an explicit empty selection, not null', () => {
      usePlanInputsStore.getState().setResupplyStops('cdt', []);
      const set = selectResupplyStopIds('cdt')(usePlanInputsStore.getState());
      expect(set).not.toBeNull();
      expect(set!.size).toBe(0);
    });
  });

  describe('migratePlanInputs', () => {
    it('collapses absent state to an empty map', () => {
      expect(migratePlanInputs(undefined, 0)).toEqual({ byTrail: {} });
      expect(migratePlanInputs(null, 0)).toEqual({ byTrail: {} });
    });

    it('collapses non-object / malformed state to an empty map', () => {
      expect(migratePlanInputs('nope', 0)).toEqual({ byTrail: {} });
      expect(migratePlanInputs({ nonsense: 1 }, 0)).toEqual({ byTrail: {} });
      expect(migratePlanInputs({ byTrail: 5 }, 0)).toEqual({ byTrail: {} });
    });

    it('preserves a well-formed byTrail map', () => {
      const byTrail = { aawt: { dailyHours: 10, pace: 'fast' as const } };
      expect(migratePlanInputs({ byTrail }, 0)).toEqual({ byTrail });
    });
  });
});
