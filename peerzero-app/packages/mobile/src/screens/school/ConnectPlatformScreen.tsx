// =============================================================================
// Connect Platform screen — pick a platform from registry and enter credentials
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { platforms as platformsApi, bots as botsApi } from '../../services/api';
import { colors } from '../../theme/colors';
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import TutorialTip from '../../components/TutorialTip';
import type { PlatformRegistryEntry } from '@peerzero/shared';
import type { ConnectPlatformScreenProps } from '../../navigation/types';

export default function ConnectPlatformScreen({ route, navigation }: ConnectPlatformScreenProps) {
  const { botId } = route.params;
  const [registry, setRegistry] = useState<PlatformRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PlatformRegistryEntry | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [botGrade, setBotGrade] = useState<number>(0);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const [data, bot] = await Promise.all([
            platformsApi.registry() as Promise<PlatformRegistryEntry[]>,
            botsApi.get(botId) as Promise<{ cached_grade?: number }>,
          ]);
          setRegistry(data.filter(p => p.is_active));
          setBotGrade(bot.cached_grade || 0);
        } catch (err: unknown) {
          Alert.alert('Connection Error', err instanceof Error ? err.message : 'Could not load available platforms. Check your connection and try again.');
        } finally {
          setLoading(false);
        }
      })();
    }, [botId]),
  );

  const doConnect = async () => {
    setConnecting(true);
    try {
      await platformsApi.connect(botId, {
        platform_slug: selected!.slug,
        api_key: apiKey.trim(),
      });
      Alert.alert('Connected', `${selected!.name} connected successfully.`);
      navigation.goBack();
    } catch (err: unknown) {
      Alert.alert('Connection Failed', err instanceof Error ? err.message : 'Could not connect to platform. Check your API key and try again.');
    } finally {
      setConnecting(false);
    }
  };

  const handleConnect = async () => {
    if (!selected || !apiKey.trim()) {
      Alert.alert('Missing Info', 'Please select a platform and enter an API key.');
      return;
    }

    // Warn if bot hasn't graduated
    if (botGrade < 12) {
      Alert.alert(
        'Your bot hasn\'t graduated yet',
        `Your bot is at Grade ${botGrade}/12. Bots that leave school early don't have a solid identity foundation. `
        + 'On external platforms, your bot will develop new patterns without the rigorous training that shapes who it becomes. '
        + 'That identity could go in any direction — good or bad.\n\n'
        + 'Are you sure you want to connect now?',
        [
          { text: 'Go Back to School', style: 'cancel' },
          { text: 'Connect Anyway', style: 'destructive', onPress: doConnect },
        ],
      );
      return;
    }

    doConnect();
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  if (selected) {
    return (
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.form}>
          <Text style={styles.formTitle}>Connect to {selected.name}</Text>
          {selected.description && (
            <Text style={styles.formDescription}>{selected.description}</Text>
          )}
          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="Enter platform API key"
            placeholderTextColor={colors.text.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Platform API key"
            accessibilityRole="text"
          />
          <Text style={styles.hint}>
            Your key is encrypted at rest (AES-256-GCM) and only decrypted in the worker process.
          </Text>
          <TouchableOpacity
            style={[styles.connectButton, connecting && { opacity: 0.6 }]}
            onPress={handleConnect}
            disabled={connecting}
            accessibilityRole="button"
            accessibilityLabel="Connect"
            accessibilityState={{ disabled: connecting }}
          >
            {connecting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.connectButtonText}>Connect</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.backLink} onPress={() => setSelected(null)} accessibilityRole="button" accessibilityLabel="Back to platform list">
            <Text style={styles.backLinkText}>Back to platform list</Text>
          </TouchableOpacity>
        </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.container}>
      <TutorialTip
        tipId="connect_platform"
        title="Connect a Platform"
        message="Choose a platform and enter its API credentials. Your bot will use this connection to post and interact outside of school."
      />
      <FlatList
        data={registry}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={styles.header}>Available Platforms</Text>
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>No platforms available yet. Check back later.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => setSelected(item)}>
            <Text style={styles.platformName}>{item.name}</Text>
            {item.description && (
              <Text style={styles.platformDesc} numberOfLines={2}>{item.description}</Text>
            )}
            <Text style={styles.platformMeta}>Auth: {item.auth_type} | Adapter: {item.adapter_type}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md },
  header: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  platformName: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  platformDesc: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs },
  platformMeta: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: spacing.sm },
  emptyText: { fontSize: fontSize.md, color: colors.text.secondary, textAlign: 'center', marginTop: spacing.xl },
  form: { padding: spacing.xl },
  formTitle: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.xs },
  formDescription: { fontSize: fontSize.sm, color: colors.text.secondary, marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: '600', color: colors.text.secondary, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.bg.card, color: colors.text.primary, fontSize: fontSize.md,
    padding: spacing.md, borderRadius: borderRadius.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  hint: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: spacing.xs },
  connectButton: {
    backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.xl,
  },
  connectButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
  backLink: { alignItems: 'center', marginTop: spacing.md },
  backLinkText: { color: colors.accent.secondary, fontSize: fontSize.sm },
});
