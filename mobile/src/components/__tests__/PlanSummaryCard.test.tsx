import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { PlanSummaryCard } from '../PlanSummaryCard';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const baseProps = {
  planName: 'April Thru-hike',
  direction: 'NOBO',
  totalDays: 14,
  totalKm: 338.5,
  totalAscent: 4200,
  totalDescent: 3900,
};

describe('PlanSummaryCard', () => {
  it('renders plan name and direction badge', async () => {
    renderWithTheme(<PlanSummaryCard {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('April Thru-hike')).toBeTruthy();
    });
    expect(screen.getByText('NOBO')).toBeTruthy();
  });

  it('renders total stats (days, km, elevation)', async () => {
    renderWithTheme(<PlanSummaryCard {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText(/14 days/)).toBeTruthy();
    });
    expect(screen.getByText(/339 km/)).toBeTruthy();
    expect(screen.getByText(/\+4200m/)).toBeTruthy();
    expect(screen.getByText(/-3900m/)).toBeTruthy();
  });

  it('renders date range when both dates provided', async () => {
    renderWithTheme(
      <PlanSummaryCard {...baseProps} startDate="2026-04-01" endDate="2026-04-14" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/1 Apr/)).toBeTruthy();
    });
    expect(screen.getByText(/14 Apr/)).toBeTruthy();
  });

  it('does not render dates when not provided', async () => {
    renderWithTheme(<PlanSummaryCard {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('April Thru-hike')).toBeTruthy();
    });
    // The date range line uses an em dash separator; its absence means no dates rendered
    expect(screen.queryByText(/\d+ \w+ — \d+ \w+/)).toBeNull();
  });

  it('renders section badge when section provided', async () => {
    renderWithTheme(<PlanSummaryCard {...baseProps} section="km 50-200" />);

    await waitFor(() => {
      expect(screen.getByText(/Section: km 50-200/)).toBeTruthy();
    });
  });

  it('has correct accessibility label', async () => {
    renderWithTheme(<PlanSummaryCard {...baseProps} />);

    await waitFor(() => {
      const card = screen.getByLabelText('April Thru-hike, NOBO, 14 days, 339 km');
      expect(card).toBeTruthy();
    });
  });
});
