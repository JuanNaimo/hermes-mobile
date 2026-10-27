import { contentImages, contentText, type Message, type StreamPayload } from "./api.ts";

/**
 * The chat view renders a flat list of items. History from
 * `/api/sessions/{id}/messages` and live SSE events both reduce into it.
 */
export type ChatItem =
  | {
      kind: "user";
      key: string;
      text: string;
      images: string[];
      /** Names of attached files (their `@file:` refs are kept out of `text`). */
      files?: string[];
      /** Those refs as sent, so a retry can point at the same files again. */
      fileRefs?: string[];
      /** A correction sent into a running turn. */
      steer?: boolean;
    }
  | {
      kind: "assistant";
      key: string;
      text: string;
      reasoning: string;
      streaming: boolean;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      args: string;
      result: string;
      status: "running" | "done" | "failed";
      callId?: string;
      /** Dashboard gateway's stable `tool_id`, to pair start and completion. */
      toolId?: string;
    }
  | {
      kind: "approval";
      key: string;
      runId: string;
      requestId?: string;
      /** Dashboard gateway: the JSON-RPC id of the server→client request to answer. */
      rpcId?: string | number;
      command: string;
      description: string;
      choices: string[];
      resolved?: string;
    }
  | {
      /** The agent asks for input mid-turn (dashboard gateway server→client requests). */
      kind: "input";
      key: string;
      rpcId: string | number;
      method: "clarify" | "sudo" | "secret";
      questions?: ClarifyQuestion[];
      /** sudo: the command that needs the password. */
      command?: string;
      /** secret: the env var asked for and the tool's explanation. */
      envVar?: string;
      prompt?: string;
      /** The answer itself is never kept here: secrets must not linger in the transcript. */
      resolved?: "answered" | "skipped" | "cancelled";
    }
  | { kind: "notice"; key: string; tone: "error" | "info"; text: string };

export interface ClarifyQuestion {
  qid: string;
  question: string;
  choices?: string[] | null;
  multi_select?: boolean;
}

let seq = 0;
const nextKey = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Pretty-print a JSON arguments string when possible. */
function prettyArgs(raw: unknown): string {
  if (typeof raw !== "string") return stringify(raw);
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** `@file:path` (optionally quoted) on its own line: how the gateway references an attached file. */
const FILE_REF_LINE = /^@file:(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))\s*$/;

/** Split the leading `@file:` lines off a user message: what the person wrote, and the files' names. */
export function splitFileRefs(text: string): { text: string; files: string[]; refs: string[] } {
  const lines = text.split("\n");
  const files: string[] = [];
  const refs: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = FILE_REF_LINE.exec(lines[i].trim());
    if (!m) break;
    const path = m[1] ?? m[2] ?? m[3] ?? m[4];
    files.push(path.split("/").pop() || path);
    refs.push(lines[i].trim());
  }
  if (!files.length) return { text, files, refs };
  return { text: lines.slice(i).join("\n").trim(), files, refs };
}

export function historyToItems(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolByCallId = new Map<string, Extract<ChatItem, { kind: "tool" }>>();

  for (const m of messages) {
    const key = `h-${m.id ?? nextKey("m")}`;
    if (m.role === "user") {
      const { text, files, refs } = splitFileRefs(contentText(m.content));
      const images = contentImages(m.content);
      if (text || images.length || files.length) {
        items.push({ kind: "user", key, text, images, ...(files.length ? { files, fileRefs: refs } : {}) });
      }
    } else if (m.role === "assistant") {
      const text = contentText(m.content);
      const reasoning = m.reasoning_content || m.reasoning || "";
      if (text || reasoning) {
        items.push({ kind: "assistant", key, text, reasoning, streaming: false });
      }
      for (const [i, call] of (m.tool_calls ?? []).entries()) {
        const tool: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          key: `${key}-t${i}`,
          name: call.function?.name || "tool",
          args: prettyArgs(call.function?.arguments),
          result: "",
          status: "done",
          callId: call.id,
        };
        items.push(tool);
        if (call.id) toolByCallId.set(call.id, tool);
      }
    } else if (m.role === "tool") {
      const result = contentText(m.content);
      const owner = m.tool_call_id ? toolByCallId.get(m.tool_call_id) : undefined;
      if (owner) owner.result = result;
      else
        items.push({
          kind: "tool",
          key,
          name: m.tool_name || "tool",
          args: "",
          result,
          status: "done",
        });
    }
  }
  return items;
}

export interface StreamState {
  items: ChatItem[];
  runId?: string;
  /** Key of the assistant segment currently receiving deltas. */
  openKey?: string;
  finished: boolean;
}

function updateItem(items: ChatItem[], key: string, patch: (it: ChatItem) => ChatItem): ChatItem[] {
  return items.map((it) => (it.key === key ? patch(it) : it));
}

function ensureOpenSegment(state: StreamState): StreamState {
  if (state.openKey) return state;
  const key = nextKey("a");
  return {
    ...state,
    openKey: key,
    items: [...state.items, { kind: "assistant", key, text: "", reasoning: "", streaming: true }],
  };
}

function closeSegment(state: StreamState): StreamState {
  if (!state.openKey) return state;
  const key = state.openKey;
  // Drop a segment that never received text (e.g. tool call straight away).
  const items = state.items
    .map((it) => (it.key === key && it.kind === "assistant" ? { ...it, streaming: false } : it))
    .filter((it) => !(it.key === key && it.kind === "assistant" && !it.text && !it.reasoning));
  return { ...state, items, openKey: undefined };
}

/** Pure reducer: apply one SSE event of a session chat stream. */
export function applyStreamEvent(state: StreamState, name: string, p: StreamPayload): StreamState {
  if (p.run_id && !state.runId) state = { ...state, runId: p.run_id };

  switch (name) {
    case "assistant.delta": {
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!delta) return state;
      const s = ensureOpenSegment(state);
      return {
        ...s,
        items: updateItem(s.items, s.openKey!, (it) =>
          it.kind === "assistant" ? { ...it, text: it.text + delta } : it,
        ),
      };
    }
    case "tool.progress": {
      // Reasoning tokens arrive as a pseudo-tool named `_thinking`.
      if (p.tool_name !== "_thinking") return state;
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!delta) return state;
      const s = ensureOpenSegment(state);
      return {
        ...s,
        items: updateItem(s.items, s.openKey!, (it) =>
          it.kind === "assistant" ? { ...it, reasoning: it.reasoning + delta } : it,
        ),
      };
    }
    case "assistant.commentary": {
      if (p.already_streamed) return state;
      const text = typeof p.text === "string" ? p.text : "";
      if (!text.trim()) return state;
      const s = closeSegment(state);
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "assistant", key: nextKey("c"), text, reasoning: "", streaming: false },
        ],
      };
    }
    case "tool.started": {
      const s = closeSegment(state);
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "tool",
            key: nextKey("t"),
            name: String(p.tool_name ?? "tool"),
            args: p.args != null ? stringify(p.args) : String(p.preview ?? ""),
            result: "",
            status: "running",
            toolId: typeof p.tool_id === "string" ? p.tool_id : undefined,
          },
        ],
      };
    }
    case "tool.completed":
    case "tool.failed": {
      const name_ = String(p.tool_name ?? "");
      const toolId = typeof p.tool_id === "string" ? p.tool_id : undefined;
      // By id when the backend gives one, else the most recent running call of that tool.
      const idx = [...state.items]
        .reverse()
        .findIndex(
          (it) =>
            it.kind === "tool" &&
            it.status === "running" &&
            (toolId && it.toolId ? it.toolId === toolId : !name_ || it.name === name_),
        );
      if (idx === -1) return state;
      const target = state.items[state.items.length - 1 - idx];
      return {
        ...state,
        items: updateItem(state.items, target.key, (it) =>
          it.kind === "tool"
            ? {
                ...it,
                status: name === "tool.failed" ? "failed" : "done",
                result: typeof p.preview === "string" ? p.preview : it.result,
              }
            : it,
        ),
      };
    }
    case "approval.request": {
      const s = closeSegment(state);
      const choices = Array.isArray(p.choices) ? (p.choices as string[]) : ["once", "deny"];
      const requestId = (p.request_id ?? p.prompt_id ?? p.approval_id) as string | undefined;
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "approval",
            key: nextKey("ap"),
            runId: String(p.run_id ?? s.runId ?? ""),
            requestId,
            rpcId: p.rpc_id as string | number | undefined,
            command: stringify(p.command),
            description: stringify(p.description ?? p.reason ?? p.pattern_key ?? ""),
            choices,
          },
        ],
      };
    }
    case "assistant.segment_end":
      return closeSegment(state);
    case "user.steer": {
      // Lands at the agent's next tool boundary, inside the running turn.
      const s = closeSegment(state);
      const text = typeof p.text === "string" ? p.text : "";
      return text ? { ...s, items: [...s.items, { kind: "user", key: nextKey("st"), text, images: [], steer: true }] } : s;
    }
    case "input.request": {
      const s = closeSegment(state);
      const method = p.method as "clarify" | "sudo" | "secret";
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "input",
            key: nextKey("in"),
            rpcId: p.rpc_id as string | number,
            method,
            questions: Array.isArray(p.questions) ? (p.questions as ClarifyQuestion[]) : undefined,
            command: typeof p.command === "string" ? p.command : undefined,
            envVar: typeof p.env_var === "string" ? p.env_var : undefined,
            prompt: typeof p.prompt === "string" ? p.prompt : undefined,
          },
        ],
      };
    }
    case "request.withdrawn": {
      // Withdrawn by the backend (interrupt, timeout, answered elsewhere): the card stops asking.
      const ids = new Set((Array.isArray(p.request_ids) ? p.request_ids : []).map(String));
      if (p.rpc_id != null) ids.add(`rpc:${p.rpc_id}`);
      const matches = (requestId: string | undefined, rpcId: string | number | undefined) =>
        (requestId != null && ids.has(requestId)) || (rpcId != null && ids.has(`rpc:${rpcId}`));
      return {
        ...state,
        items: state.items.map((it) =>
          (it.kind === "approval" || it.kind === "input") &&
          !it.resolved &&
          matches(it.kind === "approval" ? it.requestId : undefined, it.rpcId)
            ? { ...it, resolved: "cancelled" }
            : it,
        ),
      };
    }
    case "assistant.completed": {
      const content = typeof p.content === "string" ? p.content : "";
      let s = state;
      if (content) {
        const open = s.openKey
          ? s.items.find((it) => it.key === s.openKey && it.kind === "assistant")
          : undefined;
        if (open && open.kind === "assistant") {
          s = {
            ...s,
            items: updateItem(s.items, open.key, (it) =>
              it.kind === "assistant" ? { ...it, text: content } : it,
            ),
          };
        } else {
          // Final text already streamed into an earlier (closed) segment of this run.
          const already = s.items.some(
            (it) => it.kind === "assistant" && it.text.trim() === content.trim(),
          );
          if (!already) {
            s = ensureOpenSegment(s);
            s = {
              ...s,
              items: updateItem(s.items, s.openKey!, (it) =>
                it.kind === "assistant" ? { ...it, text: content } : it,
              ),
            };
          }
        }
      }
      return closeSegment(s);
    }
    case "run.failed":
    case "error": {
      const s = closeSegment(state);
      const msg = String(p.message ?? p.error ?? "La ejecución falló");
      return {
        ...s,
        finished: true,
        items: [...s.items, { kind: "notice", key: nextKey("n"), tone: "error", text: msg }],
      };
    }
    case "run.cancelled": {
      const s = closeSegment(state);
      return {
        ...s,
        finished: true,
        items: [...s.items, { kind: "notice", key: nextKey("n"), tone: "info", text: "Ejecución detenida" }],
      };
    }
    case "run.completed":
    case "done":
      return { ...closeSegment(state), finished: true };
    default:
      return state;
  }
}

/** Mark any tool still "running" as done once the stream is over. */
export function settle(state: StreamState): StreamState {
  const s = closeSegment(state);
  return {
    ...s,
    finished: true,
    items: s.items.map((it) =>
      it.kind === "tool" && it.status === "running" ? { ...it, status: "done" } : it,
    ),
  };
}

export function userItem(text: string, images: string[], files: string[] = []): ChatItem {
  return { kind: "user", key: nextKey("u"), text, images, ...(files.length ? { files } : {}) };
}
