#!/usr/bin/env node
/**
 * Tiny stand-in for the Hermes API server, for UI development without a
 * real gateway. Implements the subset hermes-mobile uses, with permissive
 * CORS and a scripted SSE turn (text → tool call → approval → answer).
 *
 *   node scripts/mock-server.mjs            # http://0.0.0.0:8642, key "dev"
 *   PORT=9000 API_KEY=secret node scripts/mock-server.mjs
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8642);
const KEY = process.env.API_KEY ?? "dev";
const now = () => Date.now() / 1000;

const sessions = new Map();
const messages = new Map();
const approvals = new Map();
let counter = 0;

function addSession(title, msgs = [], ago = 0) {
  const id = `api_${Math.floor(now())}_${(counter++).toString(16).padStart(8, "0")}`;
  sessions.set(id, {
    id, title, source: "api_server", model: "hermes-agent", started_at: now() - ago,
    last_active: now() - ago, message_count: msgs.length, preview: msgs[0]?.content ?? "",
    estimated_cost_usd: 0.0123, pinned: false, archived: false,
  });
  messages.set(id, msgs.map((m, i) => ({ id: i + 1, session_id: id, timestamp: now() - ago, ...m })));
  return id;
}

addSession("Revisión del servidor de casa", [
  { role: "user", content: "¿Cómo está el disco del NAS?" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "terminal", arguments: '{"command":"df -h /mnt/nas"}' } }] },
  { role: "tool", tool_call_id: "c1", content: "Filesystem  Size  Used Avail Use%\n/dev/sdb1   3.6T  2.1T  1.5T  59%" },
  { role: "assistant", content: "El volumen **/mnt/nas** está al **59%** (1.5 TB libres). Nada urgente.\n\n| Volumen | Uso |\n|---|---|\n| /mnt/nas | 59% |" },
], 3600);
addSession("Ideas para el blog", [
  { role: "user", content: "Dame 3 ideas de posts sobre agentes" },
  { role: "assistant", content: "1. Cómo diseñar herramientas para agentes\n2. Memoria a largo plazo en la práctica\n3. Agentes y cron: automatizar sin miedo" },
], 90000);
sessions.get([...sessions.keys()][1]).pinned = true;

const jobs = [
  { id: "job_1", name: "Resumen diario", schedule_display: "0 9 * * *", prompt: "Resumí mis emails y el calendario de hoy.", enabled: true, state: "scheduled", next_run_at: new Date(Date.now() + 36e5).toISOString(), last_run_at: new Date(Date.now() - 864e5).toISOString(), last_status: "ok" },
  { id: "job_2", name: "Backup check", schedule_display: "every 6h", prompt: "Verificá que el último backup haya terminado bien.", enabled: false, state: "paused", paused_at: new Date().toISOString(), next_run_at: null, last_status: "error", last_error: "rsync exit 23" },
];

function send(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamTurn(req, res, sessionId, body) {
  const runId = `run_${Math.random().toString(16).slice(2)}`;
  const text = typeof body.message === "string" ? body.message : (body.message?.find?.((p) => p.type === "text")?.text ?? "(imagen)");
  const list = messages.get(sessionId);
  list.push({ id: list.length + 1, role: "user", content: body.message, timestamp: now() });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let seq = 0;
  let closed = false;
  req.on("close", () => (closed = true));
  const ev = (name, payload) => {
    if (closed) return;
    res.write(`event: ${name}\ndata: ${JSON.stringify({ session_id: sessionId, run_id: runId, seq: ++seq, ts: now(), ...payload })}\n\n`);
  };
  const mid = "msg_1";
  ev("run.started", { user_message: { role: "user", content: body.message } });
  ev("message.started", { message: { id: mid, role: "assistant" } });
  for (const w of "Pensando en cómo resolver esto…".split(" ")) {
    ev("tool.progress", { tool_name: "_thinking", delta: w + " " });
    await sleep(40);
  }
  for (const w of "Dale, lo reviso en el servidor.".split(/(?<= )/)) {
    ev("assistant.delta", { message_id: mid, delta: w });
    await sleep(60);
  }
  ev("tool.started", { tool_name: "terminal", args: { command: "uptime" }, preview: "uptime" });
  await sleep(700);
  ev("tool.completed", { tool_name: "terminal", preview: "21:14 up 12 days, load average: 0.42" });

  const wantsApproval = /borr|delete|rm /i.test(text);
  if (wantsApproval) {
    const decided = new Promise((resolve) => approvals.set(runId, resolve));
    ev("approval.request", { event: "approval.request", command: "rm -rf /tmp/cache", description: "Comando destructivo detectado", request_id: "prompt_1", choices: ["once", "session", "always", "deny"] });
    const choice = await decided;
    ev(choice === "deny" ? "tool.failed" : "tool.started", { tool_name: "terminal", preview: choice === "deny" ? "BLOCKED: denied" : "rm -rf /tmp/cache" });
    if (choice !== "deny") { await sleep(400); ev("tool.completed", { tool_name: "terminal", preview: "" }); }
  }

  const answer = `Listo. Recibí: _"${text}"_.\n\nEl servidor lleva **12 días** encendido y la carga es baja.\n\n\`\`\`bash\nuptime\n\`\`\``;
  for (const chunk of answer.match(/.{1,6}/gs)) {
    ev("assistant.delta", { message_id: mid, delta: chunk });
    await sleep(25);
  }
  list.push({ id: list.length + 1, role: "assistant", content: "Dale, lo reviso en el servidor.", timestamp: now(), tool_calls: [{ id: "x", function: { name: "terminal", arguments: '{"command":"uptime"}' } }] });
  list.push({ id: list.length + 1, role: "tool", tool_call_id: "x", content: "21:14 up 12 days, load average: 0.42" });
  list.push({ id: list.length + 1, role: "assistant", content: answer, timestamp: now() });
  const s = sessions.get(sessionId);
  s.message_count = list.length;
  s.last_active = now();
  ev("assistant.completed", { message_id: mid, content: answer });
  ev("run.completed", { message_id: mid, usage: { input_tokens: 120, output_tokens: 80 } });
  ev("done", {});
  res.end();
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id");
  if (req.method === "OPTIONS") return send(res, 204);

  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/p\/[^/]+/, "");
  if (path === "/health") return send(res, 200, { status: "ok" });
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: "Invalid API key", code: "invalid_api_key" } });

  let body = {};
  if (req.method === "POST" || req.method === "PATCH") {
    let raw = "";
    for await (const c of req) raw += c;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "Invalid JSON in request body" }); }
  }

  let m;
  if (path === "/health/detailed") return send(res, 200, { status: "ok", readiness: { checks: { config: { status: "ok" }, state_db: { status: "ok" }, model: { status: "ok" }, disk: { status: "ok" }, gateway: { status: "ok" } } } });
  if (path === "/v1/capabilities") return send(res, 200, { object: "hermes.api_server.capabilities", platform: "hermes-agent", model: "hermes-agent", auth: { type: "bearer", required: true }, features: { chat_completions: true, responses_api: true, run_submission: true, run_events_sse: true, run_stop: true, reasoning_streaming: true, session_chat_stream: true } });
  if (path === "/v1/models") return send(res, 200, { object: "list", data: [{ id: "hermes-agent", object: "model" }] });
  if (path === "/v1/skills") return send(res, 200, [
    { name: "github-pr-workflow", description: "Open, review and land pull requests.", category: "dev" },
    { name: "arxiv-digest", description: "Summarize new papers on a topic.", category: "research" },
    { name: "home-assistant", description: "Control lights and sensors.", category: "home" },
  ]);
  if (path === "/v1/toolsets") return send(res, 200, [
    { name: "core", label: "Core", description: "Files and terminal", enabled: true, configured: true, tools: ["read_file", "write_file", "terminal"] },
    { name: "web", label: "Web", description: "Search and browse", enabled: true, configured: false, tools: ["web_search", "browser"] },
  ]);
  if (path === "/api/sessions" && req.method === "GET") {
    const data = [...sessions.values()].sort((a, b) => b.last_active - a.last_active);
    return send(res, 200, { object: "list", data, limit: 100, offset: 0, has_more: false });
  }
  if (path === "/api/sessions" && req.method === "POST") {
    const id = addSession(body.title ?? null);
    return send(res, 201, sessions.get(id));
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
    const s = sessions.get(decodeURIComponent(m[1]));
    if (!s) return send(res, 404, { error: { message: "Session not found", code: "session_not_found" } });
    if (req.method === "DELETE") { sessions.delete(s.id); return send(res, 200, { deleted: true }); }
    if (req.method === "PATCH") { if (body.title) s.title = body.title; return send(res, 200, s); }
    return send(res, 200, s);
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
    const id = decodeURIComponent(m[1]);
    return send(res, 200, { object: "list", session_id: id, data: messages.get(id) ?? [] });
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/fork$/))) {
    const src = sessions.get(decodeURIComponent(m[1]));
    const id = addSession(body.title ?? `${src.title} (fork)`, structuredClone(messages.get(src.id)));
    return send(res, 201, sessions.get(id));
  }
  if ((m = path.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/))) return streamTurn(req, res, decodeURIComponent(m[1]), body);
  if ((m = path.match(/^\/v1\/runs\/([^/]+)\/approval$/))) { approvals.get(m[1])?.(body.choice); return send(res, 200, { object: "hermes.run.approval_response", choice: body.choice }); }
  if ((m = path.match(/^\/v1\/runs\/([^/]+)\/stop$/))) return send(res, 200, { status: "stopping" });
  if (path === "/api/jobs" && req.method === "GET") return send(res, 200, { jobs });
  if (path === "/api/jobs" && req.method === "POST") { jobs.push({ id: `job_${jobs.length + 1}`, name: body.name, schedule_display: body.schedule, prompt: body.prompt, enabled: true }); return send(res, 201, { ok: true }); }
  if ((m = path.match(/^\/api\/jobs\/([^/]+)(?:\/(pause|resume|run))?$/))) {
    const job = jobs.find((j) => j.id === m[1]);
    if (!job) return send(res, 404, { error: "Job not found" });
    if (req.method === "DELETE") { jobs.splice(jobs.indexOf(job), 1); return send(res, 200, { ok: true }); }
    if (m[2] === "pause") { job.enabled = false; job.paused_at = new Date().toISOString(); }
    if (m[2] === "resume") { job.enabled = true; job.paused_at = null; }
    return send(res, 200, { job });
  }
  send(res, 404, { error: { message: `No route: ${req.method} ${path}` } });
});

server.listen(PORT, "0.0.0.0", () => console.log(`mock Hermes API on http://0.0.0.0:${PORT} (key: ${KEY})`));
