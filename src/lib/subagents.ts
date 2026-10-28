/**
 * Delegated children of a session (`delegate_task`), from the gateway's
 * `subagent.*` events (tui_gateway/contracts/events.py, SubagentEventPayload).
 * A pure reducer, after Hermes Desktop's store/subagents.ts, trimmed to what
 * the app shows: one row per child, nested by `parent_id`.
 */

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface Subagent {
  id: string;
  parentId: string | null;
  goal: string;
  status: SubagentStatus;
  taskIndex: number;
  taskCount: number;
  model?: string;
  /** The tool it's running now (cleared once it ends). */
  currentTool?: string;
  /** Latest line of progress or reasoning, or the final summary. */
  detail?: string;
  toolCount?: number;
  durationSeconds?: number;
  startedAt: number;
}

export interface SubagentNode extends Subagent {
  children: SubagentNode[];
}

const TERMINAL = new Set<SubagentStatus>(["completed", "failed", "interrupted"]);

export const isActive = (s: Subagent) => !TERMINAL.has(s.status);

function asStatus(v: unknown, terminalEvent: boolean): SubagentStatus {
  if (v === "completed" || v === "failed" || v === "interrupted") return v;
  if (v === "timeout" || v === "error") return "failed";
  if (v === "cancelled" || v === "canceled") return "interrupted";
  if (terminalEvent) return "failed";
  return v === "queued" ? "queued" : "running";
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const line = (text: string, max = 160) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Older emitters leave out the ids: fall back to the batch and task position. */
function idOf(p: Record<string, unknown>): string {
  return str(p.subagent_id) || `${str(p.delegation_id) || str(p.goal)}#${num(p.task_index) ?? 0}`;
}

export function applySubagentEvent(
  list: Subagent[],
  type: string,
  p: Record<string, unknown>,
  now = Date.now(),
): Subagent[] {
  if (!type.startsWith("subagent.")) return list;
  const id = idOf(p);
  const at = list.findIndex((s) => s.id === id);
  const prev: Subagent = at === -1
    ? {
        id,
        parentId: str(p.parent_id) || null,
        goal: str(p.goal),
        status: "queued",
        taskIndex: num(p.task_index) ?? 0,
        taskCount: num(p.task_count) ?? 1,
        startedAt: now,
      }
    : list[at];
  // A finished child ignores late progress frames.
  if (!TERMINAL.has(prev.status) || type === "subagent.complete") {
    const next: Subagent = {
      ...prev,
      goal: str(p.goal) || prev.goal,
      parentId: str(p.parent_id) || prev.parentId,
      model: str(p.model) || prev.model,
      toolCount: num(p.tool_count) ?? prev.toolCount,
    };
    switch (type) {
      case "subagent.spawn_requested":
        next.status = "queued";
        break;
      case "subagent.start":
        next.status = "running";
        break;
      case "subagent.tool":
        next.status = "running";
        next.currentTool = str(p.tool_name) || next.currentTool;
        if (str(p.tool_preview)) next.detail = line(str(p.tool_preview));
        break;
      case "subagent.progress":
      case "subagent.thinking":
        next.status = "running";
        if (str(p.text)) next.detail = line(str(p.text));
        break;
      case "subagent.complete":
        next.status = asStatus(p.status, true);
        next.currentTool = undefined;
        next.durationSeconds = num(p.duration_seconds) ?? next.durationSeconds;
        if (str(p.summary)) next.detail = line(str(p.summary), 280);
        break;
    }
    list = at === -1 ? [...list, next] : list.map((s, i) => (i === at ? next : s));
  }
  return list;
}

/** Children under their parents, in start order. */
export function buildSubagentTree(list: readonly Subagent[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>(list.map((s) => [s.id, { ...s, children: [] }]));
  const roots: SubagentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const order = (a: SubagentNode, b: SubagentNode) => a.startedAt - b.startedAt || a.taskIndex - b.taskIndex;
  const walk = (n: SubagentNode) => n.children.sort(order).forEach(walk);
  roots.sort(order).forEach(walk);
  return roots;
}
