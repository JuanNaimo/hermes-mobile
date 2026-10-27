import { findCookie, httpRequest, isNativeApp, type HttpRequest, type HttpResponse } from "./http.ts";
import { sha256 } from "./sha256.ts";
import type { Job, Message, Session, Skill, Toolset } from "./api.ts";
import { normalizeModelOptions, type ModelOptions } from "./models.ts";
import type {
  MessagingPlatform,
  PairedUser,
  PairingRequest,
  PlatformTest,
  SetupApplied,
  TelegramSetup,
  TelegramSetupStatus,
  WhatsAppSetup,
} from "./messaging.ts";

/**
 * Client for the Hermes dashboard (`hermes dashboard`, default port 9119):
 * one username/password login that covers every profile. The login is the
 * desktop's RFC 8252 native flow (see docs/dashboard-migration.md):
 *
 *   1. GET  /auth/native/authorize  → 302 + `hermes_session_pkce` cookie
 *   2. POST /auth/password-login    (with that cookie) → { next: loopback?code=…&state=… }
 *   3. POST /auth/native/token      { code, code_verifier } → bearer tokens
 *
 * Nothing listens on the loopback `redirect_uri`: the code is read from `next`.
 */

export interface DashboardTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  provider: string;
  userId: string;
}

export interface AuthProvider {
  name: string;
  display_name?: string;
  supports_password?: boolean;
}

export interface DashboardProfile {
  name: string;
  is_default?: boolean;
  model?: string | null;
  provider?: string | null;
  display_name?: string;
  description?: string;
  skill_count?: number;
  gateway_running?: boolean;
}

/** A session row from `/api/profiles/sessions`, tagged with its owning profile. */
export type DashboardSession = Session & { profile: string; is_active?: boolean };

export class DashboardError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DashboardError";
    this.status = status;
    this.code = code;
  }
}

/** Path the Vite dev server proxies to the dashboard (see vite.config.ts). */
export const DEV_PROXY_PATH = "/hermes-dashboard";

/**
 * Where requests actually go. In the native app, straight to the server. In
 * a browser the login can't work cross-origin, so it goes through the Vite
 * dev proxy (same-origin); a production web build has no proxy.
 */
export function dashboardOrigin(baseUrl: string): string {
  if (isNativeApp() || typeof location === "undefined") return baseUrl.replace(/\/+$/, "");
  if (import.meta.env?.DEV) return `${location.origin}${DEV_PROXY_PATH}`;
  throw new DashboardError(
    "El modo dashboard funciona en la app (APK) o con `pnpm dev`, que pasa por el proxy de Vite. " +
      "Desde un hosting estático usá el modo API key.",
    0,
    "unsupported_environment",
  );
}

/** The dashboard the dev proxy points at (`HERMES_DASHBOARD`), when running `pnpm dev`. */
export function devProxyTarget(): string | null {
  return typeof __HERMES_DASHBOARD_PROXY__ === "string" ? __HERMES_DASHBOARD_PROXY__ : null;
}

// -- PKCE ---------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(new TextEncoder().encode(verifier)));
}

// -- errors ---------------------------------------------------------------------

function errorFrom(res: HttpResponse, fallback: string): DashboardError {
  const body = res.data as { detail?: unknown; error?: unknown } | string | null;
  let message = fallback;
  let code: string | undefined;
  if (body && typeof body === "object") {
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = "Datos inválidos en el pedido";
    if (typeof body.error === "string") code = body.error;
  } else if (typeof body === "string" && body.length < 200 && body.trim()) {
    message = body.trim();
  }
  if (res.status === 401 && message === fallback) message = "No autorizado";
  return new DashboardError(message, res.status, code);
}

function networkError(err: unknown, url: string): DashboardError {
  const detail = err instanceof Error ? err.message : String(err);
  return new DashboardError(
    `No se pudo conectar con el dashboard (${url}). Revisá que \`hermes dashboard\` esté corriendo ` +
      `y sea accesible desde este dispositivo. (${detail})`,
    0,
    "network_error",
  );
}

async function send(url: string, init: Omit<HttpRequest, "url"> = {}): Promise<HttpResponse> {
  try {
    return await httpRequest({ url, ...init });
  } catch (err) {
    throw networkError(err, url);
  }
}

function toTokens(raw: unknown): DashboardTokens {
  const t = raw as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    provider?: string;
    user_id?: string;
  };
  if (!t?.access_token || !t.refresh_token) {
    throw new DashboardError("El dashboard no devolvió tokens", 0, "invalid_token_response");
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Number(t.expires_at) || 0,
    provider: t.provider ?? "",
    userId: t.user_id ?? "",
  };
}

// -- login ----------------------------------------------------------------------

export async function listAuthProviders(baseUrl: string): Promise<AuthProvider[]> {
  const origin = dashboardOrigin(baseUrl);
  const res = await send(`${origin}/api/auth/providers`);
  if (res.status !== 200) throw errorFrom(res, "No se pudo leer la lista de proveedores de login");
  const providers = (res.data as { providers?: AuthProvider[] })?.providers;
  return Array.isArray(providers) ? providers : [];
}

export async function dashboardLogin(opts: {
  baseUrl: string;
  username: string;
  password: string;
  provider?: string;
}): Promise<DashboardTokens> {
  const origin = dashboardOrigin(opts.baseUrl);
  const provider = opts.provider ?? "basic";
  const verifier = randomString(48);
  const state = randomString(16);
  // Any loopback port: nothing listens there, the code comes back in `next`.
  const port = 49152 + Math.floor(Math.random() * 16000);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 1. Start the native flow: the server parks a pending login behind a cookie.
  const params = new URLSearchParams({
    provider,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state,
  });
  const start = await send(`${origin}/auth/native/authorize?${params}`, { noRedirect: true });
  if (start.status < 300 || start.status >= 400) {
    throw errorFrom(start, `El dashboard rechazó el inicio de sesión (${start.status})`);
  }
  // The browser jar keeps the cookie on its own; native/Node forward it by hand.
  const pkceCookie = findCookie(start.setCookies, "hermes_session_pkce");

  // 2. Credentials. With the pending-login cookie, `next` is our loopback URL.
  const login = await send(`${origin}/auth/password-login`, {
    method: "POST",
    json: { provider, username: opts.username, password: opts.password },
    headers: pkceCookie ? { Cookie: pkceCookie } : undefined,
  });
  if (login.status === 401) throw new DashboardError("Usuario o contraseña incorrectos", 401, "invalid_credentials");
  if (login.status === 429) throw new DashboardError("Demasiados intentos. Esperá un momento.", 429, "rate_limited");
  if (login.status !== 200) throw errorFrom(login, `El login falló (${login.status})`);
  const next = (login.data as { next?: string })?.next ?? "";
  let code: string | null = null;
  try {
    const url = new URL(next);
    if (url.searchParams.get("state") !== state) throw new Error("state");
    code = url.searchParams.get("code");
  } catch {
    code = null;
  }
  if (!code) {
    throw new DashboardError(
      "El dashboard no devolvió el código de login nativo (¿se perdió la cookie de PKCE?).",
      0,
      "missing_code",
    );
  }

  // 3. Redeem the one-shot code for bearer tokens.
  const token = await send(`${origin}/auth/native/token`, {
    method: "POST",
    json: { code, code_verifier: verifier },
  });
  if (token.status !== 200) throw errorFrom(token, "No se pudo canjear el código de login");
  return toTokens(token.data);
}

export async function refreshTokens(baseUrl: string, tokens: DashboardTokens): Promise<DashboardTokens> {
  const origin = dashboardOrigin(baseUrl);
  const res = await send(`${origin}/auth/native/refresh`, {
    method: "POST",
    json: { refresh_token: tokens.refreshToken, provider: tokens.provider },
  });
  if (res.status === 401) {
    throw new DashboardError("La sesión venció. Volvé a iniciar sesión.", 401, "session_expired");
  }
  if (res.status !== 200) throw errorFrom(res, "No se pudo renovar la sesión");
  return toTokens(res.data);
}

// -- authenticated client -------------------------------------------------------

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_S = 120;

export class DashboardClient {
  readonly baseUrl: string;
  private tokens: DashboardTokens;
  private readonly onTokens: (t: DashboardTokens) => void;
  private refreshing: Promise<DashboardTokens> | null = null;

  constructor(baseUrl: string, tokens: DashboardTokens, onTokens: (t: DashboardTokens) => void = () => {}) {
    this.baseUrl = baseUrl;
    this.tokens = tokens;
    this.onTokens = onTokens;
  }

  /** One refresh at a time; concurrent callers share it. */
  private refresh(): Promise<DashboardTokens> {
    this.refreshing ??= refreshTokens(this.baseUrl, this.tokens)
      .then((t) => {
        this.tokens = t;
        this.onTokens(t);
        return t;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async validToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.tokens.expiresAt && this.tokens.expiresAt - now < REFRESH_MARGIN_S) await this.refresh();
    return this.tokens.accessToken;
  }

  async request<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
    const url = `${dashboardOrigin(this.baseUrl)}${path}`;
    const call = async (token: string) =>
      send(url, { ...init, headers: { Authorization: `Bearer ${token}` } });
    let res = await call(await this.validToken());
    // Server restarted with a new signing secret, clock skew…: refresh once.
    if (res.status === 401) res = await call((await this.refresh()).accessToken);
    if (res.status < 200 || res.status >= 300) throw errorFrom(res, `Error ${res.status} en ${path}`);
    return res.data as T;
  }

  /**
   * Authenticated URL for the chat socket (`/api/ws`). Prefers a single-use
   * 30 s ticket so the long-lived access token never sits in a URL; falls
   * back to `?token=`, which the dashboard also accepts. `attempt` 1 means the
   * first handshake was refused, so the token is refreshed first.
   */
  async wsUrl(attempt = 0): Promise<string> {
    if (attempt > 0) await this.refresh();
    const origin = dashboardOrigin(this.baseUrl).replace(/^http/, "ws");
    try {
      const { ticket } = await this.request<{ ticket?: string }>("/api/auth/ws-ticket", { method: "POST" });
      if (ticket) return `${origin}/api/ws?ticket=${encodeURIComponent(ticket)}`;
    } catch {
      /* older dashboards / bearer not accepted there: use the token */
    }
    return `${origin}/api/ws?token=${encodeURIComponent(await this.validToken())}`;
  }

  me() {
    return this.request<{ user_id: string; display_name?: string; email?: string; provider: string }>(
      "/api/auth/me",
    );
  }

  async profiles(): Promise<DashboardProfile[]> {
    const res = await this.request<{ profiles?: DashboardProfile[] }>("/api/profiles");
    return res?.profiles ?? [];
  }

  /** Sessions across every profile (`profile="all"`) or one, most recent first. */
  async sessions(profile = "all", limit = 200): Promise<DashboardSession[]> {
    const q = new URLSearchParams({ profile, limit: String(limit), order: "recent" });
    const res = await this.request<{ sessions?: DashboardSession[] }>(`/api/profiles/sessions?${q}`);
    return res?.sessions ?? [];
  }

  async messages(sessionId: string, profile: string): Promise<Message[]> {
    const q = new URLSearchParams({ profile, inline_images: "false" });
    const res = await this.request<{ messages?: Message[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${q}`,
    );
    return res?.messages ?? [];
  }

  // -- models (hermes_cli/web_routers/models.py) ------------------------------------

  /** The profile's model catalog, for a chat that has no session yet. */
  async modelOptions(profile: string): Promise<ModelOptions> {
    const q = new URLSearchParams({ profile, explicit_only: "true" });
    return normalizeModelOptions(await this.request(`/api/model/options?${q}`));
  }

  // -- session edits (hermes_cli/web_routers/sessions.py) ---------------------------
  // Fenced like the desktop's: read the session's runtime revision/generation,
  // present them with a fresh request id. Unfenced edits get 409.

  private async fence(id: string, profile: string): Promise<Record<string, string>> {
    const snap = await this.request<{ exists?: boolean; runtime_revision?: number; runtime_generation?: number }>(
      `/api/sessions/${encodeURIComponent(id)}/mutation-snapshot?${new URLSearchParams({ profile })}`,
    );
    const fence: Record<string, string> = { request_id: globalThis.crypto.randomUUID() };
    if (snap?.exists) {
      if (snap.runtime_revision != null) fence.expected_revision = String(snap.runtime_revision);
      if (snap.runtime_generation != null) fence.expected_generation = String(snap.runtime_generation);
    }
    return fence;
  }

  /** Rename, pin, archive or mark read. Archiving also unpins, as the desktop does. */
  async updateSession(
    id: string,
    profile: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; unread?: boolean },
  ): Promise<void> {
    const fence = await this.fence(id, profile);
    const json: Record<string, unknown> = { profile, request_id: fence.request_id, ...patch };
    if (patch.archived) json.pinned = false;
    if (fence.expected_revision) json.expected_revision = Number(fence.expected_revision);
    if (fence.expected_generation) json.expected_generation = Number(fence.expected_generation);
    await this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", json });
  }

  async deleteSession(id: string, profile: string): Promise<void> {
    const q = new URLSearchParams({ profile, ...(await this.fence(id, profile)) });
    await this.request(`/api/sessions/${encodeURIComponent(id)}?${q}`, { method: "DELETE" });
  }

  /** The session and its messages as JSON, for saving or sharing. */
  async exportSession(id: string, profile: string): Promise<string> {
    const data = await this.request<unknown>(
      `/api/sessions/${encodeURIComponent(id)}/export?${new URLSearchParams({ profile })}`,
    );
    return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }

  // -- bots (hermes_cli/web_routers/messaging.py, pairing in ops.py) -------------------

  async messagingPlatforms(profile: string): Promise<MessagingPlatform[]> {
    const res = await this.request<{ platforms?: MessagingPlatform[] }>(
      `/api/messaging/platforms?${new URLSearchParams({ profile })}`,
    );
    return Array.isArray(res?.platforms) ? res.platforms : [];
  }

  /**
   * Turn a platform on/off and set or clear its credentials. Blank values are
   * skipped by the server (it keeps what it has); `hot_served` means the
   * gateway picked the change up without a restart.
   */
  async updatePlatform(
    id: string,
    profile: string,
    patch: { enabled?: boolean; env?: Record<string, string>; clear_env?: string[] },
  ): Promise<{ hot_served?: boolean }> {
    return this.request(`/api/messaging/platforms/${encodeURIComponent(id)}?${new URLSearchParams({ profile })}`, {
      method: "PUT",
      json: { env: {}, clear_env: [], ...patch, profile },
    });
  }

  testPlatform(id: string, profile: string): Promise<PlatformTest> {
    return this.request(`/api/messaging/platforms/${encodeURIComponent(id)}/test?${new URLSearchParams({ profile })}`, {
      method: "POST",
    });
  }

  async pairing(profile: string): Promise<{ pending: PairingRequest[]; approved: PairedUser[] }> {
    const res = await this.request<{ pending?: PairingRequest[]; approved?: PairedUser[] }>(
      `/api/pairing?${new URLSearchParams({ profile })}`,
    );
    return { pending: res?.pending ?? [], approved: res?.approved ?? [] };
  }

  /** Approve a listed request (`request_id`) or the one-time code a user relayed. */
  approvePairing(profile: string, platform: string, target: { request_id?: string; code?: string }) {
    return this.request<{ ok: boolean; user?: PairedUser }>("/api/pairing/approve", {
      method: "POST",
      json: { platform, profile, request_id: target.request_id ?? "", code: target.code ?? "" },
    });
  }

  revokePairing(profile: string, platform: string, userId: string) {
    return this.request("/api/pairing/revoke", { method: "POST", json: { platform, user_id: userId, profile } });
  }

  clearPendingPairing(profile: string) {
    return this.request(`/api/pairing/clear-pending?${new URLSearchParams({ profile })}`, { method: "POST" });
  }

  /** Restart the profile's gateway so platform changes take effect. */
  restartGateway(profile: string) {
    return this.request(`/api/gateway/restart?${new URLSearchParams({ profile })}`, { method: "POST" });
  }

  /** A background `hermes …` action the dashboard spawned (`gateway-restart`, …). */
  actionStatus(name: string): Promise<{ running: boolean; exit_code: number | null; lines?: string[] }> {
    return this.request(`/api/actions/${encodeURIComponent(name)}/status?lines=20`);
  }

  /** The gateway's liveness for a profile (`/api/status`, public). */
  gatewayStatus(profile: string): Promise<{ gateway_running?: boolean; gateway_state?: string | null }> {
    return this.request(`/api/status?${new URLSearchParams({ profile })}`);
  }

  /**
   * Restart the profile's gateway and resolve once it's back: the restart
   * action has exited and the gateway reports running. Throws with the action's
   * last log line when it fails, or after `timeoutMs`.
   */
  async restartGatewayAndWait(profile: string, opts: { timeoutMs?: number; everyMs?: number } = {}) {
    const { timeoutMs = 90_000, everyMs = 1500 } = opts;
    await this.restartGateway(profile);
    const deadline = Date.now() + timeoutMs;
    const pause = () => new Promise((r) => setTimeout(r, everyMs));
    let actionDone = false;
    while (Date.now() < deadline) {
      await pause();
      if (!actionDone) {
        const action = await this.actionStatus("gateway-restart").catch(() => null);
        if (action?.running) continue;
        if (action && action.exit_code != null && action.exit_code !== 0) {
          const last = action.lines?.filter((l) => l.trim()).at(-1);
          throw new Error(`El reinicio del gateway falló${last ? `: ${last}` : ""}`);
        }
        actionDone = true;
      }
      // The dashboard itself may blink while the gateway comes back: keep polling.
      const status = await this.gatewayStatus(profile).catch(() => null);
      if (status?.gateway_running) return;
    }
    throw new Error("El gateway no volvió a tiempo; revisalo en el servidor.");
  }

  telegramSetupStart(botName?: string): Promise<TelegramSetup> {
    return this.request("/api/messaging/telegram/onboarding/start", { method: "POST", json: { bot_name: botName || null } });
  }

  telegramSetupStatus(pairingId: string): Promise<TelegramSetupStatus> {
    return this.request(`/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`);
  }

  telegramSetupApply(pairingId: string, profile: string, allowedUserIds: string[]): Promise<SetupApplied> {
    return this.request(
      `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}/apply?${new URLSearchParams({ profile })}`,
      { method: "POST", json: { allowed_user_ids: allowedUserIds, profile } },
    );
  }

  telegramSetupCancel(pairingId: string) {
    return this.request(`/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`, { method: "DELETE" });
  }

  whatsappSetupStart(
    profile: string,
    opts: { mode: "bot" | "self-chat"; allowed_users?: string; reset_session?: boolean },
  ): Promise<WhatsAppSetup> {
    return this.request(`/api/messaging/whatsapp/onboarding/start?${new URLSearchParams({ profile })}`, {
      method: "POST",
      json: { ...opts, profile },
    });
  }

  whatsappSetupStatus(pairingId: string): Promise<WhatsAppSetup> {
    return this.request(`/api/messaging/whatsapp/onboarding/${encodeURIComponent(pairingId)}`);
  }

  whatsappSetupApply(
    pairingId: string,
    profile: string,
    opts: { mode?: string; allowed_users?: string } = {},
  ): Promise<SetupApplied> {
    return this.request(
      `/api/messaging/whatsapp/onboarding/${encodeURIComponent(pairingId)}/apply?${new URLSearchParams({ profile })}`,
      { method: "POST", json: { ...opts, profile } },
    );
  }

  whatsappSetupCancel(pairingId: string) {
    return this.request(`/api/messaging/whatsapp/onboarding/${encodeURIComponent(pairingId)}`, { method: "DELETE" });
  }

  // -- audio (hermes_cli/web_routers/audio.py) -------------------------------------
  // The REST pair the desktop falls back to: the streaming sockets carry binary
  // frames, which the native socket plugin doesn't.

  /** Speech to text. An empty transcript means no speech was heard (not an error). */
  async transcribe(dataUrl: string, mimeType: string, profile?: string): Promise<string> {
    const q = profile ? `?${new URLSearchParams({ profile })}` : "";
    const res = await this.request<{ transcript?: string }>(`/api/audio/transcribe${q}`, {
      method: "POST",
      json: { data_url: dataUrl, mime_type: mimeType },
    });
    return (res?.transcript ?? "").trim();
  }

  /** Text to speech with the profile's configured provider; returns a playable data URL. */
  async speak(text: string, profile?: string): Promise<string> {
    const q = profile ? `?${new URLSearchParams({ profile })}` : "";
    const res = await this.request<{ data_url?: string }>(`/api/audio/speak${q}`, { method: "POST", json: { text } });
    if (!res?.data_url) throw new DashboardError("El servidor no devolvió audio", 0, "no_audio");
    return res.data_url;
  }

  // -- cron jobs (hermes_cli/web_routers/cron.py) ---------------------------------

  /** Jobs of every profile (`"all"`, each tagged with `profile`) or of one. */
  async cronJobs(profile = "all"): Promise<Job[]> {
    const res = await this.request<Job[]>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`);
    return Array.isArray(res) ? res : [];
  }

  createCronJob(profile: string, job: { name: string; schedule: string; prompt: string }) {
    return this.request<Job>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, { method: "POST", json: job });
  }

  /** `trigger` runs it now (a paused job is resumed for that run). */
  cronAction(id: string, profile: string | undefined, action: "pause" | "resume" | "trigger") {
    return this.request<Job>(`/api/cron/jobs/${encodeURIComponent(id)}/${action}${profileQuery(profile)}`, {
      method: "POST",
    });
  }

  deleteCronJob(id: string, profile?: string) {
    return this.request<{ ok: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}${profileQuery(profile)}`, {
      method: "DELETE",
    });
  }

  // -- skills and toolsets (web_routers/skills.py, web_routers/tools.py) ----------

  async skills(profile: string): Promise<Skill[]> {
    const res = await this.request<Skill[]>(`/api/skills${profileQuery(profile)}`);
    return Array.isArray(res) ? res : [];
  }

  setSkillEnabled(profile: string, name: string, enabled: boolean) {
    return this.request<{ ok: boolean }>(`/api/skills/toggle${profileQuery(profile)}`, {
      method: "PUT",
      json: { name, enabled, profile },
    });
  }

  async toolsets(profile: string): Promise<Toolset[]> {
    const res = await this.request<Toolset[]>(`/api/tools/toolsets${profileQuery(profile)}`);
    return Array.isArray(res) ? res : [];
  }
}

function profileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}
