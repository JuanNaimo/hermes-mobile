import { SseParser } from "./sse.ts";

/**
 * Client for the Hermes Agent API server (`hermes gateway` with
 * `API_SERVER_ENABLED=true`, default port 8642). Every call is bearer-auth'd
 * with `API_SERVER_KEY`. Only the documented, stable surface is used:
 * `/health`, `/v1/capabilities`, `/v1/models`, `/v1/skills`, `/v1/toolsets`,
 * `/api/sessions/*`, `/api/jobs/*` and the `/v1/runs/{id}` controls.
 */

export interface Connection {
  /** e.g. `http://192.168.1.20:8642` — no trailing slash, no `/v1`. */
  baseUrl: string;
  apiKey: string;
  /** Optional multi-profile routing (`/p/<profile>/…`). */
  profile?: string;
  /** Friendly label shown in the sidebar. */
  label?: string;
}

export interface Session {
  id: string;
  source?: string;
  model?: string | null;
  title?: string | null;
  started_at?: number;
  ended_at?: number | null;
  last_active?: number;
  message_count?: number;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number | null;
  preview?: string | null;
  pinned?: boolean;
  archived?: boolean;
  parent_session_id?: string | null;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: string; [key: string]: unknown };

export type MessageContent = string | ContentPart[] | null;

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface Message {
  id?: number | string;
  session_id?: string;
  role: "user" | "assistant" | "tool" | "system" | string;
  content: MessageContent;
  tool_call_id?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_name?: string | null;
  timestamp?: number;
  reasoning?: string | null;
  reasoning_content?: string | null;
  finish_reason?: string | null;
  display_kind?: string | null;
}

export interface Capabilities {
  object?: string;
  platform?: string;
  model?: string;
  auth?: { type: string; required: boolean };
  features?: Record<string, boolean>;
  endpoints?: Record<string, unknown>;
}

export interface Job {
  id: string;
  name?: string;
  prompt?: string;
  schedule?: string | Record<string, unknown>;
  schedule_display?: string;
  enabled?: boolean;
  state?: string;
  paused_at?: string | number | null;
  paused_reason?: string | null;
  next_run_at?: string | number | null;
  last_run_at?: string | number | null;
  last_status?: string | null;
  last_error?: string | null;
  deliver?: string;
  skills?: string[] | null;
  model?: string | null;
}

export interface Skill {
  name: string;
  description?: string;
  category?: string;
}

export interface Toolset {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  tools?: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Normalise whatever the user typed into a canonical base URL. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/v1$/i, "");
  return url;
}

function root(conn: Connection): string {
  const base = normalizeBaseUrl(conn.baseUrl);
  const profile = conn.profile?.trim();
  return profile ? `${base}/p/${encodeURIComponent(profile)}` : base;
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const body = await res.json();
    const err = body?.error ?? body;
    if (typeof err === "string") message = err;
    else if (err?.message) message = err.message;
    code = err?.code ?? body?.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(message, res.status, code);
}

/** Turn a low-level fetch failure into something a person can act on. */
function networkError(err: unknown, conn: Connection): Error {
  if (err instanceof DOMException && err.name === "AbortError") return err;
  const origin = typeof location !== "undefined" ? location.origin : "";
  return new ApiError(
    `No se pudo conectar con ${normalizeBaseUrl(conn.baseUrl)}. ` +
      `Revisá que el gateway esté corriendo, que la IP/puerto sean accesibles desde este dispositivo ` +
      `y que API_SERVER_CORS_ORIGINS incluya ${origin || "el origen de esta app"}.`,
    0,
    "network_error",
  );
}

/** Single-session responses come wrapped: `{ object: "hermes.session", session: {...} }`. */
type SessionEnvelope = Session | { object?: string; session: Session };

function unwrapSession(res: SessionEnvelope): Session {
  const session = "session" in res ? res.session : res;
  if (!session?.id) throw new ApiError("El servidor devolvió una sesión sin id", 0, "invalid_session");
  return session;
}

export class HermesClient {
  readonly conn: Connection;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  private headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    if (this.conn.apiKey) h.set("Authorization", `Bearer ${this.conn.apiKey}`);
    return h;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = this.headers(init.headers);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await fetch(`${root(this.conn)}${path}`, { ...init, headers });
    } catch (err) {
      throw networkError(err, this.conn);
    }
    if (!res.ok) throw await parseError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // -- discovery ----------------------------------------------------------

  health() {
    return this.request<{ status: string }>("/health");
  }

  healthDetailed() {
    return this.request<Record<string, unknown>>("/health/detailed");
  }

  capabilities() {
    return this.request<Capabilities>("/v1/capabilities");
  }

  async models(): Promise<string[]> {
    const res = await this.request<{ data?: { id: string }[] }>("/v1/models");
    return (res.data ?? []).map((m) => m.id);
  }

  async skills(): Promise<Skill[]> {
    const res = await this.request<Skill[] | { data: Skill[] }>("/v1/skills");
    return Array.isArray(res) ? res : (res?.data ?? []);
  }

  async toolsets(): Promise<Toolset[]> {
    const res = await this.request<Toolset[] | { data: Toolset[] }>("/v1/toolsets");
    return Array.isArray(res) ? res : (res?.data ?? []);
  }

  // -- sessions -----------------------------------------------------------

  async listSessions(limit = 100, offset = 0) {
    return this.request<{ data: Session[]; has_more?: boolean }>(
      `/api/sessions?limit=${limit}&offset=${offset}`,
    );
  }

  async createSession(title?: string): Promise<Session> {
    return unwrapSession(
      await this.request<SessionEnvelope>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(title ? { title } : {}),
      }),
    );
  }

  async getSession(id: string): Promise<Session> {
    return unwrapSession(await this.request<SessionEnvelope>(`/api/sessions/${encodeURIComponent(id)}`));
  }

  async renameSession(id: string, title: string): Promise<Session> {
    return unwrapSession(
      await this.request<SessionEnvelope>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    );
  }

  deleteSession(id: string) {
    return this.request<unknown>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async forkSession(id: string, title?: string): Promise<Session> {
    return unwrapSession(
      await this.request<SessionEnvelope>(`/api/sessions/${encodeURIComponent(id)}/fork`, {
        method: "POST",
        body: JSON.stringify(title ? { title } : {}),
      }),
    );
  }

  async messages(id: string): Promise<Message[]> {
    // inline_images=false keeps the transcript small over Wi-Fi/cellular.
    const res = await this.request<{ data: Message[] }>(
      `/api/sessions/${encodeURIComponent(id)}/messages?inline_images=false`,
    );
    return res.data ?? [];
  }

  /**
   * Run one streamed turn. Resolves once the server closes the stream;
   * every SSE frame is handed to `onEvent` as it arrives.
   */
  async streamChat(
    sessionId: string,
    message: MessageContent,
    onEvent: (name: string, payload: StreamPayload) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${root(this.conn)}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify({ message }),
        signal,
      });
    } catch (err) {
      throw networkError(err, this.conn);
    }
    if (!res.ok) throw await parseError(res);
    if (!res.body) throw new ApiError("El servidor no devolvió un stream", 0);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const emit = (frames: ReturnType<SseParser["push"]>) => {
      for (const frame of frames) {
        let payload: StreamPayload = {};
        try {
          payload = JSON.parse(frame.data);
        } catch {
          payload = { raw: frame.data };
        }
        onEvent(frame.event, payload);
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
    emit(parser.end());
  }

  // -- run controls -------------------------------------------------------

  stopRun(runId: string) {
    return this.request<{ status: string }>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: "{}",
    });
  }

  approve(runId: string, choice: string, requestId?: string) {
    return this.request<unknown>(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify(requestId ? { choice, request_id: requestId } : { choice }),
    });
  }

  // -- jobs ---------------------------------------------------------------

  async jobs(): Promise<Job[]> {
    const res = await this.request<{ jobs: Job[] }>("/api/jobs?include_disabled=true");
    return res.jobs ?? [];
  }

  createJob(job: { name: string; schedule: string; prompt: string }) {
    return this.request<unknown>("/api/jobs", { method: "POST", body: JSON.stringify(job) });
  }

  jobAction(id: string, action: "pause" | "resume" | "run") {
    return this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: "{}",
    });
  }

  deleteJob(id: string) {
    return this.request<unknown>(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

/** Loose shape of a session-stream event payload. */
export type StreamPayload = Record<string, unknown> & {
  run_id?: string;
  session_id?: string;
  message_id?: string;
};

/** Plain text of a message's content (text parts only). */
export function contentText(content: MessageContent): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function contentImages(content: MessageContent): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((p) =>
      p.type === "image_url" ? ((p.image_url as { url?: string } | undefined)?.url ?? "") : "",
    )
    .filter(Boolean);
}
