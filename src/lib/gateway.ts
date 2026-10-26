import { defaultSocketFactory, type Socket, type SocketFactory } from "./socket.ts";

/**
 * JSON-RPC 2.0 client for the Hermes dashboard's chat socket (`/api/ws`,
 * tui_gateway/ws.py). One JSON object per WebSocket frame, both ways:
 *
 *   server → `{"method":"event","params":{type, session_id, payload}}`
 *   server → `{"id":"…","method":"approval","params":{…}}`   (asks the client)
 *   client → `{"id":1,"method":"prompt.submit","params":{…}}` → `{"id":1,"result":…}`
 *
 * After connecting the server sends `gateway.ready`; the client must then
 * declare `client.capabilities {server_requests: true}` or approvals fail.
 */

export interface GatewayEvent {
  type: string;
  session_id?: string;
  payload: Record<string, unknown>;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export type GatewayStatus = "idle" | "connecting" | "open" | "closed";

export class GatewayError extends Error {
  readonly code: number | string;

  constructor(message: string, code: number | string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

/**
 * Server→client requests this client answers; anything else (vault prompts,
 * desktop window bridges…) gets -32601 so the agent fails fast instead of waiting.
 */
const HANDLED_SERVER_REQUESTS = new Set(["approval", "clarify", "sudo", "secret"]);

const REQUEST_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 15_000;
const PING_EVERY_MS = 25_000;
const PING_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayOptions {
  /** A fresh, authenticated `ws(s)://…/api/ws?…` URL per connection attempt. */
  url: (attempt: number) => Promise<string>;
  socketFactory?: SocketFactory;
  onEvent?: (event: GatewayEvent) => void;
  onServerRequest?: (req: ServerRequest) => void;
  onStatus?: (status: GatewayStatus, detail?: string) => void;
}

export class GatewayClient {
  private readonly opts: GatewayOptions;
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private status: GatewayStatus = "idle";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: GatewayEvent) => void>();
  private readonly disconnectListeners = new Set<(reason: string) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  get state(): GatewayStatus {
    return this.status;
  }

  /** Subscribe to events; returns the unsubscribe function. */
  on(listener: (e: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires when an open connection drops (not on `close()`). */
  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private setStatus(status: GatewayStatus, detail?: string) {
    this.status = status;
    this.opts.onStatus?.(status, detail);
  }

  /** Connect if needed. Two handshake attempts: the second gets a freshly minted credential. */
  connect(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    this.connecting ??= (async () => {
      this.closedByUs = false;
      let lastError: Error | null = null;
      for (const attempt of [0, 1]) {
        try {
          await this.open(await this.opts.url(attempt));
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (this.closedByUs) break;
        }
      }
      this.setStatus("closed", lastError?.message);
      throw lastError ?? new GatewayError("No se pudo conectar", "connect_failed");
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private open(url: string): Promise<void> {
    this.setStatus("connecting");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(err);
      };
      const readyTimer = setTimeout(() => {
        fail(new GatewayError("El dashboard no respondió al abrir el chat", "ready_timeout"));
        socket.close(4000, "ready timeout");
      }, READY_TIMEOUT_MS);

      const socket = this.opts.socketFactory
        ? this.opts.socketFactory(url, handlers())
        : defaultSocketFactory()(url, handlers());
      this.socket = socket;

      function handlers() {
        return {
          onOpen: () => {},
          onMessage: (text: string) => onText(text),
          onClose: (code: number, reason: string, wasOpen: boolean) => onClose(code, reason, wasOpen),
        };
      }

      const onText = (text: string) => {
        // Normally one object per frame; tolerate newline-joined batches.
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!ready && msg.method === "event" && (msg.params as GatewayEvent | undefined)?.type === "gateway.ready") {
            ready = true;
            this.setStatus("open");
            this.startPing();
            this.request("client.capabilities", { server_requests: true }).then(
              () => {
                if (settled) return;
                settled = true;
                clearTimeout(readyTimer);
                resolve();
              },
              (err) => fail(err),
            );
            continue;
          }
          this.handle(msg);
        }
      };

      const onClose = (code: number, reason: string, wasOpen: boolean) => {
        if (this.socket === socket) this.socket = null;
        this.stopPing();
        const why = describeClose(code, reason, wasOpen);
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new GatewayError(why, "disconnected"));
          this.pending.delete(id);
        }
        if (!settled) {
          fail(new GatewayError(why, code));
          return;
        }
        this.setStatus("closed", why);
        if (!this.closedByUs) this.disconnectListeners.forEach((l) => l(why));
      };
    });
  }

  private handle(msg: Record<string, unknown>) {
    if (msg.method === "event") {
      const params = (msg.params ?? {}) as Partial<GatewayEvent>;
      const event: GatewayEvent = { type: String(params.type ?? ""), session_id: params.session_id, payload: params.payload ?? {} };
      this.opts.onEvent?.(event);
      this.listeners.forEach((l) => l(event));
      return;
    }
    if (typeof msg.method === "string" && msg.id != null && !("result" in msg) && !("error" in msg)) {
      const req: ServerRequest = { id: msg.id as string | number, method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> };
      if (HANDLED_SERVER_REQUESTS.has(req.method) && this.opts.onServerRequest) this.opts.onServerRequest(req);
      else this.respondError(req.id, -32601, `hermes-mobile no maneja "${req.method}"`);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const error = msg.error as { code?: number; message?: string } | undefined;
      if (error) p.reject(new GatewayError(error.message || "Error del gateway", error.code ?? "rpc_error"));
      else p.resolve(msg.result);
    }
  }

  private sendFrame(frame: Record<string, unknown>) {
    if (!this.socket) throw new GatewayError("El chat del dashboard no está conectado", "not_connected");
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  }

  /** Call a method; connects first when needed (except during the handshake itself). */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.status !== "open" && method !== "client.capabilities") await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError(`Sin respuesta del dashboard a ${method}`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendFrame({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  respond(id: string | number, result: unknown) {
    this.sendFrame({ id, result });
  }

  respondError(id: string | number, code: number, message: string) {
    try {
      this.sendFrame({ id, error: { code, message } });
    } catch {
      /* socket gone: the server cancels the request itself */
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // A ping that goes unanswered means a dead link the OS hasn't noticed yet.
      this.request("gateway.ping", {}, PING_TIMEOUT_MS).catch(() => this.socket?.close(4000, "ping timeout"));
    }, PING_EVERY_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close() {
    this.closedByUs = true;
    this.stopPing();
    this.socket?.close(1000, "client closed");
    this.socket = null;
    if (this.status !== "idle") this.setStatus("closed");
  }
}

function describeClose(code: number, reason: string, wasOpen: boolean): string {
  if (!wasOpen) {
    // Browsers hide the HTTP status of a refused upgrade (always 1006); native sockets report it.
    const status = /HTTP (\d{3})/.exec(reason)?.[1];
    if (status === "401" || status === "403") {
      return "El dashboard rechazó la conexión del chat (credencial vencida, chat deshabilitado o Origin no permitido).";
    }
    return `No se pudo abrir el chat del dashboard (/api/ws)${reason ? `: ${reason}` : ""}.`;
  }
  if (code === 4401) return "El dashboard cerró el chat: credencial inválida.";
  if (code === 4403) return "El dashboard cerró el chat: el chat embebido está deshabilitado o el origen no está permitido.";
  return `Se cortó la conexión con el dashboard${reason ? ` (${reason})` : ""}.`;
}
