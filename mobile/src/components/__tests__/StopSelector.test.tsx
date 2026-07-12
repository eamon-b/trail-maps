import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { ThemeProvider } from '../../theme';
import { StopSelector } from '../StopSelector';
import type { TrailWaypoint } from '../../lib/trail-utils';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

function makeWaypoints(): TrailWaypoint[] {
  return [
    { id: 'wp-0', name: 'Camp Alpha', lat: -33, lon: 115, type: 'campsite', totalDistance: 10 },
    { id: 'wp-1', name: 'Creek Beta', lat: -33.1, lon: 115.1, type: 'water', totalDistance: 25 },
    { id: 'wp-2', name: 'Town Gamma', lat: -33.2, lon: 115.2, type: 'town', totalDistance: 40 },
    { id: 'wp-3', name: 'Hut Delta', lat: -33.3, lon: 115.3, type: 'hut', totalDistance: 55 },
  ];
}

describe('StopSelector', () => {
  const waypoints = makeWaypoints();
  const onToggleStop = jest.fn();

  beforeEach(() => {
    onToggleStop.mockClear();
    jest.clearAllMocks();
  });

  it('renders all waypoints with names and km values', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set()}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Camp Alpha')).toBeTruthy();
    });
    expect(screen.getByText('Creek Beta')).toBeTruthy();
    expect(screen.getByText('Town Gamma')).toBeTruthy();
    expect(screen.getByText('Hut Delta')).toBeTruthy();
  });

  it('highlights selected stops via selectedStopKms', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set([10, 40])}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      const campAlpha = screen.getByLabelText(/Camp Alpha.*selected/);
      expect(campAlpha).toBeTruthy();
    });

    const townGamma = screen.getByLabelText(/Town Gamma.*selected/);
    expect(townGamma).toBeTruthy();

    // Unselected ones should not have "selected" in label
    const creekBeta = screen.getByLabelText(/Creek Beta/);
    expect(creekBeta.props.accessibilityState?.checked).toBe(false);
  });

  it('calls onToggleStop on press', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set()}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Camp Alpha')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText(/Camp Alpha/));
    expect(onToggleStop).toHaveBeenCalledTimes(1);
    expect(onToggleStop).toHaveBeenCalledWith(waypoints[0]);
    // Selection tick on stop toggle (plan decision 5, via PressableRow).
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('filters by search text (case-insensitive)', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set()}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Camp Alpha')).toBeTruthy();
    });

    const searchInput = screen.getByLabelText('Filter waypoints');
    fireEvent.changeText(searchInput, 'creek');

    await waitFor(() => {
      expect(screen.getByText('Creek Beta')).toBeTruthy();
    });
    expect(screen.queryByText('Camp Alpha')).toBeNull();
    expect(screen.queryByText('Town Gamma')).toBeNull();
  });

  it('shows empty state when search matches nothing', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set()}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Filter waypoints')).toBeTruthy();
    });

    const searchInput = screen.getByLabelText('Filter waypoints');
    fireEvent.changeText(searchInput, 'zzzzz');

    await waitFor(() => {
      expect(screen.getByText(/No stops matching/)).toBeTruthy();
    });
  });

  it('displays gap distance between waypoints', async () => {
    renderWithTheme(
      <StopSelector
        waypoints={waypoints}
        selectedStopKms={new Set()}
        onToggleStop={onToggleStop}
      />
    );

    await waitFor(() => {
      // Gap between consecutive waypoints: 10→25, 25→40, 40→55 = all +15.0 km
      const gaps = screen.getAllByText('+15.0 km');
      expect(gaps.length).toBe(3);
    });
  });

});
