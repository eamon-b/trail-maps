import React, { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface Props {
  children: ReactNode;
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
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
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Map unavailable</Text>
          <Text style={styles.message}>
            The map encountered an error. This can happen with large tile sets or corrupted data.
          </Text>
          <Pressable
            onPress={this.handleRetry}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Retry loading the map"
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
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
    backgroundColor: '#f5f5f5',
  },
  title: {
    ...typography.titleLarge,
    color: '#333',
    marginBottom: spacing.sm,
  },
  message: {
    ...typography.body,
    color: '#666',
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  retryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: '#4CAF50',
    borderRadius: 8,
  },
  retryText: {
    ...typography.body,
    color: '#fff',
    fontWeight: '600',
  },
});
