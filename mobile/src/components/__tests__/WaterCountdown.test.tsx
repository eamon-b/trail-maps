import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { WaterCountdown } from '../WaterCountdown';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('WaterCountdown', () => {
  it('returns null when nextWaterKm is null', async () => {
    const { toJSON } = renderWithTheme(<WaterCountdown nextWaterKm={null} />);
    // ThemeProvider renders null while loading, then the component itself returns null
    await waitFor(() => {
      expect(toJSON()).toBeNull();
    });
  });

  it('renders distance text for close water (< 5 km)', async () => {
    renderWithTheme(<WaterCountdown nextWaterKm={3.2} />);
    await waitFor(() => {
      expect(screen.getByText('Next water: 3.2 km')).toBeTruthy();
    });
    const textEl = screen.getByText('Next water: 3.2 km');
    const flatStyle = Array.isArray(textEl.props.style)
      ? Object.assign({}, ...textEl.props.style)
      : textEl.props.style;
    // Green comes from theme.colors.alertGreen (light theme: #188530), not a
    // hardcoded literal — Night Red mode must stay red-shifted
    expect(flatStyle.color).toBe('#188530');
  });

  it('renders distance text for medium distance (5-15 km)', async () => {
    renderWithTheme(<WaterCountdown nextWaterKm={10} />);
    await waitFor(() => {
      expect(screen.getByText('Next water: 10.0 km')).toBeTruthy();
    });
    const textEl = screen.getByText('Next water: 10.0 km');
    const flatStyle = Array.isArray(textEl.props.style)
      ? Object.assign({}, ...textEl.props.style)
      : textEl.props.style;
    // Amber color comes from theme.colors.alertAmber (light theme: #A84B00)
    expect(flatStyle.color).toBe('#A84B00');
  });

  it('renders distance text for far water (> 15 km)', async () => {
    renderWithTheme(<WaterCountdown nextWaterKm={20} />);
    await waitFor(() => {
      expect(screen.getByText('Next water: 20.0 km')).toBeTruthy();
    });
    const textEl = screen.getByText('Next water: 20.0 km');
    const flatStyle = Array.isArray(textEl.props.style)
      ? Object.assign({}, ...textEl.props.style)
      : textEl.props.style;
    // Red color comes from theme.colors.alertRed (light theme: #D32F2F)
    expect(flatStyle.color).toBe('#D32F2F');
  });

  it('has correct accessibility label', async () => {
    renderWithTheme(<WaterCountdown nextWaterKm={7.5} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText('Next water source in 7.5 kilometers'),
      ).toBeTruthy();
    });
  });

  it('formats distance to 1 decimal place', async () => {
    renderWithTheme(<WaterCountdown nextWaterKm={4.567} />);
    await waitFor(() => {
      expect(screen.getByText('Next water: 4.6 km')).toBeTruthy();
    });
    expect(
      screen.getByLabelText('Next water source in 4.6 kilometers'),
    ).toBeTruthy();
  });
});
