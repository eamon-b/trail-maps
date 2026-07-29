/**
 * Error boundary around the MapLibre map. A native map crash (bad tile set,
 * corrupt style, renderer teardown) is caught here and replaced with a themed
 * retry surface instead of taking down the whole guide.
 *
 * Ported from the old app's MapErrorBoundary; only the token import paths
 * change for Tracknotes' `src/tokens` layout.
 */

import React, { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';

interface Props {
  children: ReactNode;
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
}

/** Split out so it can consume the theme via a hook; the boundary itself must
 * stay a class component. */
function MapErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Map unavailable</Text>
      <Text style={[styles.message, { color: colors.textSecondary }]}>
        The map encountered an error. This can happen with large tile sets or corrupted data.
      </Text>
      <Pressable
        onPress={onRetry}
        style={[styles.retryButton, { backgroundColor: colors.accent }]}
        accessibilityRole="button"
        accessibilityLabel="Retry loading the map"
      >
        <Text style={[styles.retryText, { color: colors.textInverse }]}>Retry</Text>
      </Pressable>
    </View>
  );
}

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  handleRetry = () => {
    this.setState({ hasError: false });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.hasError) {
      return <MapErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  message: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  retryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  retryText: {
    ...typography.body,
    fontWeight: '600',
  },
});
