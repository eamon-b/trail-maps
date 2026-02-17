import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { WaypointList, WaypointListItem, waypointEmojis } from '../WaypointList';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

function makeWaypoints(count = 5): WaypointListItem[] {
  const types = ['campsite', 'water', 'town', 'hut', 'summit'];
  return Array.from({ length: count }, (_, i) => ({
    id: `wp-${i}`,
    name: `Waypoint ${i + 1}`,
    type: types[i % types.length],
    kmPosition: (i + 1) * 10,
  }));
}

describe('WaypointList', () => {
  const onSelect = jest.fn();
  const onSeeAll = jest.fn();

  beforeEach(() => {
    onSelect.mockClear();
    onSeeAll.mockClear();
  });

  it('renders all waypoints with names', async () => {
    const waypoints = makeWaypoints(3);

    renderWithTheme(
      <WaypointList waypoints={waypoints} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('Waypoint 1')).toBeTruthy();
    });
    expect(screen.getByText('Waypoint 2')).toBeTruthy();
    expect(screen.getByText('Waypoint 3')).toBeTruthy();
  });

  it('renders emoji icons for waypoint types', async () => {
    const waypoints: WaypointListItem[] = [
      { id: '1', name: 'Camp', type: 'campsite' },
      { id: '2', name: 'Creek', type: 'water' },
    ];

    renderWithTheme(
      <WaypointList waypoints={waypoints} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText(waypointEmojis.campsite)).toBeTruthy();
    });
    expect(screen.getByText(waypointEmojis.water)).toBeTruthy();
  });

  it('limits display when maxItems is set', async () => {
    const waypoints = makeWaypoints(5);

    renderWithTheme(
      <WaypointList
        waypoints={waypoints}
        maxItems={3}
        onSelect={onSelect}
        onSeeAll={onSeeAll}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Waypoint 1')).toBeTruthy();
    });
    expect(screen.getByText('Waypoint 2')).toBeTruthy();
    expect(screen.getByText('Waypoint 3')).toBeTruthy();
    expect(screen.queryByText('Waypoint 4')).toBeNull();
    expect(screen.queryByText('Waypoint 5')).toBeNull();
  });

  it('shows "See all" button when items exceed maxItems', async () => {
    const waypoints = makeWaypoints(5);

    renderWithTheme(
      <WaypointList
        waypoints={waypoints}
        maxItems={3}
        onSelect={onSelect}
        onSeeAll={onSeeAll}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('See all waypoints')).toBeTruthy();
    });
  });

  it('does not show "See all" when items fit within maxItems', async () => {
    const waypoints = makeWaypoints(2);

    renderWithTheme(
      <WaypointList
        waypoints={waypoints}
        maxItems={3}
        onSelect={onSelect}
        onSeeAll={onSeeAll}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Waypoint 1')).toBeTruthy();
    });
    expect(screen.queryByText('See all waypoints')).toBeNull();
  });

  it('calls onSelect when waypoint is pressed', async () => {
    const waypoints = makeWaypoints(2);

    renderWithTheme(
      <WaypointList waypoints={waypoints} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('Waypoint 1')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText(new RegExp('Waypoint 1')));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(waypoints[0]);
  });

  it('calls onSeeAll when "See all" button is pressed', async () => {
    const waypoints = makeWaypoints(5);

    renderWithTheme(
      <WaypointList
        waypoints={waypoints}
        maxItems={2}
        onSelect={onSelect}
        onSeeAll={onSeeAll}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('See all waypoints')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('See all waypoints'));
    expect(onSeeAll).toHaveBeenCalledTimes(1);
  });

  it('shows distanceAhead when provided', async () => {
    const waypoints: WaypointListItem[] = [
      { id: '1', name: 'Camp A', type: 'campsite', distanceAhead: '2.5 km' },
    ];

    renderWithTheme(
      <WaypointList waypoints={waypoints} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('2.5 km')).toBeTruthy();
    });
  });

  it('falls back to poi emoji for unknown type', async () => {
    const waypoints: WaypointListItem[] = [
      { id: '1', name: 'Mystery', type: 'unknown_type' },
    ];

    renderWithTheme(
      <WaypointList waypoints={waypoints} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText(waypointEmojis.poi)).toBeTruthy();
    });
  });
});
