// =============================================================================
// Classes screen — list user's classes, join/create
// =============================================================================

import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Alert, ActivityIndicator, Keyboard } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { classes as classesApi } from '../services/api';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import type { ClassInfo } from '@peerzero/shared';

export default function ClassesScreen({ navigation }: any) {
  const [classList, setClassList] = useState<ClassInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await classesApi.list() as ClassInfo[];
      setClassList(data);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    try {
      await classesApi.join(joinCode.trim());
      setShowJoin(false);
      setJoinCode('');
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      Alert.alert('Error', 'Class name is required');
      return;
    }
    try {
      await classesApi.create({ name: newName.trim(), description: newDesc.trim() || undefined });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const renderItem = ({ item }: { item: ClassInfo }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => navigation.navigate('ClassDetail', { classId: item.id })}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.className}>{item.name}</Text>
        <Text style={styles.roleBadge}>{item.role}</Text>
      </View>
      {item.description && (
        <Text style={styles.classDesc} numberOfLines={2}>{item.description}</Text>
      )}
      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>{item.member_count} members</Text>
        {item.school_name && <Text style={styles.metaText}>{item.school_name}</Text>}
      </View>
      <View style={styles.codeRow}>
        <Text style={styles.codeLabel}>Join code:</Text>
        <Text style={styles.codeValue} selectable>{item.join_code}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Join form */}
      {showJoin && (
        <View style={styles.formOverlay}>
          <Text style={styles.formTitle}>Join a Class</Text>
          <TextInput
            style={styles.input}
            value={joinCode}
            onChangeText={setJoinCode}
            placeholder="Enter 6-character join code"
            placeholderTextColor={colors.text.tertiary}
            autoCapitalize="characters"
            maxLength={6}
            returnKeyType="go"
            onSubmitEditing={handleJoin}
          />
          <View style={styles.formActions}>
            <TouchableOpacity style={styles.cancelButton} onPress={() => setShowJoin(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.submitButton} onPress={handleJoin}>
              <Text style={styles.submitText}>Join</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Create form */}
      {showCreate && (
        <View style={styles.formOverlay}>
          <Text style={styles.formTitle}>Create a Class</Text>
          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            placeholder="Class name"
            placeholderTextColor={colors.text.tertiary}
          />
          <TextInput
            style={[styles.input, { marginTop: spacing.sm }]}
            value={newDesc}
            onChangeText={setNewDesc}
            placeholder="Description (optional)"
            placeholderTextColor={colors.text.tertiary}
            multiline
          />
          <View style={styles.formActions}>
            <TouchableOpacity style={styles.cancelButton} onPress={() => setShowCreate(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.submitButton} onPress={handleCreate}>
              <Text style={styles.submitText}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={classList}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No Classes Yet</Text>
            <Text style={styles.emptyText}>Create a class or join one with a code to compare bots and track progress together.</Text>
          </View>
        }
      />

      {!showJoin && !showCreate && (
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.fab} onPress={() => setShowJoin(true)}>
            <Text style={styles.fabText}>Join Class</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.fab, styles.fabSecondary]} onPress={() => setShowCreate(true)}>
            <Text style={[styles.fabText, styles.fabSecondaryText]}>Create Class</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  list: { padding: spacing.md, paddingBottom: 80 },
  card: {
    backgroundColor: colors.bg.card, padding: spacing.md, borderRadius: borderRadius.md,
    marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  className: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  roleBadge: {
    fontSize: fontSize.xs, color: colors.accent.secondary, fontWeight: '600',
    textTransform: 'uppercase',
  },
  classDesc: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs },
  cardMeta: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  metaText: { fontSize: fontSize.xs, color: colors.text.tertiary },
  codeRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.xs },
  codeLabel: { fontSize: fontSize.xs, color: colors.text.tertiary },
  codeValue: { fontSize: fontSize.sm, fontWeight: '600', color: colors.accent.primary, fontFamily: 'monospace' },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: colors.text.primary },
  emptyText: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: spacing.xs, textAlign: 'center', paddingHorizontal: spacing.lg },
  formOverlay: {
    backgroundColor: colors.bg.card, padding: spacing.lg, margin: spacing.md,
    borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.accent.primary + '40',
  },
  formTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text.primary, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.bg.primary, color: colors.text.primary, fontSize: fontSize.md,
    padding: spacing.md, borderRadius: borderRadius.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  formActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, justifyContent: 'flex-end' },
  cancelButton: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  cancelText: { color: colors.text.secondary, fontSize: fontSize.md },
  submitButton: {
    backgroundColor: colors.accent.primary, paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg, borderRadius: borderRadius.sm,
  },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
  buttonRow: {
    position: 'absolute', bottom: spacing.lg, left: spacing.lg, right: spacing.lg,
    flexDirection: 'row', gap: spacing.sm,
  },
  fab: {
    flex: 1, backgroundColor: colors.accent.primary, padding: spacing.md,
    borderRadius: borderRadius.md, alignItems: 'center',
  },
  fabSecondary: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accent.primary,
  },
  fabText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
  fabSecondaryText: { color: colors.accent.primary },
});
