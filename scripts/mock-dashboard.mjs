#!/usr/bin/env node
/**
 * Stand-in for the Hermes dashboard (`hermes dashboard`, :9119) covering what
 * hermes-mobile's dashboard mode uses today: the native PKCE login with the
 * `basic` password provider, token refresh, profiles, the cross-profile
 * session list and session history. It mirrors the real server's rules
 * (hermes_cli/dashboard_auth/routes.py) closely enough to catch client bugs:
 * one-shot codes that expire in 120 s, S256 verification, a loopback-only
 * redirect_uri, the PKCE cookie, a Host check and localhost-only CORS.
 *
 *   node scripts/mock-dashboard.mjs        # http://127.0.0.1:9119, user hermes / pass hermes
 *
 * Env: PORT, HOST (127.0.0.1; 0.0.0.0 disables the Host check like the real
 * server), MOCK_USER, MOCK_PASSWORD, ACCESS_TTL (seconds, default 12 h; use a
 * small value to exercise refresh).
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";

export function startMockDashboard({
  port = Number(process.env.PORT ?? 9119),
  host = process.env.HOST ?? "127.0.0.1",
  user = process.env.MOCK_USER ?? "hermes",
  password = process.env.MOCK_PASSWORD ?? "hermes",
  accessTtl = Number(process.env.ACCESS_TTL ?? 12 * 3600),
  log = true,
} = {}) {
  const now = () => Date.now() / 1000;
  const token = () => randomBytes(24).toString("base64url");
  const b64url = (buf) => Buffer.from(buf).toString("base64url");

  /** broker id → { challenge, redirectUri, state, provider, created } */
  const pending = new Map();
  /** code → { challenge, created } */
  const codes = new Map();
  /** access token → expires_at */
  const access = new Map();
  /** refresh token → user */
  const refresh = new Map();

  const profiles = [
    { name: "default", is_default: true, model: "anthropic/claude-sonnet", provider: "openrouter", has_env: true, skill_count: 42, gateway_running: true, description: "Perfil principal", display_name: "", bot_title: "", has_alias: false },
    { name: "tech-insider", is_default: false, model: "openai/gpt-5", provider: "openrouter", has_env: true, skill_count: 12, gateway_running: false, description: "Notas y newsletter de tecnología", display_name: "Tech Insider", bot_title: "", has_alias: true },
  ];

  let n = 0;
  const sessions = []; // rows tagged with profile
  const messages = new Map(); // `${profile}/${id}` → messages
  function addSession(profile, title, source, msgs, ago) {
    const id = `${new Date(Date.now() - ago * 1000).toISOString().slice(0, 10).replace(/-/g, "")}_${(n++).toString(16).padStart(6, "0")}`;
    sessions.push({
      id, profile, title, source, model: profiles.find((p) => p.name === profile).model,
      started_at: now() - ago - 60, last_active: now() - ago, ended_at: ago > 3600 ? now() - ago : null,
      message_count: msgs.length, tool_call_count: msgs.filter((m) => m.tool_calls).length,
      input_tokens: 1200, output_tokens: 640, estimated_cost_usd: 0.0042,
      preview: typeof msgs[0]?.content === "string" ? msgs[0].content.slice(0, 80) : "",
      parent_session_id: null, pinned: false, archived: false,
    });
    messages.set(`${profile}/${id}`, msgs.map((m, i) => ({ id: i + 1, session_id: id, timestamp: now() - ago, ...m })));
    return id;
  }
  addSession("default", "Revisión del NAS", "cli", [
    { role: "user", content: "¿Cómo está el disco del NAS?" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: '{"command":"df -h /mnt/nas"}' } }] },
    { role: "tool", tool_call_id: "c1", tool_name: "terminal", content: "/dev/sdb1  3.6T  2.1T  1.5T  59% /mnt/nas" },
    { role: "assistant", content: "El volumen **/mnt/nas** está al **59%** (1.5 TB libres)." },
  ], 120);
  addSession("default", "Plan de la semana", "desktop", [
    { role: "user", content: "Armame un plan para esta semana" },
    { role: "assistant", content: "1. Lunes: backups\n2. Martes: revisar PRs\n3. Jueves: newsletter" },
  ], 7200);
  addSession("tech-insider", "Newsletter #42", "telegram", [
    { role: "user", content: "Resumime las noticias de IA de hoy" },
    { role: "assistant", content: "## Destacado\n\n- Nuevo modelo abierto de Nous\n- Agentes con memoria a largo plazo" },
  ], 1800);
  addSession("tech-insider", "Ideas de posts", "cli", [
    { role: "user", content: "Dame 3 ideas de posts" },
    { role: "assistant", content: "1. Agentes en casa\n2. Hermes en la tablet\n3. Cron + IA" },
  ], 90000);
  sessions.find((s) => s.title === "Plan de la semana").pinned = true;

  // ---------------------------------------------------------------------------

  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }
  const detail = (res, status, msg) => json(res, status, { detail: msg });

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function issue(provider = "basic") {
    const at = token();
    const rt = token();
    const expiresAt = Math.floor(now() + accessTtl);
    access.set(at, expiresAt);
    refresh.set(rt, user);
    return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_at: expiresAt, provider, user_id: user };
  }

  function authed(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const exp = m && access.get(m[1]);
    return Boolean(exp && exp > now());
  }

  async function body(req) {
    let raw = "";
    for await (const c of req) raw += c;
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const q = url.searchParams;
    if (log) console.log(req.method, req.url);

    // DNS-rebinding defence: on a loopback bind only loopback Host values pass.
    const hostOnly = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(hostOnly)) {
      return detail(res, 400, "Invalid host header");
    }

    // CORS: localhost origins only, no credentials (same as the real dashboard).
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!origin || !LOCAL_ORIGIN.test(origin)) return detail(res, 400, "Disallowed CORS origin");
      res.writeHead(200, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }

    // -- public ----------------------------------------------------------------
    if (path === "/") {
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    if (path === "/login") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<!doctype html><title>Hermes · login</title><p>Mock login page</p>");
    }
    if (path === "/api/status") return json(res, 200, { status: "ok", version: "0.22.4-mock", auth_required: true });
    if (path === "/api/auth/providers") {
      return json(res, 200, {
        providers: [
          { name: "basic", display_name: "Usuario y contraseña", supports_password: true, supports_session: true },
          { name: "nous", display_name: "Nous Portal", supports_password: false, supports_session: true },
        ],
      });
    }

    if (path === "/auth/native/authorize" && req.method === "GET") {
      if ((q.get("code_challenge_method") ?? "").toUpperCase() !== "S256") return detail(res, 400, "code_challenge_method must be S256");
      if (!q.get("code_challenge")) return detail(res, 400, "code_challenge required");
      let redirect;
      try {
        redirect = new URL(q.get("redirect_uri") ?? "");
      } catch {
        return detail(res, 400, "redirect_uri required");
      }
      if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname)) {
        return detail(res, 400, "native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)");
      }
      const provider = q.get("provider") || "basic";
      if (provider !== "basic") return detail(res, 404, `Unknown provider: '${provider}'`);
      const broker = token();
      pending.set(broker, { challenge: q.get("code_challenge"), redirectUri: redirect.href, state: q.get("state") ?? "", provider, created: now() });
      res.writeHead(302, {
        Location: "/login",
        "Set-Cookie": `hermes_session_pkce=${provider}.${broker}; HttpOnly; Max-Age=600; Path=/; SameSite=lax`,
      });
      return res.end();
    }

    if (path === "/auth/password-login" && req.method === "POST") {
      const b = await body(req);
      if (!b || typeof b.username !== "string" || typeof b.password !== "string" || !b.provider) {
        return json(res, 422, { detail: [{ msg: "Field required" }] });
      }
      if (b.provider !== "basic") return detail(res, 404, "Unknown provider");
      const [cookieProvider, broker] = (cookies(req).hermes_session_pkce ?? "").split(".");
      if (broker && cookieProvider !== b.provider) return detail(res, 400, "This native sign-in was started for a different provider; use that provider's form or restart sign-in.");
      if (b.username !== user || b.password !== password) return detail(res, 401, "Invalid credentials");
      const p = broker && pending.get(broker);
      if (broker) {
        if (!p || now() - p.created > 600) return detail(res, 400, "Native sign-in expired; restart sign-in.");
        pending.delete(broker);
        const code = token();
        codes.set(code, { challenge: p.challenge, created: now(), provider: p.provider });
        const next = new URL(p.redirectUri);
        next.searchParams.set("code", code);
        next.searchParams.set("state", p.state);
        return json(res, 200, { ok: true, next: next.href }, {
          "Set-Cookie": "hermes_session_pkce=; Max-Age=0; Path=/; SameSite=lax",
        });
      }
      // Browser (non-native) login: cookies only, no tokens in the body.
      const t = issue();
      return json(res, 200, { ok: true, next: b.next || "/" }, {
        "Set-Cookie": `hermes_session_at=${t.access_token}; HttpOnly; Path=/; SameSite=lax`,
      });
    }

    if (path === "/auth/native/token" && req.method === "POST") {
      const b = await body(req);
      const c = b && codes.get(b.code);
      if (b?.code) codes.delete(b.code); // consumed on every path
      const ok = c && now() - c.created <= 120 &&
        b.code_verifier && b64url(createHash("sha256").update(b.code_verifier).digest()) === c.challenge;
      if (!ok) return detail(res, 400, "Invalid or expired authorization code.");
      return json(res, 200, issue(c.provider));
    }

    if (path === "/auth/native/refresh" && req.method === "POST") {
      const b = await body(req);
      if (!b?.refresh_token) return detail(res, 400, "refresh_token required");
      if (!refresh.has(b.refresh_token)) {
        return json(res, 401, { error: "session_expired", detail: "Refresh token expired or invalid; start a new sign-in." });
      }
      refresh.delete(b.refresh_token); // rotate
      return json(res, 200, issue(b.provider || "basic"));
    }

    // -- authenticated -----------------------------------------------------------
    if (path.startsWith("/api/")) {
      if (!authed(req)) return detail(res, 401, "Unauthorized");

      if (path === "/api/auth/ws-ticket" && req.method === "POST") {
        const ticket = token();
        tickets.set(ticket, now() + 30);
        return json(res, 200, { ticket, ttl_seconds: 30 });
      }
      if (path === "/api/auth/me") {
        return json(res, 200, { user_id: user, email: "", display_name: user, org_id: "", provider: "basic", expires_at: 0 });
      }
      if (path === "/api/profiles") return json(res, 200, { profiles });
      if (path === "/api/profiles/sessions") {
        const profile = q.get("profile") || "all";
        if (profile !== "all" && !profiles.some((p) => p.name === profile)) return detail(res, 404, `Profile not found: ${profile}`);
        const limit = Math.min(Number(q.get("limit") ?? 20), 500);
        const offset = Number(q.get("offset") ?? 0);
        const rows = sessions
          .filter((s) => profile === "all" || s.profile === profile)
          .map((s) => ({ ...s, is_default_profile: s.profile === "default", is_active: s.ended_at == null && now() - s.last_active < 300 }))
          .sort((a, b) => b.last_active - a.last_active);
        const totals = {};
        for (const s of rows) totals[s.profile] = (totals[s.profile] ?? 0) + 1;
        return json(res, 200, { sessions: rows.slice(offset, offset + limit), total: rows.length, profile_totals: totals, limit, offset, errors: [], storage: [] });
      }
      const m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const profile = q.get("profile") || "default";
        const list = messages.get(`${profile}/${id}`);
        if (!list) return detail(res, 404, "Session not found");
        return json(res, 200, { session_id: id, profile, messages: list, pagination: { limit: 500, offset: 0, order: "latest", returned: list.length } });
      }
      return detail(res, 404, "Not Found");
    }
    detail(res, 404, "Not Found");
  });

  // ---------------------------------------------------------------------------
  // /api/ws — JSON-RPC 2.0 chat socket (tui_gateway/ws.py).

  /** ws ticket → expiry (single use, 30 s). */
  const tickets = new Map();
  /** runtime session id → { profile, stored, ws, interrupted, pendingApproval } */
  const live = new Map();
  let runtimeN = 0;
  let requestN = 0;
  const wss = new WebSocketServer({ noServer: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function refuse(socket, status, why) {
    if (log) console.log(`ws upgrade refused (${status}): ${why}`);
    // The real dashboard closes before accepting: the client sees a failed handshake.
    socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/api/ws") return refuse(socket, 404, `path ${url.pathname}`);
    const hostOnly = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(hostOnly)) return refuse(socket, 403, `host ${req.headers.host}`);
    // An http(s) Origin must name the bound host (port ignored), as in
    // web_server_boundary._is_accepted_host. The user's dashboard is bound to
    // its LAN IP, so the WebView's http://localhost fails; native sockets send
    // no Origin at all.
    const origin = req.headers.origin;
    if (origin && /^https?:/i.test(origin)) {
      const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "");
      const accepted =
        host === "0.0.0.0" || host === "::" ||
        (LOOPBACK_HOSTS.has(host) ? LOOPBACK_HOSTS.has(originHost) : originHost === host);
      if (!accepted) return refuse(socket, 403, `origin ${origin}`);
    }
    const ticket = url.searchParams.get("ticket");
    const tok = url.searchParams.get("token");
    let ok = false;
    if (ticket && tickets.has(ticket)) {
      ok = tickets.get(ticket) > now();
      tickets.delete(ticket); // single use
    } else if (tok) {
      const exp = access.get(tok);
      ok = Boolean(exp && exp > now());
    }
    if (!ok) return refuse(socket, 403, ticket ? "ticket unknown, used or expired" : "bad credential");
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  function onSocket(ws) {
    const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify({ jsonrpc: "2.0", ...obj }));
    const event = (type, sid, payload) => send({ method: "event", params: { type, session_id: sid, payload } });
    /** Server→client requests waiting for an answer: id → resolve. */
    const asked = new Map();
    const ask = (method, sid, params) => {
      const id = `req_${++requestN}`;
      // Without `client.capabilities {server_requests: true}` every request fails fast.
      if (!capabilities) return { id, answer: Promise.resolve({ error: { code: -32601, message: "client takes no requests" } }) };
      send({ id, method, params: { session_id: sid, ...params } });
      return { id, answer: new Promise((resolve) => asked.set(id, resolve)) };
    };
    let capabilities = false;

    event("gateway.ready", undefined, { skin: {}, change_events: true, heartbeat: true, replay_epoch: "mock" });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ id: null, error: { code: -32700, message: "parse error" } });
      }
      // The client answering one of our requests.
      if (typeof msg.id === "string" && asked.has(msg.id) && !msg.method) {
        asked.get(msg.id)(msg);
        asked.delete(msg.id);
        return;
      }
      const { id, method, params = {} } = msg;
      const reply = (result) => send({ id, result });
      const fail = (code, message) => send({ id, error: { code, message } });
      if (log) console.log("ws ←", method, JSON.stringify(params).slice(0, 120));
      switch (method) {
        case "gateway.ping":
          return reply({ ok: true });
        case "client.capabilities":
          capabilities = Boolean(params.server_requests);
          return reply({ server_requests: ["approval", "clarify", "sudo", "secret"], declines_not_shown: true });
        case "session.create": {
          const profile = params.profile || "default";
          if (!profiles.some((p) => p.name === profile)) return fail(4004, `profile not found: ${profile}`);
          const rid = `rt_${++runtimeN}`;
          // The stored row appears with the first prompt, as on the real gateway.
          const stored = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${(n++).toString(16).padStart(6, "0")}`;
          live.set(rid, { profile, stored, title: params.title ?? null, ws, created: false });
          return reply({ session_id: rid, stored_session_id: stored, message_count: 0, messages: [], info: {} });
        }
        case "session.resume": {
          const profile = params.profile || "default";
          const row = sessions.find((s) => s.id === params.session_id && s.profile === profile);
          if (!row) return fail(4004, `session not found: ${params.session_id}`);
          const rid = `rt_${++runtimeN}`;
          live.set(rid, { profile, stored: row.id, title: row.title, ws, created: true });
          const count = messages.get(`${profile}/${row.id}`)?.length ?? 0;
          return reply({ session_id: rid, stored_session_id: row.id, message_count: count, messages: [], messages_omitted: true, info: {} });
        }
        case "session.interrupt": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const running = Boolean(s.running);
          s.interrupted = running;
          if (s.pendingApproval) {
            const { id: rid, requestId } = s.pendingApproval;
            event("request.cancel", params.session_id, { id: rid, method: "approval", reason: "interrupted" });
            event("approval.cancelled", params.session_id, { session_id: params.session_id, stored_session_id: s.stored, reason: "interrupt", cancelled_count: 1, request_ids: [requestId] });
            asked.get(rid)?.({ result: { choice: "deny" } });
            asked.delete(rid);
          }
          return reply({ status: running ? "interrupted" : "not_interrupted", interrupted: running });
        }
        case "prompt.submit": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          if (s.running) return reply({ status: "queued" });
          const text = typeof params.text === "string" ? params.text : JSON.stringify(params.text);
          reply({ status: "streaming" });
          void runTurn(params.session_id, s, text);
          return;
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    });

    async function runTurn(sid, s, text) {
      s.running = true;
      s.interrupted = false;
      const key = `${s.profile}/${s.stored}`;
      if (!s.created) {
        s.created = true;
        sessions.push({
          id: s.stored, profile: s.profile, title: s.title || text.slice(0, 40), source: "desktop",
          model: profiles.find((p) => p.name === s.profile).model, started_at: now(), last_active: now(), ended_at: null,
          message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0,
          preview: text.slice(0, 80), parent_session_id: null, pinned: false, archived: false,
        });
        messages.set(key, []);
      }
      const rows = messages.get(key);
      const push = (m) => rows.push({ id: rows.length + 1, session_id: s.stored, timestamp: now(), ...m });
      push({ role: "user", content: text });
      const stream = async (type, words, delay = 30) => {
        for (const w of words) {
          if (s.interrupted) return false;
          event(type, sid, { text: w });
          await sleep(delay);
        }
        return true;
      };
      const finish = (payload) => {
        s.running = false;
        const row = sessions.find((r) => r.id === s.stored && r.profile === s.profile);
        if (row) {
          row.last_active = now();
          row.message_count = rows.length;
        }
        event("message.complete", sid, { usage: { input_tokens: 120, output_tokens: 80 }, ...payload });
      };
      const interrupted = (partial) => finish({ text: partial, status: "interrupted" });

      event("message.start", sid, {});
      if (!(await stream("reasoning.delta", "Pienso qué revisar primero… ".split(/(?<= )/), 20))) return interrupted("");
      const intro = "Dale, lo reviso en el servidor.";
      if (!(await stream("message.delta", intro.split(/(?<= )/)))) return interrupted(intro);
      event("message.delta", sid, { text: null });

      const callId = `call_${++requestN}`;
      event("tool.start", sid, { tool_id: callId, name: "terminal", args: { command: "uptime" } });
      await sleep(400);
      if (s.interrupted) return interrupted(intro);
      event("tool.complete", sid, { tool_id: callId, name: "terminal", args: { command: "uptime" }, duration_s: 0.4, result: { output: "21:14 up 12 days, load average: 0.42", exit_code: 0 }, summary: "up 12 days, load 0.42" });
      push({ role: "assistant", content: intro, tool_calls: [{ id: callId, type: "function", function: { name: "terminal", arguments: '{"command":"uptime"}' } }] });
      push({ role: "tool", tool_call_id: callId, tool_name: "terminal", content: "21:14 up 12 days, load average: 0.42" });

      if (/pregunt/i.test(text)) {
        // A request this client does not implement must come back as -32601, not hang.
        const { answer } = ask("clarify", sid, { questions: [{ qid: "q1", question: "¿Cuál?" }] });
        const res = await answer;
        event("status.update", sid, { kind: "status", text: res.error?.code === -32601 ? "clarify declined" : "clarify answered" });
      }

      let approvalNote = "";
      if (/borr|delete|rm /i.test(text)) {
        const requestId = `appr_${++requestN}`;
        const { id: rid, answer } = ask("approval", sid, {
          request_id: requestId, command: "rm -rf /tmp/cache", description: "Comando destructivo detectado",
          choices: ["once", "session", "always", "deny"], tool_name: "terminal",
        });
        s.pendingApproval = { id: rid, requestId };
        const res = await answer;
        s.pendingApproval = null;
        if (s.interrupted) return interrupted(intro);
        const choice = res.result?.choice ?? "deny";
        const id2 = `call_${++requestN}`;
        event("tool.start", sid, { tool_id: id2, name: "terminal", args: { command: "rm -rf /tmp/cache" } });
        await sleep(200);
        const blocked = choice === "deny";
        event("tool.complete", sid, { tool_id: id2, name: "terminal", result: blocked ? { error: "BLOCKED: denied by user" } : { output: "", exit_code: 0 }, summary: blocked ? "BLOCKED: denied by user" : "cache borrada" });
        approvalNote = blocked ? "\n\nNo borré la cache porque lo denegaste." : "\n\nBorré la cache temporal.";
      }

      if (/falla/i.test(text)) {
        return finish({ text: "", status: "error", error: "El proveedor devolvió 503 (mock)" });
      }
      const answer = `Listo. Recibí: _"${text}"_.\n\nEl servidor lleva **12 días** encendido.${approvalNote}`;
      if (!(await stream("message.delta", answer.match(/.{1,8}/gs), 25))) return interrupted(answer);
      push({ role: "assistant", content: answer });
      finish({ text: answer, status: "complete" });
    }

    ws.on("close", () => {
      for (const [rid, s] of live) if (s.ws === ws) live.delete(rid);
    });
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (log) console.log(`mock Hermes dashboard on http://${host}:${addr.port} (user: ${user} / pass: ${password})`);
      resolve({
        server,
        port: addr.port,
        /** Kill every chat socket without a close frame (Wi-Fi drop, server restart). */
        dropSockets: () => wss.clients.forEach((c) => c.terminate()),
        close: () => {
          wss.clients.forEach((c) => c.terminate());
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockDashboard();
}
