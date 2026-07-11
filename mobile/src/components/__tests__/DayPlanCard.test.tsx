import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { DayPlanCard, DayPlanData } from '../DayPlanCard';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const baseData: DayPlanData = {
  dayNumber: 3,
  startName: 'Donnelly River',
  endName: 'One Tree Bridge',
  distanceKm: 22.4,
  ascentM: 350,
  descentM: 280,
};

describe('DayPlanCard', () => {
  it('renders day number and route text', async () => {
    renderWithTheme(<DayPlanCard data={baseData} />);

    await waitFor(() => {
      expect(screen.getByText(/DAY 3/)).toBeTruthy();
    });
    expect(screen.getByText(/Donnelly River → One Tree Bridge/)).toBeTruthy();
  });

  it('renders distance and elevation stats', async () => {
    renderWithTheme(<DayPlanCard data={baseData} />);

    await waitFor(() => {
      expect(screen.getByText(/22\.4 km/)).toBeTruthy();
    });
    expect(screen.getByText(/\+350m\/-280m/)).toBeTruthy();
  });

  it('shows date when provided', async () => {
    const data: DayPlanData = { ...baseData, date: '15 Apr' };
    renderWithTheme(<DayPlanCard data={data} />);

    await waitFor(() => {
      expect(screen.getByText(/DAY 3 — 15 Apr/)).toBeTruthy();
    });
  });

  it('shows water sources count when provided', async () => {
    const data: DayPlanData = { ...baseData, waterSources: 3 };
    renderWithTheme(<DayPlanCard data={data} />);

    await waitFor(() => {
      expect(screen.getByText(/3 water sources/)).toBeTruthy();
    });
  });

  it('shows climate data when provided', async () => {
    const climate = { tempMin: 5, tempMax: 18, precipitation: 42, rainyDays: 8 };
    renderWithTheme(<DayPlanCard data={baseData} climate={climate} />);

    await waitFor(() => {
      expect(screen.getByText(/5–18°C/)).toBeTruthy();
    });
    expect(screen.getByText(/42mm/)).toBeTruthy();
  });

  it('shows map pin button when onShowOnMap provided', async () => {
    const onShowOnMap = jest.fn();
    renderWithTheme(<DayPlanCard data={baseData} onShowOnMap={onShowOnMap} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Show on map')).toBeTruthy();
    });
  });

  it('shows the ⋯ actions menu button and fires onOpenMenu', async () => {
    const onOpenMenu = jest.fn();
    renderWithTheme(<DayPlanCard data={baseData} onOpenMenu={onOpenMenu} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Day 3 actions')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Day 3 actions'));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('does not render the legacy merge/split arrow buttons', async () => {
    renderWithTheme(<DayPlanCard data={baseData} onOpenMenu={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/DAY 3/)).toBeTruthy();
    });
    expect(screen.queryByLabelText('Merge with previous day')).toBeNull();
    expect(screen.queryByLabelText('Split this day')).toBeNull();
  });

  it('shows the water/resupply strip and taps through', async () => {
    const onResourcePress = jest.fn();
    renderWithTheme(
      <DayPlanCard
        data={{ ...baseData, waterSources: 2 }}
        resources={{ maxCarryKm: 18, hasResupply: true }}
        onResourcePress={onResourcePress}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 water sources/)).toBeTruthy();
    });
    expect(screen.getByText(/carry 18 km/)).toBeTruthy();
    expect(screen.getByText(/resupply/)).toBeTruthy();

    fireEvent.press(screen.getByText(/carry 18 km/));
    expect(onResourcePress).toHaveBeenCalledTimes(1);
  });

  it('has correct accessibility label with all data', async () => {
    const data: DayPlanData = {
      ...baseData,
      date: '15 Apr',
      estimatedHours: 7,
      waterSources: 2,
    };
    renderWithTheme(<DayPlanCard data={data} />);

    await waitFor(() => {
      const card = screen.getByLabelText(
        'Day 3, 15 Apr. Donnelly River to One Tree Bridge. 22.4 kilometers, 350 meters ascent, 280 meters descent. About 7 hours. 2 water sources.',
      );
      expect(card).toBeTruthy();
    });
  });
});
