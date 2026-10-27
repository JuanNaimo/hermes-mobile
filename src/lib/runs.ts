import { useSyncExternalStore } from "react";
import type { HermesClient, MessageContent } from "./api.ts";
import { applyStreamEvent, settle, userItem, type ChatItem, type StreamState } from "./transcript.ts";

/**
 * Live turns, kept outside React so switching sessions (or closing the
 * drawer on a phone) never drops the connection — the API server
 * interrupts a run whose stream disconnects.
 *
 * Each run carries its backend's controls, so the chat view stops or
 * answers an approval the same way for the API server and the dashboard.
 */
export interface RunControls {
  stop(): Promise<void>;
  approve(item: Extract<ChatItem, { kind: "approval" }>, choice: string): Promise<void>;
  /** Answer a clarify / sudo / secret card (dashboard only). */
  respond(item: Extract<ChatItem, { kind: "input" }>, result: Record<string, unknown>): Promise<void>;
}

export interface LiveRun {
  /** Items of this turn only: the optimistic user message + streamed output. */
  stream: StreamState;
  busy: boolean;
  controls: RunControls;
  /** Picked up from the server (it was already running when this app attached), not started here. */
  resumed?: boolean;
}

type Listener = () => void;

const runs = new Map<string, LiveRun>();
const listeners = new Set<Listener>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}

function set(sessionId: string, run: LiveRun) {
  runs.set(sessionId, run);
  emit();
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getRun(sessionId: string | null): LiveRun | undefined {
  return sessionId ? runs.get(sessionId) : undefined;
}

export function clearRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (run && !run.busy) {
    runs.delete(sessionId);
    emit();
  }
}

export function busySessions(): string[] {
  return [...runs.entries()].filter(([, r]) => r.busy).map(([id]) => id);
}

/** Re-render when any live run changes. */
export function useRunsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// -- messages written while a turn runs, sent one by one after it --------------

/** A non-image file picked in the composer, read as a data URL. */
export interface FileAttachment {
  name: string;
  dataUrl: string;
  size: number;
}

export interface Queued {
  key: string;
  text: string;
  images: string[];
  files: FileAttachment[];
}

const queues = new Map<string, Queued[]>();
let queuedN = 0;

export function getQueue(sessionId: string | null): Queued[] {
  return (sessionId && queues.get(sessionId)) || [];
}

export function enqueue(sessionId: string, text: string, images: string[], files: FileAttachment[] = []): Queued {
  const item = { key: `q${++queuedN}`, text, images, files };
  queues.set(sessionId, [...getQueue(sessionId), item]);
  emit();
  return item;
}

export function dropQueued(sessionId: string, key: string) {
  const rest = getQueue(sessionId).filter((q) => q.key !== key);
  if (rest.length) queues.set(sessionId, rest);
  else queues.delete(sessionId);
  emit();
}

/** The next queued message, removed from the queue. */
export function takeQueued(sessionId: string): Queued | undefined {
  const [next] = getQueue(sessionId);
  if (next) dropQueued(sessionId, next.key);
  return next;
}

// -- building blocks for a backend's run driver ---------------------------------

/** Start a busy run showing the optimistic user message. */
export function beginRun(
  sessionId: string,
  text: string,
  images: string[],
  controls: RunControls,
  opts: { resumed?: boolean; files?: string[] } = {},
) {
  const files = opts.files ?? [];
  const items: ChatItem[] = text || images.length || files.length ? [userItem(text, images, files)] : [];
  set(sessionId, { stream: { items, finished: false }, busy: true, controls, resumed: opts.resumed });
}

/**
 * Restart a run's output from a server snapshot (its user message stays):
 * used when the events in between can't be replayed.
 */
export function resetRunOutput(sessionId: string) {
  const run = runs.get(sessionId);
  if (!run) return;
  const keep = run.stream.items[0]?.kind === "user" ? [run.stream.items[0]] : [];
  set(sessionId, { ...run, stream: { items: keep, finished: false } });
}

/** Feed one event (in the reducer's vocabulary) into a run. */
export function runEvent(sessionId: string, name: string, payload: Record<string, unknown>) {
  const run = runs.get(sessionId);
  if (run) set(sessionId, { ...run, stream: applyStreamEvent(run.stream, name, payload) });
}

/** The turn is over: settle leftovers (running tools, open segment). */
export function endRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (run?.busy) set(sessionId, { ...run, busy: false, stream: settle(run.stream) });
}

export async function stopRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (run?.busy) await run.controls.stop();
}

export async function answerApproval(sessionId: string, itemKey: string, choice: string) {
  const run = runs.get(sessionId);
  const item = run?.stream.items.find((it) => it.key === itemKey);
  if (!run || !item || item.kind !== "approval") return;
  await run.controls.approve(item, choice);
  const current = runs.get(sessionId) ?? run;
  set(sessionId, {
    ...current,
    stream: {
      ...current.stream,
      items: current.stream.items.map((it) =>
        it.key === itemKey && it.kind === "approval" ? { ...it, resolved: choice } : it,
      ),
    },
  });
}

/** Send the answer to an input card, then mark it (the answer itself is not kept). */
export async function answerInput(
  sessionId: string,
  itemKey: string,
  result: Record<string, unknown>,
  resolved: "answered" | "skipped",
) {
  const run = runs.get(sessionId);
  const item = run?.stream.items.find((it) => it.key === itemKey);
  if (!run || !item || item.kind !== "input") return;
  await run.controls.respond(item, result);
  const current = runs.get(sessionId) ?? run;
  set(sessionId, {
    ...current,
    stream: {
      ...current.stream,
      items: current.stream.items.map((it) => (it.key === itemKey && it.kind === "input" ? { ...it, resolved } : it)),
    },
  });
}

// -- API server driver (SSE over /api/sessions/{id}/chat/stream) -----------------

export async function startRun(
  client: HermesClient,
  sessionId: string,
  text: string,
  images: string[],
  onFinished?: () => void,
) {
  const content: MessageContent = images.length
    ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ]
    : text;

  const abort = new AbortController();
  beginRun(sessionId, text, images, {
    async stop() {
      const runId = runs.get(sessionId)?.stream.runId;
      try {
        if (!runId) throw new Error("no run id yet");
        await client.stopRun(runId);
      } catch {
        // Without a run id (or if /stop fails) dropping the stream interrupts the turn.
        abort.abort();
      }
    },
    async approve(item, choice) {
      await client.approve(item.runId || runs.get(sessionId)?.stream.runId || "", choice, item.requestId);
    },
    // The API server's stream never asks for input.
    async respond() {},
  });

  try {
    await client.streamChat(sessionId, content, (name, payload) => runEvent(sessionId, name, payload), abort.signal);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      runEvent(sessionId, "error", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    endRun(sessionId);
    onFinished?.();
  }
}
