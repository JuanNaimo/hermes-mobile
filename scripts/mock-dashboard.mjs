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
  /** Events kept per session for `session.events.since` (the real ring holds 512). */
  replayMax = 512,
  /** How long a session without a socket (and no turn running) stays live. */
  orphanGraceMs = 20_000,
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

  /** `model.options` / `GET /api/model/options`: two providers, one without credentials. */
  const catalog = {
    providers: [
      {
        slug: "openrouter", name: "OpenRouter", aliases: ["or"], authenticated: true,
        models: ["anthropic/claude-sonnet", "anthropic/claude-opus", "openai/gpt-5", "deepseek/deepseek-chat"],
        featured_models: ["anthropic/claude-sonnet", "openai/gpt-5"],
        capabilities: {
          "anthropic/claude-sonnet": { reasoning: true, can_disable_reasoning: true, fast: false },
          "anthropic/claude-opus": { reasoning: true, can_disable_reasoning: true, fast: true },
          "openai/gpt-5": { reasoning: true, can_disable_reasoning: false, fast: true },
          "deepseek/deepseek-chat": { reasoning: false, fast: false },
        },
        pricing: {
          "anthropic/claude-sonnet": { input: "$3", output: "$15" },
          "anthropic/claude-opus": { input: "$15", output: "$75" },
          "openai/gpt-5": { input: "$1.25", output: "$10" },
          "deepseek/deepseek-chat": { input: "$0.27", output: "$1.10" },
        },
      },
      { slug: "nous", name: "Nous Portal", authenticated: false, warning: "Iniciá sesión con `hermes login nous`", models: ["hermes-4-405b"] },
    ],
  };
  /** Models the mock treats as expensive: switching to one asks for confirmation. */
  const EXPENSIVE = new Set(["anthropic/claude-opus"]);
  /** Commands `complete.slash` offers: [name, description]. */
  const SLASH = [
    ["help", "Lista de comandos"],
    ["plan", "Planificar una tarea (skill)"],
    ["draft", "Empezar un borrador en el compositor"],
    ["compress", "Resumir el contexto para liberar espacio"],
  ];
  /** Fences per stored session (`profile/id`), bumped by every metadata edit. */
  const revisions = new Map();
  const revisionOf = (key) => revisions.get(key) ?? 1;

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

  // Cron jobs per profile (cron/jobs.json of each profile home).
  let jobN = 0;
  const cron = { default: [], "tech-insider": [] };
  function addJob(profile, fields) {
    const job = {
      id: `job_${(++jobN).toString(16).padStart(6, "0")}`, name: "", prompt: "", schedule_display: "",
      enabled: true, state: "scheduled", paused_at: null, paused_reason: null, deliver: "local",
      next_run_at: new Date(Date.now() + 3_600_000).toISOString(), last_run_at: null, last_status: null,
      last_error: null, created_at: new Date().toISOString(), ...fields,
    };
    cron[profile].push(job);
    return job;
  }
  addJob("default", { name: "Resumen diario", schedule_display: "0 9 * * *", prompt: "Resumí mis emails y el calendario de hoy.", last_run_at: new Date(Date.now() - 86_400_000).toISOString(), last_status: "ok" });
  addJob("tech-insider", { name: "Newsletter semanal", schedule_display: "0 8 * * 1", prompt: "Armá el borrador de la newsletter con lo más leído.", enabled: false, state: "paused", paused_at: new Date().toISOString(), next_run_at: null, last_status: "error", last_error: "rss feed timeout" });
  const annotate = (profile) => (job) => ({ ...job, profile, profile_name: profile, is_default_profile: profile === "default", scheduler_heartbeat_age_s: 3 });
  function findJob(id, hint) {
    for (const profile of hint && cron[hint] ? [hint, ...Object.keys(cron)] : Object.keys(cron)) {
      const job = cron[profile].find((j) => j.id === id);
      if (job) return { profile, job };
    }
    return null;
  }

  // Skills per profile, with the disabled set from each profile's config.
  const skillCatalog = {
    default: [
      { name: "github-pr-workflow", description: "Abrir, revisar y mergear pull requests.", category: "dev", provenance: "bundled", usage: 14 },
      { name: "home-assistant", description: "Luces, sensores y escenas de la casa.", category: "home", provenance: "hub", usage: 3 },
      { name: "nas-maintenance", description: "Chequeos de disco y backups del NAS.", category: "ops", provenance: "agent", usage: 1 },
    ],
    "tech-insider": [
      { name: "arxiv-digest", description: "Resumen de papers nuevos sobre un tema.", category: "research", provenance: "bundled", usage: 22 },
      { name: "newsletter-draft", description: "Borrador de la newsletter semanal.", category: "writing", provenance: "agent", usage: 6 },
    ],
  };
  const disabledSkills = { default: new Set(["home-assistant"]), "tech-insider": new Set() };
  const toolsetsFor = (profile) => [
    { name: "terminal", label: "Terminal", description: "Comandos en el servidor", platform: "cli", enabled: true, available: true, configured: true, tools: ["terminal", "process"] },
    { name: "web", label: "Web", description: "Búsqueda y navegación", platform: "cli", enabled: true, available: true, configured: profile === "default", tools: ["web_search", "web_extract"] },
    { name: "image_gen", label: "Imágenes", description: "Generación de imágenes", platform: "cli", enabled: false, available: false, configured: false, tools: ["image_generate"] },
  ];

  /** Bots: per-profile platform switches and credentials, one shared pairing store. */
  const botState = new Map();
  /** The last `/api/gateway/restart`: { polls, profile }. */
  let restart = null;
  const bots = {
    tg: null,
    wa: null,
    pairing: {
      pending: [{ platform: "telegram", request_id: "req-1", user_id: "555111", user_name: "maria", age_minutes: 3 }],
      approved: [{ platform: "telegram", user_id: "123456789", user_name: "juan", approved_at: 1_760_000_000 }],
    },
    state(profile) {
      if (!botState.has(profile)) {
        botState.set(profile, {
          telegram: { enabled: true, env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_USERS: "123456789" } },
          discord: { enabled: false, env: {} },
          slack: { enabled: false, env: {} },
        });
      }
      return botState.get(profile);
    },
    platforms(profile) {
      const st = bots.state(profile);
      const field = (env, key, extra = {}) => ({
        key, required: false, is_set: Boolean(env[key]), redacted_value: env[key] && !extra.is_list ? "123…abc" : null,
        value: extra.is_list ? (env[key] ?? "") : null, description: "", prompt: key, help: "", url: null,
        is_password: !extra.is_list, is_list: false, advanced: false, ...extra,
      });
      const make = (id, name, keys) => {
        const { enabled, env } = st[id];
        const configured = Boolean(env[keys[0]]);
        return {
          id, name, description: `Chateá con Hermes desde ${name}.`, docs_url: `https://hermes-agent.nousresearch.com/docs/${id}`,
          enabled, configured, gateway_running: true,
          state: !enabled ? "disabled" : !configured ? "not_configured" : id === "telegram" ? "connected" : "pending_restart",
          error_code: null, error_message: null, home_channel: null,
          env_vars: [field(env, keys[0], { required: true, prompt: "Bot token" }), field(env, keys[1], { prompt: "Usuarios permitidos", is_list: true, is_password: false })],
        };
      };
      return [
        make("telegram", "Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]),
        make("discord", "Discord", ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS"]),
        make("slack", "Slack", ["SLACK_BOT_TOKEN", "SLACK_ALLOWED_USERS"]),
      ];
    },
    update(profile, id, b) {
      const plat = bots.state(profile)[id];
      for (const key of b.clear_env ?? []) delete plat.env[key];
      for (const [key, value] of Object.entries(b.env ?? {})) if (String(value).trim()) plat.env[key] = String(value).trim();
      if (b.enabled != null) plat.enabled = Boolean(b.enabled);
    },
  };

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
    if (path === "/api/status") {
      // Down while a restart action runs.
      const down = Boolean(restart && restart.polls < 3);
      return json(res, 200, { status: "ok", version: "0.22.4-mock", auth_required: true, gateway_running: !down, gateway_state: down ? "starting" : "running" });
    }
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
      // -- audio (hermes_cli/web_routers/audio.py): fixed transcript, a short silent wav.
      if (path === "/api/audio/transcribe" && req.method === "POST") {
        const b = await body(req);
        const mime = String(b?.mime_type ?? "").split(";")[0];
        if (!/^data:/.test(String(b?.data_url ?? ""))) return detail(res, 400, "data_url must be a data: URL");
        if (!(mime.startsWith("audio/") || mime === "video/webm")) return detail(res, 400, `Unsupported audio type: ${mime}`);
        // A clip whose payload is just "silence" stands for no speech.
        const silent = String(b.data_url).endsWith(Buffer.from("silence").toString("base64"));
        return json(res, 200, { ok: true, transcript: silent ? "" : "hola hermes, ¿cómo va el servidor?", provider: "mock" });
      }
      if (path === "/api/audio/speak" && req.method === "POST") {
        const b = await body(req);
        if (!String(b?.text ?? "").trim()) return detail(res, 400, "text is required");
        const wav = Buffer.alloc(44);
        wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(0, 40);
        return json(res, 200, { ok: true, data_url: `data:audio/wav;base64,${wav.toString("base64")}`, mime_type: "audio/wav", provider: "mock" });
      }
      if (path === "/api/auth/me") {
        return json(res, 200, { user_id: user, email: "", display_name: user, org_id: "", provider: "basic", expires_at: 0 });
      }
      if (path === "/api/profiles") return json(res, 200, { profiles });

      // -- cron (web_routers/cron.py) --
      const knownProfile = (name) => profiles.some((p) => p.name === name);
      if (path === "/api/cron/jobs" && req.method === "GET") {
        const profile = q.get("profile") || "all";
        if (profile !== "all" && !knownProfile(profile)) return detail(res, 404, `Profile '${profile}' does not exist.`);
        const names = profile === "all" ? Object.keys(cron) : [profile];
        return json(res, 200, names.flatMap((n) => cron[n].map(annotate(n))));
      }
      if (path === "/api/cron/jobs" && req.method === "POST") {
        const profile = q.get("profile") || "default";
        if (!knownProfile(profile)) return detail(res, 404, `Profile '${profile}' does not exist.`);
        const b = await body(req);
        if (!b?.schedule?.trim()) return json(res, 422, { detail: [{ loc: ["body", "schedule"], msg: "Field required" }] });
        if (!b.prompt?.trim() && !(b.skills?.length)) return detail(res, 400, "A job needs a prompt or at least one skill");
        const job = addJob(profile, { name: b.name || b.prompt.slice(0, 40), prompt: b.prompt, schedule_display: b.schedule.trim() });
        return json(res, 200, annotate(profile)(job));
      }
      let cm = path.match(/^\/api\/cron\/jobs\/([^/]+)(?:\/(pause|resume|trigger))?$/);
      if (cm) {
        const found = findJob(decodeURIComponent(cm[1]), q.get("profile"));
        if (!found) return detail(res, 404, "Job not found");
        const { profile, job } = found;
        if (req.method === "DELETE" && !cm[2]) {
          cron[profile].splice(cron[profile].indexOf(job), 1);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && cm[2] === "pause") Object.assign(job, { enabled: false, state: "paused", paused_at: new Date().toISOString(), next_run_at: null });
        else if (req.method === "POST" && cm[2] === "resume") Object.assign(job, { enabled: true, state: "scheduled", paused_at: null, next_run_at: new Date(Date.now() + 3_600_000).toISOString() });
        else if (req.method === "POST" && cm[2] === "trigger") Object.assign(job, { last_run_at: new Date().toISOString(), last_status: "ok", last_error: null });
        else if (req.method !== "GET") return detail(res, 405, "Method Not Allowed");
        return json(res, 200, annotate(profile)(job));
      }

      // -- skills / toolsets (web_routers/skills.py, web_routers/tools.py) --
      if (path === "/api/skills" && req.method === "GET") {
        const profile = q.get("profile") || "default";
        if (!knownProfile(profile)) return detail(res, 404, `Profile '${profile}' does not exist.`);
        return json(res, 200, skillCatalog[profile].map((sk) => ({ ...sk, enabled: !disabledSkills[profile].has(sk.name) })));
      }
      if (path === "/api/skills/toggle" && req.method === "PUT") {
        const b = await body(req);
        const profile = b?.profile || q.get("profile") || "default";
        if (!knownProfile(profile)) return detail(res, 404, `Profile '${profile}' does not exist.`);
        if (typeof b?.name !== "string" || typeof b.enabled !== "boolean") return json(res, 422, { detail: [{ msg: "Field required" }] });
        if (b.enabled) disabledSkills[profile].delete(b.name);
        else disabledSkills[profile].add(b.name);
        return json(res, 200, { ok: true, name: b.name, enabled: b.enabled });
      }
      if (path === "/api/tools/toolsets" && req.method === "GET") {
        const profile = q.get("profile") || "default";
        if (!knownProfile(profile)) return detail(res, 404, `Profile '${profile}' does not exist.`);
        return json(res, 200, toolsetsFor(profile));
      }
      if (path === "/api/sessions/search") {
        // Ids first, then message content, one hit per session; FTS snippets mark the match >>>…<<<.
        const term = (q.get("q") ?? "").trim();
        if (!term) return json(res, 200, { results: [] });
        const profile = q.get("profile") || "default";
        const needle = term.toLowerCase();
        const results = [];
        for (const row of sessions.filter((r) => r.profile === profile)) {
          const base = { session_id: row.id, id: row.id, profile, title: row.title, preview: row.preview, last_active: row.last_active, archived: Boolean(row.archived), source: row.source };
          if (row.id.toLowerCase().startsWith(needle)) {
            results.push({ ...base, snippet: "", role: null });
            continue;
          }
          const hit = (messages.get(`${profile}/${row.id}`) ?? []).find((m) => typeof m.content === "string" && m.content.toLowerCase().includes(needle));
          if (hit) {
            const at = hit.content.toLowerCase().indexOf(needle);
            const snippet = `${at > 30 ? "..." : ""}${hit.content.slice(Math.max(0, at - 30), at)}>>>${hit.content.slice(at, at + term.length)}<<<${hit.content.slice(at + term.length, at + term.length + 40)}...`;
            results.push({ ...base, snippet, role: hit.role, session_started: row.started_at });
          }
        }
        return json(res, 200, { results: results.slice(0, Number(q.get("limit") ?? 20)) });
      }
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
      // -- bots (web_routers/messaging.py, pairing in ops.py): one connected Telegram, an off Discord.
      if (path === "/api/messaging/platforms") {
        const p = q.get("profile") || "default";
        return json(res, 200, { env_path: "~/.hermes/.env", platforms: bots.platforms(p) });
      }
      const bm = path.match(/^\/api\/messaging\/platforms\/([^/]+)(\/test)?$/);
      if (bm) {
        const id = decodeURIComponent(bm[1]);
        const p = q.get("profile") || "default";
        const plat = bots.platforms(p).find((x) => x.id === id);
        if (!plat) return detail(res, 404, `Unknown messaging platform: ${id}`);
        if (bm[2] && req.method === "POST") {
          if (!plat.enabled) return json(res, 200, { ok: false, state: plat.state, message: `${plat.name} is disabled. Enable it, then restart the gateway.` });
          if (!plat.configured) return json(res, 200, { ok: false, state: plat.state, message: "Missing required setup: DISCORD_BOT_TOKEN" });
          return json(res, 200, { ok: true, state: "connected", message: "Connected. 1 user paired.", auth_posture: "pairing" });
        }
        if (req.method === "PUT") {
          const b = await body(req);
          bots.update(p, id, b);
          return json(res, 200, { ok: true, platform: id, hot_served: false });
        }
      }
      if (path === "/api/pairing") return json(res, 200, bots.pairing);
      if (path === "/api/pairing/approve" && req.method === "POST") {
        const b = await body(req);
        const i = bots.pairing.pending.findIndex((r) => r.request_id === b.request_id || (b.code && b.code === "ABCD1234"));
        if (i < 0) return detail(res, 404, `Pairing request or code not found or expired for platform '${b.platform}'.`);
        const [r] = bots.pairing.pending.splice(i, 1);
        const user = { platform: r.platform, user_id: r.user_id, user_name: r.user_name, approved_at: now() };
        bots.pairing.approved.push(user);
        return json(res, 200, { ok: true, user });
      }
      if (path === "/api/pairing/revoke" && req.method === "POST") {
        const b = await body(req);
        bots.pairing.approved = bots.pairing.approved.filter((u) => !(u.platform === b.platform && u.user_id === b.user_id));
        return json(res, 200, { ok: true });
      }
      if (path === "/api/pairing/clear-pending" && req.method === "POST") {
        const cleared = bots.pairing.pending.length;
        bots.pairing.pending = [];
        return json(res, 200, { ok: true, cleared });
      }
      if (path === "/api/gateway/restart" && req.method === "POST") {
        // Running for a couple of polls, then the gateway is back.
        restart = { polls: 0, profile: q.get("profile") || "default" };
        return json(res, 200, { ok: true, pid: 4242, name: "gateway-restart" });
      }
      if (path === "/api/actions/gateway-restart/status") {
        const running = Boolean(restart && ++restart.polls < 3);
        return json(res, 200, { name: "gateway-restart", running, exit_code: restart && !running ? 0 : null, pid: 4242, lines: ["Restarting gateway…", ...(running ? [] : ["✓ Gateway restarted"])] });
      }
      if (path === "/api/messaging/telegram/onboarding/start" && req.method === "POST") {
        bots.tg = { id: token().slice(0, 12), polls: 0 };
        return json(res, 200, {
          pairing_id: bots.tg.id, suggested_username: "hermes_mock_bot", deep_link: "https://t.me/BotFather?start=mock",
          qr_payload: "https://t.me/BotFather?start=mock", expires_at: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (path === "/api/messaging/whatsapp/onboarding/start" && req.method === "POST") {
        const b = await body(req);
        bots.wa = { pairing_id: token().slice(0, 12), status: "starting", qr_payload: null, mode: b.mode || "bot", allowed_users: b.allowed_users || "", polls: 0 };
        return json(res, 200, bots.wa);
      }
      const tm = path.match(/^\/api\/messaging\/(telegram|whatsapp)\/onboarding\/([^/]+)(\/apply)?$/);
      if (tm) {
        const [, kind, id, apply] = tm;
        if (req.method === "DELETE") return json(res, 200, { ok: true });
        if (kind === "telegram") {
          if (!bots.tg || bots.tg.id !== id) return detail(res, 404, "Telegram setup session not found.");
          if (apply) return json(res, 200, { ok: true, platform: "telegram", bot_username: "hermes_mock_bot", needs_restart: false, restart_started: true });
          // Ready on the second poll.
          return json(res, 200, ++bots.tg.polls < 2 ? { status: "waiting" } : { status: "ready", bot_username: "hermes_mock_bot", owner_user_id: "123456789" });
        }
        if (!bots.wa || bots.wa.pairing_id !== id) return detail(res, 404, "WhatsApp setup session not found.");
        if (apply) return json(res, 200, { ok: true, platform: "whatsapp", needs_restart: false, restart_started: true });
        bots.wa.polls = (bots.wa.polls ?? 0) + 1;
        if (bots.wa.polls >= 3) Object.assign(bots.wa, { status: "connected", account_name: "Juan", account_phone: "5491122334455" });
        else if (bots.wa.polls >= 1) Object.assign(bots.wa, { status: "waiting", qr_payload: "2@mock-whatsapp-qr,abc,def" });
        return json(res, 200, bots.wa);
      }
      if (path === "/api/model/set" && req.method === "POST") {
        const b = await body(req);
        if (!["main", "auxiliary"].includes(b.scope)) return detail(res, 400, "scope must be 'main' or 'auxiliary'");
        const p = profiles.find((x) => x.name === (b.profile || q.get("profile") || "default"));
        if (!p) return detail(res, 404, "Profile not found");
        if (EXPENSIVE.has(b.model) && !b.confirm_expensive_model) {
          return json(res, 200, { ok: false, scope: b.scope, provider: b.provider, model: b.model, confirm_required: true, confirm_message: `${b.model} cuesta $15/$75 por millón de tokens. ¿Usarlo igual?` });
        }
        if (b.scope === "main") Object.assign(p, { model: b.model, provider: b.provider });
        return json(res, 200, { ok: true, scope: b.scope, provider: b.provider, model: b.model });
      }
      if (path === "/api/model/options") {
        const profile = q.get("profile") || "default";
        const p = profiles.find((x) => x.name === profile);
        if (!p) return detail(res, 404, `Profile not found: ${profile}`);
        return json(res, 200, { ...catalog, model: p.model, provider: p.provider });
      }
      const sm = path.match(/^\/api\/sessions\/([^/]+)(\/mutation-snapshot|\/export)?$/);
      if (sm) {
        const id = decodeURIComponent(sm[1]);
        const profile = q.get("profile") || "default";
        const row = sessions.find((r) => r.id === id && r.profile === profile);
        const key = `${profile}/${id}`;
        if (sm[2] === "/mutation-snapshot") {
          return json(res, 200, { session_id: id, exists: Boolean(row), runtime_revision: revisionOf(key), runtime_generation: 1 });
        }
        if (sm[2] === "/export") {
          if (!row) return detail(res, 404, "Session not found");
          return json(res, 200, { ...row, messages: messages.get(key) ?? [] });
        }
        // Edits are fenced as on the real dashboard: unfenced → 409, stale revision → 409.
        const fenceOk = (reqId, rev) => {
          if (!reqId) return detail(res, 409, "mutation_identity_required"), false;
          if (Number(rev) !== revisionOf(key)) return detail(res, 409, "revision_conflict"), false;
          return true;
        };
        if (req.method === "PATCH") {
          const b = await body(req);
          if (!row) return detail(res, 404, "Session not found");
          if (!fenceOk(b.request_id, b.expected_revision)) return;
          for (const k of ["title", "pinned", "archived", "unread"]) if (k in b) row[k] = b[k];
          revisions.set(key, revisionOf(key) + 1);
          return json(res, 200, { ok: true, title: row.title, pinned: row.pinned, archived: row.archived });
        }
        if (req.method === "DELETE") {
          if (!row) return json(res, 200, { ok: true, already_absent: true });
          if (!fenceOk(q.get("request_id"), q.get("expected_revision"))) return;
          sessions.splice(sessions.indexOf(row), 1);
          messages.delete(key);
          return json(res, 200, { ok: true });
        }
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
  /**
   * runtime session id → { profile, stored, ws, running, interrupted, pending, … }.
   * A session outlives its socket, like on the real gateway: a turn keeps
   * running detached and `session.resume` re-binds it to the new socket.
   */
  const live = new Map();
  /** Server→client requests still unanswered: id → { sid, method, params, resolve }. */
  const openRequests = new Map();
  /** runtime id → { seq, ring: [params…], evictedThrough } (event_replay.py). */
  const replay = new Map();
  /** Changes per mock process, like a server restart. */
  const replayEpoch = randomBytes(6).toString("hex");
  const isOpen = (ws) => ws && ws.readyState === 1;
  const sendTo = (ws, obj) => isOpen(ws) && ws.send(JSON.stringify({ jsonrpc: "2.0", ...obj }));
  /** Stamp, record and deliver one session event to whichever socket holds the session now. */
  function emit(type, sid, payload) {
    const r = replay.get(sid) ?? { seq: 0, ring: [], evictedThrough: 0 };
    replay.set(sid, r);
    const params = { type, session_id: sid, payload, seq: ++r.seq };
    r.ring.push(params);
    while (r.ring.length > replayMax) r.evictedThrough = r.ring.shift().seq;
    sendTo(live.get(sid)?.ws, { method: "event", params });
  }
  function scheduleReap(sid) {
    const s = live.get(sid);
    if (!s) return;
    clearTimeout(s.reap);
    s.reap = setTimeout(() => {
      const cur = live.get(sid);
      if (!cur || cur.ws) return;
      // A detached turn keeps going; check again once it's had time to end.
      if (cur.running) return scheduleReap(sid);
      live.delete(sid);
      replay.delete(sid);
    }, orphanGraceMs);
    s.reap.unref?.();
  }
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
    const send = (obj) => sendTo(ws, obj);
    const event = (type, sid, payload) => (sid ? emit(type, sid, payload) : send({ method: "event", params: { type, payload } }));
    /** Ask the client holding `sid` now; the answer may come from a later socket. */
    const ask = (method, sid, params) => {
      const id = `req_${++requestN}`;
      const holder = live.get(sid)?.ws;
      // Without `client.capabilities {server_requests: true}` every request fails fast.
      if (isOpen(holder) && !holder.capabilities) {
        return { id, answer: Promise.resolve({ error: { code: -32601, message: "client takes no requests" } }) };
      }
      const full = { session_id: sid, ...params };
      sendTo(holder, { id, method, params: full });
      return { id, answer: new Promise((resolve) => openRequests.set(id, { sid, method, params: full, resolve })) };
    };
    const openFor = (sid) =>
      [...openRequests.entries()].filter(([, r]) => r.sid === sid).map(([id, r]) => ({ id, method: r.method, params: r.params }));
    /** What `session.info` reports for a live session. */
    const infoOf = (s) => ({
      model: s.model, provider: s.provider, reasoning_effort: s.effort, fast: s.fast, yolo: s.yolo,
      title: s.title ?? "", running: Boolean(s.running), usage: s.usage ?? null,
    });
    const freshLive = (profile, extra) => {
      const p = profiles.find((x) => x.name === profile);
      return { model: p.model, provider: p.provider, effort: "medium", fast: false, yolo: false, ...extra };
    };

    event("gateway.ready", undefined, { skin: {}, change_events: true, heartbeat: true, replay_epoch: replayEpoch });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ id: null, error: { code: -32700, message: "parse error" } });
      }
      // The client answering one of our requests.
      if (typeof msg.id === "string" && openRequests.has(msg.id) && !msg.method) {
        const req = openRequests.get(msg.id);
        openRequests.delete(msg.id);
        req.resolve(msg);
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
          ws.capabilities = Boolean(params.server_requests);
          return reply({ server_requests: ["approval", "clarify", "sudo", "secret"], declines_not_shown: true });
        case "session.create": {
          const profile = params.profile || "default";
          if (!profiles.some((p) => p.name === profile)) return fail(4004, `profile not found: ${profile}`);
          const rid = `rt_${++runtimeN}`;
          // The stored row appears with the first prompt, as on the real gateway.
          const stored = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${(n++).toString(16).padStart(6, "0")}`;
          const s = freshLive(profile, { profile, stored, title: params.title ?? null, ws, created: false });
          if (params.model) Object.assign(s, { model: params.model, provider: params.provider ?? s.provider });
          if (params.reasoning_effort) s.effort = params.reasoning_effort;
          live.set(rid, s);
          return reply({ session_id: rid, stored_session_id: stored, message_count: 0, messages: [], info: infoOf(s) });
        }
        case "session.resume": {
          const profile = params.profile || "default";
          const row = sessions.find((s) => s.id === params.session_id && s.profile === profile);
          if (!row) return fail(4004, `session not found: ${params.session_id}`);
          // Already live (a turn running detached, or another socket): re-bind it here.
          const found = [...live.entries()].find(([, x]) => x.stored === row.id && x.profile === profile);
          if (found) {
            const [rid, s] = found;
            s.ws = ws;
            clearTimeout(s.reap);
            const count = messages.get(`${profile}/${row.id}`)?.length ?? 0;
            const open = openFor(rid);
            return reply({
              session_id: rid, stored_session_id: row.id, message_count: count, messages: [], messages_omitted: true,
              info: infoOf(s), todo_state: row.todos ?? null, running: Boolean(s.running),
              status: s.running ? "streaming" : "idle",
              ...(s.running ? { inflight: { user: s.inflightUser ?? "", assistant: s.inflightText ?? "", streaming: true } } : {}),
              ...(open.length ? { open_requests: open } : {}),
            });
          }
          const rid = `rt_${++runtimeN}`;
          const s = freshLive(profile, { profile, stored: row.id, title: row.title, ws, created: true, model: row.model });
          live.set(rid, s);
          const count = messages.get(`${profile}/${row.id}`)?.length ?? 0;
          return reply({ session_id: rid, stored_session_id: row.id, message_count: count, messages: [], messages_omitted: true, info: infoOf(s), todo_state: row.todos ?? null });
        }
        case "session.interrupt": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const running = Boolean(s.running);
          s.interrupted = running;
          if (s.pending) {
            const { id: rid, method: m, requestId } = s.pending;
            event("request.cancel", params.session_id, { id: rid, method: m, reason: "interrupted" });
            if (m === "approval") {
              event("approval.cancelled", params.session_id, { session_id: params.session_id, stored_session_id: s.stored, reason: "interrupt", cancelled_count: 1, request_ids: [requestId] });
            }
            openRequests.get(rid)?.resolve({ cancelled: true, result: m === "approval" ? { choice: "deny" } : {} });
            openRequests.delete(rid);
          }
          return reply({ status: running ? "interrupted" : "not_interrupted", interrupted: running });
        }
        case "image.attach_bytes": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const bytes = Buffer.from(String(params.content_base64 ?? params.data ?? ""), "base64");
          const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
          if (!isJpeg && !isPng) return reply({ attached: false, message: "not an image (magic bytes)" });
          s.images = [...(s.images ?? []), { name: params.filename, bytes: bytes.length }];
          return reply({ attached: true, name: params.filename, path: `/tmp/hermes/${params.filename}`, count: s.images.length, bytes: bytes.length });
        }
        case "file.attach": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const m = /^data:[^;,]*(?:;[^;,=]+=[^;,]+)*;base64,(.*)$/is.exec(String(params.data_url ?? ""));
          if (!params.path && !m) return fail(4015, "path or data_url required");
          if (!m) return fail(5028, "file not found on gateway and no data_url provided");
          const bytes = Buffer.from(m[1], "base64");
          // _sanitize_attachment_name + a numbered copy on a clash, like prompt_attachments.py.
          let name = String(params.name || "attachment").replace(/[\\/]/g, "_").replace(/^\.+/, "") || "attachment";
          s.files = s.files ?? new Map();
          for (let n = 2; s.files.has(name); n++) name = name.replace(/(-\d+)?(\.[^.]*)?$/, (_, _n, ext = "") => `-${n}${ext}`);
          s.files.set(name, bytes);
          const ref = `attachments/${name}`;
          const quoted = /[\s()[\]{}"'`]/.test(ref) ? `"${ref}"` : ref;
          return reply({ attached: true, name, path: `/home/hermes/${ref}`, ref_path: ref, ref_text: `@file:${quoted}`, uploaded: true });
        }
        case "prompt.submit": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const text = typeof params.text === "string" ? params.text : JSON.stringify(params.text);
          // Busy: the gateway queues it as the next turn (busy_input_mode "queue").
          if (s.running) {
            s.queue = [...(s.queue ?? []), text];
            return reply({ status: "queued" });
          }
          reply({ status: "streaming" });
          void runTurn(params.session_id, s, text);
          return;
        }
        case "prompt.btw":
        case "prompt.background": {
          const text = String(params.text ?? "");
          if (!text) return fail(4012, "text required");
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const kind = method === "prompt.btw" ? "btw" : "bg";
          const taskId = `${kind}_${(++requestN).toString(16).padStart(6, "0")}`;
          reply({ task_id: taskId });
          // Answers beside the running turn, whatever it is doing.
          setTimeout(() => {
            const answer = /falla/i.test(text)
              ? "error: el modelo auxiliar no respondió (mock)"
              : kind === "btw"
                ? `Al costado: sobre "${text}", el servidor lleva 12 días encendido.`
                : `Terminé en segundo plano: ${text}.`;
            emit(kind === "btw" ? "btw.complete" : "background.complete", params.session_id, {
              task_id: taskId, text: answer, ...(kind === "btw" ? { question: text } : {}),
            });
          }, kind === "btw" ? 300 : 700);
          return;
        }
        case "session.steer": {
          const text = String(params.text ?? "").trim();
          if (!text) return fail(4002, "text is required");
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          // An idle agent can't take a correction: the client sends it as a prompt.
          if (!s.running) return reply({ status: "rejected", text });
          s.steers = [...(s.steers ?? []), text];
          return reply({ status: "queued", text });
        }
        case "session.events.since": {
          const sid = String(params.session_id ?? "");
          const last = Number(params.last_seen ?? 0);
          const r = replay.get(sid) ?? { seq: 0, ring: [], evictedThrough: 0 };
          const events = r.ring.filter((e) => e.seq > last);
          return reply({ events, latest_seq: r.seq, truncated: last < r.evictedThrough, count: events.length, epoch: replayEpoch, open_requests: openFor(sid) });
        }
        case "model.options": {
          const s = live.get(params.session_id);
          const p = profiles.find((x) => x.name === (params.profile || "default"));
          return reply({ ...catalog, model: s?.model ?? p?.model, provider: s?.provider ?? p?.provider });
        }
        case "config.set": {
          const s = live.get(params.session_id);
          if (!s) return fail(4001, "session_id required");
          const value = String(params.value ?? "");
          switch (params.key) {
            case "model": {
              const [model, , provider] = value.split(/\s+/);
              const known = catalog.providers.find((p) => p.slug === provider)?.models.includes(model);
              if (!known) return fail(4002, `unknown model: ${model}`);
              if (EXPENSIVE.has(model) && !params.confirm_expensive_model) {
                return reply({ key: "model", value, confirm_required: true, confirm_message: `${model} cuesta $15/$75 por millón de tokens. ¿Usarlo igual?` });
              }
              Object.assign(s, { model, provider });
              break;
            }
            case "reasoning":
              if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) return fail(4002, `bad effort: ${value}`);
              s.effort = value;
              break;
            case "yolo":
              s.yolo = value === "1";
              break;
            case "fast":
              s.fast = value === "fast";
              break;
            default:
              return fail(4002, `unknown key: ${params.key}`);
          }
          reply({ key: params.key, value, scope: "session" });
          return event("session.info", params.session_id, infoOf(s));
        }
        case "complete.slash": {
          const word = String(params.text ?? "").slice(1).toLowerCase();
          const items = SLASH.filter(([name]) => name.startsWith(word)).map(([name, meta]) => ({ text: `/${name}`, meta }));
          return reply({ items, replace_from: 0 });
        }
        case "slash.exec": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          const [name, ...rest] = String(params.command ?? "").split(/\s+/);
          if (name === "help") return reply({ output: SLASH.map(([n, m]) => `/${n} — ${m}`).join("\n") });
          if (name === "plan") return reply({ type: "send", message: `Armá un plan para: ${rest.join(" ") || "revisar el servidor"}`, display: `/plan ${rest.join(" ")}` });
          if (name === "draft") return reply({ type: "prefill", message: "Escribime un resumen de " });
          if (name === "compress") return reply({ output: "Contexto comprimido: 12.4k → 3.1k tokens." });
          return fail(4018, `unknown command: /${name}`);
        }
        case "command.dispatch":
          return fail(4018, `unknown command: /${params.name}`);
        case "session.undo": {
          const s = live.get(params.session_id);
          if (!s) return fail(4004, "session not live");
          if (s.running) return fail(4009, "session busy");
          const rows = messages.get(`${s.profile}/${s.stored}`) ?? [];
          const at = rows.findLastIndex((r) => r.role === "user");
          const removed = at === -1 ? 0 : rows.splice(at).length;
          return reply({ removed });
        }
        case "session.branch_stored": {
          const profile = params.profile || "default";
          const row = sessions.find((r) => r.id === params.parent_session_id && r.profile === profile);
          if (!row) return fail(4004, "session not found");
          const stored = `${row.id}_b${(n++).toString(16)}`;
          sessions.push({ ...row, id: stored, title: params.title || `${row.title} (rama)`, parent_session_id: row.id, last_active: now(), pinned: false });
          messages.set(`${profile}/${stored}`, (messages.get(`${profile}/${row.id}`) ?? []).map((m) => ({ ...m, session_id: stored })));
          const rid = `rt_${++runtimeN}`;
          const s = freshLive(profile, { profile, stored, title: params.title ?? null, ws, created: true });
          live.set(rid, s);
          return reply({ session_id: rid, stored_session_id: stored, message_count: 0, messages_omitted: true, info: infoOf(s) });
        }
        default:
          return fail(-32601, `method not found: ${method}`);
      }
    });

    async function runTurn(sid, s, text) {
      s.running = true;
      s.interrupted = false;
      s.inflightUser = text;
      s.inflightText = "";
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
      const images = s.images ?? [];
      s.images = [];
      push({ role: "user", content: images.length ? `${text}${text ? "\n" : ""}${images.map(() => "[image]").join(" ")}` : text });
      const stream = async (type, words, delay = 30) => {
        for (const w of words) {
          if (s.interrupted) return false;
          if (type === "message.delta") s.inflightText += w;
          event(type, sid, { text: w });
          await sleep(delay);
        }
        return true;
      };
      const finish = (payload) => {
        s.running = false;
        s.inflightUser = s.inflightText = undefined;
        s.turns = (s.turns ?? 0) + 1;
        s.usage = { input: 1200 * s.turns, output: 300 * s.turns, total: 1500 * s.turns, calls: s.turns, context_used: 9000 * s.turns, context_max: 200000, context_percent: Math.min(100, 4.5 * s.turns), cost_usd: 0.012 * s.turns };
        event("session.usage", sid, { usage: s.usage });
        const row = sessions.find((r) => r.id === s.stored && r.profile === s.profile);
        if (row) {
          row.last_active = now();
          row.message_count = rows.length;
        }
        event("message.complete", sid, { usage: { input_tokens: 120, output_tokens: 80 }, ...payload });
        // The server's own queue drains into the next turn.
        const next = s.queue?.shift();
        if (next != null) setTimeout(() => void runTurn(sid, s, next), 50);
      };
      const interrupted = (partial) => finish({ text: partial, status: "interrupted" });

      event("message.start", sid, {});
      if (/plan|tareas/i.test(text)) {
        const todos = [
          { id: "1", content: "Revisar uptime y carga", status: "completed" },
          { id: "2", content: "Mirar el uso de disco", status: "in_progress" },
          { id: "3", content: "Proponer limpieza", status: "pending" },
        ];
        const row = sessions.find((r) => r.id === s.stored && r.profile === s.profile);
        if (row) row.todos = { todos, revision: 1 };
        event("todo.updated", sid, { todos, revision: 1 });
      }
      if (!(await stream("reasoning.delta", "Pienso qué revisar primero… ".split(/(?<= )/), 20))) return interrupted("");
      const intro = "Dale, lo reviso en el servidor.";
      if (!(await stream("message.delta", intro.split(/(?<= )/)))) return interrupted(intro);
      event("message.delta", sid, { text: null });

      const callId = `call_${++requestN}`;
      event("status.update", sid, { kind: "status", text: "Consultando el servidor…" });
      event("tool.start", sid, { tool_id: callId, name: "terminal", args: { command: "uptime" } });
      await sleep(400);
      // server._status_update(sid, "ready"): the kind doubles as the text.
      event("status.update", sid, { kind: "status", text: "ready" });
      if (s.interrupted) return interrupted(intro);
      event("tool.complete", sid, { tool_id: callId, name: "terminal", args: { command: "uptime" }, duration_s: 0.4, result: { output: "21:14 up 12 days, load average: 0.42", exit_code: 0 }, summary: "up 12 days, load 0.42" });
      push({ role: "assistant", content: intro, tool_calls: [{ id: callId, type: "function", function: { name: "terminal", arguments: '{"command":"uptime"}' } }] });
      push({ role: "tool", tool_call_id: callId, tool_name: "terminal", content: "21:14 up 12 days, load average: 0.42" });

      // Asks the client and waits; `pending` lets an interrupt withdraw it.
      const askAndWait = async (method, params, requestId) => {
        const { id: rid, answer } = ask(method, sid, params);
        s.pending = { id: rid, method, requestId };
        const res = await answer;
        s.pending = null;
        return res;
      };
      const notes = [];
      // Corrections land at the tool boundary.
      for (const steer of s.steers ?? []) notes.push(`Tomé tu corrección: "${steer}".`);
      s.steers = [];

      if (/vault/i.test(text)) {
        // Not implemented by the app: must come back as -32601, not hang.
        const res = await askAndWait("vault.code", { site: "github.com" });
        event("status.update", sid, { kind: "status", text: res.error?.code === -32601 ? "vault declined" : "vault answered" });
      }
      if (/pregunt|deploy/i.test(text)) {
        const res = await askAndWait("clarify", {
          questions: [
            { qid: "q1", question: "¿A qué entorno?", choices: ["staging", "prod"], multi_select: false },
            { qid: "q2", question: "¿Qué servicios reinicio?", choices: ["api", "web", "worker"], multi_select: true },
          ],
        });
        if (s.interrupted) return interrupted(intro);
        const a = res.result?.answers;
        if (!a) notes.push("No respondiste las preguntas, así que no hice el deploy.");
        else {
          let services = a.q2;
          try {
            services = JSON.parse(a.q2).join(", ");
          } catch {
            /* free text */
          }
          notes.push(`Deploy a **${a.q1 ?? "?"}**; servicios: ${services ?? "ninguno"}.`);
        }
      }
      if (/sudo|reinici/i.test(text)) {
        const res = await askAndWait("sudo", { command: "sudo systemctl restart nginx" });
        if (s.interrupted) return interrupted(intro);
        const value = res.result?.value ?? "";
        // The real tool never echoes the password; neither does the mock.
        notes.push(!value ? "Sin contraseña no reinicié nginx." : value === password ? "Reinicié nginx." : "La contraseña de sudo no funcionó.");
      }
      if (/token|clave/i.test(text)) {
        const res = await askAndWait("secret", { env_var: "GITHUB_TOKEN", prompt: "Pegá un token de GitHub con permiso repo.", metadata: { skill: "github-pr-workflow" } });
        if (s.interrupted) return interrupted(intro);
        const value = res.result?.value ?? "";
        notes.push(value ? `Guardé GITHUB_TOKEN (${value.length} caracteres).` : "Seguimos sin token de GitHub.");
      }
      if (images.length) notes.push(`Recibí ${images.length} ${images.length === 1 ? "imagen" : "imágenes"}.`);
      for (const [, quotedRef, plainRef] of text.matchAll(/^@file:(?:"([^"]+)"|(\S+))$/gm)) {
        const name = (quotedRef ?? plainRef).split("/").pop();
        const bytes = s.files?.get(name);
        if (!bytes) notes.push(`No encontré ${name}.`);
        else {
          const pdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
          notes.push(`Leí **${name}** (${bytes.length} bytes${pdf ? ", PDF" : ""}).`);
        }
      }

      let approvalNote = "";
      if (/borr|delete|rm /i.test(text)) {
        const requestId = `appr_${++requestN}`;
        const res = await askAndWait("approval", {
          request_id: requestId, command: "rm -rf /tmp/cache", description: "Comando destructivo detectado",
          choices: ["once", "session", "always", "deny"], tool_name: "terminal",
        }, requestId);
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
      const extra = notes.length ? `\n\n${notes.join("\n\n")}` : "";
      const said = text.replace(/^(@file:.*\n?)+/, "").trim();
      const answer = `Listo. Recibí: _"${said}"_.\n\nEl servidor lleva **12 días** encendido.${extra}${approvalNote}`;
      if (!(await stream("message.delta", answer.match(/.{1,8}/gs), 25))) return interrupted(answer);
      push({ role: "assistant", content: answer });
      finish({ text: answer, status: "complete" });
    }

    ws.on("close", () => {
      for (const [rid, s] of live) {
        if (s.ws !== ws) continue;
        s.ws = null;
        // Questions sent to this socket stay open for whoever re-attaches.
        scheduleReap(rid);
      }
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
          for (const s of live.values()) clearTimeout(s.reap);
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
