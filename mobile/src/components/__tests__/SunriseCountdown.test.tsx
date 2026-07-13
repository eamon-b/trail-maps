import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { SunriseCountdown } from '../SunriseCountdown';
import { ThemeProvider } from '../../theme';

// Adelaide, Australia — reliable sun data
const LAT = -34.93;
const LON = 138.6;

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('SunriseCountdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders without crashing for a valid Australian location', async () => {
    // Use a fixed date where sun definitely rises and sets in Australia
    const { toJSON } = renderWithTheme(
      <SunriseCountdown latitude={LAT} longitude={LON} />,
    );
    await waitFor(() => {
      expect(toJSON()).not.toBeNull();
    });
  });

  it('shows sunrise or sunset label', async () => {
    renderWithTheme(<SunriseCountdown latitude={LAT} longitude={LON} />);
    await waitFor(() => {
      const hasSunrise = !!screen.queryByText(/Sunrise/i);
      const hasSunset = !!screen.queryByText(/Sunset/i);
      expect(hasSunrise || hasSunset).toBe(true);
    });
  });

  it('has an accessibility label describing the sun event', async () => {
    renderWithTheme(<SunriseCountdown latitude={LAT} longitude={LON} />);
    await waitFor(() => {
      // The accessibility label should mention either Sunrise or Sunset
      const el =
        screen.queryByLabelText(/Sunrise/i) ||
        screen.queryByLabelText(/Sunset/i);
      expect(el).toBeTruthy();
    });
  });

  it('updates on a 60-second timer tick', async () => {
    renderWithTheme(
      <SunriseCountdown latitude={LAT} longitude={LON} />,
    );
    // Timer fires after 60s — just ensure no crash on tick
    await waitFor(() => {
      expect(screen.queryByText(/Sunrise|Sunset/i)).toBeTruthy();
    });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Sunrise|Sunset/i)).toBeTruthy();
    });
  });
});
