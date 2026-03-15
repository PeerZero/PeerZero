// =============================================================================
// Settings screen — API keys (BYOK), account, logout
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, TextInput, Switch, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../hooks/useAuth';
import { apiKeys as keysApi, notifications as notifApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { LLM_PROVIDERS, NOTIFICATION_TYPES, NOTIFICATION_LABELS, DEFAULT_NOTIFICATION_PREFS } from '@peerzero/shared';
import type { ApiKeyInfo, NotificationType } from '@peerzero/shared';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newProvider, setNewProvider] = useState<'anthropic' | 'openai'>('anthropic');

  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(DEFAULT_NOTIFICATION_PREFS);

  const loadNotifPrefs = useCallback(async () => {
    try {
      const result = await notifApi.getPreferences() as { preferences: Record<string, boolean> };
      setNotifPrefs({ ...DEFAULT_NOTIFICATION_PREFS, ...result.preferences });
    } catch {
      // Use defaults if fetch fails
    }
  }, []);

  const toggleNotifPref = async (type: string, value: boolean) => {
    const updated = { ...notifPrefs, [type]: value };
    setNotifPrefs(updated);
    try {
      await notifApi.updatePreferences({ [type]: value });
    } catch {
      // Revert on failure
      setNotifPrefs(notifPrefs);
    }
  };

  const loadKeys = useCallback(async () => {
    try {
      const data = await keysApi.list() as ApiKeyInfo[];
      setKeys(data);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load API keys');
    }
  }, []);

  useFocusEffect(useCallback(() => { loadKeys(); loadNotifPrefs(); }, [loadKeys, loadNotifPrefs]));

  const handleAddKey = async () => {
    if (!newLabel || !newKey) return;

    // Basic format validation
    if (newProvider === 'anthropic' && !newKey.startsWith('sk-ant-')) {
      Alert.alert('Invalid Key', 'Anthropic API keys typically start with "sk-ant-"');
      return;
    }
    if (newProvider === 'openai' && !newKey.startsWith('sk-')) {
      Alert.alert('Invalid Key', 'OpenAI API keys typically start with "sk-"');
      return;
    }

    try {
      await keysApi.add(newProvider, newLabel, newKey);
      setNewKey('');  // Clear immediately after submission
      setNewLabel('');
      setShowAddKey(false);
      await loadKeys();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to add key');
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
    <ScrollView style={styles.container}>
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

      {/* Notification Preferences */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        {NOTIFICATION_TYPES.map(type => {
          const label = NOTIFICATION_LABELS[type];
          return (
            <View key={type} style={styles.notifRow}>
              <View style={styles.notifInfo}>
                <Text style={styles.notifTitle}>{label.title}</Text>
                <Text style={styles.notifDesc}>{label.description}</Text>
              </View>
              <Switch
                value={notifPrefs[type] ?? DEFAULT_NOTIFICATION_PREFS[type]}
                onValueChange={(val) => toggleNotifPref(type, val)}
                trackColor={{ false: colors.bg.elevated, true: colors.accent.primary + '60' }}
                thumbColor={notifPrefs[type] ? colors.accent.primary : colors.text.tertiary}
              />
            </View>
          );
        })}
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={logout}>
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
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
  notifRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.xs,
  },
  notifInfo: { flex: 1, marginRight: spacing.md },
  notifTitle: { fontSize: fontSize.md, fontWeight: '500', color: colors.text.primary },
  notifDesc: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  logoutButton: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.accent.error + '40',
  },
  logoutText: { fontSize: fontSize.md, color: colors.accent.error, fontWeight: '600' },
});
