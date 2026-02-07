import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ModeSelector } from '../ModeSelector';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('ModeSelector', () => {
  it('renders with accessibility label for current mode', async () => {
    renderWithTheme(<ModeSelector />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Current mode: Plan/i)).toBeTruthy();
    });
  });

  it('has accessible tab buttons for each mode when expanded', async () => {
    renderWithTheme(<ModeSelector />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Current mode/)).toBeTruthy();
    });
    // Tap to expand
    fireEvent.press(screen.getByLabelText(/Current mode/));
    // All three mode buttons should be accessible
    expect(screen.getByLabelText(/Switch to Plan mode/)).toBeTruthy();
    expect(screen.getByLabelText(/Switch to Hike mode/)).toBeTruthy();
    expect(screen.getByLabelText(/Switch to Contribute mode/)).toBeTruthy();
  });
});
