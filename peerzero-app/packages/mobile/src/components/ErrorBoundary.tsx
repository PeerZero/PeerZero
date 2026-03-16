// =============================================================================
// ErrorBoundary — catches unhandled JS errors and shows a fallback UI
// instead of crashing the entire app. Wraps the root component tree.
// =============================================================================

import React, { Component, ErrorInfo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console in dev; in production this could report to a crash service
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            The app ran into an unexpected error. You can try again or restart the app.
          </Text>
          {__DEV__ && this.state.error && (
            <Text style={styles.errorDetail} selectable>
              {this.state.error.toString()}
            </Text>
          )}
          <TouchableOpacity
            style={styles.button}
            onPress={this.handleReset}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.accent.error,
    marginBottom: spacing.md,
  },
  message: {
    fontSize: fontSize.md,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  errorDetail: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    fontFamily: 'monospace',
    backgroundColor: colors.bg.card,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    width: '100%',
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  button: {
    backgroundColor: colors.accent.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
  },
  buttonText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
