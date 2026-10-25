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

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (log) console.log(`mock Hermes dashboard on http://${host}:${addr.port} (user: ${user} / pass: ${password})`);
      resolve({ server, port: addr.port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockDashboard();
}
