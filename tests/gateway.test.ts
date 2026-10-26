import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WS from "ws";
import { DashboardClient, dashboardLogin } from "../src/lib/dashboard.ts";
import { GatewayClient, type GatewayEvent } from "../src/lib/gateway.ts";
import { approvalToStream, gatewayEventToStream } from "../src/lib/gatewayEvents.ts";
import { applyStreamEvent, settle, type StreamState } from "../src/lib/transcript.ts";
import { webSocket } from "../src/lib/socket.ts";
// @ts-expect-error plain JS module without types
import { startMockDashboard } from "../scripts/mock-dashboard.mjs";

let mock: { port: number; close: () => Promise<void> };
let dash: DashboardClient;
let base: string;

before(async () => {
  mock = await startMockDashboard({ port: 0, log: false });
  base = `http://127.0.0.1:${mock.port}`;
  dash = new DashboardClient(base, await dashboardLogin({ baseUrl: base, username: "hermes", password: "hermes" }));
});
after(() => mock.close());

/** Connect a gateway client that auto-answers approvals with `choice`. */
function gateway(choice = "once") {
  let state: StreamState = { items: [], finished: false };
  const apply = (name: string, payload: Record<string, unknown>) => (state = applyStreamEvent(state, name, payload));
  const gw: GatewayClient = new GatewayClient({
    url: (attempt) => dash.wsUrl(attempt),
    socketFactory: webSocket,
    onServerRequest: (req) => {
      const [name, payload] = approvalToStream(req);
      apply(name, payload);
      gw.respond(req.id, { choice });
    },
  });
  const events: GatewayEvent[] = [];
  gw.on((e) => {
    events.push(e);
    for (const [name, payload] of gatewayEventToStream(e)) apply(name, payload);
  });
  const done = () =>
    new Promise<void>((resolve) => {
      const off = gw.on((e) => {
        if (e.type === "message.complete") {
          off();
          resolve();
        }
      });
    });
  return { gw, events, done, state: () => settle(state) };
}

test("chats over /api/ws: new session, streamed turn with tool and approval, persisted history", async () => {
  const { gw, done, state } = gateway("once");
  const created = await gw.request<{ session_id: string; stored_session_id: string }>("session.create", {
    profile: "tech-insider",
    title: "Desde la tablet",
  });
  const finished = done();
  const ack = await gw.request<{ status: string }>("prompt.submit", {
    session_id: created.session_id,
    text: "borrá la cache temporal",
    profile: "tech-insider",
  });
  assert.equal(ack.status, "streaming");
  await finished;

  const items = state().items;
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes("approval"), JSON.stringify(kinds));
  assert.ok(items.filter((i) => i.kind === "tool").every((i) => i.kind === "tool" && i.status === "done"));
  const last = items.at(-1)!;
  assert.ok(last.kind === "assistant" && last.text.includes("Borré la cache"), JSON.stringify(last));
  assert.ok(items.some((i) => i.kind === "assistant" && i.reasoning.length > 0), "reasoning attached");

  // The stored session shows up in the REST list with its history.
  const listed = await dash.sessions("tech-insider");
  assert.ok(listed.some((s) => s.id === created.stored_session_id));
  const history = await dash.messages(created.stored_session_id, "tech-insider");
  assert.equal(history[0].role, "user");
  assert.equal(history.at(-1)!.role, "assistant");
  gw.close();
});

test("resumes a stored session and interrupts a running turn", async () => {
  const { gw, events, done, state } = gateway();
  const nas = (await dash.sessions("default")).find((s) => s.title === "Revisión del NAS")!;
  const resumed = await gw.request<{ session_id: string }>("session.resume", {
    session_id: nas.id,
    profile: "default",
    omit_messages: true,
  });
  const finished = done();
  await gw.request("prompt.submit", { session_id: resumed.session_id, text: "contame algo largo", profile: "default" });
  while (!events.some((e) => e.type === "message.delta")) await new Promise((r) => setTimeout(r, 10));
  const res = await gw.request<{ status: string }>("session.interrupt", { session_id: resumed.session_id, profile: "default" });
  assert.equal(res.status, "interrupted");
  await finished;
  assert.ok(state().items.some((i) => i.kind === "notice" && i.text === "Ejecución detenida"));
  gw.close();
});

test("answers server requests it doesn't handle with -32601 instead of hanging", async () => {
  const { gw, events, done } = gateway();
  const created = await gw.request<{ session_id: string }>("session.create", { profile: "default" });
  const finished = done();
  await gw.request("prompt.submit", { session_id: created.session_id, text: "te hago una pregunta" });
  await finished;
  assert.ok(events.some((e) => e.type === "status.update" && e.payload.text === "clarify declined"));
  gw.close();
});

test("turn errors surface as an error notice", async () => {
  const { gw, done, state } = gateway();
  const created = await gw.request<{ session_id: string }>("session.create", { profile: "default" });
  const finished = done();
  await gw.request("prompt.submit", { session_id: created.session_id, text: "esto falla" });
  await finished;
  assert.ok(state().items.some((i) => i.kind === "notice" && i.tone === "error" && /503/.test(i.text)));
  gw.close();
});

function handshake(url: string, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WS(url, origin ? { origin } : {});
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
}

test("handshake rules: single-use tickets, and a foreign Origin is refused", async () => {
  const url = await dash.wsUrl();
  assert.match(url, /\?ticket=/);
  assert.equal(await handshake(url), 101);
  assert.equal(await handshake(url), 403, "ticket reused");
  // Bound to loopback here; the user's dashboard is bound to its LAN IP, where
  // the WebView's http://localhost is the foreign origin. No Origin passes.
  assert.equal(await handshake(await dash.wsUrl(), "http://192.168.0.50:5180"), 403);
  assert.equal(await handshake(await dash.wsUrl()), 101);
});

test("DashboardChat: a dropped socket ends the turn with a notice, the next send reconnects", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const nas = (await dash.sessions("default")).find((s) => s.title === "Revisión del NAS")!;
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond());
  };

  let finished = 0;
  void chat.send(nas.id, "default", "contame algo largo", () => finished++);
  await until(() => getRun(nas.id)?.stream.items.some((i) => i.kind === "assistant" && i.text.length > 0) ?? false);
  (mock as unknown as { dropSockets: () => void }).dropSockets();
  await until(() => finished === 1);
  const dropped = getRun(nas.id)!;
  assert.equal(dropped.busy, false);
  assert.ok(dropped.stream.items.some((i) => i.kind === "notice" && /Se cortó la conexión/.test(i.text)));

  // Same session again: new socket, `session.resume` for a fresh runtime id.
  await chat.send(nas.id, "default", "hola de nuevo", () => finished++);
  await until(() => finished === 2);
  const again = getRun(nas.id)!;
  assert.ok(again.stream.items.some((i) => i.kind === "assistant" && /hola de nuevo/.test(i.text)));
  chat.close();
});
