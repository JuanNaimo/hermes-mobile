import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Sync } from "../src/lib/sha256.ts";
import { findCookie, splitSetCookie } from "../src/lib/http.ts";
import { DashboardClient, dashboardLogin, pkceChallenge, type DashboardTokens } from "../src/lib/dashboard.ts";
// @ts-expect-error plain JS module without types
import { startMockDashboard } from "../scripts/mock-dashboard.mjs";

test("sha256 fallback matches node:crypto across block boundaries", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = randomBytes(len);
    assert.equal(
      Buffer.from(sha256Sync(new Uint8Array(data))).toString("hex"),
      createHash("sha256").update(data).digest("hex"),
      `length ${len}`,
    );
  }
});

test("PKCE challenge matches the RFC 7636 appendix B vector", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("finds the PKCE cookie in folded and prefixed Set-Cookie headers", () => {
  const folded = "a=1; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT, __Host-hermes_session_pkce=xyz; HttpOnly; Path=/";
  const lines = splitSetCookie(folded);
  assert.equal(lines.length, 2);
  assert.equal(findCookie(lines, "hermes_session_pkce"), "__Host-hermes_session_pkce=xyz");
  assert.equal(findCookie(["hermes_session_pkce=; Max-Age=0"], "hermes_session_pkce"), undefined);
});

let mock: { port: number; close: () => Promise<void> };
let shortTtl: { port: number; close: () => Promise<void> };
before(async () => {
  mock = await startMockDashboard({ port: 0, log: false });
  // Tokens that are already inside the refresh margin.
  shortTtl = await startMockDashboard({ port: 0, log: false, accessTtl: 30 });
});
after(async () => {
  await mock.close();
  await shortTtl.close();
});

const base = (m: { port: number }) => `http://127.0.0.1:${m.port}`;

test("logs in through the native PKCE flow and reads profiles, sessions and history", async () => {
  const tokens = await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" });
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.equal(tokens.provider, "basic");

  const client = new DashboardClient(base(mock), tokens);
  assert.equal((await client.me()).user_id, "hermes");
  assert.deepEqual((await client.profiles()).map((p) => p.name), ["default", "tech-insider"]);

  const all = await client.sessions();
  assert.equal(new Set(all.map((s) => s.profile)).size, 2);
  const only = await client.sessions("tech-insider");
  assert.ok(only.length > 0 && only.every((s) => s.profile === "tech-insider"));

  const nas = all.find((s) => s.title === "Revisión del NAS")!;
  const msgs = await client.messages(nas.id, nas.profile);
  assert.equal(msgs[0].role, "user");
  await assert.rejects(client.messages(nas.id, "tech-insider"), /Session not found/);
});

test("rejects bad credentials with a readable error", async () => {
  await assert.rejects(
    dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "nope" }),
    /Usuario o contraseña incorrectos/,
  );
});

test("refreshes tokens before they expire and persists the new pair", async () => {
  const tokens = await dashboardLogin({ baseUrl: base(shortTtl), username: "hermes", password: "hermes" });
  const saved: DashboardTokens[] = [];
  const client = new DashboardClient(base(shortTtl), tokens, (t) => saved.push(t));
  // Two concurrent calls share a single refresh.
  await Promise.all([client.profiles(), client.sessions()]);
  assert.equal(saved.length, 1);
  assert.notEqual(saved[0].accessToken, tokens.accessToken);
});

test("a revoked refresh token surfaces session_expired", async () => {
  const tokens = await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" });
  const client = new DashboardClient(base(mock), { ...tokens, accessToken: "stale", refreshToken: "revoked" });
  await assert.rejects(client.profiles(), (err: { code?: string }) => err.code === "session_expired");
});
