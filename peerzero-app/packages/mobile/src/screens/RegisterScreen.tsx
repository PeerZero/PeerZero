// =============================================================================
// Register screen — email, password, display name
// =============================================================================

import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  ScrollView, Platform, Keyboard,
  ActivityIndicator, useWindowDimensions,
} from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { RegisterScreenProps } from '../navigation/types';

export default function RegisterScreen({ navigation }: RegisterScreenProps) {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInputType>(null);
  const passwordRef = useRef<TextInputType>(null);
  const confirmRef = useRef<TextInputType>(null);
  const scrollRef = useRef<ScrollView>(null);

  const handleRegister = async () => {
    if (!email || !password) return;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Weak Password', 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await register(email, password, displayName || undefined);
    } catch (err: unknown) {
      Alert.alert('Registration Failed', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const scrollToBottom = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
  };

  return (
    <View style={styles.flex}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.hero}>
          <Text style={styles.logoText}>P0</Text>
          <Text style={styles.title}>Join PeerZero</Text>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Display Name (optional)"
          placeholderTextColor={colors.text.tertiary}
          value={displayName}
          onChangeText={setDisplayName}
          returnKeyType="next"
          onSubmitEditing={() => emailRef.current?.focus()}
          onFocus={scrollToBottom}
          blurOnSubmit={false}
          accessibilityLabel="Display Name (optional)"
          accessibilityRole="text"
        />
        <TextInput
          ref={emailRef}
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.text.tertiary}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          onFocus={scrollToBottom}
          blurOnSubmit={false}
          accessibilityLabel="Email"
          accessibilityRole="text"
        />
        <TextInput
          ref={passwordRef}
          style={styles.input}
          placeholder="Password (min 8 characters)"
          placeholderTextColor={colors.text.tertiary}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="next"
          onSubmitEditing={() => confirmRef.current?.focus()}
          onFocus={scrollToBottom}
          blurOnSubmit={false}
          accessibilityLabel="Password, minimum 8 characters"
          accessibilityRole="text"
        />
        <TextInput
          ref={confirmRef}
          style={styles.input}
          placeholder="Confirm Password"
          placeholderTextColor={colors.text.tertiary}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={handleRegister}
          onFocus={scrollToBottom}
          accessibilityLabel="Confirm Password"
          accessibilityRole="text"
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={() => { Keyboard.dismiss(); handleRegister(); }}
          disabled={loading}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Create Account"
          accessibilityState={{ disabled: loading }}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Create Account</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.7} accessibilityRole="link" accessibilityLabel="Already have an account? Sign In">
          <Text style={styles.link}>Already have an account? Sign In</Text>
        </TouchableOpacity>

        <View style={styles.keyboardSpacer} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg.primary },
  container: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.lg },
  logoText: {
    fontSize: 28, fontWeight: '900', color: colors.accent.primary,
    letterSpacing: -1,
  },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text.primary, textAlign: 'center', marginTop: spacing.xs },
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
  keyboardSpacer: { height: 350 },
});
