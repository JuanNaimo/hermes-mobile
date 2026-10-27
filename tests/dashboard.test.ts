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

test("cron jobs across profiles: list, create in a profile, pause/resume/trigger, delete", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const all = await client.cronJobs();
  assert.deepEqual(new Set(all.map((j) => j.profile)), new Set(["default", "tech-insider"]));

  const created = await client.createCronJob("tech-insider", { name: "Prueba", schedule: "every 2h", prompt: "hola" });
  assert.equal(created.profile, "tech-insider");
  assert.ok((await client.cronJobs("tech-insider")).some((j) => j.id === created.id));
  assert.ok(!(await client.cronJobs("default")).some((j) => j.id === created.id));

  assert.equal((await client.cronAction(created.id, "tech-insider", "pause")).state, "paused");
  assert.equal((await client.cronAction(created.id, "tech-insider", "resume")).enabled, true);
  assert.ok((await client.cronAction(created.id, undefined, "trigger")).last_run_at, "profile hint optional");
  await client.deleteCronJob(created.id, "tech-insider");
  await assert.rejects(client.cronAction(created.id, "tech-insider", "pause"), /Job not found/);
  await assert.rejects(client.createCronJob("default", { name: "x", schedule: "", prompt: "y" }), /Datos inválidos/);
});

test("skills per profile with a persistent on/off switch, and toolsets", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const skills = await client.skills("default");
  const ha = skills.find((s) => s.name === "home-assistant")!;
  assert.equal(ha.enabled, false);
  assert.equal(ha.provenance, "hub");
  await client.setSkillEnabled("default", "home-assistant", true);
  assert.equal((await client.skills("default")).find((s) => s.name === "home-assistant")!.enabled, true);
  assert.ok(!(await client.skills("tech-insider")).some((s) => s.name === "home-assistant"));
  const toolsets = await client.toolsets("tech-insider");
  assert.ok(toolsets.some((t) => t.name === "web" && t.configured === false));
});

test("voice: transcribes a clip and synthesizes speech for a profile", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const clip = `data:audio/webm;base64,${Buffer.from("fake opus").toString("base64")}`;
  assert.equal(await client.transcribe(clip, "audio/webm", "default"), "hola hermes, ¿cómo va el servidor?");
  const silence = `data:audio/webm;base64,${Buffer.from("silence").toString("base64")}`;
  assert.equal(await client.transcribe(silence, "audio/webm"), "");
  await assert.rejects(client.transcribe(clip, "text/plain"), /Unsupported audio type/);
  assert.match(await client.speak("Hola", "tech-insider"), /^data:audio\/wav;base64,/);
});

test("session edits are fenced: rename, pin, archive, export and delete", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const [first] = await client.sessions("default");
  await client.updateSession(first.id, "default", { title: "Renombrada" });
  await client.updateSession(first.id, "default", { pinned: true });
  let row = (await client.sessions("default")).find((s) => s.id === first.id)!;
  assert.equal(row.title, "Renombrada");
  assert.equal(row.pinned, true);
  // Archiving also unpins.
  await client.updateSession(first.id, "default", { archived: true });
  row = (await client.sessions("default")).find((s) => s.id === first.id)!;
  assert.deepEqual([row.archived, row.pinned], [true, false]);
  const exported = JSON.parse(await client.exportSession(first.id, "default"));
  assert.equal(exported.id, first.id);
  assert.ok(Array.isArray(exported.messages));
  await client.deleteSession(first.id, "default");
  assert.ok(!(await client.sessions("default")).some((s) => s.id === first.id));
  // An unfenced edit is refused, as on the real dashboard.
  const [other] = await client.sessions("default");
  await assert.rejects(
    client.request(`/api/sessions/${other.id}`, { method: "PATCH", json: { profile: "default", title: "x" } }),
    /mutation_identity_required/,
  );
});

test("model catalog over REST for a new chat", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const options = await client.modelOptions("default");
  assert.equal(options.model, "anthropic/claude-sonnet");
  assert.equal(options.providers[0].capabilities?.["openai/gpt-5"]?.can_disable_reasoning, false);
});

test("bots: platforms per profile, credentials, test, pairing and quick setups", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const platforms = await client.messagingPlatforms("default");
  const tg = platforms.find((p) => p.id === "telegram")!;
  assert.equal(tg.state, "connected");
  // Secrets come back only as a preview.
  assert.equal(tg.env_vars[0].value, null);
  assert.equal((await client.testPlatform("telegram", "default")).auth_posture, "pairing");

  assert.match((await client.testPlatform("discord", "default")).message, /disabled/);
  await client.updatePlatform("discord", "default", { enabled: true, env: { DISCORD_BOT_TOKEN: "tok" } });
  const discord = (await client.messagingPlatforms("default")).find((p) => p.id === "discord")!;
  assert.deepEqual([discord.enabled, discord.configured, discord.state], [true, true, "pending_restart"]);
  await client.updatePlatform("discord", "default", { clear_env: ["DISCORD_BOT_TOKEN"] });
  assert.equal((await client.messagingPlatforms("default")).find((p) => p.id === "discord")!.configured, false);
  // Other profiles keep their own switches.
  assert.equal((await client.messagingPlatforms("tech-insider")).find((p) => p.id === "discord")!.enabled, false);

  let pairing = await client.pairing("default");
  await client.approvePairing("default", "telegram", { request_id: pairing.pending[0].request_id });
  pairing = await client.pairing("default");
  assert.deepEqual([pairing.pending.length, pairing.approved.length], [0, 2]);
  await client.revokePairing("default", "telegram", "555111");
  assert.equal((await client.pairing("default")).approved.length, 1);
  await assert.rejects(client.approvePairing("default", "telegram", { code: "NOPE" }), /not found/);

  const tgSetup = await client.telegramSetupStart();
  assert.match(tgSetup.deep_link, /^https:\/\/t\.me\//);
  assert.equal((await client.telegramSetupStatus(tgSetup.pairing_id)).status, "waiting");
  const ready = await client.telegramSetupStatus(tgSetup.pairing_id);
  assert.equal(ready.status === "ready" && ready.owner_user_id, "123456789");
  assert.equal((await client.telegramSetupApply(tgSetup.pairing_id, "default", ["123456789"])).needs_restart, false);

  const wa = await client.whatsappSetupStart("default", { mode: "bot" });
  assert.equal((await client.whatsappSetupStatus(wa.pairing_id)).status, "waiting");
  await client.whatsappSetupStatus(wa.pairing_id);
  assert.equal((await client.whatsappSetupStatus(wa.pairing_id)).status, "connected");
  assert.equal((await client.whatsappSetupApply(wa.pairing_id, "default")).ok, true);
});

test("restarting the gateway waits for the action and for the gateway to report running", async () => {
  const client = new DashboardClient(base(mock), await dashboardLogin({ baseUrl: base(mock), username: "hermes", password: "hermes" }));
  const started = Date.now();
  await client.restartGatewayAndWait("default", { everyMs: 20 });
  assert.equal((await client.gatewayStatus("default")).gateway_running, true);
  assert.ok(Date.now() - started >= 40, "polled until the action finished");
  await assert.rejects(client.restartGatewayAndWait("default", { everyMs: 20, timeoutMs: 30 }), /no volvió a tiempo/);
});
