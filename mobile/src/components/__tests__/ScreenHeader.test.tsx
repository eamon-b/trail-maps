import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { ScreenHeader } from '../ScreenHeader';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('ScreenHeader', () => {
  it('renders the title as a header', async () => {
    renderWithTheme(<ScreenHeader title="Settings" />);
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
    expect(screen.getByText('Settings').props.accessibilityRole).toBe('header');
  });

  it('renders a back button that calls onBack', async () => {
    const onBack = jest.fn();
    renderWithTheme(<ScreenHeader title="Plan" onBack={onBack} />);
    await waitFor(() => expect(screen.getByLabelText('Go back')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Go back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('supports a custom back label (e.g. Cancel for modals)', async () => {
    const onBack = jest.fn();
    renderWithTheme(<ScreenHeader title="Import" onBack={onBack} backLabel="Cancel" />);
    await waitFor(() => expect(screen.getByLabelText('Cancel')).toBeTruthy());
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('hides the back button when onBack is omitted', async () => {
    renderWithTheme(<ScreenHeader title="Plain" />);
    await waitFor(() => expect(screen.getByText('Plain')).toBeTruthy());
    expect(screen.queryByLabelText('Go back')).toBeNull();
  });

  it('renders a right action and respects disabled', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <ScreenHeader
        title="Picker"
        rightAction={{ label: 'Apply', onPress, disabled: true }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Apply')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Apply'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders arbitrary rightSlot content', async () => {
    renderWithTheme(
      <ScreenHeader title="Custom" rightSlot={<Text>Slot</Text>} />,
    );
    await waitFor(() => expect(screen.getByText('Slot')).toBeTruthy());
  });

  it('clamps title font scaling at 1.4x', async () => {
    renderWithTheme(<ScreenHeader title="Clamped" />);
    await waitFor(() => expect(screen.getByText('Clamped')).toBeTruthy());
    expect(screen.getByText('Clamped').props.maxFontSizeMultiplier).toBe(1.4);
  });
});
