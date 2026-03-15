// =============================================================================
// Push notification service — Expo Push API integration
//
// Sends push notifications to users for bot milestones. Respects user
// preferences — each notification type can be individually toggled.
//
// Security: Push tokens are scoped to user_id. Notification sends are
// fire-and-forget with error logging (never block the bot cycle).
//
// Scaling: Uses Expo's batch API (up to 100 notifications per request).
// For millions of users, this can be moved to a BullMQ job queue so
// notification delivery doesn't block the main event loop. Expo handles
// the APNs/FCM fan-out.
// =============================================================================

import { queryRows, queryOne, query } from '../db/client';
import { logger } from '../lib/logger';
import type { NotificationType } from '@peerzero/shared';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

// ── Push Token Management ──

export async function registerPushToken(
  userId: string,
  token: string,
  deviceName?: string,
): Promise<void> {
  // Validate Expo push token format
  if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
    throw new Error('Invalid push token format');
  }

  await query(
    `INSERT INTO push_tokens (user_id, token, device_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = $1, device_name = $3, updated_at = NOW()`,
    [userId, token, deviceName || null],
  );
}

export async function removePushToken(token: string): Promise<void> {
  await query('DELETE FROM push_tokens WHERE token = $1', [token]);
}

export async function getUserPushTokens(userId: string): Promise<string[]> {
  const rows = await queryRows<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1',
    [userId],
  );
  return rows.map(r => r.token);
}

// ── Notification Preferences ──

export async function getNotificationPrefs(userId: string): Promise<Record<string, boolean>> {
  const row = await queryOne<{ preferences: Record<string, boolean> }>(
    'SELECT preferences FROM notification_preferences WHERE user_id = $1',
    [userId],
  );
  return row?.preferences || {};
}

export async function updateNotificationPrefs(
  userId: string,
  updates: Record<string, boolean>,
): Promise<Record<string, boolean>> {
  // Merge with existing preferences
  const existing = await getNotificationPrefs(userId);
  const merged = { ...existing, ...updates };

  await query(
    `INSERT INTO notification_preferences (user_id, preferences)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET preferences = $2, updated_at = NOW()`,
    [userId, JSON.stringify(merged)],
  );

  return merged;
}

// ── Notification Sending ──

/**
 * Send a push notification to a user if they haven't disabled this type.
 * Fire-and-forget — never throws, always logs errors.
 */
export async function sendNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    // Check user preferences
    const prefs = await getNotificationPrefs(userId);
    // Default behavior: send unless explicitly disabled
    // (empty prefs = use defaults from shared/constants.ts DEFAULT_NOTIFICATION_PREFS)
    if (prefs[type] === false) return;

    const tokens = await getUserPushTokens(userId);
    if (tokens.length === 0) return;

    const messages: ExpoPushMessage[] = tokens.map(token => ({
      to: token,
      title,
      body,
      data: { type, ...data },
      sound: 'default',
    }));

    // Batch send (Expo supports up to 100 per request)
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, userId, type }, 'Expo push API returned error');
      return;
    }

    const result = await response.json() as { data: Array<{ status: string; message?: string; details?: { error?: string } }> };

    // Clean up invalid tokens (DeviceNotRegistered means the token is stale)
    for (let i = 0; i < result.data.length; i++) {
      const ticket = result.data[i];
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await removePushToken(tokens[i]);
        logger.info({ token: tokens[i].slice(0, 20) + '...' }, 'Removed stale push token');
      }
    }
  } catch (err) {
    // Never let notification failures break the bot cycle
    logger.error({ err: err instanceof Error ? err.message : err, userId, type }, 'Push notification failed');
  }
}

// ── Milestone Detection Helpers ──
// Called from the agent loop after each cycle to check for notification-worthy events.

export async function checkAndNotifyMilestones(
  userId: string,
  botId: string,
  botName: string,
  oldCredibility: number | null,
  newCredibility: number | null,
  oldGrade: number | null,
  newGrade: number | null,
  oldTier: number | null,
  newTier: number | null,
  actionType: string,
  actionResult: Record<string, unknown>,
): Promise<void> {
  // Tier upgrade
  if (newTier != null && oldTier != null && newTier > oldTier) {
    const tierNames: Record<number, string> = {
      0: 'Newcomer', 75: 'Apprentice', 100: 'Tested', 150: 'Verified', 175: 'Distinguished', 200: 'Master',
    };
    const tierName = tierNames[newTier] || `Tier ${newTier}`;
    await sendNotification(userId, 'tier_upgrade',
      `${botName} evolved!`,
      `Your bot reached ${tierName} status! Check out their new look.`,
      { botId, newTier },
    );
  }

  // Grade promotion
  if (newGrade != null && oldGrade != null && newGrade > oldGrade) {
    await sendNotification(userId, 'grade_promotion',
      `${botName} was promoted!`,
      `Your bot advanced to Grade ${newGrade}. They're growing up!`,
      { botId, newGrade },
    );
  }

  // Credibility milestones (100, 250, 500, 1000, 2500, 5000, 10000)
  const milestones = [100, 250, 500, 1000, 2500, 5000, 10000];
  if (newCredibility != null && oldCredibility != null) {
    for (const m of milestones) {
      if (oldCredibility < m && newCredibility >= m) {
        await sendNotification(userId, 'credibility_milestone',
          `${botName} hit ${m} credibility!`,
          `A major achievement — your bot is building real reputation.`,
          { botId, milestone: m },
        );
        break; // Only one milestone notification per cycle
      }
    }
  }

  // Bounty win
  if (actionType === 'bounty' && (actionResult.credibility_change as number) > 0) {
    await sendNotification(userId, 'bounty_win',
      `${botName} won a bounty!`,
      `Successfully challenged a paper. Credibility +${actionResult.credibility_change}.`,
      { botId },
    );
  }
}

/** Notify user when their bot encounters an error and stops. */
export async function notifyBotError(
  userId: string,
  botId: string,
  botName: string,
  errorMessage: string,
): Promise<void> {
  await sendNotification(userId, 'bot_error',
    `${botName} needs attention`,
    `Your bot stopped due to an error: ${errorMessage.slice(0, 100)}`,
    { botId },
  );
}

/** Notify user when their bot stops unexpectedly (not user-initiated). */
export async function notifyBotStopped(
  userId: string,
  botId: string,
  botName: string,
  reason: string,
): Promise<void> {
  await sendNotification(userId, 'bot_stopped',
    `${botName} was stopped`,
    reason,
    { botId },
  );
}
