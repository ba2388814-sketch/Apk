'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUT_DIR = path.join(os.tmpdir(), 'html-apk-output');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        if (ext !== '.html' && ext !== '.htm') {
            return cb(new Error('শুধু HTML ফাইল আপলোড করা যাবে।'));
        }

        cb(null, true);
    }
});

const jobs = new Map();
let buildRunning = false;

function validPackageName(value) {
    if (typeof value !== 'string') return false;

    if (value.length > 180) return false;

    const parts = value.split('.');

    if (parts.length < 2) return false;

    return parts.every(part =>
        /^[a-zA-Z][a-zA-Z0-9_]*$/.test(part)
    );
}

function cleanAppName(value) {
    if (typeof value !== 'string') {
        return 'My HTML App';
    }

    return value
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim()
        .slice(0, 50) || 'My HTML App';
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function runCommand(command, args, cwd, timeoutMs = 12 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            shell: false,
            env: {
                ...process.env,
                GRADLE_USER_HOME:
                    process.env.GRADLE_USER_HOME ||
                    path.join(os.tmpdir(), 'gradle-cache')
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let logs = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (finished) return;

            finished = true;
            child.kill('SIGTERM');

            reject(new Error('বিল্ড করতে নির্ধারিত সময়ের বেশি লাগছে।'));
        }, timeoutMs);

        function collect(data) {
            logs += data.toString();

            // Log memory সীমিত রাখা হচ্ছে।
            if (logs.length > 30000) {
                logs = logs.slice(-30000);
            }
        }

        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        child.on('error', error => {
            if (finished) return;

            finished = true;
            clearTimeout(timer);
            reject(error);
        });

        child.on('close', code => {
            if (finished) return;

            finished = true;
            clearTimeout(timer);

            if (code === 0) {
                resolve(logs);
            } else {
                reject(new Error(
                    'Gradle build ব্যর্থ হয়েছে। শেষের লগ:\n' +
                    logs.slice(-10000)
                ));
            }
        });
    });
}

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createAndroidProject(projectDir, html, appName, packageName) {
    const packagePath = packageName.replace(/\./g, '/');

    // Gradle project configuration
    writeFile(
        path.join(projectDir, 'settings.gradle'),
        `
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = 'HtmlGeneratedApp'
include ':app'
`
    );

    writeFile(
        path.join(projectDir, 'build.gradle'),
        `
plugins {
    id 'com.android.application' version '8.7.3' apply false
}
`
    );

    writeFile(
        path.join(projectDir, 'gradle.properties'),
        `
org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8
org.gradle.parallel=false
org.gradle.caching=true
android.useAndroidX=true
`
    );

    writeFile(
        path.join(projectDir, 'app', 'build.gradle'),
        `
plugins {
    id 'com.android.application'
}

android {
    namespace '${packageName}'
    compileSdk 35

    defaultConfig {
        applicationId '${packageName}'
        minSdk 23
        targetSdk 28
        versionCode 1
        versionName '1.0'
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}
`
    );

    const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="false"
        android:label="${escapeXml(appName)}"
        android:usesCleartextTraffic="false"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>
    </application>
</manifest>`;

    writeFile(
        path.join(projectDir, 'app', 'src', 'main', 'AndroidManifest.xml'),
        manifest
    );

    writeFile(
        path.join(
            projectDir,
            'app',
            'src',
            'main',
            'java',
            packagePath,
            'MainActivity.java'
        ),
        `
package ${packageName};

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);

        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        webView = new WebView(this);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        setContentView(webView);

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }

        super.onDestroy();
    }
}
`
    );

    writeFile(
        path.join(
            projectDir,
            'app',
            'src',
            'main',
            'assets',
            'index.html'
        ),
        html
    );
}

async function buildApk(job, html, appName, packageName) {
    const projectDir = path.join(OUTPUT_DIR, job.id);
    const apkPath = path.join(
        projectDir,
        'app',
        'build',
        'outputs',
        'apk',
        'debug',
        'app-debug.apk'
    );

    try {
        job.status = 'building';
        job.message = 'Android প্রজেক্ট তৈরি হচ্ছে';

        createAndroidProject(
            projectDir,
            html,
            appName,
            packageName
        );

        job.message = 'Gradle দিয়ে APK বিল্ড হচ্ছে';

        await runCommand(
            'gradle',
            [
                '--no-daemon',
                '--stacktrace',
                'assembleDebug'
            ],
            projectDir
        );

        if (!fs.existsSync(apkPath)) {
            throw new Error('বিল্ড শেষ হয়েছে, কিন্তু APK ফাইল পাওয়া যায়নি।');
        }

        const destination = path.join(
            OUTPUT_DIR,
            job.id + '.apk'
        );

        fs.copyFileSync(apkPath, destination);

        job.status = 'completed';
        job.message = 'APK সফলভাবে তৈরি হয়েছে';
        job.downloadUrl = '/api/download/' + job.id;
        job.completedAt = Date.now();

    } catch (error) {
        job.status = 'failed';
        job.message = 'APK তৈরি করা যায়নি';
        job.error = String(error.message || error).slice(0, 12000);

    } finally {
        buildRunning = false;

        fs.rm(projectDir, {
            recursive: true,
            force: true
        }, () => {});
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'HTML-to-APK Builder'
    });
});

// Start an APK build.
// HTML file form field: html
// Other fields: appName, packageName
app.post('/api/build', upload.single('html'), async (req, res) => {
    if (buildRunning) {
        return res.status(429).json({
            error: 'অন্য একটি APK বিল্ড হচ্ছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।'
        });
    }

    let html = '';

    if (req.file) {
        html = req.file.buffer.toString('utf8');
    } else if (typeof req.body.htmlCode === 'string') {
        html = req.body.htmlCode;
    }

    if (!html.trim()) {
        return res.status(400).json({
            error: 'একটি HTML ফাইল আপলোড করুন অথবা HTML কোড দিন।'
        });
    }

    if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) {
        return res.status(413).json({
            error: 'HTML ফাইল ৫ MB-এর চেয়ে ছোট হতে হবে।'
        });
    }

    const appName = cleanAppName(req.body.appName);
    const packageName = req.body.packageName || 'com.example.htmlapp';

    if (!validPackageName(packageName)) {
        return res.status(400).json({
            error: 'Package name সঠিক নয়। উদাহরণ: com.example.myapp'
        });
    }

    const id = crypto.randomUUID();

    const job = {
        id,
        status: 'queued',
        message: 'বিল্ডের অনুরোধ গ্রহণ করা হয়েছে',
        createdAt: Date.now(),
        downloadUrl: null,
        error: null
    };

    jobs.set(id, job);
    buildRunning = true;

    // Request দ্রুত শেষ হবে; build আলাদাভাবে চলবে।
    res.status(202).json({
        success: true,
        jobId: id,
        statusUrl: '/api/status/' + id,
        message: 'APK বিল্ড শুরু হয়েছে'
    });

    buildApk(job, html, appName, packageName);
});

// Check build status
app.get('/api/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
        return res.status(404).json({
            error: 'বিল্ডের তথ্য পাওয়া যায়নি।'
        });
    }

    res.json({
        jobId: job.id,
        status: job.status,
        message: job.message,
        downloadUrl: job.downloadUrl,
        error: job.error
    });
});

// Download the generated APK
app.get('/api/download/:id', (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job || job.status !== 'completed') {
        return res.status(404).json({
            error: 'ডাউনলোড করার মতো APK পাওয়া যায়নি।'
        });
    }

    const apkPath = path.join(OUTPUT_DIR, job.id + '.apk');

    if (!fs.existsSync(apkPath)) {
        return res.status(404).json({
            error: 'APK ফাইল মুছে গেছে অথবা আর উপলভ্য নেই।'
        });
    }

    res.download(apkPath, 'generated-app.apk');
});

// Remove old jobs and APK files
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;

    for (const [id, job] of jobs.entries()) {
        if (job.createdAt < cutoff && job.status !== 'building') {
            jobs.delete(id);

            fs.rm(
                path.join(OUTPUT_DIR, id + '.apk'),
                { force: true },
                () => {}
            );
        }
    }
}, 5 * 60 * 1000).unref();

app.use((err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(400).json({
        error: err.message || 'অনুরোধটি সম্পন্ন করা যায়নি।'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('HTML-to-APK Builder listening on port ' + PORT);
});
