import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS module without types
import { patchAndroidManifest, patchInfoPlist } from "../scripts/patch-native.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Hermes" />
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Hermes</string>
\t<key>UISupportedInterfaceOrientations</key>
\t<array><string>UIInterfaceOrientationPortrait</string></array>
</dict>
</plist>
`;

test("adds the microphone permissions to a fresh AndroidManifest once", () => {
  const once = patchAndroidManifest(MANIFEST);
  assert.match(once, /<uses-permission android:name="android.permission.RECORD_AUDIO" \/>\n/);
  assert.match(once, /MODIFY_AUDIO_SETTINGS" \/>\n<\/manifest>/);
  assert.equal(patchAndroidManifest(once), once, "idempotent");
});

test("adds the mic prompt and local networking to the top-level Info.plist dict once", () => {
  const once = patchInfoPlist(PLIST);
  assert.match(once, /<key>NSMicrophoneUsageDescription<\/key>\n\t<string>[^<]+<\/string>/);
  assert.match(once, /<key>NSAllowsLocalNetworking<\/key>\n\t\t<true\/>\n\t<\/dict>\n<\/dict>\n<\/plist>/);
  assert.equal(patchInfoPlist(once), once, "idempotent");
});
