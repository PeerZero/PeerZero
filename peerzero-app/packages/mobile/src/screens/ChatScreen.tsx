// =============================================================================
// Chat screen — conversational feed between user and bot
//
// Shows bot activity narrations, milestone announcements, and direct messages
// in a chat-style interface. The bot feels like a friend updating you on its
// life and responding to your questions.
// =============================================================================

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, AppState,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { bots as botsApi } from '../services/api';
import { useBotStream } from '../hooks/useBotStream';
import { colors } from '../theme/colors';
import { spacing, fontSize, borderRadius } from '../theme/spacing';
import BotAvatar from '../components/BotAvatar';
import type { BotMessage, BotDetail, SendMessageResponse, PaginatedResponse } from '@peerzero/shared';
import { credibilityToStage, calculateHunger } from '@peerzero/shared';
import type { ChatScreenProps } from '../navigation/types';
import { timeAgo } from '../utils/timeAgo';

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
  const flatListRef = useRef<FlatList>(null);

  // Load bot details
  useEffect(() => {
    botsApi.get(botId).then(data => setBot(data as BotDetail)).catch(() => {});
  }, [botId]);

  // Set header title to bot name
  useEffect(() => {
    if (bot) {
      navigation.setOptions({ title: bot.name });
    }
  }, [bot?.name, navigation]);

  // Load initial messages
  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const result = await botsApi.messages(botId, 1) as PaginatedResponse<BotMessage>;
      setMessages(result.data.reverse()); // API returns newest-first, we want oldest-first
      setPage(1);
      setHasMore(result.has_more);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useFocusEffect(useCallback(() => { loadMessages(); }, [loadMessages]));

  // Refresh messages when app comes back to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') loadMessages();
    });
    return () => sub.remove();
  }, [loadMessages]);

  // Load older messages (pagination)
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await botsApi.messages(botId, nextPage) as PaginatedResponse<BotMessage>;
      // Prepend older messages (reversed since API returns newest-first)
      setMessages(prev => [...result.data.reverse(), ...prev]);
      setPage(nextPage);
      setHasMore(result.has_more);
    } catch {
      // Silently fail on pagination errors
    } finally {
      setLoadingMore(false);
    }
  };

  // Real-time: listen for new messages via WebSocket
  useBotStream({
    botId,
    onMessage: useCallback((message: BotMessage) => {
      setMessages(prev => {
        // Deduplicate (message may already exist from optimistic update or API response)
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
      // Scroll to bottom on new message
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }, []),
    onStatusChange: useCallback((status: string) => {
      setBot(prev => prev ? { ...prev, status: status as BotDetail['status'] } : null);
    }, []),
  });

  // Send a message
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setSending(true);
    setInputText('');

    // Optimistic: add user message immediately
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
      // Replace temp message with real one, add bot reply
      setMessages(prev => {
        const without = prev.filter(m => m.id !== tempUserMsg.id);
        // Only add if not already present (WebSocket may have delivered it)
        const addUser = without.some(m => m.id === result.user_message.id) ? [] : [result.user_message];
        const addBot = without.some(m => m.id === result.bot_reply.id) ? [] : [result.bot_reply];
        return [...without, ...addUser, ...addBot];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: unknown) {
      // Remove optimistic message on failure
      setMessages(prev => prev.filter(m => m.id !== tempUserMsg.id));
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item }: { item: BotMessage }) => {
    const isUser = item.role === 'user';
    const isActivity = item.message_type === 'activity';
    const isMilestone = item.message_type === 'milestone';

    return (
      <View style={[styles.messageRow, isUser && styles.messageRowUser]}>
        {/* Bot avatar for bot messages */}
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

        <View style={[
          styles.messageBubble,
          isUser && styles.messageBubbleUser,
          isActivity && styles.messageBubbleActivity,
          isMilestone && styles.messageBubbleMilestone,
        ]}>
          {/* Activity/milestone badge */}
          {(isActivity || isMilestone) && (
            <View style={styles.messageTypeBadge}>
              <Text style={[
                styles.messageTypeBadgeText,
                isMilestone && { color: colors.mood.milestone },
              ]}>
                {isMilestone ? '⭐' : '📝'} {isMilestone ? 'Milestone' : (item.metadata as Record<string, string> | null)?.action_type || 'Update'}
              </Text>
            </View>
          )}

          <Text style={[
            styles.messageText,
            isUser && styles.messageTextUser,
          ]}>
            {item.content}
          </Text>

          <Text style={[
            styles.messageTime,
            isUser && styles.messageTimeUser,
          ]}>
            {timeAgo(item.created_at)}
          </Text>
        </View>
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
      {/* Message feed */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={renderMessage}
        contentContainerStyle={[
          styles.messageList,
          messages.length === 0 && styles.emptyList,
        ]}
        onEndReachedThreshold={0.3}
        inverted={false}
        // Load more when scrolling to top
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
              Say hi to {bot?.name || 'your bot'}!
            </Text>
            <Text style={styles.emptySubtitle}>
              Chat with your bot, and it'll share updates about what it's learning as it goes.
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
  messageList: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  emptyList: {
    flex: 1,
    justifyContent: 'center',
  },

  // Messages
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
});
