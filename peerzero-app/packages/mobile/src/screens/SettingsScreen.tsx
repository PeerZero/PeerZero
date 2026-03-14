// =============================================================================
// Settings screen — API keys (BYOK), account, logout
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../hooks/useAuth';
import { apiKeys as keysApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ApiKeyInfo } from '@peerzero/shared';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newProvider, setNewProvider] = useState<'anthropic' | 'openai'>('anthropic');

  const loadKeys = useCallback(async () => {
    try {
      const data = await keysApi.list() as ApiKeyInfo[];
      setKeys(data);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load API keys');
    }
  }, []);

  useFocusEffect(useCallback(() => { loadKeys(); }, [loadKeys]));

  const handleAddKey = async () => {
    if (!newLabel || !newKey) return;
    try {
      await keysApi.add(newProvider, newLabel, newKey);
      setShowAddKey(false);
      setNewLabel('');
      setNewKey('');
      await loadKeys();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleDeleteKey = (id: string, label: string) => {
    Alert.alert('Delete Key', `Remove "${label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await keysApi.delete(id);
            await loadKeys();
          } catch (err: any) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      {/* Account section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.email}>{user?.email}</Text>
        <Text style={styles.info}>
          Bots: {user?.entitlements?.bots_used || 0} / {user?.entitlements?.bot_slots || 1}
        </Text>
      </View>

      {/* API Keys section */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>API Keys (BYOK)</Text>
          <TouchableOpacity onPress={() => setShowAddKey(!showAddKey)}>
            <Text style={styles.addButton}>{showAddKey ? 'Cancel' : '+ Add Key'}</Text>
          </TouchableOpacity>
        </View>

        {showAddKey && (
          <View style={styles.addForm}>
            <View style={styles.providerRow}>
              <TouchableOpacity
                style={[styles.providerPill, newProvider === 'anthropic' && styles.providerActive]}
                onPress={() => setNewProvider('anthropic')}
              >
                <Text style={[styles.providerText, newProvider === 'anthropic' && styles.providerTextActive]}>Anthropic</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.providerPill, newProvider === 'openai' && styles.providerActive]}
                onPress={() => setNewProvider('openai')}
              >
                <Text style={[styles.providerText, newProvider === 'openai' && styles.providerTextActive]}>OpenAI</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={styles.input} placeholder="Label (e.g. 'My Opus Key')" placeholderTextColor={colors.text.tertiary} value={newLabel} onChangeText={setNewLabel} />
            <TextInput style={styles.input} placeholder="API Key" placeholderTextColor={colors.text.tertiary} value={newKey} onChangeText={setNewKey} secureTextEntry />
            <TouchableOpacity style={styles.saveButton} onPress={handleAddKey}>
              <Text style={styles.saveButtonText}>Save Key</Text>
            </TouchableOpacity>
          </View>
        )}

        {keys.map(k => (
          <View key={k.id} style={styles.keyCard}>
            <View style={styles.keyInfo}>
              <Text style={styles.keyLabel}>{k.label}</Text>
              <Text style={styles.keyFingerprint}>{k.provider} — {k.key_fingerprint}</Text>
            </View>
            <TouchableOpacity onPress={() => handleDeleteKey(k.id, k.label)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          </View>
        ))}

        {keys.length === 0 && !showAddKey && (
          <Text style={styles.hint}>Add your own API key to power your bots. You pay your provider directly.</Text>
        )}
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={logout}>
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, padding: spacing.md },
  section: { marginBottom: spacing.xl },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary, marginBottom: spacing.sm },
  email: { fontSize: fontSize.md, color: colors.accent.secondary },
  info: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs },
  addButton: { fontSize: fontSize.md, color: colors.accent.primary, fontWeight: '600' },
  addForm: { backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md, marginBottom: spacing.md },
  providerRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  providerPill: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderRadius: borderRadius.full, borderWidth: 1, borderColor: colors.border,
  },
  providerActive: { backgroundColor: colors.accent.primary, borderColor: colors.accent.primary },
  providerText: { fontSize: fontSize.sm, color: colors.text.secondary },
  providerTextActive: { color: '#fff' },
  input: {
    backgroundColor: colors.bg.secondary, color: colors.text.primary, padding: spacing.sm,
    borderRadius: borderRadius.sm, marginBottom: spacing.sm, fontSize: fontSize.md,
  },
  saveButton: { backgroundColor: colors.accent.primary, padding: spacing.sm, borderRadius: borderRadius.sm, alignItems: 'center' },
  saveButtonText: { color: '#fff', fontWeight: '600' },
  keyCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg.card,
    padding: spacing.md, borderRadius: borderRadius.md, marginBottom: spacing.sm,
  },
  keyInfo: { flex: 1 },
  keyLabel: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  keyFingerprint: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  deleteText: { fontSize: fontSize.sm, color: colors.accent.error },
  hint: { fontSize: fontSize.sm, color: colors.text.tertiary, fontStyle: 'italic' },
  logoutButton: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.accent.error + '40',
  },
  logoutText: { fontSize: fontSize.md, color: colors.accent.error, fontWeight: '600' },
});
