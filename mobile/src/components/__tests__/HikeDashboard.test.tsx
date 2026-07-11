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
