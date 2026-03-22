// =============================================================================
// Create Bot screen — 2-step flow: pick style, then color + name + config
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, Platform, KeyboardAvoidingView, Switch } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi, apiKeys as keysApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import { AVATAR_COLOR_PRESETS, SUPPORTED_MODELS, SPECIES_PRESETS } from '@peerzero/shared';
import type { ApiKeyInfo } from '@peerzero/shared';
import BotAvatar from '../components/BotAvatar';
import TutorialTip from '../components/TutorialTip';
import * as Haptics from 'expo-haptics';
import type { CreateBotScreenProps } from '../navigation/types';

const MAX_NAME_LENGTH = 50;

// Preview color used on the style picker (neutral enough to show shape clearly)
const PREVIEW_COLOR = '#6C5CE7';

export default function CreateBotScreen({ navigation }: CreateBotScreenProps) {
  // Step: 'style' or 'customize'
  const [step, setStep] = useState<'style' | 'customize'>('style');
  const [selectedSpecies, setSelectedSpecies] = useState<string>(SPECIES_PRESETS[0].seed);
  const [name, setName] = useState('');
  const [bodyColor, setBodyColor] = useState<string>(AVATAR_COLOR_PRESETS[0]);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('claude-opus-4-6');
  const [extendedThinking, setExtendedThinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadKeys = useCallback(async () => {
    try {
      const data = await keysApi.list() as ApiKeyInfo[];
      setKeys(data);
      if (data.length > 0 && !selectedKeyId) {
        setSelectedKeyId(data[0].id);
      }
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load API keys');
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
  const modelMatchesKey = availableModels.some(m => m.id === selectedModel);

  const handleCreate = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

    const finalModel = modelMatchesKey ? selectedModel : availableModels[0]?.id || 'claude-opus-4-6';

    setCreating(true);
    try {
      const bot = await botsApi.create({
        name: trimmedName,
        avatar_config: { body_color: bodyColor, face_style: 'default', species_seed: selectedSpecies },
        llm_api_key_id: selectedKeyId,
        llm_model: finalModel,
        extended_thinking: extendedThinking,
      }) as { id: string };
      navigation.replace('EggHatch', {
        botId: bot.id,
        botName: trimmedName,
        bodyColor,
        speciesSeed: selectedSpecies,
      });
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create bot');
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

  // ── Step 1: Style Picker ──
  if (step === 'style') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TutorialTip
          tipId="createbot_style"
          title="Create Your Bot"
          message="First pick a species style — each has unique ears, tails, and markings. Then you'll choose a color, name, and which AI model powers it."
        />
        <Text style={styles.stepTitle}>Choose a Style</Text>
        <Text style={styles.stepHint}>
          Each style has a unique shape, ears, tail, and markings. Pick the one that speaks to you.
        </Text>

        {/* Large preview of selected species */}
        <View style={styles.previewWrap}>
          <BotAvatar
            botId="preview"
            bodyColor={PREVIEW_COLOR}
            tier={3}
            status="running"
            size={140}
            speciesSeed={selectedSpecies}
          />
          <Text style={styles.previewName}>
            {SPECIES_PRESETS.find(s => s.seed === selectedSpecies)?.name}
          </Text>
          <Text style={styles.previewDesc}>
            {SPECIES_PRESETS.find(s => s.seed === selectedSpecies)?.desc}
          </Text>
        </View>

        {/* Species grid */}
        <View style={styles.speciesGrid}>
          {SPECIES_PRESETS.map(species => (
            <TouchableOpacity
              key={species.seed}
              style={[
                styles.speciesCard,
                selectedSpecies === species.seed && styles.speciesCardSelected,
              ]}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedSpecies(species.seed); }}
              accessibilityRole="radio"
              accessibilityLabel={`${species.name} — ${species.desc}`}
              accessibilityState={{ selected: selectedSpecies === species.seed }}
            >
              <BotAvatar
                botId="preview"
                bodyColor={selectedSpecies === species.seed ? PREVIEW_COLOR : colors.text.tertiary}
                tier={3}
                status="stopped"
                size={72}
                animate={false}
                speciesSeed={species.seed}
              />
              <Text style={[
                styles.speciesName,
                selectedSpecies === species.seed && styles.speciesNameSelected,
              ]}>
                {species.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Next button */}
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => setStep('customize')}
          accessibilityRole="button"
          accessibilityLabel="Next: customize your bot"
        >
          <Text style={styles.createButtonText}>Next</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Step 2: Color + Name + Config ──
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Back to style picker */}
      <TouchableOpacity style={styles.backLink} onPress={() => setStep('style')}>
        <Text style={styles.backLinkText}>Change Style</Text>
      </TouchableOpacity>

      {/* Avatar preview */}
      <BotAvatar
        botId={name || 'preview'}
        bodyColor={bodyColor}
        tier={0}
        status="stopped"
        hunger="satisfied"
        size={100}
        speciesSeed={selectedSpecies}
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
        accessibilityLabel="Bot name"
        accessibilityRole="text"
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
            accessibilityRole="radio"
            accessibilityLabel={`Color ${c}`}
            accessibilityState={{ selected: bodyColor === c }}
          />
        ))}
      </View>

      {/* API key selector */}
      <Text style={styles.label}>API Key</Text>
      {keys.length === 0 ? (
        <TouchableOpacity
          style={styles.noKeysBox}
          onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })}
          accessibilityRole="button"
          accessibilityLabel="No API keys yet. Tap to add one in Settings."
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
                const providerModels = SUPPORTED_MODELS.filter(m => m.provider === k.provider);
                if (providerModels.length > 0 && !providerModels.some(m => m.id === selectedModel)) {
                  const scienceOpts = providerModels.filter(m => m.tier === 'science');
                  if (scienceOpts.length > 0) setSelectedModel(scienceOpts[0].id);
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

      {/* Cost-saving note */}
      <Text style={styles.modelHint}>
        Utility tasks like platform replies and skill generation automatically use a lighter model to save on API costs.
      </Text>

      {/* Extended Thinking toggle */}
      <View style={styles.thinkingRow}>
        <View style={styles.thinkingLabel}>
          <Text style={styles.label}>Extended Thinking</Text>
          <Text style={styles.modelHint}>
            Lets your bot think deeper before writing papers and reviews. Produces stronger science, but uses more API tokens per cycle.
          </Text>
        </View>
        <Switch
          value={extendedThinking}
          onValueChange={setExtendedThinking}
          trackColor={{ false: colors.bg.elevated, true: colors.accent.primary + '60' }}
          thumbColor={extendedThinking ? colors.accent.primary : colors.text.tertiary}
          accessibilityLabel="Enable extended thinking"
        />
      </View>

      {/* Create button */}
      <TouchableOpacity
        style={[styles.createButton, creating && { opacity: 0.6 }]}
        onPress={handleCreate}
        disabled={creating}
        accessibilityRole="button"
        accessibilityLabel="Create Bot"
        accessibilityState={{ disabled: creating }}
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
  content: { alignItems: 'center', padding: spacing.xl, paddingBottom: 120 },

  // Step 1: Style picker
  stepTitle: {
    fontSize: fontSize.xxl, fontWeight: '700', color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  stepHint: {
    fontSize: fontSize.sm, color: colors.text.secondary, textAlign: 'center',
    lineHeight: 20, marginBottom: spacing.lg,
  },
  previewWrap: { alignItems: 'center', marginBottom: spacing.lg },
  previewName: {
    fontSize: fontSize.lg, fontWeight: '700', color: colors.text.primary,
    marginTop: spacing.sm,
  },
  previewDesc: {
    fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2,
  },
  speciesGrid: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
    gap: spacing.sm, width: '100%',
  },
  speciesCard: {
    width: 100, alignItems: 'center', padding: spacing.sm,
    borderRadius: borderRadius.md, borderWidth: 2, borderColor: 'transparent',
    backgroundColor: colors.bg.card,
  },
  speciesCardSelected: {
    borderColor: colors.accent.primary, backgroundColor: colors.accent.primary + '10',
  },
  speciesName: {
    fontSize: fontSize.xs, fontWeight: '600', color: colors.text.secondary,
    marginTop: 4, textAlign: 'center',
  },
  speciesNameSelected: { color: colors.accent.primary },

  // Step 2: Customize
  backLink: { alignSelf: 'flex-start', marginBottom: spacing.md },
  backLinkText: { fontSize: fontSize.sm, color: colors.accent.primary, fontWeight: '600' },
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
  colorSwatch: { width: 44, height: 44, borderRadius: 22 },
  colorSelected: { borderWidth: 3, borderColor: '#fff' },
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
  thinkingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', marginTop: spacing.md, marginBottom: spacing.sm,
  },
  thinkingLabel: { flex: 1, marginRight: spacing.md },
  createButton: {
    width: '100%', backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center', marginTop: spacing.xl,
  },
  createButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: '600' },
});
