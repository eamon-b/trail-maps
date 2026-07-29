/**
 * Verifies the share hook wires the composed payload into `Share.share` and
 * swallows cancels/failures without surfacing errors.
 */

import React from 'react';
import { Share } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { useCheckInShare, type ShareCheckIn } from '../use-check-in-share';

function grabHook(): ShareCheckIn {
  let captured: ShareCheckIn | null = null;
  function Harness() {
    captured = useCheckInShare();
    return null;
  }
  act(() => {
    TestRenderer.create(<Harness />);
  });
  if (!captured) throw new Error('hook did not initialise');
  return captured;
}

const INPUT = {
  trailName: 'Australian Alps Walking Track',
  totalKm: 688.3,
  units: 'km' as const,
  gps: { lat: -37.04449, lon: 146.96018, currentKm: 219.2 },
};

describe('useCheckInShare', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes the composed message and title to Share.share', async () => {
    const spy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: null });

    const share = grabHook();
    await act(async () => {
      await share(INPUT);
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [content, options] = spy.mock.calls[0];
    expect(content).toEqual({
      title: 'Check-in on Australian Alps Walking Track',
      message:
        'Checking in from Australian Alps Walking Track — 219.2 km of 688.3 km. Position: 37.04449°S, 146.96018°E.\n' +
        'https://maps.google.com/?q=-37.04449,146.96018\n' +
        '(via Tracknotes)',
    });
    expect(options).toEqual({
      subject: 'Check-in on Australian Alps Walking Track',
      dialogTitle: 'Check-in on Australian Alps Walking Track',
    });
  });

  it('resolves quietly when the user dismisses the sheet', async () => {
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'dismissedAction' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const share = grabHook();
    await act(async () => {
      await expect(share(INPUT)).resolves.toBeUndefined();
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('logs (but does not throw) on a genuine failure', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const share = grabHook();
    await act(async () => {
      await expect(share(INPUT)).resolves.toBeUndefined();
    });

    expect(warn).toHaveBeenCalledWith('[share] check-in share failed', expect.any(Error));
  });
});
