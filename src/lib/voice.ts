import { useSyncExternalStore } from "react";

/**
 * Voice on this device: record with the mic for dictation, play replies out
 * loud. The dashboard does the speech work (`/api/audio/transcribe` and
 * `/api/audio/speak`); this module only captures and plays.
 */

/** What Hermes Desktop prefers; Android WebViews record webm/opus, iOS mp4. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

/** The dashboard's default `voice.max_recording_seconds`. */
export const MAX_RECORDING_MS = 120_000;

export interface Recording {
  /** Stop and get the clip. */
  stop(): Promise<Blob>;
  /** Stop and throw the clip away. */
  cancel(): void;
}

function micError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("No hay permiso para usar el micrófono. Habilitalo en los ajustes de la app.");
  }
  if (name === "NotFoundError") return new Error("No se encontró un micrófono.");
  return err instanceof Error ? err : new Error(String(err));
}

/** Start recording; `onLimit` fires when the clip reaches {@link MAX_RECORDING_MS}. */
export async function startRecording(onLimit?: () => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Este dispositivo no permite grabar audio desde la app.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw micError(err);
  }
  const mimeType = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const clip = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    };
  });
  const limit = setTimeout(() => onLimit?.(), MAX_RECORDING_MS);
  const end = () => {
    clearTimeout(limit);
    if (recorder.state !== "inactive") recorder.stop();
  };
  recorder.start();
  return {
    stop() {
      end();
      return clip;
    },
    cancel: end,
  };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el audio"));
    reader.readAsDataURL(blob);
  });
}

/** Markdown → what should be said: no code, no markup, no URLs. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/(\*\*|__|\*|~~)(?=\S)|(?<=\S)(\*\*|__|\*|~~)/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// -- playback: one reply at a time, app-wide --------------------------------------

export type SpeechState = { key: string; phase: "loading" | "playing" } | null;

let state: SpeechState = null;
let audio: HTMLAudioElement | null = null;
/** Bumped on every start/stop, so a slow synthesis can't play after being cancelled. */
let generation = 0;
const listeners = new Set<() => void>();

function set(next: SpeechState) {
  state = next;
  listeners.forEach((l) => l());
}

export function stopSpeaking() {
  generation++;
  audio?.pause();
  audio = null;
  if (state) set(null);
}

/**
 * Say `text` (markdown) out loud, replacing whatever is playing. `key` names
 * what is being read so its button can show it; `synthesize` fetches the audio.
 */
export async function speak(key: string, text: string, synthesize: (text: string) => Promise<string>): Promise<void> {
  stopSpeaking();
  const said = speechText(text);
  if (!said) return;
  const mine = generation;
  set({ key, phase: "loading" });
  try {
    const url = await synthesize(said);
    if (mine !== generation) return;
    const el = new Audio(url);
    audio = el;
    el.onended = () => mine === generation && stopSpeaking();
    el.onerror = () => mine === generation && stopSpeaking();
    await el.play();
    if (mine === generation) set({ key, phase: "playing" });
  } catch (err) {
    if (mine === generation) stopSpeaking();
    throw err;
  }
}

export function useSpeech(): SpeechState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
