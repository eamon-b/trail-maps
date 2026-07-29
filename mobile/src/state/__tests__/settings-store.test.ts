import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSettingsStore,
  selectDirection,
  type Units,
} from '../settings-store';

describe('settings-store', () => {
  beforeEach(() => {
    useSettingsStore.setState({ units: 'km', perTrailDirection: {} });
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
});
