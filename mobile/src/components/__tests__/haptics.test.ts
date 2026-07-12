import * as Haptics from 'expo-haptics';
import {
  triggerHaptic,
  triggerLocationHaptic,
  setHapticsEnabled,
  getHapticsEnabled,
} from '../haptics';

describe('haptics preference gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to the module default (on) between tests.
    setHapticsEnabled(true);
  });

  it('defaults to enabled', () => {
    expect(getHapticsEnabled()).toBe(true);
  });

  it('fires the vocabulary haptic when enabled', async () => {
    await triggerHaptic('selection');
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('suppresses the vocabulary haptic when disabled', async () => {
    setHapticsEnabled(false);
    expect(getHapticsEnabled()).toBe(false);

    await triggerHaptic('selection');
    await triggerHaptic('warning');

    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('suppresses location haptics when disabled', async () => {
    setHapticsEnabled(false);
    await triggerLocationHaptic('offTrail');
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it('resumes firing after being re-enabled', async () => {
    setHapticsEnabled(false);
    await triggerHaptic('success');
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    await triggerHaptic('success');
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
  });
});
