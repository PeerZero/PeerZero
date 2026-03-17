// =============================================================================
// Create Bot screen — name, color, API key, model selection
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Keyboard, Platform, KeyboardAvoidingView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, apiKeys as keysApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { AVATAR_COLOR_PRESETS, SUPPORTED_MODELS, DEFAULT_FAST_MODELS } from '@peerzero/shared';
import type { ApiKeyInfo } from '@peerzero/shared';
import BotAvatar from '../components/BotAvatar';
import type { CreateBotScreenProps } from '../navigation/types';

const MAX_NAME_LENGTH = 50;

export default function CreateBotScreen({ navigation }: CreateBotScreenProps) {
  const [name, setName] = useState('');
  const [bodyColor, setBodyColor] = useState<string>(AVATAR_COLOR_PRESETS[0]);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('claude-opus-4-6');
  const [selectedFastModel, setSelectedFastModel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadKeys = useCallback(async () => {
    try {
      const data = await keysApi.list() as ApiKeyInfo[];
      setKeys(data);
      if (data.length > 0 && !selectedKeyId) {
        setSelectedKeyId(data[0].id);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadKeys(); }, [loadKeys]));

  // Filter models by provider of selected key
  const selectedKey = keys.find(k => k.id === selectedKeyId);
  const availableModels = selectedKey
    ? SUPPORTED_MODELS.filter(m => m.provider === selectedKey.provider)
    : SUPPORTED_MODELS;

  const scienceModels = availableModels.filter(m => m.tier === 'science');
  const fastModels = availableModels.filter(m => m.tier === 'fast');

  // If selected model doesn't match provider, reset to default
  const modelMatchesKey = availableModels.some(m => m.id === selectedModel);
  if (!modelMatchesKey && availableModels.length > 0 && selectedKey) {
    // Will be picked up on next render
  }

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name Required', 'Give your bot a name to get started.');
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      Alert.alert('Name Too Long', `Max ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    if (!selectedKeyId) {
      Alert.alert('API Key Required', 'Add an API key in Settings first.');
      return;
    }

    // Ensure model matches provider
    const finalModel = modelMatchesKey ? selectedModel : availableModels[0]?.id || 'claude-opus-4-6';

    setCreating(true);
    try {
      const bot = await botsApi.create({
        name: trimmedName,
        avatar_config: { body_color: bodyColor, face_style: 'default' },
        llm_api_key_id: selectedKeyId,
        llm_model: finalModel,
        fast_llm_model: selectedFastModel,
      }) as { id: string };
      navigation.replace('Bot', { botId: bot.id });
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create bot');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Avatar preview */}
      <BotAvatar
        botId={name || 'preview'}
        bodyColor={bodyColor}
        tier={0}
        status="stopped"
        hunger="satisfied"
        size={100}
      />

      {/* Name input */}
      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        placeholder="What's your bot called?"
        placeholderTextColor={colors.text.tertiary}
        value={name}
        onChangeText={(t) => setName(t.slice(0, MAX_NAME_LENGTH))}
        maxLength={MAX_NAME_LENGTH}
        autoCapitalize="words"
        autoFocus
      />
      <Text style={styles.charCount}>{name.length}/{MAX_NAME_LENGTH}</Text>

      {/* Color picker */}
      <Text style={styles.label}>Color</Text>
      <View style={styles.colorGrid}>
        {AVATAR_COLOR_PRESETS.map(c => (
          <TouchableOpacity
            key={c}
            style={[styles.colorSwatch, { backgroundColor: c }, bodyColor === c && styles.colorSelected]}
            onPress={() => setBodyColor(c)}
          />
        ))}
      </View>

      {/* API key selector */}
      <Text style={styles.label}>API Key</Text>
      {keys.length === 0 ? (
        <TouchableOpacity
          style={styles.noKeysBox}
          onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })}
        >
          <Text style={styles.noKeysText}>No API keys yet. Tap to add one in Settings.</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.keyList}>
          {keys.map(k => (
            <TouchableOpacity
              key={k.id}
              style={[styles.keyOption, selectedKeyId === k.id && styles.keyOptionSelected]}
              onPress={() => {
                setSelectedKeyId(k.id);
                // Auto-switch models to match provider
                const providerModels = SUPPORTED_MODELS.filter(m => m.provider === k.provider);
                if (providerModels.length > 0 && !providerModels.some(m => m.id === selectedModel)) {
                  const scienceOpts = providerModels.filter(m => m.tier === 'science');
                  if (scienceOpts.length > 0) setSelectedModel(scienceOpts[0].id);
                }
                // Reset fast model if it doesn't match new provider
                if (selectedFastModel && !providerModels.some(m => m.id === selectedFastModel)) {
                  setSelectedFastModel(null);
                }
              }}
            >
              <Text style={[styles.keyLabel, selectedKeyId === k.id && styles.keyLabelSelected]}>{k.label}</Text>
              <Text style={styles.keyFingerprint}>{k.provider} — {k.key_fingerprint}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Science model selector */}
      <Text style={styles.label}>Science Model</Text>
      <Text style={styles.modelHint}>
        Used for papers, reviews, bounties, and revisions. Pick the strongest model you can — science quality depends on it.
      </Text>
      <View style={styles.modelGrid}>
        {scienceModels.map(m => (
          <TouchableOpacity
            key={m.id}
            style={[styles.modelPill, selectedModel === m.id && styles.modelPillSelected]}
            onPress={() => setSelectedModel(m.id)}
          >
            <Text style={[styles.modelText, selectedModel === m.id && styles.modelTextSelected]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Fast model selector (optional) */}
      <Text style={styles.label}>Fast Model (Optional)</Text>
      <Text style={styles.modelHint}>
        Used for memory condensation and identity reflection — tasks that don't need full reasoning power. Saves cost without hurting science quality.
      </Text>
      <View style={styles.modelGrid}>
        <TouchableOpacity
          style={[styles.modelPill, selectedFastModel === null && styles.modelPillSelected]}
          onPress={() => setSelectedFastModel(null)}
        >
          <Text style={[styles.modelText, selectedFastModel === null && styles.modelTextSelected]}>None</Text>
        </TouchableOpacity>
        {fastModels.map(m => (
          <TouchableOpacity
            key={m.id}
            style={[styles.modelPill, selectedFastModel === m.id && styles.modelPillSelected]}
            onPress={() => setSelectedFastModel(m.id)}
          >
            <Text style={[styles.modelText, selectedFastModel === m.id && styles.modelTextSelected]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Create button */}
      <TouchableOpacity
        style={[styles.createButton, creating && { opacity: 0.6 }]}
        onPress={handleCreate}
        disabled={creating}
      >
        {creating ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.createButtonText}>Create Bot</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  content: { alignItems: 'center', padding: spacing.xl },
  label: {
    fontSize: fontSize.sm, fontWeight: '600', color: colors.text.secondary,
    textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.lg,
    alignSelf: 'flex-start', marginBottom: spacing.xs,
  },
  input: {
    width: '100%', backgroundColor: colors.bg.card, color: colors.text.primary,
    padding: spacing.md, borderRadius: borderRadius.md, fontSize: fontSize.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  charCount: { fontSize: fontSize.xs, color: colors.text.tertiary, alignSelf: 'flex-end', marginTop: 2 },
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, width: '100%' },
  colorSwatch: {
    width: 44, height: 44, borderRadius: 22,
  },
  colorSelected: {
    borderWidth: 3, borderColor: '#fff',
  },
  noKeysBox: {
    width: '100%', backgroundColor: colors.bg.card, padding: spacing.lg,
    borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  noKeysText: { color: colors.accent.primary, fontSize: fontSize.sm, textAlign: 'center' },
  keyList: { width: '100%', gap: spacing.xs },
  keyOption: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  keyOptionSelected: { borderColor: colors.accent.primary, backgroundColor: colors.accent.primary + '10' },
  keyLabel: { fontSize: fontSize.md, fontWeight: '600', color: colors.text.primary },
  keyLabelSelected: { color: colors.accent.primary },
  keyFingerprint: { fontSize: fontSize.xs, color: colors.text.tertiary, marginTop: 2 },
  modelHint: {
    fontSize: fontSize.xs, color: colors.text.tertiary, lineHeight: 18,
    marginBottom: spacing.sm, width: '100%',
  },
  modelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, width: '100%' },
  modelPill: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: borderRadius.full, borderWidth: 1, borderColor: colors.border,
  },
  modelPillSelected: { backgroundColor: colors.accent.primary, borderColor: colors.accent.primary },
  modelText: { fontSize: fontSize.sm, color: colors.text.secondary },
  modelTextSelected: { color: '#fff', fontWeight: '600' },
  createButton: {
    width: '100%', backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.xl,
  },
  createButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
});
