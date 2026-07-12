import React, { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface Props {
  children: ReactNode;
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
}

/**
 * Themed fallback UI. Split into a function component so it can consume the
 * theme via useTheme — the error boundary itself must stay a class component.
 */
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

/**
 * Error boundary that catches crashes in the MapLibre map component.
 * Displays a fallback UI instead of crashing the entire app.
 */
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
