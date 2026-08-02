package com.agmonr.servicebox

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.ContextThemeWrapper
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Owns one WebView per added service URL. Started (not just bound) so it
 * keeps running after MainActivity is closed or swiped from Recents.
 *
 * Keeping the process alive isn't enough on its own: Chromium suspends
 * devicemotion/geolocation delivery to a WebView whenever its page isn't
 * visible, regardless of whether the process is still running (confirmed
 * via logcat: a 5s JS heartbeat kept ticking the whole time, but motion
 * event counts dropped to zero the instant the page went hidden). So this
 * service also runs its own SensorManager/LocationManager listeners —
 * native callbacks aren't routed through Chromium's rendering pipeline and
 * keep firing regardless of page visibility — and bridges that data into
 * each WebView as synthetic devicemotion/geolocation events when the real
 * ones would otherwise go silent.
 */
class ServiceRunnerService : Service(), SensorEventListener, LocationListener {

    inner class LocalBinder : Binder() {
        fun getService(): ServiceRunnerService = this@ServiceRunnerService
    }

    private val binder = LocalBinder()
    private val webViews = LinkedHashMap<String, WebView>()

    var progressListener: ((url: String, progress: Int) -> Unit)? = null

    private val sensorManager by lazy { getSystemService(Context.SENSOR_SERVICE) as SensorManager }
    private val locationManager by lazy { getSystemService(Context.LOCATION_SERVICE) as LocationManager }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        WebView.setWebContentsDebuggingEnabled(true)
        startNativeSensorBridge()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, buildNotification())
        }
        return START_STICKY
    }

    private fun startNativeSensorBridge() {
        sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        requestLocationUpdatesIfPermitted()
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdatesIfPermitted() {
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (locationManager.isProviderEnabled(provider)) {
                locationManager.requestLocationUpdates(provider, 1000L, 0f, this, Looper.getMainLooper())
            }
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val js = "window.__sbDispatchMotion && window.__sbDispatchMotion(${event.values[0]},${event.values[1]},${event.values[2]})"
        webViews.values.forEach { it.evaluateJavascript(js, null) }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onLocationChanged(location: Location) {
        val speed = if (location.hasSpeed()) location.speed else "null"
        val heading = if (location.hasBearing()) location.bearing else "null"
        val js = "window.__sbDispatchPosition && window.__sbDispatchPosition(" +
            "${location.latitude},${location.longitude},${location.accuracy}," +
            "$speed,$heading,${location.time})"
        webViews.values.forEach { it.evaluateJavascript(js, null) }
    }

    @Deprecated("Deprecated in API 29, still called on older devices")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    fun ensureWebView(url: String): WebView {
        webViews[url]?.let { return it }
        val webView = WebView(ContextThemeWrapper(applicationContext, R.style.AppTheme)).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setGeolocationEnabled(true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, loadedUrl: String?) {
                    super.onPageFinished(view, loadedUrl)
                    view?.evaluateJavascript(BACKGROUND_BRIDGE_JS, null)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressListener?.invoke(url, newProgress)
                }

                override fun onGeolocationPermissionsShowPrompt(
                    origin: String?,
                    callback: GeolocationPermissions.Callback?
                ) {
                    val granted = ContextCompat.checkSelfPermission(
                        this@ServiceRunnerService, Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                    callback?.invoke(origin, granted, false)
                }

                override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                    message?.let { Log.d("SBMonitor", "[$url] ${it.message()}") }
                    return true
                }
            }
            loadUrl(url)
        }
        webViews[url] = webView
        updateNotification()
        return webView
    }

    fun removeWebView(url: String) {
        webViews.remove(url)?.destroy()
        if (webViews.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } else {
            updateNotification()
        }
    }

    fun runningCount(): Int = webViews.size

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ServiceBox")
            .setContentText("Running ${webViews.size} service(s) in the background")
            .setSmallIcon(android.R.drawable.ic_menu_manage)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification() {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification())
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Background services", NotificationManager.IMPORTANCE_LOW
            )
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        sensorManager.unregisterListener(this)
        locationManager.removeUpdates(this)
        webViews.values.forEach { it.destroy() }
        webViews.clear()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "servicebox_running"
        private const val NOTIF_ID = 1

        // Bridges native accelerometer/GPS data (unaffected by page
        // visibility) into the page whenever the real browser APIs would
        // otherwise go silent while hidden. Two parts:
        //
        // 1. Neutralizes window.LinearAccelerationSensor/Accelerometer.
        //    Narrow, coupled to trip-report.js specifically: that page
        //    tries the Generic Sensor API first and only falls back to
        //    devicemotion if those classes are absent. Forcing the
        //    fallback is what makes window.addEventListener('devicemotion')
        //    the thing actually listening, so __sbDispatchMotion's
        //    synthetic events have a listener to reach. A future service
        //    that uses the Generic Sensor API with no devicemotion
        //    fallback would lose motion data entirely under this — fine
        //    for now since trip-report.html is the only real consumer.
        //
        // 2. __sbDispatchMotion/__sbDispatchPosition, called from Kotlin
        //    via evaluateJavascript on every native sensor/location
        //    update. Motion is gated on document.hidden so it doesn't
        //    double up with real devicemotion while visible (confirmed
        //    working on its own). Geolocation fully replaces
        //    watchPosition/getCurrentPosition rather than gating, since
        //    there's only one callback path to manage either way and it
        //    removes any dependency on the browser's own (unverified,
        //    likely also-suspended) geolocation background behavior.
        private const val BACKGROUND_BRIDGE_JS = """
            (function() {
              if (window.__sbBridgeInstalled) return;
              window.__sbBridgeInstalled = true;

              window.LinearAccelerationSensor = undefined;
              window.Accelerometer = undefined;

              window.__sbDispatchMotion = function(x, y, z) {
                if (document.visibilityState === 'visible') return;
                try {
                  window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
                    acceleration: { x: x, y: y, z: z },
                    accelerationIncludingGravity: null,
                    rotationRate: null,
                    interval: 20
                  }));
                } catch (e) { /* DeviceMotionEvent ctor unsupported here */ }
              };

              window.__sbPositionWatchers = [];
              window.__sbDispatchPosition = function(lat, lon, acc, speed, heading, ts) {
                var pos = {
                  coords: {
                    latitude: lat, longitude: lon, accuracy: acc,
                    altitude: null, altitudeAccuracy: null,
                    heading: heading, speed: speed
                  },
                  timestamp: ts
                };
                window.__sbPositionWatchers.forEach(function(cb) { cb(pos); });
              };

              if (navigator.geolocation) {
                navigator.geolocation.watchPosition = function(success) {
                  window.__sbPositionWatchers.push(success);
                  return window.__sbPositionWatchers.length;
                };
                navigator.geolocation.clearWatch = function(id) {
                  if (id >= 1 && id <= window.__sbPositionWatchers.length) {
                    window.__sbPositionWatchers[id - 1] = function() {};
                  }
                };
                navigator.geolocation.getCurrentPosition = function(success) {
                  var idx = window.__sbPositionWatchers.push(function(pos) {
                    window.__sbPositionWatchers[idx - 1] = function() {};
                    success(pos);
                  });
                };
              }

              var motionCount = 0;
              window.addEventListener('devicemotion', function() { motionCount++; });
              document.addEventListener('visibilitychange', function() {
                console.log('[SB-MONITOR] visibilitychange=' + document.visibilityState + ' ts=' + Date.now());
              });
              setInterval(function() {
                console.log('[SB-MONITOR] tick visibility=' + document.visibilityState +
                  ' motionEvents5s=' + motionCount);
                motionCount = 0;
              }, 5000);
            })();
        """
    }
}
