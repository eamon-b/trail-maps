import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { WaterCarryList } from '../WaterCarryList';
import { ThemeProvider } from '../../theme';
import type { WaterCarryAnalysis } from '@lib/water-carry-calculator';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const noDataAnalysis: WaterCarryAnalysis = {
  hasWaterData: false,
  sources: [],
  gaps: [],
  longestGapKm: 0,
  dryStretchCount: 0,
};

const basicAnalysis: WaterCarryAnalysis = {
  hasWaterData: true,
  sources: [
    { name: 'Creek Alpha', km: 5.0, type: 'water' },
    { name: 'Tank Bravo', km: 18.5, type: 'water-tank' },
    { name: 'Spring Charlie', km: 40.2, type: 'water' },
  ],
  gaps: [
    {
      fromName: 'Trail Start',
      toName: 'Creek Alpha',
      fromKm: 0,
      toKm: 5.0,
      distanceKm: 5.0,
      isDryStretch: false,
    },
    {
      fromName: 'Creek Alpha',
      toName: 'Tank Bravo',
      fromKm: 5.0,
      toKm: 18.5,
      distanceKm: 13.5,
      isDryStretch: false,
    },
    {
      fromName: 'Tank Bravo',
      toName: 'Spring Charlie',
      fromKm: 18.5,
      toKm: 40.2,
      distanceKm: 21.7,
      isDryStretch: true,
    },
  ],
  longestGapKm: 21.7,
  dryStretchCount: 1,
};

const seasonalAnalysis: WaterCarryAnalysis = {
  hasWaterData: true,
  sources: [
    { name: 'Summer Creek', km: 10.0, type: 'water', seasonalNote: 'May be dry in summer' },
    { name: 'Reliable Spring', km: 25.0, type: 'water' },
  ],
  gaps: [
    {
      fromName: 'Trail Start',
      toName: 'Summer Creek',
      fromKm: 0,
      toKm: 10.0,
      distanceKm: 10.0,
      isDryStretch: false,
    },
    {
      fromName: 'Summer Creek',
      toName: 'Reliable Spring',
      fromKm: 10.0,
      toKm: 25.0,
      distanceKm: 15.0,
      isDryStretch: true,
    },
  ],
  longestGapKm: 15.0,
  dryStretchCount: 1,
};

describe('WaterCarryList', () => {
  it('renders "No water source data" when hasWaterData is false', async () => {
    renderWithTheme(<WaterCarryList analysis={noDataAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('Water Sources')).toBeTruthy();
    });
    expect(screen.getByText('No water source data available for this trail.')).toBeTruthy();
  });

  it('renders source count and longest gap', async () => {
    renderWithTheme(<WaterCarryList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('3 sources')).toBeTruthy();
    });
    expect(screen.getByText('Longest gap: 21.7 km')).toBeTruthy();
  });

  it('renders gap rows with distances', async () => {
    renderWithTheme(<WaterCarryList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('5.0 km')).toBeTruthy();
    });
    expect(screen.getByText('13.5 km')).toBeTruthy();
    expect(screen.getByText('21.7 km')).toBeTruthy();
  });

  it('shows "DRY" label for dry stretch gaps', async () => {
    renderWithTheme(<WaterCarryList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('DRY')).toBeTruthy();
    });
  });

  it('shows dry stretch count', async () => {
    renderWithTheme(<WaterCarryList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('1 dry stretch')).toBeTruthy();
    });
  });

  it('renders seasonal notes when present', async () => {
    renderWithTheme(<WaterCarryList analysis={seasonalAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('May be dry in summer')).toBeTruthy();
    });
  });
});
