import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { AlertBanner } from '../AlertBanner';
import { LocationStatusBar } from '../LocationStatusBar';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('AlertBanner', () => {
  it('renders with correct accessibility role and label', async () => {
    renderWithTheme(
      <AlertBanner visible level="warning" message="You are 150m off trail" />,
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText('warning alert: You are 150m off trail'),
      ).toBeTruthy();
    });
  });
});

describe('LocationStatusBar', () => {
  it('renders all states with text labels (not color alone)', async () => {
    const states = ['onTrail', 'noGps', 'drifting', 'warning', 'offTrail'] as const;
    const expectedLabels = ['On trail', 'No GPS', 'Drifting', 'Warning', 'Off trail'];

    for (let i = 0; i < states.length; i++) {
      const { unmount } = renderWithTheme(
        <LocationStatusBar state={states[i]} />,
      );
      await waitFor(() => {
        expect(screen.getByText(expectedLabels[i])).toBeTruthy();
      });
      unmount();
    }
  });

  it('includes detail text in accessibility label', async () => {
    renderWithTheme(
      <LocationStatusBar state="offTrail" detail="150m from trail" />,
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText('Location status: Off trail. 150m from trail'),
      ).toBeTruthy();
    });
  });
});
