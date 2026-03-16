// =============================================================================
// Connect Platform screen — pick a platform from registry and enter credentials
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { platforms as platformsApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { PlatformRegistryEntry } from '@peerzero/shared';

export default function ConnectPlatformScreen({ route, navigation }: any) {
  const { botId } = route.params;
  const [registry, setRegistry] = useState<PlatformRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PlatformRegistryEntry | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const data = await platformsApi.registry() as PlatformRegistryEntry[];
          setRegistry(data.filter(p => p.is_active));
        } catch (err: any) {
          Alert.alert('Error', err.message);
        } finally {
          setLoading(false);
        }
      })();
    }, []),
  );

  const handleConnect = async () => {
    if (!selected || !apiKey.trim()) {
      Alert.alert('Missing Info', 'Please select a platform and enter an API key.');
      return;
    }
    setConnecting(true);
    try {
      await platformsApi.connect(botId, {
        platform_slug: selected.slug,
        api_key: apiKey.trim(),
      });
      Alert.alert('Connected', `${selected.name} connected successfully.`);
      navigation.goBack();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setConnecting(false);
    }
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
      <View style={styles.container}>
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
          />
          <Text style={styles.hint}>
            Your key is encrypted at rest (AES-256-GCM) and only decrypted in the worker process.
          </Text>
          <TouchableOpacity
            style={[styles.connectButton, connecting && { opacity: 0.6 }]}
            onPress={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.connectButtonText}>Connect</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.backLink} onPress={() => setSelected(null)}>
            <Text style={styles.backLinkText}>Back to platform list</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
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
