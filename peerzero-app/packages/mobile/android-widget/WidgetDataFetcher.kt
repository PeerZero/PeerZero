// =============================================================================
// Widget Data Fetcher — secure HTTP client for widget data endpoint
//
// Security:
//   - Widget token stored in EncryptedSharedPreferences (AES-256-GCM, backed by AndroidKeyStore)
//   - Token scoped to read-only widget data
//   - TLS-only connections (no cleartext HTTP)
//   - ETag support for conditional fetching
//   - No sensitive data (API keys, profiles) in response
//
// Scalability:
//   - Single compact HTTP call returns all bots (~200-500 bytes each)
//   - ETag eliminates redundant data transfer
//   - Response cached locally for offline display
// =============================================================================

package com.peerzero.app.widget

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

data class WidgetBotData(
    val id: String,
    val name: String,
    val bodyColor: String,
    val status: String,
    val credibility: Double?,
    val tier: Int,
    val grade: Int?,
    val schoolName: String?,
    val lastActivityHeadline: String?,
    val lastActivityMood: String?,
    val lastCycleAt: String?
)

data class WidgetDataResponse(
    val bots: List<WidgetBotData>,
    val updatedAt: String
)

object WidgetDataFetcher {

    private const val PREFS_NAME = "peerzero_widget_prefs"
    private const val KEY_WIDGET_TOKEN = "widget_token"
    private const val KEY_API_BASE_URL = "api_base_url"
    private const val KEY_SELECTED_BOT_ID = "selected_bot_id"
    private const val KEY_ETAG = "widget_data_etag"
    private const val KEY_CACHED_DATA = "widget_data_cache"
    private const val DEFAULT_BASE_URL = "https://api.peerzero.app"

    private fun getEncryptedPrefs(context: Context): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getWidgetToken(context: Context): String? {
        return getEncryptedPrefs(context).getString(KEY_WIDGET_TOKEN, null)
    }

    fun setWidgetToken(context: Context, token: String) {
        getEncryptedPrefs(context).edit().putString(KEY_WIDGET_TOKEN, token).apply()
    }

    fun getSelectedBotId(context: Context): String? {
        return getEncryptedPrefs(context).getString(KEY_SELECTED_BOT_ID, null)
    }

    fun setSelectedBotId(context: Context, botId: String) {
        getEncryptedPrefs(context).edit().putString(KEY_SELECTED_BOT_ID, botId).apply()
    }

    fun setApiBaseUrl(context: Context, url: String) {
        getEncryptedPrefs(context).edit().putString(KEY_API_BASE_URL, url).apply()
    }

    fun clearToken(context: Context) {
        getEncryptedPrefs(context).edit()
            .remove(KEY_WIDGET_TOKEN)
            .remove(KEY_ETAG)
            .remove(KEY_CACHED_DATA)
            .apply()
    }

    fun fetchData(context: Context): WidgetDataResponse? {
        val token = getWidgetToken(context) ?: return null
        val prefs = getEncryptedPrefs(context)
        val baseUrl = prefs.getString(KEY_API_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        val etag = prefs.getString(KEY_ETAG, null)

        try {
            val url = URL("$baseUrl/api/widgets/data")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("X-Widget-Token", token)
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000

            if (etag != null) {
                conn.setRequestProperty("If-None-Match", etag)
            }

            val responseCode = conn.responseCode

            if (responseCode == 304) {
                // Not modified — use cached data
                val cached = prefs.getString(KEY_CACHED_DATA, null) ?: return null
                return parseResponse(cached)
            }

            if (responseCode != 200) return getCachedData(prefs)

            val reader = BufferedReader(InputStreamReader(conn.inputStream))
            val body = reader.readText()
            reader.close()

            // Cache response and ETag
            val newEtag = conn.getHeaderField("ETag")
            prefs.edit()
                .putString(KEY_CACHED_DATA, body)
                .apply {
                    if (newEtag != null) putString(KEY_ETAG, newEtag)
                }
                .apply()

            return parseResponse(body)
        } catch (e: Exception) {
            // Network error — return cached data
            return getCachedData(prefs)
        }
    }

    private fun getCachedData(prefs: android.content.SharedPreferences): WidgetDataResponse? {
        val cached = prefs.getString(KEY_CACHED_DATA, null) ?: return null
        return try { parseResponse(cached) } catch (_: Exception) { null }
    }

    private fun parseResponse(json: String): WidgetDataResponse {
        val obj = JSONObject(json)
        val botsArray = obj.getJSONArray("bots")
        val bots = mutableListOf<WidgetBotData>()

        for (i in 0 until botsArray.length()) {
            val bot = botsArray.getJSONObject(i)
            val avatarConfig = bot.getJSONObject("avatar_config")

            bots.add(WidgetBotData(
                id = bot.getString("id"),
                name = bot.getString("name"),
                bodyColor = avatarConfig.optString("body_color", "#6C5CE7"),
                status = bot.getString("status"),
                credibility = if (bot.isNull("credibility")) null else bot.getDouble("credibility"),
                tier = bot.getInt("tier"),
                grade = if (bot.isNull("grade")) null else bot.getInt("grade"),
                schoolName = bot.optString("school_name", null),
                lastActivityHeadline = bot.optString("last_activity_headline", null),
                lastActivityMood = bot.optString("last_activity_mood", null),
                lastCycleAt = bot.optString("last_cycle_at", null)
            ))
        }

        return WidgetDataResponse(
            bots = bots,
            updatedAt = obj.getString("updated_at")
        )
    }
}
