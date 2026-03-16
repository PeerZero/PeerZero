// =============================================================================
// PeerZero Widget Provider — Android home screen widget
//
// Shows the bot's avatar, name, status, and latest activity.
// Tapping opens the app's bot detail screen via deep link.
//
// Update strategy:
//   - Widget updates every 30 min via WorkManager (battery-friendly)
//   - Additional update triggered when app writes new data
//   - Uses EncryptedSharedPreferences for widget token (AndroidKeyStore-backed)
//
// Security:
//   - No sensitive data in RemoteViews (no API keys, no profiles)
//   - Widget token in encrypted storage, not accessible to other apps
//   - Deep links use app's URL scheme only
// =============================================================================

package com.peerzero.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.widget.RemoteViews
import androidx.work.*
import com.peerzero.app.R
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

class PeerZeroWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }

        // Schedule periodic updates via WorkManager
        schedulePeriodicUpdate(context)
    }

    override fun onEnabled(context: Context) {
        schedulePeriodicUpdate(context)
    }

    override fun onDisabled(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    companion object {
        const val WORK_NAME = "peerzero_widget_update"

        fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            val data = WidgetDataFetcher.fetchData(context)
            val selectedBotId = WidgetDataFetcher.getSelectedBotId(context)

            // Pick the right bot: selected > running > first
            val bot = if (selectedBotId != null) {
                data?.bots?.firstOrNull { it.id == selectedBotId }
            } else {
                data?.bots?.firstOrNull { it.status == "running" } ?: data?.bots?.firstOrNull()
            }

            val views = RemoteViews(context.packageName, R.layout.widget_layout)

            if (bot != null) {
                // Render avatar bitmap
                val avatarBitmap = renderAvatarBitmap(bot, 160)
                views.setImageViewBitmap(R.id.widget_avatar, avatarBitmap)

                // Bot name
                views.setTextViewText(R.id.widget_bot_name, bot.name)

                // Status with color indicator
                views.setTextViewText(R.id.widget_status, bot.status.replaceFirstChar { it.uppercase() })
                views.setTextColor(R.id.widget_status, statusColor(bot.status))

                // Latest activity
                views.setTextViewText(
                    R.id.widget_activity,
                    bot.lastActivityHeadline ?: "No activity yet"
                )

                // Credibility
                views.setTextViewText(
                    R.id.widget_credibility,
                    bot.credibility?.let { "${it.toInt()}" } ?: "—"
                )

                // Deep link to bot screen
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("peerzero://bot/${bot.id}"))
                val pendingIntent = PendingIntent.getActivity(
                    context, appWidgetId, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
            } else {
                // No bot data — show setup prompt
                views.setTextViewText(R.id.widget_bot_name, "PeerZero")
                views.setTextViewText(R.id.widget_status, "")
                views.setTextViewText(R.id.widget_activity, "Tap to set up your widget")
                views.setTextViewText(R.id.widget_credibility, "")

                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("peerzero://settings/widgets"))
                val pendingIntent = PendingIntent.getActivity(
                    context, appWidgetId, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.widget_root, pendingIntent)
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        private fun schedulePeriodicUpdate(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<WidgetUpdateWorker>(
                30, TimeUnit.MINUTES  // Battery-friendly 30-min interval
            )
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        private fun statusColor(status: String): Int {
            return when (status) {
                "running" -> Color.parseColor("#00E676")
                "error" -> Color.parseColor("#FF5252")
                "paused" -> Color.parseColor("#FFD600")
                else -> Color.parseColor("#8B93A8")
            }
        }

        // ── Avatar rendering (simplified for widget RemoteViews) ──

        private fun hashCode(str: String): Int {
            var hash = 0
            for (char in str) {
                hash = ((hash shl 5) - hash) + char.code
            }
            return abs(hash)
        }

        private fun seededRandom(seed: Int, index: Int): Double {
            val x = sin(seed.toDouble() + index.toDouble() * 9301.0 + 49297.0) * 49381.0
            return x - kotlin.math.floor(x)
        }

        fun renderAvatarBitmap(bot: WidgetBotData, sizePx: Int): Bitmap {
            val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val scale = sizePx / 100f

            val seed = hashCode(bot.id)
            val r = { i: Int -> seededRandom(seed, i) }
            val tier = min(bot.tier, 5)
            val sizeBonus = min(tier, 5) * 1.2f

            val bodyColor = try { Color.parseColor(bot.bodyColor) } catch (_: Exception) { Color.parseColor("#6C5CE7") }
            val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = bodyColor }
            val lightPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = bodyColor
                alpha = 100
            }

            // ── Aura (tier 4+) ──
            if (tier >= 4) {
                val auraPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = bodyColor
                    alpha = if (tier >= 5) 50 else 30
                }
                canvas.drawCircle(50f * scale, 50f * scale, 46f * scale, auraPaint)
            }

            // ── Feet ──
            val footPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = bodyColor
                alpha = 180
            }
            val bodyBottom = 50f + 26f + sizeBonus
            val footY = min(bodyBottom + 2f, 90f)
            canvas.drawOval(
                (42f - 6f) * scale, (footY - 3f) * scale,
                (42f + 6f) * scale, (footY + 3f) * scale, footPaint
            )
            canvas.drawOval(
                (58f - 6f) * scale, (footY - 3f) * scale,
                (58f + 6f) * scale, (footY + 3f) * scale, footPaint
            )

            // ── Ears (tier 1+) ──
            if (tier >= 1) {
                val earScale = when { tier >= 3 -> 1.2f; tier >= 2 -> 1.0f; else -> 0.7f }
                val earPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = bodyColor
                    alpha = 200
                }
                val earRadius = 10f * earScale * scale
                canvas.drawCircle(32f * scale, 24f * scale, earRadius, earPaint)
                canvas.drawCircle(68f * scale, 24f * scale, earRadius, earPaint)
            }

            // ── Body ──
            val bodyRadius = (28f + sizeBonus) * scale
            canvas.drawCircle(50f * scale, 50f * scale, bodyRadius, bodyPaint)

            // ── Belly highlight ──
            val bellyRx = (16f + sizeBonus * 0.4f) * scale
            val bellyRy = (18f + sizeBonus * 0.4f) * scale
            canvas.drawOval(
                50f * scale - bellyRx, (54f) * scale - bellyRy,
                50f * scale + bellyRx, (54f) * scale + bellyRy,
                lightPaint
            )

            // ── Eyes ──
            val eyeSpacing = (0.3 + r(4) * 0.2).toFloat() * 30f
            val eyeSize = (0.8 + r(5) * 0.4).toFloat() * 5f
            val eyeCy = 44f
            val leftX = 50f - eyeSpacing
            val rightX = 50f + eyeSpacing

            val isSleeping = bot.status == "stopped"

            if (isSleeping) {
                // Closed eyes — arcs
                val eyeArcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.parseColor("#2D1B4E")
                    style = Paint.Style.STROKE
                    strokeWidth = 1.5f * scale
                    strokeCap = Paint.Cap.ROUND
                }
                for (ex in listOf(leftX, rightX)) {
                    val path = android.graphics.Path()
                    path.moveTo((ex - eyeSize) * scale, eyeCy * scale)
                    path.quadTo(ex * scale, (eyeCy - eyeSize * 0.8f) * scale, (ex + eyeSize) * scale, eyeCy * scale)
                    canvas.drawPath(path, eyeArcPaint)
                }
            } else {
                val whitePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
                val pupilPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2D1B4E") }

                for (ex in listOf(leftX, rightX)) {
                    canvas.drawCircle(ex * scale, eyeCy * scale, eyeSize * scale, whitePaint)
                    canvas.drawCircle(ex * scale, eyeCy * scale, eyeSize * 0.5f * scale, pupilPaint)
                    // Highlight
                    canvas.drawCircle(
                        (ex + eyeSize * 0.25f) * scale,
                        (eyeCy - eyeSize * 0.25f) * scale,
                        eyeSize * 0.18f * scale, whitePaint
                    )
                }
            }

            // ── Cheeks ──
            val cheekSize = (0.5 + r(6) * 0.5).toFloat()
            val cheekPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = bodyColor
                alpha = 90
            }
            val cheekRadius = 4f * cheekSize * scale
            canvas.drawOval(
                (50f - eyeSpacing - 3f) * scale - cheekRadius, 49f * scale - cheekRadius * 0.7f,
                (50f - eyeSpacing - 3f) * scale + cheekRadius, 49f * scale + cheekRadius * 0.7f,
                cheekPaint
            )
            canvas.drawOval(
                (50f + eyeSpacing + 3f) * scale - cheekRadius, 49f * scale - cheekRadius * 0.7f,
                (50f + eyeSpacing + 3f) * scale + cheekRadius, 49f * scale + cheekRadius * 0.7f,
                cheekPaint
            )

            // ── Mouth ──
            val mouthPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#2D1B4E")
                style = Paint.Style.STROKE
                strokeWidth = 1.2f * scale
                strokeCap = Paint.Cap.ROUND
                alpha = 130
            }
            if (!isSleeping) {
                val mouthPath = android.graphics.Path()
                mouthPath.moveTo((50f - 4f) * scale, 54f * scale)
                mouthPath.quadTo(50f * scale, (54f + 4f) * scale, (50f + 4f) * scale, 54f * scale)
                canvas.drawPath(mouthPath, mouthPaint)
            }

            // ── Crown (tier 4+) ──
            if (tier >= 4) {
                val bodyTop = 50f - 26f - sizeBonus
                val crownBase = bodyTop + 2f
                if (tier >= 5) {
                    val crownPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#FFD700") }
                    val crownPath = android.graphics.Path()
                    crownPath.moveTo(36f * scale, crownBase * scale)
                    crownPath.lineTo(38f * scale, (crownBase - 10f) * scale)
                    crownPath.lineTo(43f * scale, (crownBase - 4f) * scale)
                    crownPath.lineTo(50f * scale, (crownBase - 14f) * scale)
                    crownPath.lineTo(57f * scale, (crownBase - 4f) * scale)
                    crownPath.lineTo(62f * scale, (crownBase - 10f) * scale)
                    crownPath.lineTo(64f * scale, crownBase * scale)
                    crownPath.close()
                    canvas.drawPath(crownPath, crownPaint)
                } else {
                    val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = Color.parseColor("#FFD600")
                        style = Paint.Style.STROKE
                        strokeWidth = 1.5f * scale
                        alpha = 180
                    }
                    canvas.drawOval(
                        (50f - 14f) * scale, (bodyTop - 6f) * scale,
                        (50f + 14f) * scale, (bodyTop + 2f) * scale,
                        haloPaint
                    )
                }
            }

            // ── Sparkles (tier 4+) ──
            if (tier >= 4) {
                val sparklePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.parseColor("#FFD700")
                    alpha = if (tier >= 5) 200 else 130
                }
                val positions = listOf(14f to 18f, 82f to 22f, 20f to 70f, 80f to 68f, 10f to 45f, 90f to 42f)
                val count = if (tier >= 5) 6 else 3
                for (i in 0 until count) {
                    val (sx, sy) = positions[i]
                    canvas.drawCircle(sx * scale, sy * scale, 2f * scale, sparklePaint)
                }
            }

            return bitmap
        }
    }
}
