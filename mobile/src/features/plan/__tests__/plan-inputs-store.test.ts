import {
  usePlanInputsStore,
  selectPrefs,
  clampHours,
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
});
