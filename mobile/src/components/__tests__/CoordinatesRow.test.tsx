import React from 'react';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
      `35°30'00.0" S 148°15'00.0" E`,
    );
  });

  it('uses N/W hemispheres for positive lat / negative lon', () => {
    expect(formatCoordinates(35.5, -148.25, 'dms')).toBe(
      `35°30'00.0" N 148°15'00.0" W`,
    );
  });

  it('zero-pads seconds to two integer digits (consistent with minutes)', () => {
    // 35°07'24.4" — seconds < 10 must read "04.4", not "4.4"
    const dms = formatCoordinates(-35.123454, 148.123454, 'dms');
    expect(dms).toMatch(/^35°\d\d'\d\d\.\d" S 148°\d\d'\d\d\.\d" E$/);
  });

  it('carries at the minute boundary instead of emitting 59\'60"', () => {
    // -35.999999 must round up to 36°00'00.0", never 35°59'60.0"
    expect(formatCoordinates(-35.999999, 148, 'dms')).toBe(
      `36°00'00.0" S 148°00'00.0" E`,
    );
  });

  it('carries through both minute and degree at a near-whole boundary', () => {
    expect(formatCoordinates(-35, 149.9999999, 'dms')).toBe(
      `35°00'00.0" S 150°00'00.0" E`,
    );
  });

  it('formats an exact whole degree', () => {
    expect(formatCoordinates(36.0, 0, 'dms')).toBe(
      `36°00'00.0" N 0°00'00.0" E`,
    );
  });

  it('formats the origin (0, 0)', () => {
    expect(formatCoordinates(0, 0, 'dms')).toBe(`0°00'00.0" N 0°00'00.0" E`);
  });
});

describe('CoordinatesRow', () => {
  it('renders the current position as decimal degrees', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(screen.getByText('-35.12345, 148.98765')).toBeTruthy();
    });
  });

  it('copies the coordinate string to the clipboard on tap', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(screen.getByText('-35.12345, 148.98765')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('-35.12345, 148.98765'));
    await waitFor(() => {
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith('-35.12345, 148.98765');
      expect(screen.getByText('Copied')).toBeTruthy();
    });
  });

  it('opens the share sheet from the share icon', async () => {
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction, activityType: null });

    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(screen.getByText('-35.12345, 148.98765')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('Share coordinates'));
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
      expect(screen.getByText(`35°30'00.0" S 148°15'00.0" E`)).toBeTruthy();
    });
  });

  it('has an accessibility label describing the coordinates', async () => {
    renderWithTheme(<CoordinatesRow latitude={-35.12345} longitude={148.98765} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText(
          'Current coordinates -35.12345, 148.98765. Tap to copy, long press to change format.',
        ),
      ).toBeTruthy();
    });
  });
});
