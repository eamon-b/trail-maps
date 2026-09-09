import AsyncStorage from '@react-native-async-storage/async-storage';
import { defaultPoiFilterState } from '@lib/poi-display';
import {
  useSettingsStore,
  selectDirection,
  selectPoiFilter,
  type SettingsState,
  type Units,
} from '../settings-store';

describe('settings-store', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      units: 'km',
      perTrailDirection: {},
      poiFilter: defaultPoiFilterState(),
    });
    jest.clearAllMocks();
  });

  it('defaults to km units', () => {
    expect(useSettingsStore.getState().units).toBe('km');
  });

  it('sets units', () => {
    useSettingsStore.getState().setUnits('mi');
    expect(useSettingsStore.getState().units).toBe('mi');
  });

  it('tracks direction independently per trail', () => {
    const { setDirection, getDirection } = useSettingsStore.getState();
    setDirection('aawt', 'reversed');
    expect(getDirection('aawt')).toBe('reversed');
    // Untouched trails default to 'default'.
    expect(getDirection('heysen')).toBe('default');
  });

  it('toggles direction between default and reversed', () => {
    const { toggleDirection } = useSettingsStore.getState();
    toggleDirection('larapinta');
    expect(useSettingsStore.getState().getDirection('larapinta')).toBe('reversed');
    toggleDirection('larapinta');
    expect(useSettingsStore.getState().getDirection('larapinta')).toBe('default');
  });

  it('exposes a reactive direction selector', () => {
    useSettingsStore.getState().setDirection('bibbulmun', 'reversed');
    const value = selectDirection('bibbulmun')(useSettingsStore.getState());
    expect(value).toBe('reversed');
  });

  it('persists via AsyncStorage', async () => {
    useSettingsStore.getState().setUnits('mi' as Units);
    // persist middleware writes asynchronously.
    await new Promise((r) => setTimeout(r, 0));
    expect(AsyncStorage.setItem).toHaveBeenCalled();
    const [key, payload] = (AsyncStorage.setItem as jest.Mock).mock.calls.at(-1)!;
    expect(key).toBe('tracknotes:settings');
    expect(payload).toContain('"units":"mi"');
  });

  it('shows every POI category by default', () => {
    const filter = useSettingsStore.getState().poiFilter;
    expect(filter.enabled).toBe(true);
    expect(Object.values(filter.categories).every(Boolean)).toBe(true);
  });

  it('toggles the POI master switch and single categories independently', () => {
    const { setPoiEnabled, setPoiCategory } = useSettingsStore.getState();

    setPoiCategory('transport', false);
    expect(useSettingsStore.getState().poiFilter.categories.transport).toBe(false);
    expect(useSettingsStore.getState().poiFilter.categories.water).toBe(true);
    expect(useSettingsStore.getState().poiFilter.enabled).toBe(true);

    setPoiEnabled(false);
    const filter = selectPoiFilter(useSettingsStore.getState());
    expect(filter.enabled).toBe(false);
    // The master switch hides everything without forgetting the categories.
    expect(filter.categories.transport).toBe(false);
    expect(filter.categories.water).toBe(true);
  });

  it('persists the POI filter', async () => {
    useSettingsStore.getState().setPoiCategory('emergency', false);
    await new Promise((r) => setTimeout(r, 0));
    const [, payload] = (AsyncStorage.setItem as jest.Mock).mock.calls.at(-1)!;
    expect(JSON.parse(payload).state.poiFilter.categories.emergency).toBe(false);
  });

  it('normalises a persisted blob written by a different build', () => {
    // An old or hand-edited blob can name a category we no longer have and miss
    // ones we do; rehydrating must not leave the store without a usable filter.
    const merge = useSettingsStore.persist.getOptions().merge!;
    const merged = merge(
      { units: 'mi', poiFilter: { enabled: false, categories: { water: false, ferry: true } } },
      useSettingsStore.getState(),
    ) as SettingsState;

    expect(merged.units).toBe('mi');
    expect(merged.poiFilter.enabled).toBe(false);
    expect(merged.poiFilter.categories.water).toBe(false);
    expect(merged.poiFilter.categories.camping).toBe(true);
    expect('ferry' in merged.poiFilter.categories).toBe(false);
    // The actions survive the merge — a rehydrate must not blank the store.
    expect(typeof merged.setPoiCategory).toBe('function');
  });

  it('falls back to the default filter when nothing was persisted', () => {
    const merge = useSettingsStore.persist.getOptions().merge!;
    const merged = merge(undefined, useSettingsStore.getState()) as SettingsState;
    expect(merged.poiFilter).toEqual(defaultPoiFilterState());
  });
});
