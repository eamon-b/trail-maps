import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { LocationStatusBar, LocationState } from '../LocationStatusBar';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('LocationStatusBar', () => {
  const allStates: Array<{ state: LocationState; label: string; icon: string }> = [
    { state: 'onTrail', label: 'On trail', icon: '✓' },
    { state: 'noGps', label: 'No GPS', icon: '⊘' },
    { state: 'drifting', label: 'Drifting', icon: '~' },
    { state: 'warning', label: 'Warning', icon: '⚠' },
    { state: 'offTrail', label: 'Off trail', icon: '✕' },
  ];

  it.each(allStates)('renders $state with label "$label" and icon "$icon"', async ({ state, label, icon }) => {
    renderWithTheme(<LocationStatusBar state={state} />);

    await waitFor(() => {
      expect(screen.getByText(label)).toBeTruthy();
    });
    expect(screen.getByText(icon)).toBeTruthy();
  });

  it('shows detail text when provided', async () => {
    renderWithTheme(<LocationStatusBar state="offTrail" detail="150m from trail" />);

    await waitFor(() => {
      expect(screen.getByText('150m from trail')).toBeTruthy();
    });
  });

  it('does not show detail text when not provided', async () => {
    renderWithTheme(<LocationStatusBar state="onTrail" />);

    await waitFor(() => {
      expect(screen.getByText('On trail')).toBeTruthy();
    });

    // Only icon + label, no detail
    expect(screen.queryByText('150m from trail')).toBeNull();
  });

  it('has accessibility label with state', async () => {
    renderWithTheme(<LocationStatusBar state="warning" />);

    await waitFor(() => {
      expect(screen.getByLabelText('Location status: Warning')).toBeTruthy();
    });
  });

  it('includes detail in accessibility label', async () => {
    renderWithTheme(<LocationStatusBar state="offTrail" detail="200m away" />);

    await waitFor(() => {
      expect(screen.getByLabelText('Location status: Off trail. 200m away')).toBeTruthy();
    });
  });

  it('has accessibilityRole="alert"', async () => {
    const { toJSON } = renderWithTheme(<LocationStatusBar state="onTrail" />);

    await waitFor(() => {
      expect(screen.getByText('On trail')).toBeTruthy();
    });

    // Verify the container has the alert role via the accessibility label
    const container = screen.getByLabelText('Location status: On trail');
    expect(container.props.accessibilityRole).toBe('alert');
  });
});
