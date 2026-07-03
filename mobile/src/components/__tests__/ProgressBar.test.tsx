import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { ProgressBar } from '../ProgressBar';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('ProgressBar', () => {
  it('renders with label and detail', async () => {
    renderWithTheme(
      <ProgressBar progress={0.25} label="BIBBULMUN TRACK" detail="km 245 / 982" />,
    );
    await waitFor(() => {
      expect(screen.getByText('BIBBULMUN TRACK')).toBeTruthy();
    });
    expect(screen.getByText('km 245 / 982')).toBeTruthy();
  });

  it('has correct accessibility label with percentage', async () => {
    renderWithTheme(<ProgressBar progress={0.45} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Progress: 45%/)).toBeTruthy();
    });
  });

  it('clamps progress without throwing', async () => {
    // Below 0
    const { unmount } = renderWithTheme(<ProgressBar progress={-0.5} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Progress: 0%/)).toBeTruthy();
    });
    unmount();
  });

  it('clamps progress above 1', async () => {
    renderWithTheme(<ProgressBar progress={1.5} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Progress: 100%/)).toBeTruthy();
    });
  });
});
