import type { DashboardClient } from "./dashboard.ts";
import { GatewayClient, GatewayError, type GatewayStatus, type ServerRequest } from "./gateway.ts";
import { gatewayEventToStream, serverRequestToStream } from "./gatewayEvents.ts";
import { normalizeModelOptions, type ModelOptions } from "./models.ts";
import { beginRun, endRun, getRun, runEvent } from "./runs.ts";
import { adoptFences, forgetFences, getLive, mergeInfo, setTodos, setUsage } from "./sessionLive.ts";
import type { SocketFactory } from "./socket.ts";

/** Model and effort for a chat that doesn't exist yet: they ride on `session.create`. */
export interface NewSessionOptions {
  model?: string;
  provider?: string;
  reasoning_effort?: string;
}

/** The result of a model pick: done, or the server wants a confirmation first. */
export type ModelSwitch =
  | { status: "ok"; warning?: string; deferred?: boolean }
  | { status: "confirm"; message: string };

/** What a slash command asks the app to do next. */
export type SlashOutcome =
  | { kind: "output"; text: string }
  | { kind: "send"; message: string; display?: string }
  | { kind: "prefill"; message: string };

export interface SlashCompletion {
  text: string;
  display?: string;
  meta?: string;
}

/**
 * Chat for dashboard mode, over the gateway socket (`/api/ws`).
 *
 * The app addresses sessions by their STORED id (what the REST list shows);
 * the gateway runs turns on a RUNTIME id that `session.create` /
 * `session.resume` hand out per connection. This class keeps that mapping and
 * forgets it when the socket drops, since the server detaches live sessions
 * from a closed connection.
 *
 * Two server flavours: a plain `hermes dashboard` takes the legacy setters
 * (`config.set`, `session.undo`, `session.branch_stored`); one hosted by the
 * gateway's session authority refuses those and wants revision-fenced
 * `session.mutate` instead. `gateway.sessionAuthority` says which.
 */
export class DashboardChat {
  readonly gateway: GatewayClient;
  private readonly dashboard: DashboardClient;
  /** stored id → runtime id, valid for the current connection. */
  private runtime = new Map<string, string>();
  /** runtime id → stored id, to route events and approvals to runs. */
  private stored = new Map<string, string>();
  /** stored id → the resume in flight, so concurrent callers share it. */
  private attaching = new Map<string, Promise<string>>();
  private readonly finishers = new Map<string, () => void>();

  constructor(
    dashboard: DashboardClient,
    opts: {
      socketFactory?: SocketFactory;
      onStatus?: (s: GatewayStatus, detail?: string) => void;
      /** A title changed or sessions came and went on the server: refetch the list. */
      onSessionsChanged?: () => void;
    } = {},
  ) {
    this.dashboard = dashboard;
    this.gateway = new GatewayClient({
      url: (attempt) => dashboard.wsUrl(attempt),
      socketFactory: opts.socketFactory,
      onStatus: opts.onStatus,
      onServerRequest: (req) => this.onServerRequest(req),
    });
    this.gateway.on((event) => {
      if (event.type === "sessions.changed") return opts.onSessionsChanged?.();
      const sid = event.session_id && this.stored.get(event.session_id);
      if (!sid) return;
      const p = event.payload;
      // Session state: whether or not a turn runs here.
      adoptFences(sid, event.type === "session.info" || event.type === "session.updated" ? p.revision : undefined,
        (event as { execution_generation?: unknown }).execution_generation ?? p.execution_generation);
      switch (event.type) {
        case "session.info":
          mergeInfo(sid, p);
          break;
        case "session.usage":
          setUsage(sid, p.usage ?? p);
          break;
        case "todo.updated":
          setTodos(sid, p.todos, p.revision);
          break;
        case "tool.complete":
          if (p.todos) setTodos(sid, p.todos, p.revision);
          break;
        case "message.complete":
          setUsage(sid, p.usage);
          break;
        case "session.title":
          mergeInfo(sid, { title: p.title });
          opts.onSessionsChanged?.();
          break;
      }
      if (!getRun(sid)?.busy) return;
      for (const [name, payload] of gatewayEventToStream(event)) runEvent(sid, name, payload);
      if (event.type === "message.complete") this.finish(sid);
    });
    this.gateway.onDisconnect((reason) => {
      this.runtime.clear();
      this.stored.clear();
      this.attaching.clear();
      forgetFences();
      // A turn can't be followed across connections: say so and let the
      // transcript (reloaded from REST) show what the server did.
      for (const [sid] of this.finishers) {
        runEvent(sid, "error", {
          message: `${reason} Si el turno seguía en el servidor, recargá la sesión para ver el resultado.`,
        });
        this.finish(sid);
      }
    });
  }

  private finish(storedId: string) {
    endRun(storedId);
    const done = this.finishers.get(storedId);
    this.finishers.delete(storedId);
    done?.();
  }

  private remember(storedId: string, runtimeId: string, result: Record<string, unknown>) {
    this.runtime.set(storedId, runtimeId);
    this.stored.set(runtimeId, storedId);
    mergeInfo(storedId, result.info as Record<string, unknown> | undefined);
    adoptFences(storedId, result.revision, result.execution_generation);
    const todos = result.todo_state as { todos?: unknown; revision?: unknown } | null | undefined;
    if (todos) setTodos(storedId, todos.todos, todos.revision);
  }

  /** New session in `profile`. Its stored row appears once the first prompt runs. */
  async create(profile: string, title?: string, options: NewSessionOptions = {}): Promise<string> {
    const params: Record<string, unknown> = { profile, ...(title ? { title } : {}) };
    for (const [k, v] of Object.entries(options)) if (v) params[k] = v;
    const res = await this.gateway.request<{ session_id: string; stored_session_id: string } & Record<string, unknown>>(
      "session.create",
      params,
    );
    this.remember(res.stored_session_id, res.session_id, res);
    return res.stored_session_id;
  }

  /**
   * Attach a stored session to this connection (once) and return its runtime
   * id. Opening a session does this too, so its model, effort and usage show
   * before anything is sent.
   */
  async attach(storedId: string, profile: string): Promise<string> {
    await this.gateway.connect();
    const known = this.runtime.get(storedId);
    if (known) return known;
    let pending = this.attaching.get(storedId);
    if (!pending) {
      pending = this.gateway
        .request<{ session_id: string } & Record<string, unknown>>("session.resume", {
          session_id: storedId,
          profile,
          // History comes from REST; don't ship the transcript twice.
          omit_messages: true,
          inline_images: false,
        })
        .then((res) => {
          this.remember(storedId, res.session_id, res);
          return res.session_id;
        })
        .finally(() => this.attaching.delete(storedId));
      this.attaching.set(storedId, pending);
    }
    return pending;
  }

  /**
   * Run one turn; resolves when it is accepted, `onFinished` fires when it ends.
   * `images` are data URLs; each is queued with `image.attach_bytes` and rides
   * along with the next `prompt.submit`. `before` runs first, inside the turn
   * (a retry's undo), so its failure shows in the transcript like any other.
   */
  async send(
    storedId: string,
    profile: string,
    text: string,
    images: string[] = [],
    onFinished?: () => void,
    before?: (runtimeId: string) => Promise<void>,
  ): Promise<void> {
    beginRun(storedId, text, images, {
      stop: async () => {
        const rid = this.runtime.get(storedId);
        if (rid) await this.gateway.request("session.interrupt", { session_id: rid, profile });
      },
      approve: async (item, choice) => {
        if (item.rpcId != null) {
          this.gateway.respond(item.rpcId, { choice });
          return;
        }
        // Card replayed without the request id: answer through the RPC instead.
        const rid = this.runtime.get(storedId);
        if (rid) await this.gateway.request("approval.respond", { session_id: rid, profile, choice, request_id: item.requestId });
      },
      respond: async (item, result) => {
        this.gateway.respond(item.rpcId, result);
      },
    });
    this.finishers.set(storedId, () => onFinished?.());
    try {
      const rid = await this.attach(storedId, profile);
      await before?.(rid);
      for (const [i, url] of images.entries()) {
        const res = await this.gateway.request<{ attached?: boolean; message?: string }>("image.attach_bytes", {
          session_id: rid,
          profile,
          content_base64: url.slice(url.indexOf(",") + 1),
          filename: `imagen-${i + 1}.${/^data:image\/png/.test(url) ? "png" : "jpg"}`,
        });
        if (res?.attached === false) throw new Error(res.message || "El servidor no aceptó la imagen");
      }
      await this.gateway.request("prompt.submit", { session_id: rid, text, profile });
    } catch (err) {
      runEvent(storedId, "error", { message: err instanceof Error ? err.message : String(err) });
      this.finish(storedId);
    }
  }

  /**
   * Run the last user turn again: drop it (and its reply) from the session,
   * then send `text` (the same words, or edited ones) in its place.
   */
  async retry(storedId: string, profile: string, text: string, onFinished?: () => void, lastUserRowId?: number) {
    await this.send(storedId, profile, text, [], onFinished, async (rid) => {
      if (this.gateway.sessionAuthority) {
        if (lastUserRowId == null) throw new Error("No se encontró el mensaje a reintentar; recargá la sesión.");
        await this.mutate(storedId, profile, "rewind", { target_message_id: lastUserRowId });
      } else {
        await this.gateway.request("session.undo", { session_id: rid, profile, intent: "retry" });
      }
    });
  }

  // -- session settings ----------------------------------------------------------

  /**
   * Authority mode's fenced edit. A fence refusal that names fresh fences is
   * retried once at them for value picks (re-applying a model or effort is
   * harmless); anything else surfaces.
   */
  private async mutate(
    storedId: string,
    profile: string,
    operation: string,
    payload: Record<string, unknown>,
    retry = true,
  ): Promise<Record<string, unknown>> {
    const rid = await this.attach(storedId, profile);
    const { revision, generation } = getLive(storedId);
    if (revision === undefined) throw new Error("La sesión no informó su revisión; volvé a abrirla.");
    try {
      const res = await this.gateway.request<Record<string, unknown>>("session.mutate", {
        session_id: rid,
        profile,
        request_id: globalThis.crypto.randomUUID(),
        expected_revision: revision,
        ...(generation !== undefined ? { expected_generation: generation } : {}),
        operation,
        payload,
      });
      adoptFences(storedId, res?.revision);
      return res ?? {};
    } catch (err) {
      const reason = err instanceof GatewayError ? err.data?.reason : undefined;
      if (err instanceof GatewayError && (reason === "revision_conflict" || reason === "stale_generation")) {
        adoptFences(storedId, err.data?.revision, err.data?.execution_generation);
        if (retry && (operation === "model" || operation === "reasoning")) {
          return this.mutate(storedId, profile, operation, payload, false);
        }
      }
      throw err;
    }
  }

  private async configSet(storedId: string, profile: string, key: string, value: string, extra: Record<string, unknown> = {}) {
    const rid = await this.attach(storedId, profile);
    const res = await this.gateway.request<Record<string, unknown>>("config.set", { session_id: rid, profile, key, value, ...extra });
    mergeInfo(storedId, res?.info as Record<string, unknown> | undefined);
    return res ?? {};
  }

  /** The catalog, with the session's current pick when it is attached. */
  async modelOptions(storedId: string | null, profile: string, refresh = false): Promise<ModelOptions> {
    if (!storedId) return this.dashboard.modelOptions(profile);
    const rid = await this.attach(storedId, profile);
    const raw = await this.gateway.request("model.options", { session_id: rid, profile, explicit_only: true, ...(refresh ? { refresh: true } : {}) });
    return normalizeModelOptions(raw);
  }

  /** Switch this session's model. Expensive models answer `confirm` first; call again with `confirm`. */
  async setModel(storedId: string, profile: string, model: string, provider: string, confirm = false): Promise<ModelSwitch> {
    let res: Record<string, unknown>;
    if (this.gateway.sessionAuthority) {
      res = await this.mutate(storedId, profile, "model", { model, provider, ...(confirm ? { confirm: true } : {}) });
    } else {
      res = await this.configSet(storedId, profile, "model", `${model} --provider ${provider} --session`, {
        ...(confirm ? { confirm_expensive_model: true } : {}),
      });
    }
    if (res.confirm_required) {
      return { status: "confirm", message: String(res.confirm_message || "Este modelo es caro. ¿Usarlo igual?") };
    }
    if (!res.deferred) mergeInfo(storedId, { model, provider });
    return { status: "ok", warning: typeof res.warning === "string" ? res.warning : undefined, deferred: Boolean(res.deferred) };
  }

  /** Reasoning effort for this session (`none` turns thinking off). */
  async setReasoning(storedId: string, profile: string, effort: string) {
    if (this.gateway.sessionAuthority) await this.mutate(storedId, profile, "reasoning", { effort });
    else await this.configSet(storedId, profile, "reasoning", effort);
    mergeInfo(storedId, { reasoning_effort: effort });
  }

  /** Skip approvals for this session. */
  async setYolo(storedId: string, profile: string, on: boolean) {
    await this.configSet(storedId, profile, "yolo", on ? "1" : "0");
    mergeInfo(storedId, { yolo: on });
  }

  /** Priority tier, where the model offers one. */
  async setFast(storedId: string, profile: string, on: boolean) {
    await this.configSet(storedId, profile, "fast", on ? "fast" : "normal");
    mergeInfo(storedId, { fast: on });
  }

  /** Copy the session into a new one; returns the new stored id. */
  async branch(storedId: string, profile: string, title?: string): Promise<string> {
    if (this.gateway.sessionAuthority) {
      const res = await this.mutate(storedId, profile, "branch", title ? { title } : {});
      const id = res.branched_session_id ?? res.stored_session_id;
      if (typeof id !== "string") throw new Error("El servidor no devolvió la sesión nueva");
      return id;
    }
    await this.gateway.connect();
    const res = await this.gateway.request<{ session_id: string; stored_session_id: string } & Record<string, unknown>>(
      "session.branch_stored",
      { parent_session_id: storedId, profile, ...(title ? { title } : {}) },
    );
    this.remember(res.stored_session_id, res.session_id, res);
    return res.stored_session_id;
  }

  // -- slash commands --------------------------------------------------------------

  /** Completions for the composer's `/…` text; each replaces `text` from `replaceFrom` on. */
  async completeSlash(
    text: string,
    storedId: string | null,
    profile: string,
  ): Promise<{ items: SlashCompletion[]; replaceFrom: number }> {
    await this.gateway.connect();
    const rid = storedId ? this.runtime.get(storedId) : undefined;
    const res = await this.gateway.request<{ items?: SlashCompletion[]; replace_from?: number }>("complete.slash", {
      text,
      profile,
      ...(rid ? { session_id: rid } : {}),
    });
    return {
      items: Array.isArray(res?.items) ? res.items : [],
      replaceFrom: typeof res?.replace_from === "number" ? res.replace_from : 0,
    };
  }

  /**
   * Run `/name args` on the session. Plain commands answer with output;
   * directives ask to send a message (skills, aliases resolve to one) or to
   * put text in the composer.
   */
  async runSlash(storedId: string, profile: string, line: string): Promise<SlashOutcome> {
    const rid = await this.attach(storedId, profile);
    const command = line.trim().replace(/^\/+/, "");
    let res: Record<string, unknown>;
    try {
      res = await this.gateway.request<Record<string, unknown>>("slash.exec", { session_id: rid, profile, command });
    } catch (err) {
      // Commands slash.exec can't run in-process go through the dispatcher.
      if (!(err instanceof GatewayError)) throw err;
      const [name, ...rest] = command.split(/\s+/);
      res = await this.gateway.request<Record<string, unknown>>("command.dispatch", {
        session_id: rid,
        profile,
        name,
        arg: rest.join(" "),
      });
    }
    return slashOutcome(res);
  }

  private onServerRequest(req: ServerRequest) {
    const sid = this.stored.get(String(req.params.session_id ?? ""));
    if (!sid || !getRun(sid)?.busy) {
      // Not a turn on screen here: decline to show it (4404) instead of answering for the
      // person; another attached client, or the timeout, settles it.
      this.gateway.respondError(req.id, 4404, "no window here shows this session");
      return;
    }
    const [name, payload] = serverRequestToStream(req);
    runEvent(sid, name, payload);
  }

  close() {
    this.gateway.close();
    this.runtime.clear();
    this.stored.clear();
    this.attaching.clear();
  }
}

/** `apps/shared/src/slash.ts` directive types → what the app does. */
export function slashOutcome(res: Record<string, unknown> | null | undefined): SlashOutcome {
  const r = res ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (r.type) {
    case "send":
    case "skill":
      if (str(r.message)) return { kind: "send", message: str(r.message), display: str(r.display) || undefined };
      break;
    case "prefill":
      return { kind: "prefill", message: str(r.message) };
  }
  const text = [str(r.output), str(r.notice), str(r.warning)].filter(Boolean).join("\n\n");
  return { kind: "output", text: text || "Listo." };
}
