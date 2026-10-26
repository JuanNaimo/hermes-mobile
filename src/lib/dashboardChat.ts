import type { DashboardClient } from "./dashboard.ts";
import { GatewayClient, type GatewayStatus, type ServerRequest } from "./gateway.ts";
import { approvalToStream, gatewayEventToStream } from "./gatewayEvents.ts";
import { beginRun, endRun, getRun, runEvent } from "./runs.ts";
import type { SocketFactory } from "./socket.ts";

/**
 * Chat for dashboard mode, over the gateway socket (`/api/ws`).
 *
 * The app addresses sessions by their STORED id (what the REST list shows);
 * the gateway runs turns on a RUNTIME id that `session.create` /
 * `session.resume` hand out per connection. This class keeps that mapping and
 * forgets it when the socket drops, since the server detaches live sessions
 * from a closed connection.
 */
export class DashboardChat {
  readonly gateway: GatewayClient;
  /** stored id → runtime id, valid for the current connection. */
  private runtime = new Map<string, string>();
  /** runtime id → stored id, to route events and approvals to runs. */
  private stored = new Map<string, string>();
  private readonly finishers = new Map<string, () => void>();

  constructor(
    dashboard: DashboardClient,
    opts: { socketFactory?: SocketFactory; onStatus?: (s: GatewayStatus, detail?: string) => void } = {},
  ) {
    this.gateway = new GatewayClient({
      url: (attempt) => dashboard.wsUrl(attempt),
      socketFactory: opts.socketFactory,
      onStatus: opts.onStatus,
      onServerRequest: (req) => this.onServerRequest(req),
    });
    this.gateway.on((event) => {
      const sid = event.session_id && this.stored.get(event.session_id);
      if (!sid || !getRun(sid)?.busy) return;
      for (const [name, payload] of gatewayEventToStream(event)) runEvent(sid, name, payload);
      if (event.type === "message.complete") this.finish(sid);
    });
    this.gateway.onDisconnect((reason) => {
      this.runtime.clear();
      this.stored.clear();
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

  private remember(storedId: string, runtimeId: string) {
    this.runtime.set(storedId, runtimeId);
    this.stored.set(runtimeId, storedId);
  }

  /** New session in `profile`. Its stored row appears once the first prompt runs. */
  async create(profile: string, title?: string): Promise<string> {
    const res = await this.gateway.request<{ session_id: string; stored_session_id: string }>("session.create", {
      profile,
      ...(title ? { title } : {}),
    });
    this.remember(res.stored_session_id, res.session_id);
    return res.stored_session_id;
  }

  private async live(storedId: string, profile: string): Promise<string> {
    await this.gateway.connect();
    const known = this.runtime.get(storedId);
    if (known) return known;
    const res = await this.gateway.request<{ session_id: string }>("session.resume", {
      session_id: storedId,
      profile,
      // History comes from REST; don't ship the transcript twice.
      omit_messages: true,
      inline_images: false,
    });
    this.remember(storedId, res.session_id);
    return res.session_id;
  }

  /** Run one turn; resolves when it is accepted, `onFinished` fires when it ends. */
  async send(storedId: string, profile: string, text: string, onFinished?: () => void): Promise<void> {
    beginRun(storedId, text, [], {
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
    });
    this.finishers.set(storedId, () => onFinished?.());
    try {
      const rid = await this.live(storedId, profile);
      await this.gateway.request("prompt.submit", { session_id: rid, text, profile });
    } catch (err) {
      runEvent(storedId, "error", { message: err instanceof Error ? err.message : String(err) });
      this.finish(storedId);
    }
  }

  private onServerRequest(req: ServerRequest) {
    const sid = this.stored.get(String(req.params.session_id ?? ""));
    if (!sid || !getRun(sid)?.busy) {
      // Not a turn on screen here: decline to show it (4404) instead of answering for the
      // person; another attached client, or the timeout, settles it.
      this.gateway.respondError(req.id, 4404, "no window here shows this session");
      return;
    }
    const [name, payload] = approvalToStream(req);
    runEvent(sid, name, payload);
  }

  close() {
    this.gateway.close();
    this.runtime.clear();
    this.stored.clear();
  }
}
