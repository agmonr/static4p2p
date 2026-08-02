package com.agmonr.servicebox

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray

class MainActivity : AppCompatActivity() {

    private lateinit var webViewContainer: FrameLayout
    private lateinit var urlInput: EditText
    private lateinit var chipContainer: LinearLayout
    private lateinit var progressBar: ProgressBar

    private val prefs by lazy { getSharedPreferences("servicebox", MODE_PRIVATE) }
    private val services = mutableListOf<String>()
    private var currentUrl: String? = null

    private var runnerService: ServiceRunnerService? = null
    private var pendingStartUrl: String? = null

    private val defaultService = "https://agmonr.github.io/govapiportal/"

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
            services.forEach { runnerService?.ensureWebView(it) }
            (pendingStartUrl ?: currentUrl)?.let { showService(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            runnerService = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webViewContainer = findViewById(R.id.webViewContainer)
        urlInput = findViewById(R.id.urlInput)
        chipContainer = findViewById(R.id.serviceChipContainer)
        progressBar = findViewById(R.id.progressBar)
        val addButton = findViewById<Button>(R.id.addButton)

        requestNeededPermissions()
        loadServices()

        if (services.isEmpty()) {
            services.add(defaultService)
            saveServices()
        }

        addButton.setOnClickListener { addServiceFromInput() }

        pendingStartUrl = prefs.getString("current_url", services.firstOrNull())
        rebuildChips()

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

    private fun addServiceFromInput() {
        var url = urlInput.text.toString().trim()
        if (url.isEmpty()) return
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://$url"
        }
        if (!services.contains(url)) {
            services.add(url)
            saveServices()
        }
        urlInput.text.clear()
        showService(url)
    }

    private fun removeService(url: String) {
        services.remove(url)
        saveServices()
        runnerService?.removeWebView(url)
        if (currentUrl == url) {
            detachCurrentWebView()
            currentUrl = null
            val next = services.firstOrNull()
            if (next != null) {
                showService(next)
            } else {
                prefs.edit().remove("current_url").apply()
                rebuildChips()
            }
        } else {
            rebuildChips()
        }
    }

    /** Attaches the WebView for [url] into the container. The WebView itself
     * lives in ServiceRunnerService and keeps running whether or not it's
     * attached here. */
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
        rebuildChips()
    }

    private fun attachToContainer(webView: WebView) {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webViewContainer.addView(
            webView,
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
    }

    private fun detachCurrentWebView() {
        if (webViewContainer.childCount > 0) {
            webViewContainer.removeAllViews()
        }
    }

    private fun rebuildChips() {
        chipContainer.removeAllViews()
        for (url in services) {
            val isActive = url == currentUrl
            val chip = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(24, 12, 24, 12)
                setBackgroundColor(
                    ContextCompat.getColor(
                        this@MainActivity,
                        if (isActive) android.R.color.holo_blue_light else android.R.color.darker_gray
                    )
                )
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.setMargins(8, 4, 8, 4)
                layoutParams = lp
            }
            val label = TextView(this).apply {
                text = shortLabel(url)
                setPadding(0, 0, 24, 0)
                setOnClickListener { showService(url) }
            }
            val remove = TextView(this).apply {
                text = "×"
                setOnClickListener {
                    removeService(url)
                    Toast.makeText(this@MainActivity, "Removed ${shortLabel(url)}", Toast.LENGTH_SHORT).show()
                }
            }
            chip.addView(label)
            chip.addView(remove)
            chipContainer.addView(chip)
        }
    }

    private fun shortLabel(url: String): String {
        return try {
            val uri = Uri.parse(url)
            (uri.host ?: url) + (uri.path?.takeIf { it.length > 1 } ?: "")
        } catch (e: Exception) {
            url
        }
    }

    private fun loadServices() {
        services.clear()
        val raw = prefs.getString("services", null) ?: return
        val arr = JSONArray(raw)
        for (i in 0 until arr.length()) {
            services.add(arr.getString(i))
        }
    }

    private fun saveServices() {
        val arr = JSONArray()
        services.forEach { arr.put(it) }
        prefs.edit().putString("services", arr.toString()).apply()
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
