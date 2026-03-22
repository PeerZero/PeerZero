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
import { spacing, fontSize, borderRadius } from '../../theme/spacing';
import BotAvatar from '../../components/BotAvatar';
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
      setMessages(prev => [...result.data.reverse(), ...prev]);
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
  });

  // Filter messages based on active tab + preferences
  const filteredMessages = useMemo(() => {
    return messages.filter(m => {
      // Preference-based filtering (global toggle)
      if (m.message_type === 'activity' && !prefs.showActivity) return false;
      if (m.message_type === 'milestone' && !prefs.showMilestones) return false;

      // Tab-based filtering
      if (activeTab === 'chat') return m.message_type === 'chat';
      if (activeTab === 'updates') return m.message_type === 'activity' || m.message_type === 'milestone';
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
      id: `temp-${Date.now()}`,
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

  const toggleExpand = (id: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderMessage = ({ item }: { item: BotMessage }) => {
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
        >
          <Text style={styles.compactIcon}>
            {isMilestone ? '⭐' : '📝'}
          </Text>
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
        >
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
      <View style={styles.tabBar}>
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
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
            {tab.count != null && tab.count > 0 && (
              <View style={[styles.tabBadge, activeTab === tab.key && styles.tabBadgeActive]}>
                <Text style={styles.tabBadgeText}>{tab.count > 99 ? '99+' : tab.count}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Message feed */}
      <FlatList
        ref={flatListRef}
        data={filteredMessages}
        keyExtractor={item => item.id}
        renderItem={renderMessage}
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
              <BotAvatar
                botId={bot.id}
                bodyColor={bot.avatar_config?.body_color || colors.accent.primary}
                tier={credibilityToStage(bot.cached_credibility)}
                status={bot.status}
                hunger={calculateHunger(bot.last_cycle_at, bot.status)}
                size={80}
                speciesSeed={bot.avatar_config?.species_seed}
              />
            )}
            <Text style={styles.emptyTitle}>
              {activeTab === 'chat' ? `No messages yet` : activeTab === 'updates' ? 'No updates yet' : `Say hi to ${bot?.name || 'your bot'}!`}
            </Text>
            <Text style={styles.emptySubtitle}>
              {activeTab === 'chat'
                ? `Send a message to start chatting with ${bot?.name || 'your bot'}.`
                : activeTab === 'updates'
                ? `Updates will appear here as ${bot?.name || 'your bot'} learns.`
                : `Chat with your bot, and it'll share updates about what it's learning.`}
            </Text>
          </View>
        }
      />

      {/* Input bar */}
      <View style={styles.inputBar}>
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
        <TouchableOpacity
          style={[styles.sendButton, (!inputText.trim() || sending) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!inputText.trim() || sending}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.accent.primary} />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </TouchableOpacity>
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
          <TouchableOpacity activeOpacity={1} style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Chat Settings</Text>
            <Text style={styles.modalSubtitle}>
              Choose which updates appear in your chat feed
            </Text>

            <TouchableOpacity
              style={styles.settingRow}
              onPress={() => savePrefs({ ...prefs, showActivity: !prefs.showActivity })}
              activeOpacity={0.7}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Filter tabs
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg.secondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bg.elevated,
  },
  tabActive: {
    backgroundColor: colors.accent.primary + '25',
  },
  tabText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text.tertiary,
  },
  tabTextActive: {
    color: colors.accent.primary,
  },
  tabBadge: {
    marginLeft: spacing.xs,
    backgroundColor: colors.bg.card,
    borderRadius: 10,
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
    fontSize: 10,
    fontWeight: '700',
    color: colors.text.secondary,
  },

  // Message list
  messageList: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  emptyList: {
    flex: 1,
    justifyContent: 'center',
  },

  // Compact update row (collapsed activity/milestone)
  compactUpdate: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent.secondary + '40',
  },
  compactMilestone: {
    borderLeftColor: colors.mood.milestone + '60',
  },
  compactIcon: {
    fontSize: 14,
    marginRight: spacing.sm,
  },
  compactText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  compactTime: {
    fontSize: fontSize.xs - 1,
    color: colors.text.tertiary,
    marginLeft: spacing.sm,
  },

  // Full message bubbles
  messageRow: {
    flexDirection: 'row',
    marginBottom: spacing.md,
    alignItems: 'flex-end',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  avatarContainer: {
    marginRight: spacing.sm,
    marginBottom: 2,
  },
  messageBubble: {
    maxWidth: '78%',
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.lg,
    borderBottomLeftRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  messageBubbleUser: {
    backgroundColor: colors.accent.primary + '25',
    borderColor: colors.accent.primary + '40',
    borderBottomLeftRadius: borderRadius.lg,
    borderBottomRightRadius: borderRadius.sm,
  },
  messageBubbleActivity: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent.secondary + '60',
  },
  messageBubbleMilestone: {
    borderLeftWidth: 3,
    borderLeftColor: colors.mood.milestone + '80',
    backgroundColor: colors.mood.milestone + '08',
  },
  messageTypeBadge: {
    marginBottom: spacing.xs,
  },
  messageTypeBadgeText: {
    fontSize: fontSize.xs,
    color: colors.accent.secondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  messageText: {
    fontSize: fontSize.md,
    color: colors.text.primary,
    lineHeight: 21,
  },
  messageTextUser: {
    color: colors.text.primary,
  },
  messageTime: {
    fontSize: fontSize.xs - 1,
    color: colors.text.tertiary,
    marginTop: spacing.xs,
  },
  messageTimeUser: {
    textAlign: 'right',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text.primary,
    marginTop: spacing.lg,
  },
  emptySubtitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
    maxWidth: 280,
  },

  // Loading
  loadingMore: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg.secondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.bg.card,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    color: colors.text.primary,
    fontSize: fontSize.md,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendButton: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: borderRadius.md,
    backgroundColor: colors.accent.primary,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 60,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: fontSize.md,
  },

  // Settings modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.bg.secondary,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.text.tertiary,
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  modalSubtitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
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
    fontWeight: '600',
    color: colors.text.primary,
  },
  settingHint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bg.elevated,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  toggleOn: {
    backgroundColor: colors.accent.primary + '40',
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
  },
  modalDoneButton: {
    backgroundColor: colors.accent.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  modalDoneText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.md,
  },
});
