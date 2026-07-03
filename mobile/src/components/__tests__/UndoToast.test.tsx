import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { UndoToast } from '../UndoToast';

// Mock useReduceMotion to return false by default
jest.mock('../../theme/useReduceMotion', () => ({
  useReduceMotion: jest.fn(() => false),
}));

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('UndoToast', () => {
  const onUndo = jest.fn();
  const onDismiss = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    onUndo.mockClear();
    onDismiss.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null when visible is false', () => {
    const { toJSON } = renderWithTheme(
      <UndoToast
        visible={false}
        message="Item deleted"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    expect(toJSON()).toBeNull();
  });

  it('renders message and undo button when visible', async () => {
    renderWithTheme(
      <UndoToast
        visible={true}
        message="Stop removed"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Stop removed')).toBeTruthy();
    });
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  it('calls onUndo when undo button is pressed', async () => {
    renderWithTheme(
      <UndoToast
        visible={true}
        message="Stop removed"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Undo')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('Undo'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses after 3 seconds', async () => {
    renderWithTheme(
      <UndoToast
        visible={true}
        message="Item deleted"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    // Wait for component to mount and effect to fire
    await waitFor(() => {
      expect(screen.getByText('Item deleted')).toBeTruthy();
    });

    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has correct accessibility label', async () => {
    renderWithTheme(
      <UndoToast
        visible={true}
        message="Day removed"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Day removed. Tap undo to restore.')).toBeTruthy();
    });
  });

  it('has accessibilityRole="alert"', async () => {
    renderWithTheme(
      <UndoToast
        visible={true}
        message="Deleted"
        onUndo={onUndo}
        onDismiss={onDismiss}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Deleted')).toBeTruthy();
    });

    const container = screen.getByLabelText('Deleted. Tap undo to restore.');
    expect(container.props.accessibilityRole).toBe('alert');
  });
});
