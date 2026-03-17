// =============================================================================
// Login screen — email + password, link to register
// =============================================================================

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';

export default function LoginScreen({ navigation }: any) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

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
    <View style={styles.container}>
      <Text style={styles.title}>PeerZero</Text>
      <Text style={styles.subtitle}>Train AI that thinks for itself</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.text.tertiary}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.text.tertiary}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />

      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Signing in...' : 'Sign In'}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate('Register')}>
        <Text style={styles.link}>Don't have an account? Register</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, justifyContent: 'center', padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: '700', color: colors.accent.primary, textAlign: 'center', marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center', marginBottom: spacing.xxl },
  input: {
    backgroundColor: colors.bg.card, color: colors.text.primary, padding: spacing.md,
    borderRadius: borderRadius.md, marginBottom: spacing.md, fontSize: fontSize.md,
    borderWidth: 1, borderColor: colors.border,
  },
  button: {
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.sm,
  },
  buttonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  link: { color: colors.accent.secondary, textAlign: 'center', marginTop: spacing.lg, fontSize: fontSize.md },
});
