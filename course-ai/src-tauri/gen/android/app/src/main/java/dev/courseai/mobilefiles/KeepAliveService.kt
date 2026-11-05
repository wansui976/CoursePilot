package dev.courseai.mobilefiles

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 处理视频、下载模型这些长任务期间的前台服务：通知栏里一条进度，外加 CPU 唤醒锁，
 * 切到别的 App、熄屏都接着跑。Rust 侧 keep_alive.rs 决定什么时候开、什么时候关。
 */
class KeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CoursePilot:longTask").apply {
      setReferenceCounted(false)
      // 兜底：Rust 那边万一没通知收工，最多也就占这么久。
      acquire(6 * 60 * 60 * 1000L)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val type = when {
      Build.VERSION.SDK_INT >= 35 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
      Build.VERSION.SDK_INT >= 29 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      else -> 0
    }
    try {
      // 不走 ServiceCompat：androidx.core 1.13 不认识 Android 15 的 mediaProcessing，
      // 把它抹成 0 传下去，系统报「type none」直接把整个 App 崩掉。
      val notification = buildNotification(this, current)
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, type)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      // 起不来（后台限制、类型被拒……）就算了：任务照跑，只是可能被挂起，绝不能因此崩掉 App。
      Log.w(TAG, "startForeground failed", error)
      stopSelf()
    }
    // 进程被杀后系统不用替我们重启：任务状态在 Rust 里，重启了也接不上。
    return START_NOT_STICKY
  }

  // Android 15 起 mediaProcessing / dataSync 一天最多 6 小时，到点必须自己停。
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  data class State(val title: String, val detail: String, val progress: Double)

  companion object {
    private const val TAG = "KeepAliveService"
    private const val CHANNEL_ID = "long_tasks"
    private const val NOTIFICATION_ID = 0x5c0e
    private const val PREFS = "course_ai_keep_alive"
    private const val ASKED_NOTIFICATIONS = "asked_notifications"

    @Volatile private var running = false
    @Volatile private var current = State("CoursePilot", "", -1.0)

    fun update(activity: Activity, active: Boolean, state: State) {
      val context = activity.applicationContext
      if (!active) {
        context.stopService(Intent(context, KeepAliveService::class.java))
        return
      }
      current = state
      if (running) {
        // 服务已经在跑：直接换通知内容。后台再调 startForegroundService 会被系统拒绝。
        if (canPostNotifications(context)) {
          NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, buildNotification(context, state))
        }
        return
      }
      askNotificationPermissionOnce(activity)
      try {
        ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java))
      } catch (error: Exception) {
        // 多半是 App 已在后台（Android 12 起不许从后台起前台服务）；任务照跑，只是可能被挂起。
        Log.w(TAG, "start foreground service failed", error)
      }
    }

    private fun canPostNotifications(context: Context): Boolean =
      Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED

    // 没有通知权限服务也照跑，只是通知栏里看不到进度。只问一次，用户拒了就不再打扰。
    private fun askNotificationPermissionOnce(activity: Activity) {
      if (canPostNotifications(activity)) return
      val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (prefs.getBoolean(ASKED_NOTIFICATIONS, false)) return
      prefs.edit().putBoolean(ASKED_NOTIFICATIONS, true).apply()
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0x5c0e)
    }

    private fun buildNotification(context: Context, state: State): Notification {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(CHANNEL_ID, "后台任务进度", NotificationManager.IMPORTANCE_LOW)
        channel.description = "处理视频、下载模型时显示进度"
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open = launch?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val builder = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle(state.title)
        .setContentText(state.detail)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(open)
      if (state.progress >= 0) {
        builder.setProgress(1000, (state.progress * 1000).toInt(), false)
      } else {
        builder.setProgress(0, 0, true)
      }
      return builder.build()
    }
  }
}
