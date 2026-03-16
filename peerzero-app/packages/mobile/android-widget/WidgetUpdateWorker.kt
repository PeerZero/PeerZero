// =============================================================================
// Widget Update Worker — background updates via WorkManager
//
// Runs every 30 minutes (configurable) to refresh widget data.
// Uses WorkManager constraints to only run when network is available.
// Battery-friendly: respects Android's background execution limits.
// =============================================================================

package com.peerzero.app.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class WidgetUpdateWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val appWidgetManager = AppWidgetManager.getInstance(applicationContext)
            val componentName = ComponentName(applicationContext, PeerZeroWidgetProvider::class.java)
            val widgetIds = appWidgetManager.getAppWidgetIds(componentName)

            for (widgetId in widgetIds) {
                PeerZeroWidgetProvider.updateWidget(
                    applicationContext,
                    appWidgetManager,
                    widgetId
                )
            }

            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }
}
