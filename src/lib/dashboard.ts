import { findCookie, httpRequest, isNativeApp, type HttpRequest, type HttpResponse } from "./http.ts";
import { sha256 } from "./sha256.ts";
import type { Message, Session } from "./api.ts";

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
}
