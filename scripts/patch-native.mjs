#!/usr/bin/env node
/**
 * Re-apply the native settings `cap add` doesn't know about. `android/` and
 * `ios/` are generated and git-ignored, so this runs after every `cap add`
 * (the `cap:*` scripts do it). Idempotent: running it twice changes nothing.
 *
 * - Android: microphone permissions for dictation.
 * - iOS: the microphone prompt text, and plain-HTTP access to the LAN gateway.
 *
 * Usage: node scripts/patch-native.mjs [project root]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ANDROID_PERMISSIONS = ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"];
const MIC_TEXT = "Hermes usa el micrófono para dictar mensajes.";

export function patchAndroidManifest(xml) {
  let out = xml;
  for (const perm of ANDROID_PERMISSIONS) {
    if (out.includes(`"${perm}"`)) continue;
    out = out.replace(/(\n?)(\s*)<\/manifest>/, `$1$2    <uses-permission android:name="${perm}" />\n$2</manifest>`);
  }
  return out;
}

export function patchInfoPlist(xml) {
  let out = xml;
  const addKey = (key, valueXml) => {
    if (out.includes(`<key>${key}</key>`)) return;
    // Into the top-level dict: before its closing tag, the last </dict> in the file.
    const at = out.lastIndexOf("</dict>");
    if (at === -1) throw new Error("Info.plist without a top-level <dict>");
    out = `${out.slice(0, at)}\t<key>${key}</key>\n\t${valueXml}\n${out.slice(at)}`;
  };
  addKey("NSMicrophoneUsageDescription", `<string>${MIC_TEXT}</string>`);
  addKey("NSAppTransportSecurity", "<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>");
  return out;
}

function patchFile(path, fn) {
  if (!existsSync(path)) return "missing";
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) return "ok";
  writeFileSync(path, after);
  return "patched";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.argv[2] ?? process.cwd();
  const results = {
    android: patchFile(join(root, "android/app/src/main/AndroidManifest.xml"), patchAndroidManifest),
    ios: patchFile(join(root, "ios/App/App/Info.plist"), patchInfoPlist),
  };
  for (const [platform, result] of Object.entries(results)) {
    if (result !== "missing") console.log(`${platform}: ${result === "patched" ? "permisos agregados" : "ya estaba"}`);
  }
}
