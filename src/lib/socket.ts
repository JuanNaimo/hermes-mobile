import { isNativeApp } from "./http.ts";

/**
 * The few WebSocket operations the gateway client needs, behind one shape so
 * it can run over the native plugin (APK), the browser's WebSocket (dev, via
 * the Vite proxy) or Node's (tests).
 *
 * Native matters for the Hermes dashboard: a WebView socket carries
 * `Origin: http://localhost`, which `/api/ws` refuses unless the dashboard is
 * bound to 0.0.0.0. The plugin's sockets (OkHttp / URLSession) send none.
 */
export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  /** Called once per socket, last. `wasOpen` false: the handshake itself failed. */
  onClose: (code: number, reason: string, wasOpen: boolean) => void;
}

export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => Socket;

/** Native plugin in the Capacitor app, WebSocket everywhere else. */
export function defaultSocketFactory(): SocketFactory {
  return isNativeApp() ? nativeSocket : webSocket;
}

export const webSocket: SocketFactory = (url, h) => {
  const ws = new WebSocket(url);
  let opened = false;
  let closed = false;
  ws.onopen = () => {
    opened = true;
    h.onOpen();
  };
  ws.onmessage = (e) => h.onMessage(typeof e.data === "string" ? e.data : String(e.data));
  ws.onclose = (e) => {
    if (closed) return;
    closed = true;
    h.onClose(e.code, e.reason, opened);
  };
  // `error` is always followed by `close`, which carries what little browsers expose.
  ws.onerror = () => {};
  return {
    send: (text) => ws.send(text),
    close: (code = 1000, reason = "") => ws.close(code, reason),
  };
};

// -- native plugin (plugins/native-websocket) -----------------------------------

interface NativeEvents {
  open: { id: string };
  message: { id: string; data: string };
  close: { id: string; code: number; reason: string; wasOpen: boolean };
  error: { id: string; message: string; status: number };
}

interface NativeWebSocketPlugin {
  connect(opts: { url: string; headers?: Record<string, string> }): Promise<{ id: string }>;
  send(opts: { id: string; data: string }): Promise<void>;
  close(opts: { id: string; code?: number; reason?: string }): Promise<void>;
  addListener<E extends keyof NativeEvents>(
    event: E,
    cb: (data: NativeEvents[E]) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

let plugin: Promise<NativeWebSocketPlugin> | null = null;
const native = new Map<string, SocketHandlers>();
/** Events for an id whose `connect` promise hasn't resolved yet. */
const early = new Map<string, Array<() => void>>();

function nativePlugin(): Promise<NativeWebSocketPlugin> {
  plugin ??= import("@capacitor/core").then(async ({ registerPlugin }) => {
    const p = registerPlugin<NativeWebSocketPlugin>("NativeWebSocket");
    const route = <E extends keyof NativeEvents>(event: E, fn: (h: SocketHandlers, d: NativeEvents[E]) => void) =>
      p.addListener(event, (d) => {
        const h = native.get(d.id);
        if (h) fn(h, d);
        else early.set(d.id, [...(early.get(d.id) ?? []), () => native.get(d.id) && fn(native.get(d.id)!, d)]);
      });
    await route("open", (h) => h.onOpen());
    await route("message", (h, d) => h.onMessage(d.data));
    await route("close", (h, d) => {
      native.delete(d.id);
      h.onClose(d.code, d.reason, d.wasOpen);
    });
    return p;
  });
  return plugin;
}

export const nativeSocket: SocketFactory = (url, h) => {
  let id: string | null = null;
  let closeRequested: { code: number; reason: string } | null = null;

  void nativePlugin()
    .then((p) => p.connect({ url }))
    .then(({ id: socketId }) => {
      id = socketId;
      native.set(socketId, h);
      early.get(socketId)?.forEach((replay) => replay());
      early.delete(socketId);
      if (closeRequested) void nativePlugin().then((p) => p.close({ id: socketId, ...closeRequested! }));
    })
    .catch((err) => h.onClose(1006, err instanceof Error ? err.message : String(err), false));

  return {
    send(text) {
      // onOpen (the only point the caller starts sending) is replayed after `id` is known.
      if (!id) throw new Error("socket not open");
      void nativePlugin().then((p) => p.send({ id: id!, data: text }));
    },
    close(code = 1000, reason = "") {
      if (!id) closeRequested = { code, reason };
      else void nativePlugin().then((p) => p.close({ id: id!, code, reason }));
    },
  };
};
