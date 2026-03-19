// =============================================================================
// Forgot Password screen — two-step: request code, then reset password
// =============================================================================

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  TouchableWithoutFeedback, Keyboard, KeyboardAvoidingView, ScrollView,
  Platform, ActivityIndicator,
} from 'react-native';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { auth } from '../services/api';
import type { ForgotPasswordScreenProps } from '../navigation/types';

export default function ForgotPasswordScreen({ navigation }: ForgotPasswordScreenProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSendCode = async () => {
    if (!email) {
      Alert.alert('Error', 'Please enter your email address.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    setLoading(true);
    try {
      await auth.forgotPassword(email);
      Alert.alert('Code Sent', 'If an account exists with that email, a reset code has been sent.');
      setStep(2);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!code || !newPassword || !confirmPassword) {
      Alert.alert('Error', 'Please fill in all fields.');
      return;
    }
    if (code.length !== 6) {
      Alert.alert('Error', 'Please enter the 6-digit code.');
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert('Error', 'Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await auth.resetPassword(email, code, newPassword);
      navigation.navigate('Login', { message: 'Password reset successfully. Please sign in.' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Reset Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.inner}>
            <View style={styles.header}>
              <Text style={styles.title}>Reset Password</Text>
              <Text style={styles.subtitle}>
                {step === 1
                  ? 'Enter your email to receive a reset code.'
                  : 'Enter the 6-digit code and your new password.'}
              </Text>
            </View>

            {step === 1 ? (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor={colors.text.tertiary}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  returnKeyType="go"
                  onSubmitEditing={handleSendCode}
                  accessibilityLabel="Email"
                  accessibilityRole="text"
                />

                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handleSendCode}
                  disabled={loading}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Send Reset Code"
                  accessibilityState={{ disabled: loading }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Send Reset Code</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  placeholder="6-digit code"
                  placeholderTextColor={colors.text.tertiary}
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="next"
                  accessibilityLabel="Reset code"
                  accessibilityRole="text"
                />

                <TextInput
                  style={styles.input}
                  placeholder="New password"
                  placeholderTextColor={colors.text.tertiary}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry
                  returnKeyType="next"
                  accessibilityLabel="New password"
                  accessibilityRole="text"
                />

                <TextInput
                  style={styles.input}
                  placeholder="Confirm new password"
                  placeholderTextColor={colors.text.tertiary}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  returnKeyType="go"
                  onSubmitEditing={handleResetPassword}
                  accessibilityLabel="Confirm new password"
                  accessibilityRole="text"
                />

                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handleResetPassword}
                  disabled={loading}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Reset Password"
                  accessibilityState={{ disabled: loading }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Reset Password</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              onPress={() => navigation.navigate('Login')}
              activeOpacity={0.7}
              accessibilityRole="link"
              accessibilityLabel="Back to Sign In"
            >
              <Text style={styles.link}>Back to Sign In</Text>
            </TouchableOpacity>
          </View>
        </TouchableWithoutFeedback>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg.primary },
  scrollContent: { flexGrow: 1, justifyContent: 'center' },
  inner: { padding: spacing.xl, paddingBottom: spacing.xxl },
  header: { alignItems: 'center', marginBottom: spacing.xxl },
  title: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.text.primary, textAlign: 'center', marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center' },
  input: {
    backgroundColor: colors.bg.card, color: colors.text.primary, padding: spacing.md,
    borderRadius: borderRadius.md, marginBottom: spacing.md, fontSize: fontSize.md,
    borderWidth: 1, borderColor: colors.border,
  },
  button: {
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.sm,
    shadowColor: colors.accent.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  link: { color: colors.accent.secondary, textAlign: 'center', marginTop: spacing.lg, fontSize: fontSize.md },
});
