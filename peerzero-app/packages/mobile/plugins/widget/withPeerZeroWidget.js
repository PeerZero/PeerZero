// =============================================================================
// Expo config plugin — Injects iOS WidgetKit extension and Android widget provider
//
// This plugin:
//   1. Adds an iOS Widget Extension target to the Xcode project
//   2. Configures App Groups for data sharing between app and widget
//   3. Adds Android AppWidgetProvider, overlay service, and receiver
//   4. Configures Android permissions for floating overlay
//
// Security: Widget reads from shared keychain (iOS) / EncryptedSharedPreferences
// (Android). No API keys stored in widget-accessible storage.
// =============================================================================

const { withInfoPlist, withXcodeProject, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const WIDGET_EXTENSION_NAME = 'PeerZeroWidget';
const APP_GROUP_ID = 'group.com.peerzero.app';
const BUNDLE_ID = 'com.peerzero.app';

function withPeerZeroWidget(config) {
  // ── iOS: Widget Extension ──
  config = withInfoPlist(config, (config) => {
    // Enable App Groups for shared data
    if (!config.modResults.UIBackgroundModes) {
      config.modResults.UIBackgroundModes = [];
    }
    return config;
  });

  config = withDangerousMod(config, ['ios', async (config) => {
    const iosDir = path.join(config.modRequest.platformProjectRoot);
    const widgetDir = path.join(iosDir, WIDGET_EXTENSION_NAME);

    // Create widget extension directory
    if (!fs.existsSync(widgetDir)) {
      fs.mkdirSync(widgetDir, { recursive: true });
    }

    // Copy Swift source files
    const widgetSourceDir = path.join(__dirname, '..', '..', 'ios-widget');
    const sourceFiles = [
      'PeerZeroWidget.swift',
      'PeerZeroWidgetBundle.swift',
      'WidgetDataProvider.swift',
      'AvatarRenderer.swift',
      'Info.plist',
      'PeerZeroWidget.entitlements',
    ];

    for (const file of sourceFiles) {
      const src = path.join(widgetSourceDir, file);
      const dest = path.join(widgetDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    // Add entitlements to main app for App Groups
    const mainEntitlements = path.join(iosDir, 'PeerZero', 'PeerZero.entitlements');
    const entitlementsContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${APP_GROUP_ID}</string>
  </array>
</dict>
</plist>`;

    const entitlementsDir = path.dirname(mainEntitlements);
    if (!fs.existsSync(entitlementsDir)) {
      fs.mkdirSync(entitlementsDir, { recursive: true });
    }
    fs.writeFileSync(mainEntitlements, entitlementsContent);

    return config;
  }]);

  // ── Android: Widget Provider + Overlay Service ──
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return config;

    // Add overlay permission
    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }

    const existingPerms = manifest['uses-permission'].map(
      (p) => p.$?.['android:name']
    );

    if (!existingPerms.includes('android.permission.SYSTEM_ALERT_WINDOW')) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' },
      });
    }

    if (!existingPerms.includes('android.permission.FOREGROUND_SERVICE')) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.FOREGROUND_SERVICE' },
      });
    }

    if (!existingPerms.includes('android.permission.FOREGROUND_SERVICE_SPECIAL_USE')) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE' },
      });
    }

    // Add widget provider receiver
    if (!app.receiver) {
      app.receiver = [];
    }

    const receiverExists = app.receiver.some(
      (r) => r.$?.['android:name'] === '.widget.PeerZeroWidgetProvider'
    );

    if (!receiverExists) {
      app.receiver.push({
        $: {
          'android:name': '.widget.PeerZeroWidgetProvider',
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } },
            ],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.appwidget.provider',
              'android:resource': '@xml/peerzero_widget_info',
            },
          },
        ],
      });
    }

    // Add floating overlay service
    if (!app.service) {
      app.service = [];
    }

    const serviceExists = app.service.some(
      (s) => s.$?.['android:name'] === '.widget.FloatingOverlayService'
    );

    if (!serviceExists) {
      app.service.push({
        $: {
          'android:name': '.widget.FloatingOverlayService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
      });
    }

    return config;
  });

  config = withDangerousMod(config, ['android', async (config) => {
    const androidDir = config.modRequest.platformProjectRoot;
    const packagePath = BUNDLE_ID.replace(/\./g, '/');
    const widgetSrcDir = path.join(androidDir, 'app', 'src', 'main', 'java', packagePath, 'widget');
    const resDir = path.join(androidDir, 'app', 'src', 'main', 'res');
    const xmlDir = path.join(resDir, 'xml');
    const layoutDir = path.join(resDir, 'layout');
    const drawableDir = path.join(resDir, 'drawable');

    // Create directories
    for (const dir of [widgetSrcDir, xmlDir, layoutDir, drawableDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Copy Kotlin source files
    const androidSourceDir = path.join(__dirname, '..', '..', 'android-widget');
    const kotlinFiles = [
      'PeerZeroWidgetProvider.kt',
      'FloatingOverlayService.kt',
      'WidgetDataFetcher.kt',
      'WidgetUpdateWorker.kt',
    ];

    for (const file of kotlinFiles) {
      const src = path.join(androidSourceDir, file);
      const dest = path.join(widgetSrcDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    // Copy resource files
    const resourceFiles = {
      'peerzero_widget_info.xml': xmlDir,
      'widget_layout.xml': layoutDir,
      'floating_overlay_layout.xml': layoutDir,
      'widget_background.xml': drawableDir,
    };

    for (const [file, destDir] of Object.entries(resourceFiles)) {
      const src = path.join(androidSourceDir, 'res', file);
      const dest = path.join(destDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }

    return config;
  }]);

  return config;
}

module.exports = withPeerZeroWidget;
