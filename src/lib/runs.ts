import { useSyncExternalStore } from "react";
import type { HermesClient, MessageContent } from "./api.ts";
import { applyStreamEvent, settle, userItem, type ChatItem, type StreamState } from "./transcript.ts";

/**
 * Live turns, kept outside React so switching sessions (or closing the
 * drawer on a phone) never drops the SSE connection — the server interrupts
 * a run whose stream disconnects.
 */
export interface LiveRun {
  /** Items of this turn only: the optimistic user message + streamed output. */
  stream: StreamState;
  busy: boolean;
  abort: AbortController;
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
  const items: ChatItem[] = [userItem(text, images)];
  set(sessionId, { stream: { items, finished: false }, busy: true, abort });

  const update = (fn: (s: StreamState) => StreamState) => {
    const run = runs.get(sessionId);
    if (!run) return;
    set(sessionId, { ...run, stream: fn(run.stream) });
  };

  try {
    await client.streamChat(
      sessionId,
      content,
      (name, payload) => update((s) => applyStreamEvent(s, name, payload)),
      abort.signal,
    );
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      const message = err instanceof Error ? err.message : String(err);
      update((s) => applyStreamEvent(s, "error", { message }));
    }
  } finally {
    const run = runs.get(sessionId);
    if (run) set(sessionId, { ...run, busy: false, stream: settle(run.stream) });
    onFinished?.();
  }
}

export async function stopRun(client: HermesClient, sessionId: string) {
  const run = runs.get(sessionId);
  if (!run?.busy) return;
  const runId = run.stream.runId;
  try {
    if (!runId) throw new Error("no run id yet");
    await client.stopRun(runId);
  } catch {
    // Without a run id (or if /stop fails) dropping the stream interrupts the turn.
    run.abort.abort();
  }
}

export async function answerApproval(
  client: HermesClient,
  sessionId: string,
  itemKey: string,
  choice: string,
) {
  const run = runs.get(sessionId);
  const item = run?.stream.items.find((it) => it.key === itemKey);
  if (!run || !item || item.kind !== "approval") return;
  await client.approve(item.runId || run.stream.runId || "", choice, item.requestId);
  set(sessionId, {
    ...run,
    stream: {
      ...run.stream,
      items: run.stream.items.map((it) =>
        it.key === itemKey && it.kind === "approval" ? { ...it, resolved: choice } : it,
      ),
    },
  });
}
