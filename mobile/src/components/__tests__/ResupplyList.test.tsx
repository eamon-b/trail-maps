import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ResupplyList } from '../ResupplyList';
import { ThemeProvider } from '../../theme';
import type { ResupplyAnalysis } from '../../services/resupply-calculator';
import type { ComputedDay } from '../../services/plan-calculator-types';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const noDataAnalysis: ResupplyAnalysis = {
  hasResupplyData: false,
  points: [],
  gaps: [],
  longestGapKm: 0,
  longestGapDays: 0,
};

const basicAnalysis: ResupplyAnalysis = {
  hasResupplyData: true,
  points: [
    { name: 'Townsville', km: 50, type: 'town' },
    { name: 'Resupply Hut', km: 120, type: 'food' },
    { name: 'End Town', km: 200, type: 'town' },
  ],
  gaps: [
    {
      fromName: 'Trail Start',
      toName: 'Townsville',
      fromKm: 0,
      toKm: 50,
      distanceKm: 50,
      estimatedDays: 3,
      isLong: false,
    },
    {
      fromName: 'Townsville',
      toName: 'Resupply Hut',
      fromKm: 50,
      toKm: 120,
      distanceKm: 70,
      estimatedDays: 4,
      isLong: false,
    },
    {
      fromName: 'Resupply Hut',
      toName: 'End Town',
      fromKm: 120,
      toKm: 200,
      distanceKm: 80,
      estimatedDays: 5,
      isLong: false,
    },
  ],
  longestGapKm: 80,
  longestGapDays: 5,
};

const longGapAnalysis: ResupplyAnalysis = {
  hasResupplyData: true,
  points: [
    { name: 'Start Town', km: 0, type: 'town' },
    { name: 'Remote Town', km: 150, type: 'town' },
  ],
  gaps: [
    {
      fromName: 'Start Town',
      toName: 'Remote Town',
      fromKm: 0,
      toKm: 150,
      distanceKm: 150,
      estimatedDays: 8,
      isLong: true,
    },
  ],
  longestGapKm: 150,
  longestGapDays: 8,
};

const daysData: ComputedDay[] = [
  {
    dayNumber: 1,
    startName: 'Trail Start',
    endName: 'Camp 1',
    startKm: 0,
    endKm: 25,
    distanceKm: 25,
    ascentM: 500,
    descentM: 300,
    estimatedHours: 7,
    waterSources: 2,
  },
  {
    dayNumber: 2,
    startName: 'Camp 1',
    endName: 'Camp 2',
    startKm: 25,
    endKm: 55,
    distanceKm: 30,
    ascentM: 600,
    descentM: 400,
    estimatedHours: 8,
    waterSources: 1,
  },
  {
    dayNumber: 3,
    startName: 'Camp 2',
    endName: 'Camp 3',
    startKm: 55,
    endKm: 80,
    distanceKm: 25,
    ascentM: 400,
    descentM: 500,
    estimatedHours: 7,
    waterSources: 3,
  },
];

describe('ResupplyList', () => {
  it('renders "No town or food resupply data" when hasResupplyData is false', async () => {
    renderWithTheme(<ResupplyList analysis={noDataAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('Resupply Points')).toBeTruthy();
    });
    expect(screen.getByText('No town or food resupply data for this trail.')).toBeTruthy();
  });

  it('renders point count and longest gap stats', async () => {
    renderWithTheme(<ResupplyList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('3 points')).toBeTruthy();
    });
    expect(screen.getByText('Longest: 80 km (5 days)')).toBeTruthy();
  });

  it('renders gap rows with distances and estimated days', async () => {
    renderWithTheme(<ResupplyList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('50 km')).toBeTruthy();
    });
    expect(screen.getByText('~3 days')).toBeTruthy();
    expect(screen.getByText('70 km')).toBeTruthy();
    expect(screen.getByText('~5 days')).toBeTruthy();
    expect(screen.getByText('80 km')).toBeTruthy();
  });

  it('shows "LONG" label for long gaps', async () => {
    renderWithTheme(<ResupplyList analysis={longGapAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('LONG')).toBeTruthy();
    });
  });

  it('renders food calculator toggle', async () => {
    renderWithTheme(<ResupplyList analysis={basicAnalysis} />);
    await waitFor(() => {
      expect(screen.getByText('Show food weight calculator')).toBeTruthy();
    });
  });

  it('shows "Day N" when days correlation data is available', async () => {
    renderWithTheme(<ResupplyList analysis={basicAnalysis} days={daysData} />);
    await waitFor(() => {
      expect(screen.getByText('Day 2')).toBeTruthy();
    });
  });
});
