import { renderHook, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOffTrailAlert } from '../useOffTrailAlert';

const SNOOZE_STORAGE_KEY = 'trail-companion:snoozeUntil';

describe('useOffTrailAlert snooze expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockClear();
    (AsyncStorage.removeItem as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks the alert as snoozed when snooze() is called', () => {
    const { result } = renderHook(() => useOffTrailAlert(null, null, []));

    act(() => {
      result.current.snooze('15min');
    });

    expect(result.current.isSnoozed).toBe(true);
    expect(result.current.snoozeUntil).not.toBeNull();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      SNOOZE_STORAGE_KEY,
      expect.any(String),
    );
  });

  it('clears the snooze the moment it expires, without waiting for a GPS tick', () => {
    const { result } = renderHook(() => useOffTrailAlert(null, null, []));

    act(() => {
      result.current.snooze('15min');
    });
    expect(result.current.isSnoozed).toBe(true);

    // Advance past the snooze window: the scheduled timeout should fire and
    // drop the snooze state + its persisted value, with no further GPS input.
    act(() => {
      jest.advanceTimersByTime(15 * 60 * 1000 + 1_000);
    });

    expect(result.current.isSnoozed).toBe(false);
    expect(result.current.snoozeUntil).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SNOOZE_STORAGE_KEY);
  });

  it('does not clear the snooze before it expires', () => {
    const { result } = renderHook(() => useOffTrailAlert(null, null, []));

    act(() => {
      result.current.snooze('30min');
    });

    act(() => {
      jest.advanceTimersByTime(10 * 60 * 1000);
    });

    expect(result.current.isSnoozed).toBe(true);
  });

  it('cancels the pending expiry timer on unmount', () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const { result, unmount } = renderHook(() => useOffTrailAlert(null, null, []));

    act(() => {
      result.current.snooze('60min');
    });

    unmount();

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
