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
});
