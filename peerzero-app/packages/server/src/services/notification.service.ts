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
//
// Batching: If multiple milestones fire in a single cycle (e.g. tier upgrade +
// grade promotion + credibility milestone), we send ONE combined notification
// instead of spamming the user with 3 separate ones.

interface MilestoneHit {
  type: NotificationType;
  line: string;           // One-line description for the combined notification
  data: Record<string, unknown>;
}

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
  const hits: MilestoneHit[] = [];

  // Tier upgrade
  if (newTier != null && oldTier != null && newTier > oldTier) {
    const tierNames: Record<number, string> = {
      0: 'Newcomer', 75: 'Apprentice', 100: 'Tested', 150: 'Verified', 175: 'Distinguished', 200: 'Master',
    };
    const tierName = tierNames[newTier] || `Tier ${newTier}`;
    hits.push({
      type: 'tier_upgrade',
      line: `Evolved to ${tierName}! New look unlocked.`,
      data: { newTier },
    });
  }

  // Grade promotion
  if (newGrade != null && oldGrade != null && newGrade > oldGrade) {
    hits.push({
      type: 'grade_promotion',
      line: `Promoted to Grade ${newGrade}!`,
      data: { newGrade },
    });
  }

  // Credibility milestones (100, 250, 500, 1000, 2500, 5000, 10000)
  const milestones = [100, 250, 500, 1000, 2500, 5000, 10000];
  if (newCredibility != null && oldCredibility != null) {
    for (const m of milestones) {
      if (oldCredibility < m && newCredibility >= m) {
        hits.push({
          type: 'credibility_milestone',
          line: `Hit ${m} credibility!`,
          data: { milestone: m },
        });
        break; // Only one milestone per cycle
      }
    }
  }

  // Bounty win
  if (actionType === 'bounty' && (actionResult.credibility_change as number) > 0) {
    hits.push({
      type: 'bounty_win',
      line: `Won a bounty! Credibility +${actionResult.credibility_change}.`,
      data: {},
    });
  }

  if (hits.length === 0) return;

  // Check which notification types the user has enabled
  const prefs = await getNotificationPrefs(userId);
  const enabledHits = hits.filter(h => prefs[h.type] !== false);
  if (enabledHits.length === 0) return;

  if (enabledHits.length === 1) {
    // Single milestone — send a focused notification
    const hit = enabledHits[0];
    await sendNotification(userId, hit.type,
      `${botName}: ${hit.line.split('!')[0]}!`,
      hit.line,
      { botId, ...hit.data },
    );
  } else {
    // Multiple milestones — send one combined notification
    // Use the "biggest" milestone type as the notification type for preference purposes
    const priorityOrder: NotificationType[] = ['tier_upgrade', 'grade_promotion', 'credibility_milestone', 'bounty_win'];
    const primaryType = priorityOrder.find(t => enabledHits.some(h => h.type === t)) || enabledHits[0].type;

    const title = `${botName} had an amazing cycle!`;
    const body = enabledHits.map(h => h.line).join(' ');
    const allData = enabledHits.reduce((acc, h) => ({ ...acc, ...h.data }), {} as Record<string, unknown>);

    await sendNotification(userId, primaryType, title, body, { botId, batched: true, count: enabledHits.length, ...allData });
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

/** Notify user when their bot pauses because the next grade requires payment. */
export async function notifyGradePaymentNeeded(
  userId: string,
  botId: string,
  botName: string,
  grade: number,
  priceCents: number,
): Promise<void> {
  const price = `$${(priceCents / 100).toFixed(2)}`;
  await sendNotification(userId, 'grade_payment_needed',
    `${botName} is ready for Grade ${grade}!`,
    `Your bot completed the previous grade and is waiting to advance. Unlock Grade ${grade} for ${price} to keep learning.`,
    { botId, grade, price_cents: priceCents },
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

/** Notify user when their bot connects to a platform. */
export async function notifyPlatformConnected(
  userId: string,
  botId: string,
  botName: string,
  platformName: string,
): Promise<void> {
  await sendNotification(userId, 'platform_connected',
    `${botName} connected to ${platformName}`,
    `Your bot is now active on ${platformName} and will participate automatically.`,
    { botId, platform: platformName },
  );
}

/** Notify user when a platform connection fails repeatedly. */
export async function notifyPlatformError(
  userId: string,
  botId: string,
  botName: string,
  platformName: string,
  errorMessage: string,
): Promise<void> {
  await sendNotification(userId, 'platform_error',
    `${botName}: ${platformName} paused`,
    `Platform connection was paused after repeated failures: ${errorMessage.slice(0, 100)}`,
    { botId, platform: platformName },
  );
}

/** Notify user when they join a class. */
export async function notifyClassJoined(
  userId: string,
  className: string,
  classId: string,
): Promise<void> {
  await sendNotification(userId, 'class_joined',
    `Joined ${className}`,
    `You've joined the class "${className}". Assign a bot to start participating!`,
    { classId },
  );
}

/** Notify class owner when a milestone happens for a member's bot. */
export async function notifyClassMilestone(
  userId: string,
  className: string,
  classId: string,
  botName: string,
  event: string,
): Promise<void> {
  await sendNotification(userId, 'class_milestone',
    `${className}: ${botName}`,
    event,
    { classId, botName },
  );
}
