package com.yue.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 阅 · Reader
 * 纯本地 WebView 阅读器：前端页面 + 书籍全部内置 assets，零联网。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_FILE = 1001;
    private static final String BG_PAPER = "#F7F6F2";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.parseColor(BG_PAPER));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        web.addJavascriptInterface(new Bridge(), "NativeBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u == null || !HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
                String rel = path.startsWith("/") ? path.substring(1) : path;
                try {
                    if (rel.contains("%")) rel = java.net.URLDecoder.decode(rel, "UTF-8");
                } catch (Exception ignored) { }
                try {
                    InputStream is = getAssets().open(rel);
                    Log.d("Yue", "served assets/" + rel + " (" + is.available() + "b)");
                    return new WebResourceResponse(mimeOf(rel), "utf-8", is);
                } catch (IOException e) {
                    Log.e("Yue", "MISSING assets/" + rel, e);
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream("not found".getBytes()));
                }
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Log.d("Yue", "pageFinished " + url);
                super.onPageFinished(v, url);
            }

            @Override
            public void onReceivedError(WebView v, android.webkit.WebResourceRequest r,
                                        android.webkit.WebResourceError e) {
                Log.e("Yue", "pageError " + r.getUrl() + " : " + e.getErrorCode() + " " + e.getDescription());
                super.onReceivedError(v, r, e);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/plain", "text/*"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "选择 TXT"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        setContentView(web);
        applyTheme(BG_PAPER, false);
        web.loadUrl("https://" + HOST + "/index.html");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE) return;
        if (fileCallback == null) return;
        Uri[] result = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                List<Uri> list = new ArrayList<>();
                for (int i = 0; i < n; i++) list.add(data.getClipData().getItemAt(i).getUri());
                result = list.toArray(new Uri[0]);
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /** 返回键：阅读页先回书架，再退出 */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(function(){var r=document.getElementById('reader');" +
                "var d=document.getElementById('drawer');" +
                "var s=document.getElementById('sheet');" +
                "if(d&&!d.hidden)return 'drawer';" +
                "if(s&&!s.hidden)return 'sheet';" +
                "if(r&&!r.hidden)return 'reader';" +
                "return 'shelf';})()",
                value -> {
                    String v = value == null ? "" : value.replace("\"", "");
                    if ("drawer".equals(v)) {
                        web.evaluateJavascript("document.getElementById('drawerClose').click()", null);
                    } else if ("sheet".equals(v)) {
                        web.evaluateJavascript("document.getElementById('sheetMask').click()", null);
                    } else if ("reader".equals(v)) {
                        web.evaluateJavascript("document.getElementById('backBtn').click()", null);
                    } else {
                        finish();
                    }
                });
    }

    private void applyTheme(String bg, boolean dark) {
        try {
            int c = Color.parseColor(bg);
            Window w = getWindow();
            w.setStatusBarColor(c);
            w.setNavigationBarColor(c);
            View dv = w.getDecorView();
            int flags = dv.getSystemUiVisibility();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            dv.setSystemUiVisibility(flags);
            if (web != null) web.setBackgroundColor(c);
        } catch (Exception ignored) { }
    }

    private static String mimeOf(String rel) {
        String p = rel.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".txt")) return "text/plain";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    public class Bridge {
        @JavascriptInterface
        public void setTheme(final String name, final String bg, final boolean dark) {
            runOnUiThread(() -> applyTheme(bg, dark));
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            return "1.0";
        }
    }
}
