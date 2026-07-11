import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { ThemeProvider } from '../../theme';
import { PressableRow } from '../PressableRow';
import { touchTarget } from '../../tokens/spacing';

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

function flattenedStyle(node: { props: { style: unknown } }): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style as Parameters<typeof StyleSheet.flatten>[0]) as Record<string, unknown>;
}

describe('PressableRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enforces the 44pt minimum touch target by default', async () => {
    renderWithTheme(
      <PressableRow onPress={() => {}} accessibilityLabel="Row">
        <Text>Row</Text>
      </PressableRow>,
    );
    await waitFor(() => expect(screen.getByLabelText('Row')).toBeTruthy());
    const style = flattenedStyle(screen.getByLabelText('Row'));
    expect(style.minHeight).toBe(touchTarget.min);
  });

  it('uses the 56pt field tier when size="field"', async () => {
    renderWithTheme(
      <PressableRow onPress={() => {}} size="field" accessibilityLabel="Field row">
        <Text>Row</Text>
      </PressableRow>,
    );
    await waitFor(() => expect(screen.getByLabelText('Field row')).toBeTruthy());
    const style = flattenedStyle(screen.getByLabelText('Field row'));
    expect(style.minHeight).toBe(touchTarget.field);
  });

  it('fires the selection haptic and onPress by default', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <PressableRow onPress={onPress} accessibilityLabel="Tap me">
        <Text>Tap me</Text>
      </PressableRow>,
    );
    await waitFor(() => expect(screen.getByLabelText('Tap me')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Tap me'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('suppresses haptics with haptic="none"', async () => {
    const onPress = jest.fn();
    renderWithTheme(
      <PressableRow onPress={onPress} haptic="none" accessibilityLabel="Silent">
        <Text>Silent</Text>
      </PressableRow>,
    );
    await waitFor(() => expect(screen.getByLabelText('Silent')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Silent'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('defaults accessibilityRole to button and reflects disabled state', async () => {
    renderWithTheme(
      <PressableRow onPress={() => {}} disabled accessibilityLabel="Disabled row">
        <Text>Disabled</Text>
      </PressableRow>,
    );
    await waitFor(() => expect(screen.getByLabelText('Disabled row')).toBeTruthy());
    const node = screen.getByLabelText('Disabled row');
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityState).toMatchObject({ disabled: true });
  });
});
