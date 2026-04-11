// =============================================================================
// Settings screen — profile, API keys (BYOK), notifications, account management
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput, Switch, ScrollView, Platform, Linking, KeyboardAvoidingView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../../hooks/useAuth';
import { apiKeys as keysApi, notifications as notifApi, auth as authApi, widgets as widgetsApi, bots as botsApi } from '../../services/api';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import TutorialTip from '../../components/TutorialTip';
import { useToast } from '../../components/Toast';
import * as Haptics from 'expo-haptics';
import { useTutorial } from '../../hooks/useTutorial';
import { NOTIFICATION_TYPES, NOTIFICATION_LABELS, DEFAULT_NOTIFICATION_PREFS } from '@peerzero/shared';
import type { ApiKeyInfo, BotSummary } from '@peerzero/shared';

export default function SettingsScreen() {
  const { user, logout, refreshUser } = useAuth();
  const { showToast } = useToast();
  const { resetTips, skippedAll } = useTutorial();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newProvider, setNewProvider] = useState<'anthropic' | 'openai'>('anthropic');

  // Profile editing
  const [editingName, setEditingName] = useState(false);
  const [displayName, setDisplayName] = useState('');

  // Password change
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(DEFAULT_NOTIFICATION_PREFS);

  // Widget settings
  const [widgetToken, setWidgetToken] = useState<string | null>(null);
  const [widgetTokenCopied, setWidgetTokenCopied] = useState(false);
  const [widgetBots, setWidgetBots] = useState<BotSummary[]>([]);
  const [selectedWidgetBot, setSelectedWidgetBot] = useState<string | null>(null);
  const [widgetEnabled, setWidgetEnabled] = useState(false);

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
      setNotifPrefs(notifPrefs);
    }
  };

  const loadKeys = useCallback(async () => {
    try {
      const data = await keysApi.list() as ApiKeyInfo[];
      setKeys(data);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load API keys');
    }
  }, []);

  const loadWidgetBots = useCallback(async () => {
    try {
      const response = await botsApi.list() as { data: BotSummary[] };
      setWidgetBots(response.data);
    } catch { /* ignore */ }
  }, []);

  const handleEnableWidget = async () => {
    try {
      const result = await widgetsApi.generateToken();
      setWidgetToken(result.widget_token);
      setWidgetEnabled(true);
      // On a real device, the token would be written to shared keychain (iOS)
      // or EncryptedSharedPreferences (Android) via a native module.
      // For now, we show it for manual setup.
      Alert.alert(
        'Widget Enabled',
        Platform.OS === 'ios'
          ? 'Add the PeerZero widget from your home screen. Long-press your home screen and tap the + button.'
          : 'Add the PeerZero widget from your home screen, or enable the floating overlay in your system settings.',
      );
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to enable widget');
    }
  };

  const handleDisableWidget = async () => {
    Alert.alert('Disable Widget', 'This will revoke the widget token. Your widgets will stop updating.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disable', style: 'destructive',
        onPress: async () => {
          try {
            await widgetsApi.revokeToken();
            setWidgetToken(null);
            setWidgetEnabled(false);
          } catch (err: unknown) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Failed to disable widget');
          }
        },
      },
    ]);
  };

  const handleOpenOverlaySettings = () => {
    if (Platform.OS === 'android') {
      Linking.openSettings();
    }
  };

  useFocusEffect(useCallback(() => {
    loadKeys();
    loadNotifPrefs();
    loadWidgetBots();
    if (user?.display_name) setDisplayName(user.display_name);
  }, [loadKeys, loadNotifPrefs, loadWidgetBots, user?.display_name]));

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
      setNewKey('');
      setNewLabel('');
      setShowAddKey(false);
      showToast('API key added', 'success');
      await loadKeys();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to add key');
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
            showToast('API key deleted', 'success');
            await loadKeys();
          } catch (err: unknown) {
            Alert.alert('Error', err instanceof Error ? err.message : 'Something went wrong');
          }
        },
      },
    ]);
  };

  const handleSaveDisplayName = async () => {
    if (!displayName.trim()) {
      Alert.alert('Error', 'Display name cannot be empty');
      return;
    }
    try {
      await authApi.updateProfile({ display_name: displayName.trim() });
      setEditingName(false);
      showToast('Display name updated', 'success');
      if (refreshUser) refreshUser();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to update profile');
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) {
      Alert.alert('Error', 'All password fields are required');
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert('Error', 'New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'New passwords do not match');
      return;
    }
    try {
      await authApi.changePassword({ current_password: currentPassword, new_password: newPassword });
      showToast('Password changed. Please log in again.', 'success');
      setShowPasswordChange(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      logout();
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to change password');
    }
  };

  const handleDeleteAccount = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account, all bots, all memory, and all activity. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete My Account', style: 'destructive',
          onPress: () => {
            // Double confirmation for destructive operation
            Alert.alert(
              'Are you absolutely sure?',
              'Type "DELETE" in your mind and tap confirm. All data will be lost forever.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Confirm Delete', style: 'destructive',
                  onPress: async () => {
                    try {
                      await authApi.deleteAccount();
                      logout();
                    } catch (err: unknown) {
                      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete account');
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <TutorialTip
        tipId="settings_overview"
        title="Settings"
        message="Manage your API keys (BYOK), notification preferences, home screen widgets, and account details here."
      />
      {/* Account section */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionIcon}>👤</Text>
          <Text style={styles.sectionTitle}>Account</Text>
        </View>
        <Text style={styles.email}>{user?.email}</Text>

        {/* Display name editing */}
        <View style={styles.profileRow}>
          {editingName ? (
            <View style={styles.editNameRow}>
              <TextInput
                style={styles.nameInput}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Display name"
                placeholderTextColor={colors.text.tertiary}
                maxLength={100}
                autoFocus
                accessibilityLabel="Display name"
                accessibilityRole="text"
              />
              <TouchableOpacity onPress={handleSaveDisplayName} accessibilityRole="button" accessibilityLabel="Save display name">
                <Text style={styles.saveText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { setEditingName(false); setDisplayName(user?.display_name || ''); }} accessibilityRole="button" accessibilityLabel="Cancel editing">
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.editNameRow} onPress={() => setEditingName(true)} accessibilityRole="button" accessibilityLabel={`Edit display name, currently ${user?.display_name || 'not set'}`}>
              <Text style={styles.displayName}>{user?.display_name || 'No display name'}</Text>
              <Text style={styles.editText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.info}>
          Bots: {user?.entitlements?.bots_used || 0} / {user?.entitlements?.bot_slots || 1}
        </Text>
      </View>

      {/* Password change */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionIcon}>🔒</Text>
            <Text style={styles.sectionTitle}>Security</Text>
          </View>
          <TouchableOpacity onPress={() => setShowPasswordChange(!showPasswordChange)} accessibilityRole="button" accessibilityLabel={showPasswordChange ? 'Cancel password change' : 'Change Password'}>
            <Text style={styles.addButton}>{showPasswordChange ? 'Cancel' : 'Change Password'}</Text>
          </TouchableOpacity>
        </View>

        {showPasswordChange && (
          <View style={styles.addForm}>
            <TextInput
              style={styles.input}
              placeholder="Current password"
              placeholderTextColor={colors.text.tertiary}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
              accessibilityLabel="Current password"
              accessibilityRole="text"
            />
            <TextInput
              style={styles.input}
              placeholder="New password (min 8 chars)"
              placeholderTextColor={colors.text.tertiary}
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              accessibilityLabel="New password, minimum 8 characters"
              accessibilityRole="text"
            />
            <TextInput
              style={styles.input}
              placeholder="Confirm new password"
              placeholderTextColor={colors.text.tertiary}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              accessibilityLabel="Confirm new password"
              accessibilityRole="text"
            />
            <TouchableOpacity style={styles.saveButton} onPress={handleChangePassword} accessibilityRole="button" accessibilityLabel="Change Password">
              <Text style={styles.saveButtonText}>Change Password</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* API Keys section */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionIcon}>🔑</Text>
            <Text style={styles.sectionTitle}>API Keys (BYOK)</Text>
          </View>
          <TouchableOpacity onPress={() => setShowAddKey(!showAddKey)} accessibilityRole="button" accessibilityLabel={showAddKey ? 'Cancel adding key' : 'Add API Key'}>
            <Text style={styles.addButton}>{showAddKey ? 'Cancel' : '+ Add Key'}</Text>
          </TouchableOpacity>
        </View>

        {showAddKey && (
          <View style={styles.addForm}>
            <View style={styles.providerRow}>
              <TouchableOpacity
                style={[styles.providerPill, newProvider === 'anthropic' && styles.providerActive]}
                onPress={() => setNewProvider('anthropic')}
                accessibilityRole="radio"
                accessibilityLabel="Anthropic"
                accessibilityState={{ selected: newProvider === 'anthropic' }}
              >
                <Text style={[styles.providerText, newProvider === 'anthropic' && styles.providerTextActive]}>Anthropic</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.providerPill, newProvider === 'openai' && styles.providerActive]}
                onPress={() => setNewProvider('openai')}
                accessibilityRole="radio"
                accessibilityLabel="OpenAI"
                accessibilityState={{ selected: newProvider === 'openai' }}
              >
                <Text style={[styles.providerText, newProvider === 'openai' && styles.providerTextActive]}>OpenAI</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={styles.input} placeholder="Label (e.g. 'My Opus Key')" placeholderTextColor={colors.text.tertiary} value={newLabel} onChangeText={setNewLabel} accessibilityLabel="API key label" accessibilityRole="text" />
            <TextInput style={styles.input} placeholder="API Key" placeholderTextColor={colors.text.tertiary} value={newKey} onChangeText={setNewKey} secureTextEntry accessibilityLabel="API key value" accessibilityRole="text" />
            <TouchableOpacity style={styles.saveButton} onPress={handleAddKey} accessibilityRole="button" accessibilityLabel="Save Key">
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
            <TouchableOpacity onPress={() => handleDeleteKey(k.id, k.label)} accessibilityRole="button" accessibilityLabel={`Delete API key ${k.label}`}>
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
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionIcon}>🔔</Text>
          <Text style={styles.sectionTitle}>Notifications</Text>
        </View>
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
                accessibilityLabel={label.title}
                accessibilityRole="switch"
              />
            </View>
          );
        })}
      </View>

      {/* Widget Settings */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionIcon}>📱</Text>
          <Text style={styles.sectionTitle}>Home Screen Widget</Text>
        </View>
        <Text style={styles.hint}>
          {Platform.OS === 'ios'
            ? 'Show your bot on your home screen. See its status and what it\'s thinking at a glance.'
            : 'Show your bot on your home screen or as a floating overlay. See its status and what it\'s thinking at a glance.'}
        </Text>

        {!widgetEnabled ? (
          <TouchableOpacity style={styles.saveButton} onPress={handleEnableWidget} accessibilityRole="button" accessibilityLabel="Enable Widget">
            <Text style={styles.saveButtonText}>Enable Widget</Text>
          </TouchableOpacity>
        ) : (
          <View>
            <View style={[styles.keyCard, { borderColor: colors.accent.success + '40', borderWidth: 1 }]}>
              <View style={styles.keyInfo}>
                <Text style={[styles.keyLabel, { color: colors.accent.success }]}>Widget Active</Text>
                <Text style={styles.keyFingerprint}>
                  {Platform.OS === 'ios'
                    ? 'Long-press home screen → tap + → search PeerZero'
                    : 'Long-press home screen → Widgets → PeerZero'}
                </Text>
              </View>
            </View>

            {/* Bot selector for widget */}
            {widgetBots.length > 1 && (
              <View style={{ marginTop: spacing.sm }}>
                <Text style={[styles.hint, { marginBottom: spacing.xs }]}>Which bot to show:</Text>
                {widgetBots.map(bot => (
                  <TouchableOpacity
                    key={bot.id}
                    style={[
                      styles.keyCard,
                      selectedWidgetBot === bot.id && { borderColor: colors.accent.primary, borderWidth: 1 },
                    ]}
                    onPress={() => setSelectedWidgetBot(bot.id)}
                  >
                    <Text style={styles.keyLabel}>{bot.name}</Text>
                    {selectedWidgetBot === bot.id && (
                      <Text style={{ color: colors.accent.primary, fontWeight: '600', fontSize: fontSize.sm }}>Selected</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Floating overlay toggle (Android only) */}
            {Platform.OS === 'android' && (
              <TouchableOpacity
                style={[styles.keyCard, { marginTop: spacing.sm }]}
                onPress={handleOpenOverlaySettings}
              >
                <View style={styles.keyInfo}>
                  <Text style={styles.keyLabel}>Floating Overlay</Text>
                  <Text style={styles.keyFingerprint}>
                    Draggable bot that floats on your screen. Requires "Display over other apps" permission.
                  </Text>
                </View>
                <Text style={styles.editText}>Open Settings</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.logoutButton, { marginTop: spacing.md }]}
              onPress={handleDisableWidget}
              accessibilityRole="button"
              accessibilityLabel="Disable Widget"
            >
              <Text style={styles.deleteText}>Disable Widget</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tutorial tips reset */}
      {skippedAll && (
        <TouchableOpacity
          style={styles.resetTipsButton}
          onPress={() => {
            resetTips();
            showToast('Tutorial tips will appear again on each screen.', 'info');
          }}
          accessibilityRole="button"
          accessibilityLabel="Reset Tutorial Tips"
        >
          <Text style={styles.resetTipsText}>Reset Tutorial Tips</Text>
        </TouchableOpacity>
      )}

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); logout(); }} accessibilityRole="button" accessibilityLabel="Sign Out">
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>

      {/* Delete Account */}
      <TouchableOpacity style={styles.deleteAccountButton} onPress={handleDeleteAccount} accessibilityRole="button" accessibilityLabel="Delete Account">
        <Text style={styles.deleteAccountText}>Delete Account</Text>
      </TouchableOpacity>

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, padding: spacing.md },
  section: { marginBottom: spacing.xl },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionIcon: { fontSize: 18, marginRight: spacing.sm },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  email: { fontSize: fontSize.md, color: colors.accent.secondary },
  info: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs },
  profileRow: { marginTop: spacing.sm },
  editNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nameInput: {
    flex: 1, backgroundColor: colors.bg.card, color: colors.text.primary,
    padding: spacing.sm, borderRadius: borderRadius.sm, fontSize: fontSize.md,
    borderWidth: 1, borderColor: colors.accent.primary,
  },
  displayName: { fontSize: fontSize.md, color: colors.text.primary, flex: 1 },
  editText: { fontSize: fontSize.sm, color: colors.accent.primary, fontWeight: '600' },
  saveText: { fontSize: fontSize.sm, color: colors.accent.success, fontWeight: '600' },
  cancelText: { fontSize: fontSize.sm, color: colors.text.tertiary },
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
  resetTipsButton: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.accent.secondary + '40',
    marginBottom: spacing.md,
  },
  resetTipsText: { fontSize: fontSize.md, color: colors.accent.secondary, fontWeight: '600' },
  logoutButton: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center', borderWidth: 1, borderColor: colors.accent.error + '40',
    marginBottom: spacing.md,
  },
  logoutText: { fontSize: fontSize.md, color: colors.accent.error, fontWeight: '600' },
  deleteAccountButton: {
    backgroundColor: 'transparent', padding: spacing.md, borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  deleteAccountText: { fontSize: fontSize.sm, color: colors.text.tertiary },
});
