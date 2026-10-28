import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WS from "ws";
import { DashboardClient, dashboardLogin } from "../src/lib/dashboard.ts";
import { GatewayClient, type GatewayEvent } from "../src/lib/gateway.ts";
import { gatewayEventToStream, serverRequestToStream } from "../src/lib/gatewayEvents.ts";
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

/**
 * Connect a gateway client that auto-answers what the agent asks: approvals
 * with `choice`, other requests with `answers[method]` (left unanswered when
 * absent, so a test can interrupt while the card is up).
 */
function gateway(choice = "once", answers: Record<string, Record<string, unknown>> = {}) {
  let state: StreamState = { items: [], finished: false };
  const apply = (name: string, payload: Record<string, unknown>) => (state = applyStreamEvent(state, name, payload));
  const gw: GatewayClient = new GatewayClient({
    url: (attempt) => dash.wsUrl(attempt),
    socketFactory: webSocket,
    onServerRequest: (req) => {
      const [name, payload] = serverRequestToStream(req);
      apply(name, payload);
      if (req.method === "approval") gw.respond(req.id, { choice });
      else if (answers[req.method]) gw.respond(req.id, answers[req.method]);
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
  await gw.request("prompt.submit", { session_id: created.session_id, text: "necesito un código del vault" });
  await finished;
  assert.ok(events.some((e) => e.type === "status.update" && e.payload.text === "vault declined"));
  gw.close();
});

/** One turn in a new session; returns the final assistant text and the reduced items. */
async function turn(text: string, answers: Record<string, Record<string, unknown>> = {}, setup?: (gw: GatewayClient, sid: string) => Promise<void>) {
  const { gw, done, state } = gateway("once", answers);
  const created = await gw.request<{ session_id: string }>("session.create", { profile: "default" });
  await setup?.(gw, created.session_id);
  const finished = done();
  await gw.request("prompt.submit", { session_id: created.session_id, text });
  await finished;
  gw.close();
  const items = state().items;
  const last = items.at(-1);
  return { items, text: last && last.kind === "assistant" ? last.text : "" };
}

test("clarify: choice cards, multi-select answered as a JSON array of labels", async () => {
  const { items, text } = await turn("hacé el deploy", {
    clarify: { answers: { q1: "prod", q2: JSON.stringify(["api", "worker"]) }, outcome: "submitted" },
  });
  const card = items.find((i) => i.kind === "input");
  assert.ok(card && card.kind === "input" && card.method === "clarify" && card.questions?.length === 2);
  assert.match(text, /Deploy a \*\*prod\*\*; servicios: api, worker/);
});

test("clarify skipped (no answers) and sudo / secret values", async () => {
  assert.match((await turn("hacé el deploy", { clarify: { outcome: "cancelled" } })).text, /No respondiste/);
  assert.match((await turn("reiniciá nginx", { sudo: { value: "hermes" } })).text, /Reinicié nginx/);
  assert.match((await turn("reiniciá nginx", { sudo: { value: "" } })).text, /Sin contraseña/);
  const secret = await turn("configurá el token", { secret: { value: "ghp_123456" } });
  const card = secret.items.find((i) => i.kind === "input");
  assert.ok(card && card.kind === "input" && card.envVar === "GITHUB_TOKEN");
  assert.match(secret.text, /GITHUB_TOKEN \(10 caracteres\)/);
});

test("an interrupt withdraws an open question", async () => {
  const { gw, done, state } = gateway(); // nobody answers the sudo card
  const created = await gw.request<{ session_id: string }>("session.create", { profile: "default" });
  const finished = done();
  await gw.request("prompt.submit", { session_id: created.session_id, text: "reiniciá nginx" });
  while (!state().items.some((i) => i.kind === "input")) await new Promise((r) => setTimeout(r, 10));
  await gw.request("session.interrupt", { session_id: created.session_id });
  await finished;
  const card = state().items.find((i) => i.kind === "input");
  assert.ok(card && card.kind === "input" && card.resolved === "cancelled");
  gw.close();
});

test("images go up with image.attach_bytes before the prompt", async () => {
  // Smallest JPEG/PNG headers are enough: the gateway sniffs magic bytes.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");
  const { text } = await turn("¿qué ves?", {}, async (gw, sid) => {
    const res = await gw.request<{ attached: boolean; count: number }>("image.attach_bytes", {
      session_id: sid,
      content_base64: jpeg,
      filename: "foto.jpg",
    });
    assert.equal(res.attached, true);
  });
  assert.match(text, /Recibí 1 imagen/);
});

test("DashboardChat sends picked images and shows them in the user bubble", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Foto");
  const dataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}`;
  await new Promise<void>((resolve) => void chat.send(id, "default", "mirá", [dataUrl, dataUrl], resolve));
  const run = getRun(id)!;
  const user = run.stream.items[0];
  assert.ok(user.kind === "user" && user.images.length === 2);
  const last = run.stream.items.at(-1)!;
  assert.ok(last.kind === "assistant" && /Recibí 2 imágenes/.test(last.text), JSON.stringify(last));

  // Not an image: the gateway refuses it and the turn ends with that error.
  const bad = await chat.create("default", "Mal");
  await new Promise<void>((resolve) => void chat.send(bad, "default", "x", ["data:image/jpeg;base64,aGVsbG8="], resolve));
  assert.ok(getRun(bad)!.stream.items.some((i) => i.kind === "notice" && /not an image/.test(i.text)));
  chat.close();
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

const until = async (cond: () => boolean, what = "condition") => {
  for (let i = 0; i < 800 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), what);
};

const assistantText = (items: { kind: string; text?: string }[]) =>
  items.filter((i) => i.kind === "assistant").map((i) => i.text).join("\n");

test("DashboardChat: a socket dropped mid-turn reconnects and the turn goes on with what it missed", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket, reconnectDelaysMs: [50, 200] });
  const nas = (await dash.sessions("default")).find((s) => s.title === "Revisión del NAS")!;

  let finished = 0;
  void chat.send(nas.id, "default", "contame algo largo", [], () => finished++);
  await until(() => /Dale/.test(assistantText(getRun(nas.id)?.stream.items ?? [])), "streaming started");
  (mock as unknown as { dropSockets: () => void }).dropSockets();
  await until(() => finished === 1, "turn finished");
  const run = getRun(nas.id)!;
  assert.equal(run.busy, false);
  assert.ok(!run.stream.items.some((i) => i.kind === "notice"), "no error notice");
  const text = assistantText(run.stream.items);
  assert.equal(text.match(/Dale, lo reviso/g)?.length, 1, "replayed events are applied once");
  assert.match(text, /Listo\. Recibí: _"contame algo largo"_/);
  assert.equal(run.stream.items.filter((i) => i.kind === "tool").length, 1);

  // The connection is usable again.
  await chat.send(nas.id, "default", "hola de nuevo", [], () => finished++);
  await until(() => finished === 2);
  assert.match(assistantText(getRun(nas.id)!.stream.items), /hola de nuevo/);
  chat.close();
});

test("DashboardChat: a question asked before the drop stays on screen and can be answered after it", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun, answerInput } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket, reconnectDelaysMs: [50, 200] });
  const nas = (await dash.sessions("default")).find((s) => s.title === "Revisión del NAS")!;
  let finished = 0;
  void chat.send(nas.id, "default", "hacé el deploy", [], () => finished++);
  await until(() => getRun(nas.id)?.stream.items.some((i) => i.kind === "input") ?? false, "card shown");
  (mock as unknown as { dropSockets: () => void }).dropSockets();
  await until(() => chat.gateway.state === "closed");
  await until(() => chat.gateway.state === "open", "reconnected");
  await new Promise((r) => setTimeout(r, 100));
  const cards = getRun(nas.id)!.stream.items.filter((i) => i.kind === "input");
  assert.equal(cards.length, 1, "the open request is not shown twice");
  await answerInput(nas.id, cards[0].key, { answers: { q1: "prod", q2: '["api"]' }, outcome: "submitted" }, "answered");
  await until(() => finished === 1, "turn finished");
  assert.match(assistantText(getRun(nas.id)!.stream.items), /Deploy a \*\*prod\*\*; servicios: api/);
  chat.close();
});

test("DashboardChat: opening a session that is mid-turn follows it from the server's snapshot", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun, answerInput } = await import("../src/lib/runs.ts");
  const ideas = (await dash.sessions("tech-insider")).find((s) => s.title === "Ideas de posts")!;

  // Another device starts a turn that stops on a question, then goes away.
  const other = new GatewayClient({ url: () => dash.wsUrl(0), socketFactory: webSocket, onServerRequest: () => {} });
  const { session_id: rid } = await other.request<{ session_id: string }>("session.resume", { session_id: ideas.id, profile: "tech-insider", omit_messages: true });
  let asked = false;
  other.on((e) => e.type === "message.delta" && e.session_id === rid && e.payload.text === null && (asked = true));
  await other.request("prompt.submit", { session_id: rid, text: "hacé el deploy" });
  await until(() => asked, "other device saw the first segment");
  await new Promise((r) => setTimeout(r, 500));
  other.close();

  let changed = 0;
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  chat.onRunEnded((id) => id === ideas.id && changed++);
  await chat.attach(ideas.id, "tech-insider");
  const run = getRun(ideas.id)!;
  assert.ok(run.busy && run.resumed);
  assert.equal(run.stream.items[0].kind, "user");
  assert.equal(run.stream.items[0].kind === "user" && run.stream.items[0].text, "hacé el deploy");
  assert.match(assistantText(run.stream.items), /Dale, lo reviso en el servidor\./);
  const card = run.stream.items.find((i) => i.kind === "input");
  assert.ok(card, "the pending question comes from open_requests");
  await answerInput(ideas.id, card.key, { answers: { q1: "staging", q2: '["web"]' }, outcome: "submitted" }, "answered");
  await until(() => !getRun(ideas.id)!.busy, "turn finished");
  assert.match(assistantText(getRun(ideas.id)!.stream.items), /Deploy a \*\*staging\*\*; servicios: web/);
  assert.equal(changed, 1, "a picked-up turn reports its end");
  chat.close();
});

test("DashboardChat: a replay that fell out of the server's window restarts the reply from its snapshot", async () => {
  const small = await startMockDashboard({ port: 0, log: false, replayMax: 3 });
  try {
    const url = `http://127.0.0.1:${small.port}`;
    const d = new DashboardClient(url, await dashboardLogin({ baseUrl: url, username: "hermes", password: "hermes" }));
    const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
    const { getRun } = await import("../src/lib/runs.ts");
    const chat = new DashboardChat(d, { socketFactory: webSocket, reconnectDelaysMs: [150] });
    const id = await chat.create("default", "Ventana corta");
    let finished = 0;
    void chat.send(id, "default", "contame algo", [], () => finished++);
    await until(() => /Dale/.test(assistantText(getRun(id)?.stream.items ?? [])), "streaming started");
    small.dropSockets();
    await until(() => finished === 1, "turn finished");
    const items = getRun(id)!.stream.items;
    assert.ok(!items.some((i) => i.kind === "notice"));
    const text = assistantText(items);
    assert.equal(text.match(/Dale, lo reviso/g)?.length, 1);
    assert.equal(text.match(/Listo\./g)?.length, 1);
    assert.match(text, /lleva \*\*12 días\*\* encendido\.$/);
    chat.close();
  } finally {
    await small.close();
  }
});

test("DashboardChat: when the dashboard stays unreachable the turn ends with a notice", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  let blocked = false;
  const factory: typeof webSocket = (url, h) => {
    if (!blocked) return webSocket(url, h);
    setTimeout(() => h.onClose(1006, "", false), 5);
    return { send() {}, close() {} };
  };
  const chat = new DashboardChat(dash, { socketFactory: factory, reconnectDelaysMs: [20, 20] });
  const nas = (await dash.sessions("default")).find((s) => s.title === "Revisión del NAS")!;
  let finished = 0;
  void chat.send(nas.id, "default", "contame algo largo", [], () => finished++);
  await until(() => /Dale/.test(assistantText(getRun(nas.id)?.stream.items ?? [])));
  blocked = true;
  (mock as unknown as { dropSockets: () => void }).dropSockets();
  await until(() => finished === 1);
  assert.ok(getRun(nas.id)!.stream.items.some((i) => i.kind === "notice" && /Se cortó la conexión/.test(i.text)));
  chat.close();
  // Let the detached turn on the mock run out before other tests use the session.
  await new Promise((r) => setTimeout(r, 1500));
});

test("DashboardChat: a correction steers the running turn; after it ends it becomes a normal message", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Correcciones");
  let ended = 0;
  chat.onRunEnded(() => ended++);
  void chat.send(id, "default", "revisá el disco");
  await until(() => /Dale/.test(assistantText(getRun(id)?.stream.items ?? [])));
  assert.equal(await chat.steer(id, "default", "mirá solo /var"), "steered");
  const steerItem = getRun(id)!.stream.items.find((i) => i.kind === "user" && i.steer);
  assert.equal(steerItem?.kind === "user" && steerItem.text, "mirá solo /var");
  await until(() => ended === 1);
  assert.match(assistantText(getRun(id)!.stream.items), /Tomé tu corrección: "mirá solo \/var"/);
  assert.equal(await chat.steer(id, "default", "tarde"), "queued", "no turn to steer");
  chat.close();
});

test("DashboardChat: messages queued during a turn go out one by one; a stopped turn holds them", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun, enqueue, getQueue, stopRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Cola");
  let ended = 0;
  chat.onRunEnded(() => ended++);
  void chat.send(id, "default", "primero");
  enqueue(id, "segundo", []);
  enqueue(id, "tercero", []);
  await until(() => ended === 3, "three turns");
  assert.equal(getQueue(id).length, 0);
  const users = (await dash.messages(id, "default")).filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["primero", "segundo", "tercero"]);

  void chat.send(id, "default", "cuarto");
  enqueue(id, "quinto", []);
  await until(() => /Dale/.test(assistantText(getRun(id)?.stream.items ?? [])));
  await stopRun(id);
  await until(() => ended === 4);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(getQueue(id).map((q) => q.text), ["quinto"], "held after a stop");
  assert.equal(getRun(id)!.busy, false);
  chat.close();
});

test("DashboardChat: a turn the server starts on its own (its queue) is followed", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Cola del server");
  const ended: string[] = [];
  chat.onRunEnded(() => ended.push(assistantText(getRun(id)!.stream.items)));
  void chat.send(id, "default", "uno");
  await until(() => /Dale/.test(assistantText(getRun(id)?.stream.items ?? [])));
  const rid = await chat.attach(id, "default");
  // Like another client typing while busy: the gateway queues it.
  assert.deepEqual(await chat.gateway.request("prompt.submit", { session_id: rid, text: "dos" }), { status: "queued" });
  await until(() => ended.length === 2, "both turns");
  assert.match(ended[1], /Recibí: _"dos"_/);
  assert.ok(getRun(id)!.resumed);
  chat.close();
});

test("DashboardChat: files ride file.attach and the prompt points at them; a retry points at them again", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const { historyToItems } = await import("../src/lib/transcript.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Archivos");
  const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7 informe").toString("base64")}`;
  const txt = `data:text/plain;base64,${Buffer.from("hola").toString("base64")}`;
  const files = [
    { name: "informe.pdf", dataUrl: pdf, size: 16 },
    { name: "mis notas.txt", dataUrl: txt, size: 4 },
  ];
  await new Promise<void>((resolve) => void chat.send(id, "default", "resumilos", [], resolve, { files }));
  const run = getRun(id)!;
  assert.deepEqual(run.stream.items[0].kind === "user" && run.stream.items[0].files, ["informe.pdf", "mis notas.txt"]);
  const text = assistantText(run.stream.items);
  assert.match(text, /Leí \*\*informe\.pdf\*\* \(16 bytes, PDF\)/);
  assert.match(text, /Leí \*\*mis notas\.txt\*\* \(4 bytes\)/);
  assert.match(text, /Recibí: _"resumilos"_/);

  const stored = historyToItems(await dash.messages(id, "default"));
  const user = stored.find((i) => i.kind === "user");
  assert.ok(user?.kind === "user" && user.text === "resumilos");
  assert.deepEqual(user.files, ["informe.pdf", "mis notas.txt"]);

  await new Promise<void>((resolve) => void chat.retry(id, "default", "solo el PDF", resolve, undefined, user.fileRefs));
  assert.match(assistantText(getRun(id)!.stream.items), /Leí \*\*informe\.pdf\*\*/);
  assert.deepEqual(getRun(id)!.stream.items[0].kind === "user" && getRun(id)!.stream.items[0].files, ["informe.pdf", "mis notas.txt"]);
  chat.close();
});

test("DashboardChat: /btw and /background answer beside a running turn without touching it", async () => {
  const { DashboardChat, parseSideCommand } = await import("../src/lib/dashboardChat.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  const { getLive } = await import("../src/lib/sessionLive.ts");
  assert.deepEqual(parseSideCommand("/btw ¿cuánta RAM hay?"), { kind: "btw", text: "¿cuánta RAM hay?" });
  assert.deepEqual(parseSideCommand("/bg compilá el proyecto"), { kind: "background", text: "compilá el proyecto" });
  assert.deepEqual(parseSideCommand("/background"), { kind: "background", text: "" });
  assert.equal(parseSideCommand("/btwx hola"), null);
  assert.equal(parseSideCommand("hola /btw"), null);

  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Al costado");
  let ended = 0;
  chat.onRunEnded(() => ended++);
  void chat.send(id, "default", "hacé el deploy");
  await until(() => getRun(id)?.stream.items.some((i) => i.kind === "input") ?? false, "turn parked on a question");
  await chat.side(id, "default", "btw", "¿cuánto lleva encendido?");
  await chat.side(id, "default", "background", "limpiá los logs");
  await chat.side(id, "default", "btw", "esto falla");
  await until(() => getLive(id).sideTasks.every((t) => t.answer != null), "all answered");
  const [btw, bg, failed] = getLive(id).sideTasks;
  assert.match(btw.answer!, /Al costado: sobre "¿cuánto lleva encendido\?"/);
  assert.equal(bg.kind, "background");
  assert.match(bg.answer!, /limpiá los logs/);
  assert.ok(failed.failed && /no respondió/.test(failed.answer!));
  assert.ok(getRun(id)!.busy && ended === 0, "the turn is still waiting on its question");
  assert.ok(!getRun(id)!.stream.items.some((i) => i.kind === "user" && /cuánto lleva/.test(i.text)), "not a message");
  await chat.gateway.request("session.interrupt", { session_id: await chat.attach(id, "default"), profile: "default" });
  await until(() => ended === 1);
  chat.close();
});

test("DashboardChat: delegated children show as a tree for the session; a new turn drops the finished ones", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getLive } = await import("../src/lib/sessionLive.ts");
  const { buildSubagentTree } = await import("../src/lib/subagents.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Subagentes");
  await new Promise<void>((resolve) => void chat.send(id, "default", "investigá agentes", [], resolve));
  const list = getLive(id).subagents;
  assert.deepEqual(list.map((s) => [s.id, s.status]), [["sa_1", "completed"], ["sa_2", "failed"], ["sa_3", "completed"]]);
  const tree = buildSubagentTree(list);
  assert.deepEqual(tree.map((n) => [n.id, n.children.map((c) => c.id)]), [["sa_1", ["sa_3"]], ["sa_2", []]]);
  assert.equal(list[1].detail, "El NAS no respondió a tiempo.");
  await new Promise<void>((resolve) => void chat.send(id, "default", "gracias", [], resolve));
  assert.deepEqual(getLive(id).subagents, []);
  chat.close();
});

test("DashboardChat: react to stored messages (one per author) and see the agent's reaction live", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getLive } = await import("../src/lib/sessionLive.ts");
  const { historyToItems } = await import("../src/lib/transcript.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Reacciones");
  await new Promise<void>((resolve) => void chat.send(id, "default", "reaccioná a esto", [], resolve));
  const items = historyToItems(await dash.messages(id, "default"));
  const user = items.find((i) => i.kind === "user")!;
  const reply = items.findLast((i) => i.kind === "assistant")!;
  assert.ok(user.kind === "user" && user.rowId != null);
  assert.deepEqual(getLive(id).reactions[user.rowId!].map((r) => [r.emoji, r.author]), [["👍", "agent"]], "live from message.reaction");
  assert.ok(reply.kind === "assistant" && reply.rowId != null);
  assert.deepEqual((await chat.react(id, "default", reply.rowId!, "❤️")).length, 1);
  await chat.react(id, "default", reply.rowId!, "😂");
  assert.deepEqual(getLive(id).reactions[reply.rowId!].map((r) => r.emoji), ["😂"], "one per author");
  await chat.react(id, "default", reply.rowId!, null);
  const after = historyToItems(await dash.messages(id, "default"));
  const storedReply = after.find((i) => i.kind === "assistant" && i.rowId === reply.rowId);
  assert.ok(storedReply?.kind === "assistant" && storedReply.reactions === undefined, "cleared and stored");
  const storedUser = after.find((i) => i.kind === "user");
  assert.ok(storedUser?.kind === "user" && storedUser.reactions?.[0].author === "agent", "the agent's stays");
  chat.close();
});

test("DashboardChat: model, effort, fast and yolo per session, with live info and a confirm for expensive models", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getLive } = await import("../src/lib/sessionLive.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  // New-chat picks ride on session.create.
  const id = await chat.create("default", "Modelos", { model: "openai/gpt-5", provider: "openrouter", reasoning_effort: "high" });
  assert.equal(getLive(id).info.model, "openai/gpt-5");
  assert.equal(getLive(id).info.reasoning_effort, "high");
  assert.equal(chat.gateway.sessionAuthority, false);

  const options = await chat.modelOptions(id, "default");
  assert.equal(options.model, "openai/gpt-5");
  assert.ok(options.providers.some((p) => p.slug === "nous" && p.authenticated === false));
  // Without a session the catalog comes over REST, with the profile's model.
  assert.equal((await chat.modelOptions(null, "tech-insider")).model, "openai/gpt-5");

  assert.deepEqual(await chat.setModel(id, "default", "anthropic/claude-sonnet", "openrouter"), { status: "ok", warning: undefined, deferred: false });
  assert.equal(getLive(id).info.model, "anthropic/claude-sonnet");
  const ask = await chat.setModel(id, "default", "anthropic/claude-opus", "openrouter");
  assert.equal(ask.status, "confirm");
  assert.equal(getLive(id).info.model, "anthropic/claude-sonnet");
  assert.equal((await chat.setModel(id, "default", "anthropic/claude-opus", "openrouter", true)).status, "ok");
  assert.equal(getLive(id).info.model, "anthropic/claude-opus");

  await chat.setReasoning(id, "default", "none");
  await chat.setFast(id, "default", true);
  await chat.setYolo(id, "default", true);
  const info = getLive(id).info;
  assert.deepEqual([info.reasoning_effort, info.fast, info.yolo], ["none", true, true]);
  await assert.rejects(chat.setReasoning(id, "default", "turbo"), /bad effort/);
  chat.close();
});

test("DashboardChat: usage and todos arrive with a turn; retry replaces the last turn; branch copies the session", async () => {
  const { DashboardChat } = await import("../src/lib/dashboardChat.ts");
  const { getLive } = await import("../src/lib/sessionLive.ts");
  const { getRun } = await import("../src/lib/runs.ts");
  let changed = 0;
  const chat = new DashboardChat(dash, { socketFactory: webSocket, onSessionsChanged: () => changed++ });
  const id = await chat.create("default", "Plan");
  const seen: (string | undefined)[] = [];
  const stopWatching = chat.gateway.on(() => seen.push(getLive(id).status?.text));
  await new Promise<void>((resolve) => void chat.send(id, "default", "armá un plan", [], resolve));
  stopWatching();
  assert.ok(seen.includes("Consultando el servidor…"), "status.update shows");
  assert.ok(!seen.includes("ready"), "\"ready\" clears the line instead of showing");
  assert.equal(getLive(id).status, null, "cleared when the turn ends");
  assert.equal(getLive(id).todos.length, 3);
  assert.equal(getLive(id).todos.find((t) => t.status === "in_progress")?.content, "Mirar el uso de disco");
  assert.equal(getLive(id).usage?.context_percent, 4.5);

  const before = await dash.messages(id, "default");
  assert.equal(before.filter((m) => m.role === "user").length, 1);
  await new Promise<void>((resolve) => void chat.retry(id, "default", "armá otro plan", resolve));
  const after = await dash.messages(id, "default");
  assert.deepEqual(after.filter((m) => m.role === "user").map((m) => m.content), ["armá otro plan"]);
  assert.ok(getRun(id)!.stream.items.some((i) => i.kind === "user" && i.text === "armá otro plan"));

  const child = await chat.branch(id, "default", "Plan (rama)");
  assert.notEqual(child, id);
  const copied = await dash.messages(child, "default");
  assert.equal(copied.length, after.length);
  chat.close();
});

test("DashboardChat: slash commands complete, print output, send directives and prefill", async () => {
  const { DashboardChat, slashOutcome } = await import("../src/lib/dashboardChat.ts");
  const chat = new DashboardChat(dash, { socketFactory: webSocket });
  const id = await chat.create("default", "Slash");
  const done = await chat.completeSlash("/co", id, "default");
  assert.deepEqual(done.items.map((i) => i.text), ["/compress"]);
  const help = await chat.runSlash(id, "default", "/help");
  assert.ok(help.kind === "output" && help.text.includes("/plan"));
  assert.deepEqual(await chat.runSlash(id, "default", "/plan limpiar logs"), {
    kind: "send",
    message: "Armá un plan para: limpiar logs",
    display: "/plan limpiar logs",
  });
  assert.equal((await chat.runSlash(id, "default", "/draft")).kind, "prefill");
  await assert.rejects(chat.runSlash(id, "default", "/nope"), /unknown command/);
  assert.deepEqual(slashOutcome({ type: "exec", output: "", warning: "ojo" }), { kind: "output", text: "ojo" });
  chat.close();
});
