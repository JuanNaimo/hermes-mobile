import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "@/components/ds";
import { ArrowDown, GitBranch, Pencil, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useApp, useClient } from "@/store";
import { ApiError } from "@/lib/api";
import { historyToItems, type ChatItem } from "@/lib/transcript";
import { answerApproval, clearRun, getRun, startRun, stopRun, useRunsVersion } from "@/lib/runs";
import { ApprovalCard, AssistantMessage, Notice, ToolActivity, UserMessage } from "@/components/ChatItems";
import { Composer } from "@/components/Composer";
import { EmptyState, IconButton } from "@/components/ui";

const SUGGESTIONS = [
  "¿Qué podés hacer en este servidor?",
  "Resumime los cambios de hoy en mi repo",
  "Revisá el uso de disco y avisame si algo está lleno",
  "Programá un recordatorio diario a las 9",
];

export function ChatView({ leading }: { leading?: ReactNode }) {
  const client = useClient();
  const {
    activeSessionId,
    setActiveSessionId,
    sessions,
    refreshSessions,
    settings,
    notify,
  } = useApp();
  useRunsVersion();
  const session = sessions.find((s) => s.id === activeSessionId);
  const run = getRun(activeSessionId);
  const busy = Boolean(run?.busy);

  const [history, setHistory] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const msgs = await client.messages(id);
        let loaded = historyToItems(msgs);
        // A turn still streaming is already persisted from its user message
        // on; show that tail from the live run instead of twice.
        const live = getRun(id);
        const first = live?.stream.items[0];
        if (live?.busy && first?.kind === "user") {
          const at = loaded.findLastIndex((it) => it.kind === "user" && it.text === first.text);
          if (at !== -1) loaded = loaded.slice(0, at);
        }
        setHistory(loaded);
        setLoadError(null);
        // The server transcript now contains the finished turn.
        clearRun(id);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    setHistory([]);
    setLoadError(null);
    if (activeSessionId) void loadHistory(activeSessionId);
  }, [activeSessionId, loadHistory]);

  // -- scrolling -------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const items = [...history, ...(run?.stream.items ?? [])];
  const lastLen = items.length;
  const lastText = (() => {
    const last = items[items.length - 1];
    return last && last.kind === "assistant" ? last.text.length + last.reasoning.length : 0;
  })();

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [lastLen, lastText, pinned, loading]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  }

  // -- actions ---------------------------------------------------------------
  async function send(text: string, images: string[]) {
    let id = activeSessionId;
    try {
      if (!id) {
        const title = (text || "Imagen").replace(/\s+/g, " ").slice(0, 60);
        const created = await client.createSession(title);
        id = created.id;
        setActiveSessionId(id);
        void refreshSessions();
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
      return;
    }
    setPinned(true);
    const sessionId = id;
    void startRun(client, sessionId, text, images, () => {
      void refreshSessions();
      // Only reload if the person is still looking at this session.
      if (getActiveId() === sessionId) void loadHistory(sessionId);
    });
  }

  // `activeSessionId` captured by the callback above may be stale.
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const getActiveId = () => activeRef.current;

  async function rename() {
    if (!session) return;
    const title = window.prompt("Nuevo título", session.title ?? "");
    if (title == null || !title.trim()) return;
    try {
      await client.renameSession(session.id, title.trim());
      void refreshSessions();
    } catch (err) {
      const blocked = err instanceof ApiError && err.code === "network_error";
      notify(
        blocked
          ? "El API server no permite PATCH desde el navegador (CORS). Renombrá desde el dashboard o la CLI."
          : err instanceof Error
            ? err.message
            : String(err),
        "error",
      );
    }
  }

  async function fork() {
    if (!session) return;
    try {
      const child = await client.forkSession(session.id, `${session.title || "Sesión"} (rama)`);
      await refreshSessions();
      setActiveSessionId(child.id);
      notify("Sesión ramificada");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function remove() {
    if (!session || !window.confirm("¿Borrar esta sesión? No se puede deshacer.")) return;
    try {
      await client.deleteSession(session.id);
      setActiveSessionId(null);
      void refreshSessions();
      notify("Sesión borrada");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const title = session?.title || (activeSessionId ? "Sesión" : "Nueva conversación");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-current/20 px-2 sm:px-3">
        {leading}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-sm font-bold text-midground sm:text-base">{title}</h2>
          {session && (
            <p className="truncate font-mono text-xs text-text-tertiary">
              {session.model || "hermes-agent"}
              {session.message_count != null && ` · ${session.message_count} mensajes`}
              {session.estimated_cost_usd ? ` · $${session.estimated_cost_usd.toFixed(3)}` : ""}
            </p>
          )}
        </div>
        {busy && <Spinner className="me-2 text-midground" aria-label="Hermes está trabajando" />}
        {session && (
          <>
            <IconButton label="Recargar" onClick={() => void loadHistory(session.id)} disabled={busy}>
              <RefreshCw />
            </IconButton>
            <IconButton label="Renombrar" onClick={rename} className="hidden sm:inline-flex">
              <Pencil />
            </IconButton>
            <IconButton label="Ramificar" onClick={fork} disabled={busy}>
              <GitBranch />
            </IconButton>
            <IconButton label="Borrar" onClick={remove} disabled={busy} className="hover:text-destructive">
              <Trash2 />
            </IconButton>
          </>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scroll-area absolute inset-0">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
            {loading && history.length === 0 && (
              <div className="flex justify-center py-10 text-text-secondary">
                <Spinner />
              </div>
            )}
            {loadError && <Notice item={{ kind: "notice", key: "load", tone: "error", text: loadError }} />}

            {!activeSessionId && items.length === 0 && (
              <div className="flex flex-col items-center pt-[8vh]">
                <EmptyState icon={<Sparkles />} title="¿En qué te ayudo?">
                  Hermes tiene acceso a sus herramientas, memoria y skills del servidor.
                </EmptyState>
                <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s, [])}
                      className="min-h-14 border border-current/15 bg-card/50 px-4 py-3 text-start text-sm text-text-secondary hover:border-current/30 hover:text-midground rounded-[var(--radius-md)]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {items.map((item) => {
              switch (item.kind) {
                case "user":
                  return <UserMessage key={item.key} item={item} />;
                case "assistant":
                  return (
                    <AssistantMessage key={item.key} item={item} showReasoning={settings.showReasoning} />
                  );
                case "tool":
                  return <ToolActivity key={item.key} item={item} />;
                case "approval":
                  return (
                    <ApprovalCard
                      key={item.key}
                      item={item}
                      onChoose={(choice) =>
                        activeSessionId &&
                        void answerApproval(client, activeSessionId, item.key, choice).catch((err) =>
                          notify(err instanceof Error ? err.message : String(err), "error"),
                        )
                      }
                    />
                  );
                case "notice":
                  return <Notice key={item.key} item={item} />;
              }
            })}
          </div>
        </div>

        {!pinned && (
          <button
            type="button"
            aria-label="Ir al final"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 inline-flex size-11 -translate-x-1/2 items-center justify-center rounded-full border border-current/25 bg-background-base/90 text-midground backdrop-blur animate-fade"
          >
            <ArrowDown className="size-5" />
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pt-2 pb-[calc(var(--safe-bottom)+0.75rem)] sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            busy={busy}
            enterSends={settings.enterSends}
            onSend={(t, imgs) => void send(t, imgs)}
            onStop={() => activeSessionId && void stopRun(client, activeSessionId)}
          />
        </div>
      </div>
    </div>
  );
}
