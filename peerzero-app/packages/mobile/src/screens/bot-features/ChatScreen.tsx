// =============================================================================
// Chat screen — conversational feed between user and bot
//
// Shows bot activity narrations, milestone announcements, and direct messages
// in a chat-style interface. The bot feels like a friend updating you on its
// life and responding to your questions.
//
// Filter tabs let users choose: All | Chat Only | Updates Only
// Settings let users toggle activity/milestone updates on or off entirely.
// Activity messages are compact by default — tap to expand full text.
//
// Redesigned with modern dark theme: glass cards, accent gradients, refined
// typography and spacing.
// =============================================================================

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, AppState,
  Modal,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../../services/api';
import { useBotStream } from '../../hooks/useBotStream';
import { colors } from '../../theme/colors';
import { spacing, fontSize, fontWeight, borderRadius, layout, lineHeight } from '../../theme/spacing';
import BotAvatar from '../../components/BotAvatar';
import AgendaCard from '../../components/AgendaCard';
import type { AgendaState } from '../../components/AgendaCard';
import type { BotMessage, BotDetail, SendMessageResponse, PaginatedResponse } from '@peerzero/shared';
import { credibilityToStage, calculateHunger } from '@peerzero/shared';
import type { ChatScreenProps } from '../../navigation/types';
import { timeAgo } from '../../utils/timeAgo';

// Simple key-value store — same platform split as api.ts
const kvStore = Platform.OS === 'web'
  ? {
      get: async (key: string) => localStorage.getItem(key),
      set: async (key: string, value: string) => localStorage.setItem(key, value),
    }
  : (() => {
      const ss = require('expo-secure-store') as {
        getItemAsync: (key: string) => Promise<string | null>;
        setItemAsync: (key: string, value: string) => Promise<void>;
      };
      return { get: ss.getItemAsync, set: ss.setItemAsync };
    })();

type FilterTab = 'all' | 'chat' | 'updates';

const PREFS_KEY_PREFIX = 'chat_prefs_';

interface ChatPrefs {
  showActivity: boolean;
  showMilestones: boolean;
}

const DEFAULT_PREFS: ChatPrefs = {
  showActivity: true,
  showMilestones: true,
};

export default function ChatScreen({ route, navigation }: ChatScreenProps) {
  const { botId } = route.params;
  const [bot, setBot] = useState<BotDetail | null>(null);
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [inputText, setInputText] = useState('');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [prefs, setPrefs] = useState<ChatPrefs>(DEFAULT_PREFS);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const flatListRef = useRef<FlatList>(null);

  // Load preferences
  useEffect(() => {
    kvStore.get(`${PREFS_KEY_PREFIX}${botId}`).then(raw => {
      if (raw) {
        try { setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(raw) }); } catch { /* use defaults */ }
      }
    }).catch(() => {});
  }, [botId]);

  const savePrefs = useCallback(async (newPrefs: ChatPrefs) => {
    setPrefs(newPrefs);
    try {
      await kvStore.set(`${PREFS_KEY_PREFIX}${botId}`, JSON.stringify(newPrefs));
    } catch { /* best effort */ }
  }, [botId]);

  // Load bot details
  useEffect(() => {
    botsApi.get(botId).then(data => setBot(data as BotDetail)).catch(() => {});
  }, [botId]);

  // Set header title + settings gear
  useEffect(() => {
    if (bot) {
      navigation.setOptions({
        title: bot.name,
        headerRight: () => (
          <TouchableOpacity
            onPress={() => setSettingsVisible(true)}
            style={{ paddingHorizontal: spacing.md }}
            accessibilityLabel="Chat settings"
          >
            <Text style={{ fontSize: 18, color: colors.text.secondary }}>⚙️</Text>
          </TouchableOpacity>
        ),
      });
    }
  }, [bot?.name, navigation]);

  // Load initial messages
  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const result = await botsApi.messages(botId, 1) as PaginatedResponse<BotMessage>;
      setMessages(result.data.reverse());
      setPage(1);
      setHasMore(result.has_more);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadMessages(); }, [loadMessages]));

  // Refresh on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') loadMessages();
    });
    return () => sub.remove();
  }, [loadMessages]);

  // Pagination
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await botsApi.messages(botId, nextPage) as PaginatedResponse<BotMessage>;
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const newMsgs = result.data.reverse().filter(m => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
      setPage(nextPage);
      setHasMore(result.has_more);
    } catch { /* silent */ } finally {
      setLoadingMore(false);
    }
  };

  // Real-time messages
  useBotStream({
    botId,
    onMessage: useCallback((message: BotMessage) => {
      setMessages(prev => {
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }, []),
    onStatusChange: useCallback((status: string) => {
      setBot(prev => prev ? { ...prev, status: status as BotDetail['status'] } : null);
    }, []),
    onAgendaUpdate: useCallback((messageId: string, agenda: Record<string, unknown>) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId) return m;
        return { ...m, metadata: { ...m.metadata, agenda_state: agenda } };
      }));
    }, []),
  });

  // Filter messages based on active tab + preferences
  const filteredMessages = useMemo(() => {
    return messages.filter(m => {
      // Preference-based filtering (global toggle)
      if (m.message_type === 'activity' && !prefs.showActivity) return false;
      if (m.message_type === 'milestone' && !prefs.showMilestones) return false;

      // Tab-based filtering
      if (activeTab === 'chat') return m.message_type === 'chat';
      if (activeTab === 'updates') return m.message_type === 'activity' || m.message_type === 'milestone' || m.message_type === 'agenda';
      return true; // 'all'
    });
  }, [messages, activeTab, prefs]);

  // Count badges for tabs
  const chatCount = useMemo(() => messages.filter(m => m.message_type === 'chat').length, [messages]);
  const updateCount = useMemo(() => messages.filter(m =>
    (m.message_type === 'activity' && prefs.showActivity) ||
    (m.message_type === 'milestone' && prefs.showMilestones)
  ).length, [messages, prefs]);

  // Send message
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setSending(true);
    setInputText('');

    // Switch to "all" or "chat" tab so user sees their message
    if (activeTab === 'updates') setActiveTab('all');

    const tempUserMsg: BotMessage = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bot_id: botId,
      role: 'user',
      content: text,
      message_type: 'chat',
      activity_id: null,
      metadata: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, tempUserMsg]);
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      const result = await botsApi.sendMessage(botId, text) as SendMessageResponse;
      setMessages(prev => {
        const without = prev.filter(m => m.id !== tempUserMsg.id);
        const addUser = without.some(m => m.id === result.user_message.id) ? [] : [result.user_message];
        const addBot = without.some(m => m.id === result.bot_reply.id) ? [] : [result.bot_reply];
        return [...without, ...addUser, ...addBot];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: unknown) {
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  // Cancel a running task
  const handleCancelTask = useCallback(async (taskId: string) => {
    try {
      await botsApi.cancelTask(botId, taskId);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to cancel task');
    }
  }, [botId]);

  const toggleExpand = (id: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderMessage = ({ item }: { item: BotMessage }) => {
    // Agenda messages render as an AgendaCard
    if (item.message_type === 'agenda' && (item.metadata as Record<string, unknown> | null)?.agenda_state) {
      const meta = item.metadata as Record<string, unknown>;
      return (
        <AgendaCard
          agenda={meta.agenda_state as AgendaState}
          taskId={meta.task_id as string | undefined}
          onCancel={handleCancelTask}
        />
      );
    }

    const isUser = item.role === 'user';
    const isActivity = item.message_type === 'activity';
    const isMilestone = item.message_type === 'milestone';
    const isUpdate = isActivity || isMilestone;
    const isExpanded = expandedMessages.has(item.id);

    // Activity messages: compact by default (single line), tap to expand
    if (isUpdate && !isExpanded) {
      return (
        <TouchableOpacity
          style={[styles.compactUpdate, isMilestone && styles.compactMilestone]}
          onPress={() => toggleExpand(item.id)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${isMilestone ? 'Milestone' : 'Update'}: ${(item.content || '').slice(0, 80)}. Tap to expand`}
        >
          <View style={[
            styles.compactIconWrap,
            isMilestone && styles.compactIconWrapMilestone,
          ]}>
            <Text style={styles.compactIcon}>
              {isMilestone ? '⭐' : '📝'}
            </Text>
          </View>
          <Text style={styles.compactText} numberOfLines={1}>
            {item.content}
          </Text>
          <Text style={styles.compactTime}>{timeAgo(item.created_at)}</Text>
        </TouchableOpacity>
      );
    }

    return (
      <View style={[styles.messageRow, isUser && styles.messageRowUser]}>
        {!isUser && bot && (
          <View style={styles.avatarContainer}>
            <BotAvatar
              botId={bot.id}
              bodyColor={bot.avatar_config?.body_color || colors.accent.primary}
              tier={credibilityToStage(bot.cached_credibility)}
              status={bot.status}
              hunger={calculateHunger(bot.last_cycle_at, bot.status)}
              size={32}
              speciesSeed={bot.avatar_config?.species_seed}
            />
          </View>
        )}

        <TouchableOpacity
          style={[
            styles.messageBubble,
            isUser && styles.messageBubbleUser,
            isActivity && styles.messageBubbleActivity,
            isMilestone && styles.messageBubbleMilestone,
          ]}
          activeOpacity={isUpdate ? 0.7 : 1}
          onPress={isUpdate ? () => toggleExpand(item.id) : undefined}
          disabled={!isUpdate}
          accessibilityRole={isUpdate ? "button" : "text"}
          accessibilityLabel={`${isUser ? 'You' : 'Bot'}: ${(item.content || '').slice(0, 100)}${isUpdate ? '. Tap to collapse' : ''}`}
          accessibilityState={{ disabled: !isUpdate }}
        >
          {/* Accent gradient bar for user messages */}
          {isUser && <View style={styles.userBubbleAccent} />}

          {isUpdate && (
            <View style={styles.messageTypeBadge}>
              <Text style={[
                styles.messageTypeBadgeText,
                isMilestone && { color: colors.mood.milestone },
              ]}>
                {isMilestone ? '⭐ Milestone' : `📝 ${(item.metadata as Record<string, string> | null)?.action_type || 'Update'}`}
              </Text>
            </View>
          )}

          <Text style={[styles.messageText, isUser && styles.messageTextUser]}>
            {item.content}
          </Text>

          <Text style={[styles.messageTime, isUser && styles.messageTimeUser]}>
            {timeAgo(item.created_at)}
            {isUpdate && '  tap to collapse'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={colors.accent.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Filter tabs */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        {([
          { key: 'all' as FilterTab, label: 'All' },
          { key: 'chat' as FilterTab, label: 'Chat', count: chatCount },
          { key: 'updates' as FilterTab, label: 'Updates', count: updateCount },
        ]).map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityLabel={`${tab.label} messages${tab.count ? ` (${tab.count})` : ''}`}
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
            {tab.count != null && tab.count > 0 && (
              <View style={[styles.tabBadge, activeTab === tab.key && styles.tabBadgeActive]}>
                <Text style={[
                  styles.tabBadgeText,
                  activeTab === tab.key && styles.tabBadgeTextActive,
                ]}>
                  {tab.count > 99 ? '99+' : tab.count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* AI disclosure — EU AI Act Article 50(1) transparency requirement */}
      <View style={styles.aiDisclosure}>
        <Text style={styles.aiDisclosureText}>
          AI-powered bot — responses are generated by artificial intelligence
        </Text>
      </View>

      {/* Message feed */}
      <FlatList
        ref={flatListRef}
        data={filteredMessages}
        keyExtractor={item => item.id}
        renderItem={renderMessage}
        accessibilityRole="list"
        accessibilityLabel="Chat messages"
        accessibilityLiveRegion="polite"
        contentContainerStyle={[
          styles.messageList,
          filteredMessages.length === 0 && styles.emptyList,
        ]}
        inverted={false}
        onScroll={({ nativeEvent }) => {
          if (nativeEvent.contentOffset.y < 50 && hasMore && !loadingMore) {
            loadMore();
          }
        }}
        scrollEventThrottle={200}
        ListHeaderComponent={
          loadingMore ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color={colors.text.tertiary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            {bot && (
              <View style={styles.emptyAvatarWrap}>
                <View style={styles.emptyAvatarGlow} />
                <BotAvatar
                  botId={bot.id}
                  bodyColor={bot.avatar_config?.body_color || colors.accent.primary}
                  tier={credibilityToStage(bot.cached_credibility)}
                  status={bot.status}
                  hunger={calculateHunger(bot.last_cycle_at, bot.status)}
                  size={80}
                  speciesSeed={bot.avatar_config?.species_seed}
                />
              </View>
            )}
            <Text style={styles.emptyTitle}>
              {activeTab === 'chat' ? 'No messages yet' : activeTab === 'updates' ? 'No updates yet' : `Say hi to ${bot?.name || 'your bot'}!`}
            </Text>
            <Text style={styles.emptySubtitle}>
              {activeTab === 'chat'
                ? `Send a message to start chatting with ${bot?.name || 'your bot'}.`
                : activeTab === 'updates'
                ? `Updates will appear here as ${bot?.name || 'your bot'} learns.`
                : 'Chat with your bot, and it\'ll share updates about what it\'s learning.'}
            </Text>
            {activeTab !== 'updates' && (
              <View style={styles.emptyHintPill}>
                <Text style={styles.emptyHintText}>Type a message below to get started</Text>
              </View>
            )}
          </View>
        }
      />

      {/* Input bar — glass-morphism style */}
      <View style={styles.inputBarOuter}>
        <View style={styles.inputBar}>
          <View style={styles.textInputWrap}>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder={`Message ${bot?.name || 'your bot'}...`}
              placeholderTextColor={colors.text.tertiary}
              multiline
              maxLength={2000}
              returnKeyType="default"
              editable={!sending}
            />
          </View>
          <TouchableOpacity
            style={[styles.sendButton, (!inputText.trim() || sending) && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || sending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={sending ? 'Sending message' : 'Send message'}
            accessibilityState={{ disabled: !inputText.trim() || sending }}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendButtonText}>↑</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Settings modal */}
      <Modal
        visible={settingsVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setSettingsVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSettingsVisible(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalSheet} accessibilityViewIsModal={true}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Chat Settings</Text>
            <Text style={styles.modalSubtitle}>
              Choose which updates appear in your chat feed
            </Text>

            <TouchableOpacity
              style={styles.settingRow}
              onPress={() => savePrefs({ ...prefs, showActivity: !prefs.showActivity })}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityLabel="Activity Updates"
              accessibilityState={{ checked: prefs.showActivity }}
              accessibilityHint="Bot narrates what it did each cycle"
            >
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Activity Updates</Text>
                <Text style={styles.settingHint}>
                  Bot narrates what it did each cycle (papers, reviews, etc.)
                </Text>
              </View>
              <View style={[styles.toggle, prefs.showActivity && styles.toggleOn]}>
                <View style={[styles.toggleDot, prefs.showActivity && styles.toggleDotOn]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.settingRow}
              onPress={() => savePrefs({ ...prefs, showMilestones: !prefs.showMilestones })}
              activeOpacity={0.7}
              accessibilityRole="switch"
              accessibilityLabel="Milestone Announcements"
              accessibilityState={{ checked: prefs.showMilestones }}
              accessibilityHint="Tier upgrades, grade promotions, credibility milestones"
            >
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Milestone Announcements</Text>
                <Text style={styles.settingHint}>
                  Tier upgrades, grade promotions, credibility milestones
                </Text>
              </View>
              <View style={[styles.toggle, prefs.showMilestones && styles.toggleOn]}>
                <View style={[styles.toggleDot, prefs.showMilestones && styles.toggleDotOn]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalDoneButton}
              onPress={() => setSettingsVisible(false)}
              activeOpacity={0.7}
            >
              <Text style={styles.modalDoneText}>Done</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// =============================================================================
// Styles — modern dark theme with glass-morphism, refined spacing/typography
// =============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Filter Tabs ──
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.bg.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 3,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: {
    backgroundColor: colors.accent.primary + '18',
    borderColor: colors.accent.primary + '50',
  },
  tabText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.tertiary,
    letterSpacing: 0.2,
  },
  tabTextActive: {
    color: colors.accent.primary,
  },
  tabBadge: {
    marginLeft: spacing.xs + 1,
    backgroundColor: colors.bg.elevated,
    borderRadius: borderRadius.full,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  tabBadgeActive: {
    backgroundColor: colors.accent.primary + '30',
  },
  tabBadgeText: {
    fontSize: fontSize.xxs,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
  },
  tabBadgeTextActive: {
    color: colors.accent.primary,
  },

  // ── AI Disclosure Banner ──
  aiDisclosure: {
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.xs + 1,
    backgroundColor: colors.bg.glass,
    borderBottomWidth: 1,
    borderBottomColor: colors.border + '60',
  },
  aiDisclosureText: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    textAlign: 'center',
    letterSpacing: 0.3,
  },

  // ── Message List ──
  messageList: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  emptyList: {
    flex: 1,
    justifyContent: 'center',
  },

  // ── Compact Update Row (collapsed activity/milestone) ──
  compactUpdate: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
    marginHorizontal: spacing.xl,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bg.card + '60',
    borderWidth: 1,
    borderColor: colors.border + '40',
  },
  compactMilestone: {
    backgroundColor: colors.mood.milestone + '08',
    borderColor: colors.mood.milestone + '20',
  },
  compactIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent.secondary + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  compactIconWrapMilestone: {
    backgroundColor: colors.mood.milestone + '15',
  },
  compactIcon: {
    fontSize: 12,
  },
  compactText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: fontSize.sm * lineHeight.normal,
  },
  compactTime: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    marginLeft: spacing.sm,
    fontWeight: fontWeight.medium,
  },

  // ── Full Message Bubbles ──
  messageRow: {
    flexDirection: 'row',
    marginBottom: spacing.md + 2,
    alignItems: 'flex-end',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  avatarContainer: {
    marginRight: spacing.sm,
    marginBottom: spacing.xxs,
    // Subtle shadow behind avatar
    shadowColor: colors.shadow.card,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },

  // Bot message — glass card style
  messageBubble: {
    maxWidth: '78%',
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.xl,
    borderBottomLeftRadius: borderRadius.xs,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md - 2,
    borderWidth: 1,
    borderColor: colors.border,
    // Subtle card shadow
    shadowColor: colors.shadow.card,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 2,
  },

  // User message — accent background with gradient accent bar
  messageBubbleUser: {
    backgroundColor: colors.accent.primary + '20',
    borderColor: colors.accent.primary + '35',
    borderBottomLeftRadius: borderRadius.xl,
    borderBottomRightRadius: borderRadius.xs,
    overflow: 'hidden',
    // Glow shadow
    shadowColor: colors.accent.glow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 3,
  },
  userBubbleAccent: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '40%',
    height: '100%',
    backgroundColor: colors.accent.secondary + '06',
    borderTopRightRadius: borderRadius.xl,
  },

  // Activity/milestone expanded variants
  messageBubbleActivity: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent.secondary + '50',
    backgroundColor: colors.bg.card,
  },
  messageBubbleMilestone: {
    borderLeftWidth: 3,
    borderLeftColor: colors.mood.milestone + '70',
    backgroundColor: colors.mood.milestone + '06',
    borderColor: colors.mood.milestone + '18',
  },
  messageTypeBadge: {
    marginBottom: spacing.xs + 1,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border + '60',
  },
  messageTypeBadgeText: {
    fontSize: fontSize.xxs,
    color: colors.accent.secondary,
    fontWeight: fontWeight.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  messageText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: fontSize.md * lineHeight.relaxed,
    letterSpacing: -0.1,
  },
  messageTextUser: {
    color: colors.text.primary,
  },
  messageTime: {
    fontSize: fontSize.xxs,
    color: colors.text.tertiary,
    marginTop: spacing.xs + 2,
    fontWeight: fontWeight.medium,
  },
  messageTimeUser: {
    textAlign: 'right',
  },

  // ── Empty State ──
  emptyState: {
    alignItems: 'center',
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  emptyAvatarWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyAvatarGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.accent.primary + '12',
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginTop: spacing.lg,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: fontSize.md * lineHeight.relaxed,
    maxWidth: 300,
    paddingHorizontal: spacing.sm,
  },
  emptyHintPill: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    backgroundColor: colors.accent.primary + '10',
    borderWidth: 1,
    borderColor: colors.accent.primary + '25',
  },
  emptyHintText: {
    fontSize: fontSize.xs,
    color: colors.accent.primary,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.2,
  },

  // ── Loading ──
  loadingMore: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },

  // ── Input Bar — Glass-morphism ──
  inputBarOuter: {
    backgroundColor: colors.bg.glass,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.sm : spacing.sm,
    paddingHorizontal: layout.screenPadding,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  textInputWrap: {
    flex: 1,
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  textInput: {
    paddingHorizontal: spacing.md + 2,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 4 : spacing.sm + 2,
    color: colors.text.primary,
    fontSize: fontSize.md,
    maxHeight: 100,
    lineHeight: fontSize.md * lineHeight.normal,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
    // Glow
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  },
  sendButtonDisabled: {
    backgroundColor: colors.bg.elevated,
    shadowOpacity: 0,
    elevation: 0,
  },
  sendButtonText: {
    color: '#fff',
    fontWeight: fontWeight.bold,
    fontSize: fontSize.lg,
    marginTop: -1,
  },

  // ── Settings Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.bg.secondary,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    padding: layout.cardPadding,
    paddingBottom: spacing.xxl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.text.tertiary + '60',
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.xs,
    letterSpacing: -0.3,
  },
  modalSubtitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
    lineHeight: fontSize.sm * lineHeight.relaxed,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  settingInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  settingLabel: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  settingHint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    marginTop: spacing.xxs + 1,
    lineHeight: fontSize.xs * lineHeight.relaxed,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bg.elevated,
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: {
    backgroundColor: colors.accent.primary + '30',
    borderColor: colors.accent.primary + '50',
  },
  toggleDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.text.tertiary,
  },
  toggleDotOn: {
    backgroundColor: colors.accent.primary,
    alignSelf: 'flex-end',
    // Dot glow when on
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 2,
  },
  modalDoneButton: {
    backgroundColor: colors.accent.primary,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
    // Button glow
    shadowColor: colors.accent.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  modalDoneText: {
    color: '#fff',
    fontWeight: fontWeight.bold,
    fontSize: fontSize.md,
    letterSpacing: -0.1,
  },
});
