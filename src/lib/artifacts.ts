import type { Message } from "./api.ts";
import { splitFileRefs } from "./transcript.ts";

/**
 * Images, files and links a session produced or mentioned, scraped from its
 * stored messages. A trimmed port of Hermes Desktop's artifact-utils.ts: the
 * replies' markdown, URLs and paths, `MEDIA:` deliveries, artifact-looking
 * keys in tool results, and the files the person attached.
 */

export type ArtifactKind = "image" | "file" | "link";

export interface Artifact {
  kind: ArtifactKind;
  /** A URL, a data: URL or a path on the server. */
  value: string;
  label: string;
  sessionId: string;
  profile: string;
  sessionTitle: string;
  /** Epoch ms. */
  at: number;
}

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(([^)\s]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>"')`\]]+/g;
const PATH_RE = /(^|[\s("'`])((?:\/|~\/)[^\s"'`<>()]+\.[a-z0-9]{1,8})(?=$|[\s"'`<>),.;:!?])/gim;
const MEDIA_RE = /MEDIA:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\S+))/g;
const SCREENSHOT_RE = /Screenshot path:\s*([^\r\n<>]+)/gi;

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|heic)(?:\?.*)?$/i;
const FILE_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|svg|bmp|heic|pdf|txt|json|md|csv|xlsx?|docx?|pptx?|html|zip|tar|gz|mp3|ogg|opus|wav|m4a|webm|mp4|mov|mkv|py|ts|js|log|yaml|yml)(?:\?.*)?$/i;
/** Tool result keys that name a file the tool made. */
const ARTIFACT_KEY_RE =
  /^(?:artifact_(?:file|image|path|url)|files?_(?:created|modified|written)|generated_(?:file|image|path|url)|output_(?:file|path|url)|result_(?:file|path|url)|saved_to|screenshot_path|image_path|file_path|path|url)$/i;
/** pip's own traffic, not something the session made. */
const PACKAGE_NOISE_RE = /\.whl(?:\.metadata)?$|\/\.cache\/pip\/|\/packages\/.+\.(?:tar\.gz|zip|egg)$/i;

const isUrl = (v: string) => /^https?:\/\//i.test(v);
const isPath = (v: string) => /^(?:\/|~\/)/.test(v);

function clean(value: string): string {
  let v = value.trim();
  if (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  return v.replace(/[`*]+$/g, "").replace(/[),.;:]+$/, "");
}

export function artifactKind(value: string): ArtifactKind {
  if (value.startsWith("data:image/") || IMAGE_EXT_RE.test(value)) return "image";
  if (isPath(value) || (isUrl(value) && FILE_EXT_RE.test(new URL(value).pathname))) return "file";
  return "link";
}

function labelOf(value: string, kind: ArtifactKind = artifactKind(value)): string {
  if (value.startsWith("data:")) return "imagen";
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop();
    // A page reads better by its site; a file by its name.
    if (kind === "link") return last ? `${url.host} › ${decodeURIComponent(last)}` : url.host;
    return last || url.host;
  } catch {
    return value.split("/").filter(Boolean).pop() || value;
  }
}

/** Plausible, and something worth listing: explicit deliveries skip the extension check. */
function accept(value: string, explicit: boolean): boolean {
  if (!value || PACKAGE_NOISE_RE.test(value)) return false;
  if (isUrl(value) || value.startsWith("data:image/")) return true;
  if (!isPath(value)) return false;
  return explicit || FILE_EXT_RE.test(value);
}

function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("\n");
  return "";
}

/** Every candidate in `text`, in the order it appears (a later duplicate is dropped by the caller). */
function collectFromText(text: string, push: (v: string, explicit?: boolean) => void) {
  const found: { at: number; value: string; explicit: boolean }[] = [];
  const add = (re: RegExp, pick: (m: RegExpMatchArray) => string, explicit = false) => {
    for (const m of text.matchAll(re)) found.push({ at: m.index ?? 0, value: pick(m), explicit });
  };
  add(MEDIA_RE, (m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", true);
  add(SCREENSHOT_RE, (m) => m[1], true);
  add(MARKDOWN_IMAGE_RE, (m) => m[1]);
  add(MARKDOWN_LINK_RE, (m) => m[1]);
  add(URL_RE, (m) => m[0]);
  add(PATH_RE, (m) => m[2]);
  // Stable: at the same spot, the explicit and markdown readings (added first) win.
  for (const f of found.sort((a, b) => a.at - b.at)) push(f.value, f.explicit);
}

function collectFromJson(value: unknown, key: string, push: (v: string, explicit?: boolean) => void) {
  if (typeof value === "string") {
    if (ARTIFACT_KEY_RE.test(key)) push(value, true);
    else if (value.includes("MEDIA:")) collectFromText(value, push);
    return;
  }
  if (Array.isArray(value)) return value.forEach((v) => collectFromJson(v, key, push));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectFromJson(v, k, push);
  }
}

export function extractArtifacts(
  messages: Message[],
  session: { id: string; profile: string; title: string; at?: number },
): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const m of messages) {
    const at = typeof m.timestamp === "number" ? (m.timestamp < 1e10 ? m.timestamp * 1000 : m.timestamp) : (session.at ?? Date.now());
    const push = (raw: string, explicit = false) => {
      const value = clean(raw);
      if (!accept(value, explicit) || seen.has(value)) return;
      seen.add(value);
      out.push({ kind: artifactKind(value), value, label: labelOf(value), sessionId: session.id, profile: session.profile, sessionTitle: session.title, at });
    };
    const text = textOf(m);
    if (m.role === "user") {
      // Attached files come as `@file:` refs (relative to the session's workspace).
      const { refs } = splitFileRefs(text);
      for (const ref of refs) {
        const path = ref.replace(/^@file:/, "").replace(/^(["'`])(.*)\1$/, "$2");
        if (!seen.has(path)) {
          seen.add(path);
          out.push({ kind: IMAGE_EXT_RE.test(path) ? "image" : "file", value: path, label: labelOf(path), sessionId: session.id, profile: session.profile, sessionTitle: session.title, at });
        }
      }
    } else if (m.role === "assistant") {
      collectFromText(text, push);
    } else if (m.role === "tool") {
      try {
        collectFromJson(JSON.parse(text), "", push);
      } catch {
        // Plain-text tool output: only explicit deliveries count, not every URL it printed.
        for (const mm of text.matchAll(MEDIA_RE)) push(mm[1] ?? mm[2] ?? mm[3] ?? mm[4] ?? "", true);
        for (const mm of text.matchAll(SCREENSHOT_RE)) push(mm[1], true);
      }
    }
  }
  return out;
}
