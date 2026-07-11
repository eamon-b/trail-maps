import React from 'react';
import { Share } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { CoordinatesRow, formatCoordinates } from '../CoordinatesRow';
import { ThemeProvider } from '../../theme';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('formatCoordinates', () => {
  it('formats decimal degrees to 5 dp', () => {
    expect(formatCoordinates(-35.123454, 148.987654, 'decimal')).toBe(
      '-35.12345, 148.98765',
    );
  });

  it('formats DMS with hemispheres', () => {
    expect(formatCoordinates(-35.5, 148.25, 'dms')).toBe(
      `35°30'0.0" S 148°15'0.0" E`,
    );
  });

  it('uses N/W hemispheres for positive lat / negative lon', () => {
    expect(formatCoordinates(35.5, -148.25, 'dms')).toBe(
      `35°30'0.0" N 148°15'0.0" W`,
    );
  });
});

describe('CoordinatesRow', () => {
  it('renders the current position as decimal degrees', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(screen.getByText('-35.12345, 148.98765')).toBeTruthy();
    });
  });

  it('opens the share sheet with the coordinate string on tap', async () => {
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction, activityType: null });

    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(screen.getByText('-35.12345, 148.98765')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('-35.12345, 148.98765'));
    await waitFor(() => {
      expect(shareSpy).toHaveBeenCalledWith({ message: '-35.12345, 148.98765' });
    });

    shareSpy.mockRestore();
  });

  it('toggles to DMS format on long press', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.5} longitude={148.25} />);
    await waitFor(() => {
      expect(screen.getByText('-35.50000, 148.25000')).toBeTruthy();
    });

    fireEvent(screen.getByText('-35.50000, 148.25000'), 'longPress');
    await waitFor(() => {
      expect(screen.getByText(`35°30'0.0" S 148°15'0.0" E`)).toBeTruthy();
    });
  });

  it('has an accessibility label describing the coordinates', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText(
          'Current coordinates -35.12345, 148.98765. Tap to share, long press to change format.',
        ),
      ).toBeTruthy();
    });
  });
});
