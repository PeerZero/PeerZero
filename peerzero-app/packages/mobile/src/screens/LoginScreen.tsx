// =============================================================================
// Login screen — email + password, link to register
// =============================================================================

import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  KeyboardAvoidingView, ScrollView, TouchableWithoutFeedback, Keyboard, Platform,
  ActivityIndicator,
} from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';

export default function LoginScreen({ navigation }: any) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<TextInputType>(null);

  const handleLogin = async () => {
    if (!email || !password) return;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: any) {
      // Show user-safe message — avoid leaking internal paths or stack traces
      const msg = err?.message || 'Something went wrong';
      const safeMsg = msg.startsWith('HTTP ') || msg.includes('/') || msg.includes('\\')
        ? 'Unable to sign in. Please check your credentials and try again.'
        : msg;
      Alert.alert('Login Failed', safeMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand hero */}
          <View style={styles.hero}>
            <View style={styles.logoContainer}>
              <View style={styles.logoGlow} />
              <Text style={styles.logoText}>P0</Text>
            </View>
            <Text style={styles.title}>PeerZero</Text>
            <Text style={styles.subtitle}>Train AI that thinks for itself</Text>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.text.tertiary}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            blurOnSubmit={false}
            accessibilityLabel="Email"
            accessibilityRole="text"
          />
          <TextInput
            ref={passwordRef}
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.text.tertiary}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            returnKeyType="go"
            onSubmitEditing={handleLogin}
            accessibilityLabel="Password"
            accessibilityRole="text"
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Sign In"
            accessibilityState={{ disabled: loading }}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => navigation.navigate('Register')} activeOpacity={0.7} accessibilityRole="link" accessibilityLabel="Don't have an account? Register">
            <Text style={styles.link}>Don't have an account? Register</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => Alert.alert('Reset Password', 'Enter your email above and contact support to reset your password.')}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Forgot password?"
          >
            <Text style={styles.forgotLink}>Forgot password?</Text>
          </TouchableOpacity>
        </ScrollView>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg.primary },
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  buttonDisabled: { opacity: 0.7 },
  hero: { alignItems: 'center', marginBottom: spacing.xxl },
  logoContainer: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: colors.accent.primary + '20',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: spacing.lg,
  },
  logoGlow: {
    position: 'absolute', width: 100, height: 100, borderRadius: 50,
    backgroundColor: colors.accent.primary + '08',
  },
  logoText: {
    fontSize: 32, fontWeight: '900', color: colors.accent.primary,
    letterSpacing: -1,
  },
  title: { fontSize: fontSize.title, fontWeight: '700', color: colors.text.primary, textAlign: 'center', marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center' },
  input: {
    backgroundColor: colors.bg.card, color: colors.text.primary, padding: spacing.md,
    borderRadius: borderRadius.md, marginBottom: spacing.md, fontSize: fontSize.md,
    borderWidth: 1, borderColor: colors.border,
  },
  button: {
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.sm,
    // Subtle shadow for depth
    shadowColor: colors.accent.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  buttonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  link: { color: colors.accent.secondary, textAlign: 'center', marginTop: spacing.lg, fontSize: fontSize.md },
  forgotLink: { color: colors.text.tertiary, textAlign: 'center', marginTop: spacing.md, fontSize: fontSize.sm },
});
