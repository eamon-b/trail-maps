import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { HikeDashboard, type DashboardData } from '../HikeDashboard';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const data: DashboardData = {
  trailName: 'TEST TRAIL',
  direction: 'NOBO',
  currentKm: 10,
  totalKm: 100,
  nextCampsite: { id: 'wp-camp-1', name: 'Ridge Camp', distance: '4.2 km' },
  nextWater: { id: 'custom-7', name: 'Creek Tank', distance: '1.1 km' },
  nextTown: { id: 'wp-town-1', name: 'Hillview', distance: '22.0 km' },
  nextShelter: { name: 'Old Hut', distance: '8.0 km' }, // no id — not tappable
};

describe('HikeDashboard next-waypoint cards', () => {
  it('calls onNextWaypointPress with the waypoint id when a card is tapped', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <HikeDashboard data={data} onNextWaypointPress={onPress} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Ridge Camp')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('NEXT CAMPSITE: Ridge Camp, 4.2 km'));
    expect(onPress).toHaveBeenCalledWith('wp-camp-1');
  });

  it('passes custom waypoint ids (custom- prefix) through unchanged', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <HikeDashboard data={data} onNextWaypointPress={onPress} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Creek Tank')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('NEXT WATER: Creek Tank, 1.1 km'));
    expect(onPress).toHaveBeenCalledWith('custom-7');
  });

  it('renders tappable cards with the button accessibility role', async () => {
    renderWithTheme(
      <HikeDashboard data={data} onNextWaypointPress={jest.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Ridge Camp')).toBeTruthy();
    });

    const card = screen.getByLabelText('NEXT CAMPSITE: Ridge Camp, 4.2 km');
    expect(card.props.accessibilityRole).toBe('button');
  });

  it('does not crash when a card has no waypoint id', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <HikeDashboard data={data} onNextWaypointPress={onPress} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Old Hut')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('NEXT SHELTER: Old Hut, 8.0 km'));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('HikeDashboard ETA / bearing / time-to-water (P1 PR C)', () => {
  const richData: DashboardData = {
    ...data,
    nextCampsite: { id: 'wp-camp-1', name: 'Ridge Camp', distance: '4.2 km', eta: '~1 h 5 min', bearing: 45 },
    nextWater: {
      id: 'custom-7',
      name: 'Creek Tank',
      distance: '1.1 km',
      eta: '~15 min',
      bearing: 250,
      note: 'Tank half full, clear water',
    },
    nextWaterKm: 1.1,
    nextWaterEtaMinutes: 16,
    gpsCourse: { heading: null, speed: 0, fixTimestamp: Date.now() },
    today: {
      dayNumber: 2,
      totalDays: 5,
      startName: 'A',
      endName: 'B',
      distanceKm: 20,
      ascentM: 500,
      descentM: 300,
      estimatedHours: 6,
      completedKm: 10,
      remainingHours: 3,
    },
  };

  it('renders per-waypoint ETAs on the cards', async () => {
    renderWithTheme(<HikeDashboard data={richData} />);
    await waitFor(() => {
      expect(screen.getByText('~1 h 5 min')).toBeTruthy();
      expect(screen.getByText('~15 min')).toBeTruthy();
    });
  });

  it('surfaces the water description first line on the NEXT WATER card', async () => {
    renderWithTheme(<HikeDashboard data={richData} />);
    await waitFor(() => {
      expect(screen.getByText('Tank half full, clear water')).toBeTruthy();
    });
  });

  it('labels the day-level ETA "at plan pace"', async () => {
    renderWithTheme(<HikeDashboard data={richData} />);
    await waitFor(() => {
      expect(screen.getByText(/ETA: \d{2}:\d{2} \(at plan pace\)/)).toBeTruthy();
    });
  });

  it('degrades the bearing to cardinal text while stationary (speed 0)', async () => {
    renderWithTheme(<HikeDashboard data={richData} />);
    await waitFor(() => {
      // 45° → NE (campsite), 250° → WSW (water); no arrow glyph when not moving
      expect(screen.getByText('NE')).toBeTruthy();
      expect(screen.getByText('WSW')).toBeTruthy();
      expect(screen.queryByText('↑')).toBeNull();
    });
  });

  it('shows the rotating arrow when moving with a fresh fix', async () => {
    const moving: DashboardData = {
      ...richData,
      gpsCourse: { heading: 30, speed: 1.4, fixTimestamp: Date.now() },
    };
    renderWithTheme(<HikeDashboard data={moving} />);
    await waitFor(() => {
      expect(screen.getAllByText('↑').length).toBeGreaterThan(0);
    });
  });

  it('shows the elevation-gain figure on the NEXT WATER card', async () => {
    const withWaterElevation: DashboardData = {
      ...richData,
      nextWater: { ...richData.nextWater!, elevation: '+120m' },
    };
    renderWithTheme(<HikeDashboard data={withWaterElevation} />);
    await waitFor(() => {
      expect(screen.getByText('+120m')).toBeTruthy();
    });
  });
});

describe('HikeDashboard TODAY collapse (header chevron only)', () => {
  const todayData: DashboardData = {
    trailName: 'TEST TRAIL',
    direction: 'NOBO',
    currentKm: 10,
    totalKm: 100,
    today: {
      dayNumber: 2,
      totalDays: 5,
      startName: 'Alpha',
      endName: 'Bravo',
      distanceKm: 20,
      ascentM: 500,
      descentM: 300,
      estimatedHours: 6,
      completedKm: 10,
      remainingHours: 3,
    },
  };

  it('does NOT collapse when the card body is tapped', async () => {
    renderWithTheme(<HikeDashboard data={todayData} gpsState="normal" />);
    await waitFor(() => {
      expect(screen.getByText('Alpha → Bravo')).toBeTruthy();
    });

    // The body is no longer a Pressable — tapping it must leave it expanded.
    fireEvent.press(screen.getByText('Alpha → Bravo'));
    expect(screen.getByText('Alpha → Bravo')).toBeTruthy();
    expect(screen.queryByText('Tap the header to expand')).toBeNull();
  });

  it('collapses and expands when the header chevron row is tapped', async () => {
    renderWithTheme(<HikeDashboard data={todayData} gpsState="normal" />);
    const header = await screen.findByLabelText(/Collapse today section/);

    fireEvent.press(header);
    await waitFor(() => {
      expect(screen.queryByText('Alpha → Bravo')).toBeNull();
      expect(screen.getByText('Tap the header to expand')).toBeTruthy();
    });

    // Header label flips to "Expand …" and tapping again re-expands the body.
    fireEvent.press(screen.getByLabelText(/Expand today section/));
    await waitFor(() => {
      expect(screen.getByText('Alpha → Bravo')).toBeTruthy();
    });
  });

  it('exposes the expanded accessibility state on the header row', async () => {
    renderWithTheme(<HikeDashboard data={todayData} gpsState="normal" />);
    const header = await screen.findByLabelText(/Collapse today section/);
    expect(header.props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: true }),
    );

    fireEvent.press(header);
    const collapsed = await screen.findByLabelText(/Expand today section/);
    expect(collapsed.props.accessibilityState).toEqual(
      expect.objectContaining({ expanded: false }),
    );
  });
});

describe('HikeDashboard no-fix state (gpsState=searching)', () => {
  // With no fix, currentKm is a sentinel 0 — the position-relative readouts
  // must not present distances measured from the trail start as live data.
  const searchingData: DashboardData = {
    trailName: 'TEST TRAIL',
    direction: 'NOBO',
    currentKm: 0,
    totalKm: 100,
    nextWaterKm: 0.4,
    nextWaterEtaMinutes: 6,
    upcoming: [
      { id: 'wp-1', name: 'Ridge Camp', type: 'campsite', distanceAhead: '0.2 km' },
      { id: 'wp-2', name: 'Creek Tank', type: 'water', distanceAhead: '0.4 km' },
    ],
    today: {
      dayNumber: 1,
      totalDays: 3,
      startName: 'Start',
      endName: 'End',
      distanceKm: 18,
      ascentM: 400,
      descentM: 200,
      estimatedHours: 5,
      completedKm: 0,
      remainingHours: 5,
    },
  };

  it('suppresses the km-0 today progress/ETA and shows a waiting note', async () => {
    renderWithTheme(<HikeDashboard data={searchingData} gpsState="searching" />);
    await waitFor(() => {
      expect(screen.getByText('Waiting for GPS to show progress…')).toBeTruthy();
    });
    // No km-0-relative progress, ETA, or water number
    expect(screen.queryByText(/Done: 0\.0 km/)).toBeNull();
    expect(screen.queryByText(/at plan pace/)).toBeNull();
    expect(screen.queryByText(/Next water: 0\.4 km/)).toBeNull();
  });

  it('does not render the upcoming distances while searching', async () => {
    renderWithTheme(<HikeDashboard data={searchingData} gpsState="searching" />);
    await waitFor(() => {
      // UPCOMING card degrades to the searching message rather than listing
      // distances measured from km 0.
      expect(screen.getAllByText('Searching for GPS signal...').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Ridge Camp')).toBeNull();
    expect(screen.queryByText('Creek Tank')).toBeNull();
  });

  it('shows live position-relative data once a fix arrives (normal gpsState)', async () => {
    const withFix: DashboardData = { ...searchingData, currentKm: 9, today: { ...searchingData.today!, completedKm: 4 } };
    renderWithTheme(<HikeDashboard data={withFix} gpsState="normal" />);
    await waitFor(() => {
      expect(screen.getByText(/Done: 4\.0 km/)).toBeTruthy();
    });
    expect(screen.queryByText('Waiting for GPS to show progress…')).toBeNull();
  });
});
