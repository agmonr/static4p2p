package com.agmonr.servicebox

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/** The two apps this launcher exists for. Not user-editable - there's no
 * "paste a URL" flow anymore (that let anyone browse to any site, which
 * both undermines the app's own single stated purpose and is exactly the
 * kind of generic-WebView-wrapper pattern Play Store review flags). Both
 * run in "server mode" (ServiceRunnerService's persistent foreground
 * WebView, see below) - only once the user actually picks one, not
 * pre-warmed on launch. */
private data class AppEntry(val icon: String, val name: String, val url: String)

private val APPS = listOf(
    AppEntry("🚗", "נהיגה", "https://agmonr.github.io/govapiportal/trip-report.html"),
    AppEntry("💬", "שיחה", "https://agmonr.github.io/static4p2p/chat.html")
)

class MainActivity : AppCompatActivity() {

    private lateinit var webViewContainer: FrameLayout
    private lateinit var chipContainer: LinearLayout
    private lateinit var progressBar: ProgressBar

    private val prefs by lazy { getSharedPreferences("servicebox", MODE_PRIVATE) }
    private var currentUrl: String? = null

    private var runnerService: ServiceRunnerService? = null
    private var pendingStartUrl: String? = null

    private val requiredPermissions: Array<String>
        get() {
            val perms = mutableListOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.BODY_SENSORS,
                Manifest.permission.ACTIVITY_RECOGNITION
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                perms.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            return perms.toTypedArray()
        }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            runnerService = (binder as ServiceRunnerService.LocalBinder).getService()
            runnerService?.progressListener = { url, progress ->
                runOnUiThread {
                    if (url == currentUrl) {
                        progressBar.visibility = if (progress in 1..99) View.VISIBLE else View.GONE
                        progressBar.progress = progress
                    }
                }
            }
            runnerService?.iconListener = { _, _ -> runOnUiThread { rebuildAppButtons() } }
            // Restore whichever app was open last session, if any - but
            // don't pre-warm the other one just because the app launched.
            pendingStartUrl?.let { showService(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            runnerService = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webViewContainer = findViewById(R.id.webViewContainer)
        chipContainer = findViewById(R.id.serviceChipContainer)
        progressBar = findViewById(R.id.progressBar)

        requestNeededPermissions()

        currentUrl = prefs.getString("current_url", null)
        pendingStartUrl = currentUrl
        rebuildAppButtons()

        val serviceIntent = Intent(this, ServiceRunnerService::class.java)
        ContextCompat.startForegroundService(this, serviceIntent)
        bindService(serviceIntent, connection, 0)
    }

    private fun requestNeededPermissions() {
        val missing = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1001)
        }
    }

    /** Attaches the WebView for [url] into the container, starting it in
     * ServiceRunnerService (server mode) on first use. The WebView itself
     * lives in the service and keeps running whether or not it's attached
     * here. */
    private fun showService(url: String) {
        val service = runnerService
        if (service == null) {
            pendingStartUrl = url
            return
        }
        detachCurrentWebView()
        currentUrl = url
        prefs.edit().putString("current_url", url).apply()
        attachToContainer(service.ensureWebView(url))
        rebuildAppButtons()
    }

    private fun attachToContainer(webView: WebView) {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webViewContainer.addView(
            webView,
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        // Re-attaching after detachCurrentWebView() (every onStop, and every
        // app switch) can leave Chromium's internal layout stale - viewport-
        // relative CSS (100dvh) in particular doesn't reliably recompute
        // just because the container got its size back. Toggling visibility
        // forces Android to run a full fresh measure/layout/draw pass,
        // which reliably kicks WebView into re-notifying Chromium of its
        // actual current size. requestLayout() alone was not enough here.
        webView.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    private fun detachCurrentWebView() {
        if (webViewContainer.childCount > 0) {
            webViewContainer.removeAllViews()
        }
    }

    private fun rebuildAppButtons() {
        chipContainer.removeAllViews()
        // Home-screen-style tiles (icon square + label underneath) instead
        // of the old horizontal chip row - the emoji is the icon itself
        // (always available immediately, no dependency on the page's
        // favicon having loaded yet).
        for (app in APPS) {
            val isActive = app.url == currentUrl
            val tile = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                lp.setMargins(16, 16, 16, 16)
                layoutParams = lp
                setOnClickListener { showService(app.url) }
            }
            val iconView = TextView(this).apply {
                text = app.icon
                textSize = 32f
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(132, 132)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = 28f
                    setColor(
                        ContextCompat.getColor(
                            this@MainActivity,
                            if (isActive) R.color.forest else R.color.forest_dark
                        )
                    )
                }
            }
            tile.addView(iconView)
            val label = TextView(this).apply {
                text = app.name
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(0, 12, 0, 0)
            }
            tile.addView(label)
            chipContainer.addView(tile)
        }
    }

    override fun onStop() {
        super.onStop()
        // Detach the WebView from this Activity's view tree so it isn't
        // leaked, but leave it running inside the (still-alive) service.
        detachCurrentWebView()
    }

    override fun onStart() {
        super.onStart()
        currentUrl?.let { url ->
            runnerService?.let { service -> attachToContainer(service.ensureWebView(url)) }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        runnerService?.progressListener = null
        // Unbind only — do NOT stop the service. It was started
        // independently (startForegroundService) so it keeps running.
        try {
            unbindService(connection)
        } catch (e: IllegalArgumentException) {
            // not bound, e.g. Activity destroyed before connection callback fired
        }
    }

    private fun currentWebView(): WebView? = runnerService?.let { svc ->
        currentUrl?.let { svc.ensureWebView(it) }
    }

    override fun onBackPressed() {
        val webView = currentWebView()
        if (webView != null && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
