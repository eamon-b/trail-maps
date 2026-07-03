import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { ClimateOverview } from '../ClimateOverview';
import type { ClimateData } from '../../services/climate-service';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

function makeMonthly(month: number) {
  return {
    month,
    avgTempMin: 5 + month,
    avgTempMax: 15 + month,
    avgPrecipitation: 40 + month * 2,
    avgRainyDays: 8 + month,
  };
}

function makeClimate(locationCount = 1): ClimateData {
  const locations = Array.from({ length: locationCount }, (_, i) => ({
    name: `Location ${i + 1}`,
    lat: -35 + i,
    lon: 138 + i,
    elevation: 400 + i * 100,
    monthly: [makeMonthly(1), makeMonthly(2), makeMonthly(3)],
  }));

  return {
    locations,
    dataYears: { start: 1990, end: 2020 },
  };
}

describe('ClimateOverview', () => {
  it('renders empty state when no locations', async () => {
    const climate: ClimateData = { locations: [], dataYears: { start: 1990, end: 2020 } };

    renderWithTheme(<ClimateOverview climate={climate} />);

    await waitFor(() => {
      expect(screen.getByText('No climate data available.')).toBeTruthy();
    });
  });

  it('renders title and data years subtitle', async () => {
    renderWithTheme(<ClimateOverview climate={makeClimate(1)} />);

    await waitFor(() => {
      expect(screen.getByText('Climate Data')).toBeTruthy();
    });
    expect(screen.getByText('1990–2020 averages')).toBeTruthy();
  });

  it('renders monthly data rows', async () => {
    renderWithTheme(<ClimateOverview climate={makeClimate(1)} />);

    await waitFor(() => {
      expect(screen.getByText('Jan')).toBeTruthy();
    });
    expect(screen.getByText('Feb')).toBeTruthy();
    expect(screen.getByText('Mar')).toBeTruthy();

    // Check temperature values (month=1: min=6, max=16)
    expect(screen.getByText('6°')).toBeTruthy();
    expect(screen.getByText('16°')).toBeTruthy();

    // Check rain (month=1: 42mm)
    expect(screen.getByText('42mm')).toBeTruthy();
  });

  it('does not show tabs for single location', async () => {
    renderWithTheme(<ClimateOverview climate={makeClimate(1)} />);

    await waitFor(() => {
      expect(screen.getByText('Climate Data')).toBeTruthy();
    });

    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows tabs for multiple locations', async () => {
    renderWithTheme(<ClimateOverview climate={makeClimate(2)} />);

    await waitFor(() => {
      expect(screen.getByText('Location 1')).toBeTruthy();
    });
    expect(screen.getByText('Location 2')).toBeTruthy();
  });

  it('switches location on tab press', async () => {
    const climate = makeClimate(2);
    // Give location 2 a distinct month value
    climate.locations[1].monthly = [
      { month: 7, avgTempMin: 0, avgTempMax: 10, avgPrecipitation: 100, avgRainyDays: 15 },
    ];

    renderWithTheme(<ClimateOverview climate={climate} />);

    await waitFor(() => {
      expect(screen.getByText('Location 1')).toBeTruthy();
    });

    // Initially shows location 1 data (Jan)
    expect(screen.getByText('Jan')).toBeTruthy();

    // Tap location 2 tab
    fireEvent.press(screen.getByText('Location 2'));

    await waitFor(() => {
      expect(screen.getByText('Jul')).toBeTruthy();
    });
    // Location 1 months should be gone
    expect(screen.queryByText('Jan')).toBeNull();
  });

  it('renders header row labels', async () => {
    renderWithTheme(<ClimateOverview climate={makeClimate(1)} />);

    await waitFor(() => {
      expect(screen.getByText('Month')).toBeTruthy();
    });
    expect(screen.getByText('Min')).toBeTruthy();
    expect(screen.getByText('Max')).toBeTruthy();
    expect(screen.getByText('Rain')).toBeTruthy();
    expect(screen.getByText('Days')).toBeTruthy();
  });
});
