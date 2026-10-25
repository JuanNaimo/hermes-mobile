/**
 * One HTTP entry point for the dashboard login, which needs things a
 * cross-origin `fetch` can't do (keep a cookie between two requests, stop at
 * a 302):
 *
 * - Inside the Capacitor app: `CapacitorHttp`, i.e. the platform's HTTP
 *   stack. No CORS, redirects can be disabled, and `Set-Cookie` is readable,
 *   so the caller can forward the cookie itself instead of trusting a jar.
 * - Elsewhere (the Vite dev proxy, which makes the dashboard same-origin, and
 *   Node in tests): `fetch`. The browser's cookie jar carries the cookie.
 */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** JSON-encoded when set. */
  json?: unknown;
  /** Return 3xx responses as-is instead of following them. */
  noRedirect?: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Raw `Set-Cookie` lines when the platform exposes them (native, Node). */
  setCookies: string[];
  /** Parsed JSON body, or the text when it isn't JSON. */
  data: unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  return isNativeApp() ? nativeRequest(req) : fetchRequest(req);
}

async function nativeRequest(req: HttpRequest): Promise<HttpResponse> {
  const { CapacitorHttp } = await import("@capacitor/core");
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  if (req.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method ?? "GET",
    headers,
    data: req.json,
    disableRedirects: req.noRedirect,
    responseType: "text",
  });
  const lower: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    const key = k.toLowerCase();
    const value = Array.isArray(v) ? v.join("\n") : String(v);
    lower[key] = value;
    // Android folds repeated headers with newlines, iOS with commas.
    if (key === "set-cookie") setCookies.push(...splitSetCookie(value));
  }
  return { status: res.status, headers: lower, setCookies, data: parseBody(res.data) };
}

async function fetchRequest(req: HttpRequest): Promise<HttpResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  const res = await fetch(req.url, {
    method: req.method ?? "GET",
    headers,
    body,
    redirect: req.noRedirect ? "manual" : "follow",
    credentials: "same-origin",
    signal: req.signal,
  });
  const lower: Record<string, string> = {};
  res.headers.forEach((v, k) => (lower[k.toLowerCase()] = v));
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie ? getSetCookie.call(res.headers) : [];
  // A browser hides manual redirects behind an opaque status-0 response; the
  // cookie on it is still stored, which is all the login needs.
  const status = res.type === "opaqueredirect" ? 302 : res.status;
  const text = res.type === "opaqueredirect" ? "" : await res.text();
  return { status, headers: lower, setCookies, data: parseBody(text) };
}

function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Split a folded `Set-Cookie` value without breaking on the comma in `Expires=Thu, 01 …`. */
export function splitSetCookie(value: string): string[] {
  return value
    .split(/\n|,(?=\s*[A-Za-z0-9_-]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `name=value` of the first cookie called `name` (any `__Host-`/`__Secure-` prefix). */
export function findCookie(setCookies: string[], name: string): string | undefined {
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    const cookieName = pair.slice(0, eq).trim();
    if (cookieName.replace(/^__(Host|Secure)-/, "") === name && pair.slice(eq + 1)) return pair.trim();
  }
  return undefined;
}
