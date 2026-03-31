// =============================================================================
// Register screen — email, password, display name, age gate (COPPA)
// =============================================================================

import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
  TouchableWithoutFeedback, Keyboard, KeyboardAvoidingView, ScrollView,
  Platform, ActivityIndicator,
} from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useAuth } from '../../hooks/useAuth';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import PeerZeroLogo from '../../components/PeerZeroLogo';
import type { RegisterScreenProps } from '../../navigation/types';

type AgeGroup = 'child' | 'teen' | 'adult';

const AGE_OPTIONS: { label: string; value: AgeGroup }[] = [
  { label: 'Under 13', value: 'child' },
  { label: '13 - 17', value: 'teen' },
  { label: '18+', value: 'adult' },
];

export default function RegisterScreen({ navigation }: RegisterScreenProps) {
  const { register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ageGroup, setAgeGroup] = useState<AgeGroup | null>(null);
  const [parentEmail, setParentEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<TextInputType>(null);
  const passwordRef = useRef<TextInputType>(null);
  const confirmRef = useRef<TextInputType>(null);
  const parentEmailRef = useRef<TextInputType>(null);

  const handleRegister = async () => {
    if (!email || !password) return;
    if (!ageGroup) {
      Alert.alert('Age Required', 'Please select your age group.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }
    if (ageGroup === 'child' && !parentEmail) {
      Alert.alert('Parent Email Required', 'A parent or guardian email is required for users under 13.');
      return;
    }
    if (ageGroup === 'child' && !emailRegex.test(parentEmail)) {
      Alert.alert('Invalid Parent Email', 'Please enter a valid parent email address.');
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
      await register(email, password, displayName || undefined, ageGroup, ageGroup === 'child' ? parentEmail : undefined);
      // If we get here without user being set, consent is pending (child account)
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('consent')) {
        Alert.alert(
          'Almost There!',
          "We've sent an email to your parent or guardian. You can sign in once they approve.",
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
        return;
      }
      Alert.alert('Registration Failed', err instanceof Error ? err.message : 'Something went wrong');
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
            <View style={styles.hero}>
              <PeerZeroLogo size={80} />
              <Text style={styles.title}>Join PeerZero</Text>
              <Text style={styles.subtitle}>Create your account to start training bots</Text>
            </View>

            {/* Age gate — neutral prompt (COPPA) */}
            <Text style={styles.fieldLabel}>How old are you?</Text>
            <View style={styles.ageRow}>
              {AGE_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.ageOption, ageGroup === opt.value && styles.ageOptionSelected]}
                  onPress={() => setAgeGroup(opt.value)}
                  activeOpacity={0.7}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: ageGroup === opt.value }}
                  accessibilityLabel={opt.label}
                >
                  <Text style={[styles.ageOptionText, ageGroup === opt.value && styles.ageOptionTextSelected]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {ageGroup === 'child' && (
              <>
                <Text style={styles.parentNotice}>
                  A parent or guardian must give permission for you to use PeerZero.
                </Text>
                <TextInput
                  ref={parentEmailRef}
                  style={styles.input}
                  placeholder="Parent or Guardian Email"
                  placeholderTextColor={colors.text.tertiary}
                  value={parentEmail}
                  onChangeText={setParentEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                  blurOnSubmit={false}
                  accessibilityLabel="Parent or Guardian Email"
                  accessibilityRole="text"
                />
              </>
            )}

            <TextInput
              style={styles.input}
              placeholder="Display Name (optional)"
              placeholderTextColor={colors.text.tertiary}
              value={displayName}
              onChangeText={setDisplayName}
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
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
              accessibilityLabel="Confirm Password"
              accessibilityRole="text"
            />

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleRegister}
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
  hero: { alignItems: 'center', marginBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: '700', color: colors.text.primary, textAlign: 'center', marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center' },
  fieldLabel: {
    fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  ageRow: {
    flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md,
  },
  ageOption: {
    flex: 1, paddingVertical: spacing.sm, borderRadius: borderRadius.md,
    backgroundColor: colors.bg.card, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center',
  },
  ageOptionSelected: {
    borderColor: colors.accent.primary, backgroundColor: colors.accent.primary + '15',
  },
  ageOptionText: {
    fontSize: fontSize.md, fontWeight: '600', color: colors.text.tertiary,
  },
  ageOptionTextSelected: {
    color: colors.accent.primary,
  },
  parentNotice: {
    fontSize: fontSize.sm, color: colors.accent.warning || colors.text.secondary,
    marginBottom: spacing.md, lineHeight: 20,
  },
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
