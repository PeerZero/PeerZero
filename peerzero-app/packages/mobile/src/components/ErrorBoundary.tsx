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
          <View style={styles.iconContainer}>
            <Text style={styles.icon}>🤖</Text>
            <Text style={styles.iconSub}>💫</Text>
          </View>
          <Text style={styles.title}>Oops! Something broke</Text>
          <Text style={styles.message}>
            Don't worry — your bots and their memories are safe. This was just a display glitch.
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
            activeOpacity={0.8}
          >
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>If this keeps happening, try restarting the app</Text>
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
  iconContainer: {
    marginBottom: spacing.lg,
    alignItems: 'center',
    position: 'relative',
  },
  icon: {
    fontSize: 64,
  },
  iconSub: {
    fontSize: 24,
    position: 'absolute',
    bottom: -4,
    right: -8,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.text.primary,
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
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  hint: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
});
