import { useSyncExternalStore } from "react";
import { applySubagentEvent, isActive, type Subagent } from "./subagents.ts";

/**
 * What the gateway says about each session while it is attached (dashboard
 * mode), keyed by STORED id: the model and effort it runs with, its token and
 * context usage, its todo list, and the fences an authority-hosted dashboard
 * wants on edits. Fed by `session.create` / `session.resume` results and by
 * `session.info` / `session.usage` / `todo.updated` events, which arrive
 * whether or not a turn is running.
 */

/** `tui_gateway/server.py::_get_usage` (subset the app shows). */
export interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  calls?: number;
  context_used?: number | null;
  context_max?: number | null;
  context_percent?: number | null;
  context_estimated?: boolean | null;
  cache_hit_pct?: number | null;
  cost_usd?: number | null;
  cost_status?: string | null;
  compressions?: number | null;
  avg_tps?: number | null;
}

/** `SessionLiveInfo` (subset). */
export interface LiveInfo {
  model?: string;
  provider?: string;
  reasoning_effort?: string;
  reasoning_effort_wire?: string;
  service_tier?: string;
  fast?: boolean;
  yolo?: boolean;
  approval_mode?: string;
  personality?: string;
  title?: string;
  running?: boolean;
  credential_warning?: string | null;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

/** The gateway's transient status line (`status.update`): what the agent is doing right now. */
export interface LiveStatus {
  kind: string;
  text: string;
}

/** A `/btw` question or `/background` task: runs beside the conversation, answered by an event. */
export interface SideTask {
  taskId: string;
  kind: "btw" | "background";
  question: string;
  /** Set once `btw.complete` / `background.complete` arrives. */
  answer?: string;
  failed?: boolean;
}

export interface LiveSession {
  info: LiveInfo;
  sideTasks: SideTask[];
  /** Children delegated by this session's turns (`subagent.*`). */
  subagents: Subagent[];
  status?: LiveStatus | null;
  usage: Usage | null;
  todos: Todo[];
  todoRevision: number;
  /** Authority mode: `session.mutate` must present these. */
  revision?: number;
  generation?: number;
}

const EMPTY: LiveSession = { info: {}, usage: null, todos: [], todoRevision: -1, sideTasks: [], subagents: [] };

const sessions = new Map<string, LiveSession>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getLive(storedId: string | null | undefined): LiveSession {
  return (storedId && sessions.get(storedId)) || EMPTY;
}

function update(storedId: string, fn: (s: LiveSession) => LiveSession) {
  sessions.set(storedId, fn(getLive(storedId)));
  emit();
}

const INFO_KEYS: (keyof LiveInfo)[] = [
  "model",
  "provider",
  "reasoning_effort",
  "reasoning_effort_wire",
  "service_tier",
  "fast",
  "yolo",
  "approval_mode",
  "personality",
  "title",
  "running",
  "credential_warning",
];

/** Merge a `SessionLiveInfo`-shaped object (absent keys keep their value). */
export function mergeInfo(storedId: string, raw: Record<string, unknown> | null | undefined) {
  if (!raw || typeof raw !== "object") return;
  const picked: Partial<LiveInfo> = {};
  for (const key of INFO_KEYS) if (key in raw) (picked as Record<string, unknown>)[key] = raw[key];
  const usage = raw.usage && typeof raw.usage === "object" ? (raw.usage as Usage) : undefined;
  update(storedId, (s) => ({ ...s, info: { ...s.info, ...picked }, usage: usage ?? s.usage }));
}

export function setStatus(storedId: string, status: LiveStatus | null) {
  const cur = getLive(storedId).status;
  if (cur?.kind === status?.kind && cur?.text === status?.text) return;
  update(storedId, (s) => ({ ...s, status }));
}

export function subagentEvent(storedId: string, type: string, payload: Record<string, unknown>) {
  update(storedId, (s) => ({ ...s, subagents: applySubagentEvent(s.subagents, type, payload) }));
}

/** A new turn starts: children of earlier turns that already ended drop off. */
export function pruneSubagents(storedId: string) {
  const cur = getLive(storedId).subagents;
  const kept = cur.filter(isActive);
  if (kept.length !== cur.length) update(storedId, (s) => ({ ...s, subagents: kept }));
}

export function addSideTask(storedId: string, task: SideTask) {
  update(storedId, (s) => ({ ...s, sideTasks: [...s.sideTasks, task] }));
}

/** The side agent's text; the gateway reports a failure as `error: <message>`. */
export function finishSideTask(storedId: string, taskId: unknown, text: unknown) {
  const answer = typeof text === "string" ? text : "";
  const failed = /^error: /.test(answer);
  update(storedId, (s) => ({
    ...s,
    sideTasks: s.sideTasks.map((t) =>
      t.taskId === taskId ? { ...t, answer: failed ? answer.slice(7) : answer, failed } : t,
    ),
  }));
}

export function dismissSideTask(storedId: string, taskId: string) {
  update(storedId, (s) => ({ ...s, sideTasks: s.sideTasks.filter((t) => t.taskId !== taskId) }));
}

export function setUsage(storedId: string, usage: unknown) {
  if (!usage || typeof usage !== "object") return;
  update(storedId, (s) => ({ ...s, usage: { ...s.usage, ...(usage as Usage) } }));
}

/** A full todo snapshot; older revisions (replays) are ignored. */
export function setTodos(storedId: string, todos: unknown, revision?: unknown) {
  if (!Array.isArray(todos)) return;
  const rev = typeof revision === "number" ? revision : Number.MAX_SAFE_INTEGER;
  if (rev < getLive(storedId).todoRevision) return;
  const clean = todos
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .map((t, i) => ({
      id: String(t.id ?? i),
      content: String(t.content ?? ""),
      status: (["pending", "in_progress", "completed", "cancelled"].includes(String(t.status))
        ? t.status
        : "pending") as TodoStatus,
    }));
  update(storedId, (s) => ({ ...s, todos: clean, todoRevision: typeof revision === "number" ? revision : s.todoRevision }));
}

/** Adopt fences monotonically: a late, older receipt never moves them back. */
export function adoptFences(storedId: string, revision?: unknown, generation?: unknown) {
  const s = getLive(storedId);
  const rev = typeof revision === "number" && revision > (s.revision ?? -1) ? revision : s.revision;
  const gen = typeof generation === "number" && generation > (s.generation ?? -1) ? generation : s.generation;
  if (rev !== s.revision || gen !== s.generation) update(storedId, (cur) => ({ ...cur, revision: rev, generation: gen }));
}

/** The connection dropped: fences belong to it, the rest is still a fair last-known view. */
export function forgetFences() {
  for (const [id, s] of sessions) sessions.set(id, { ...s, revision: undefined, generation: undefined });
  emit();
}

export function useLive(storedId: string | null | undefined): LiveSession {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => getLive(storedId),
  );
}
