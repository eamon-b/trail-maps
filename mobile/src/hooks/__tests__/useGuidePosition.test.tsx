/**
 * State-machine test for useGuidePosition. The location service is mocked so we
 * can drive raw fixes by hand; the real position-on-trail snap runs against a
 * small equatorial track so on-trail vs off-trail is exercised end to end.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useGuidePosition, type GuidePosition } from '../useGuidePosition';
import * as locationService from '../../services/location-service';

// A straight equatorial track (0.001° lon ≈ 111 m apart), shared by ref so the
// hint-reset effect does not thrash.
jest.mock('../../features/guide/GuideContext', () => {
  const points = [
    { lat: 0, lon: 0.0, ele: 0, dist: 0.0 },
    { lat: 0, lon: 0.001, ele: 0, dist: 0.111 },
    { lat: 0, lon: 0.002, ele: 0, dist: 0.223 },
    { lat: 0, lon: 0.003, ele: 0, dist: 0.334 },
    { lat: 0, lon: 0.004, ele: 0, dist: 0.446 },
  ];
  return {
    useGuide: () => ({ trailId: 't', direction: 'default', trail: { track: { points } } }),
  };
});

// The opt-in lives in the settings store; a plain object stands in for it.
const mockSettings = {
  gpsOnGuideOpen: false,
  setGpsOnGuideOpen: jest.fn((on: boolean) => {
    mockSettings.gpsOnGuideOpen = on;
  }),
};
jest.mock('../../state/settings-store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector(mockSettings),
}));

jest.mock('../../services/location-service', () => ({
  requestLocationPermission: jest.fn(() => Promise.resolve('granted')),
  getLocationPermissionStatus: jest.fn(() => Promise.resolve('undetermined')),
  startLocationTracking: jest.fn(() => Promise.resolve()),
  stopLocationTracking: jest.fn(),
}));

type Update = Parameters<typeof locationService.startLocationTracking>[0] extends (u: infer U) => void
  ? U
  : never;

function makeUpdate(lat: number, lon: number, accuracy = 5): Update {
  return {
    latitude: lat,
    longitude: lon,
    altitude: 0,
    accuracy,
    heading: null,
    speed: null,
    timestamp: Date.now(),
  } as Update;
}

describe('useGuidePosition state machine', () => {
  let latest: GuidePosition;
  let captured: ((u: Update) => void) | null;

  function Harness() {
    latest = useGuidePosition();
    return null;
  }

  beforeEach(() => {
    captured = null;
    mockSettings.gpsOnGuideOpen = false;
    mockSettings.setGpsOnGuideOpen.mockClear();
    (locationService.requestLocationPermission as jest.Mock).mockResolvedValue('granted');
    (locationService.getLocationPermissionStatus as jest.Mock).mockResolvedValue('undetermined');
    (locationService.startLocationTracking as jest.Mock).mockImplementation((cb: (u: Update) => void) => {
      captured = cb;
      return Promise.resolve();
    });
  });

  it('does not start on its own when the hiker never turned location on', async () => {
    (locationService.getLocationPermissionStatus as jest.Mock).mockResolvedValue('granted');
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    expect(latest.status).toBe('no-permission');
    expect(captured).toBeNull();
  });

  it('starts on its own when the hiker turned it on before and permission holds', async () => {
    mockSettings.gpsOnGuideOpen = true;
    (locationService.getLocationPermissionStatus as jest.Mock).mockResolvedValue('granted');
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    expect(latest.status).toBe('acquiring');
    expect(captured).not.toBeNull();

    await act(async () => {
      captured!(makeUpdate(0, 0.002));
    });
    expect(latest.status).toBe('fix');
    expect(latest.currentKm).not.toBeNull();
  });

  it('starts in no-permission, then acquiring after start()', async () => {
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    expect(latest.status).toBe('no-permission');
    expect(latest.position).toBeNull();

    await act(async () => {
      await latest.start();
    });
    expect(latest.status).toBe('acquiring');
    expect(captured).not.toBeNull();
  });

  it('reaches fix on an on-trail update, then off-trail when drifting away', async () => {
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    await act(async () => {
      await latest.start();
    });

    // On the trail: snaps to the km=0.223 point with ~0 m off-trail.
    await act(async () => {
      captured!(makeUpdate(0, 0.002));
    });
    expect(latest.status).toBe('fix');
    expect(latest.currentKm).toBeCloseTo(0.223, 3);
    expect(latest.position).toEqual({ lat: 0, lon: 0.002 });

    // ~1.1 km north of the line → off-trail.
    await act(async () => {
      captured!(makeUpdate(0.01, 0.002));
    });
    expect(latest.status).toBe('off-trail');
    expect(latest.offTrailMeters).toBeGreaterThan(50);
  });

  it('stays in no-permission when permission is denied', async () => {
    (locationService.requestLocationPermission as jest.Mock).mockResolvedValue('denied');
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    await act(async () => {
      await latest.start();
    });
    expect(latest.status).toBe('no-permission');
    expect(captured).toBeNull();
  });

  it('records the opt-in on start() and clears it, and the fix, on stop()', async () => {
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    await act(async () => {
      await latest.start();
    });
    expect(mockSettings.setGpsOnGuideOpen).toHaveBeenLastCalledWith(true);
    await act(async () => {
      captured!(makeUpdate(0, 0.002));
    });
    expect(latest.status).toBe('fix');

    await act(async () => {
      latest.stop();
    });
    expect(mockSettings.setGpsOnGuideOpen).toHaveBeenLastCalledWith(false);
    expect(latest.status).toBe('no-permission');
    expect(latest.currentKm).toBeNull();
    expect(latest.position).toBeNull();
  });

  it('falls back to the pill with an error when an automatic start fails, and retries on start()', async () => {
    mockSettings.gpsOnGuideOpen = true;
    (locationService.getLocationPermissionStatus as jest.Mock).mockResolvedValue('granted');
    (locationService.startLocationTracking as jest.Mock).mockRejectedValueOnce(
      new Error('Location services are off'),
    );
    await act(async () => {
      TestRenderer.create(<Harness />);
    });
    expect(latest.status).toBe('no-permission');
    expect(latest.error).toBe('Location services are off');

    await act(async () => {
      await latest.start();
    });
    expect(latest.error).toBeNull();
    expect(latest.status).toBe('acquiring');
    expect(captured).not.toBeNull();
  });
});
