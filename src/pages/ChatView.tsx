import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "@/components/ds";
import { ArrowDown, Ellipsis, GitBranch, Pencil, RefreshCw, Sparkles, Trash2, WifiOff, X } from "lucide-react";
import { useApp } from "@/store";
import { ApiError } from "@/lib/api";
import { historyToItems, type ChatItem } from "@/lib/transcript";
import {
  answerApproval,
  answerInput,
  clearRun,
  dropQueued,
  enqueue,
  getQueue,
  getRun,
  startRun,
  stopRun,
  useRunsVersion,
  type FileAttachment,
} from "@/lib/runs";
import { ApprovalCard, AssistantMessage, InputCard, Notice, ToolActivity, UserMessage } from "@/components/ChatItems";
import { Composer } from "@/components/Composer";
import { SessionControls } from "@/components/SessionControls";
import { ContextMeter, QueueStrip, SessionMenu, TodoStrip, type SessionAction } from "@/components/SessionPanels";
import type { NewSessionOptions } from "@/lib/dashboardChat";
import { useLive } from "@/lib/sessionLive";
import { EmptyState, IconButton, SectionLabel } from "@/components/ui";
import { cn } from "@/lib/utils";
import { isNativeApp } from "@/lib/http";
import { blobToDataUrl, speak, stopSpeaking } from "@/lib/voice";

const SUGGESTIONS = [
  "¿Qué podés hacer en este servidor?",
  "Resumime los cambios de hoy en mi repo",
  "Revisá el uso de disco y avisame si algo está lleno",
  "Programá un recordatorio diario a las 9",
];

export function ChatView({ leading }: { leading?: ReactNode }) {
  const {
    client,
    dashboard,
    chat,
    chatStatus,
    loadMessages,
    activeSessionId,
    activeProfile,
    setActiveSessionId,
    sessions,
    sessionsLoading,
    refreshSessions,
    profiles,
    profileFilter,
    settings,
    notify,
  } = useApp();
  // Dashboard mode: history over REST, turns over the gateway socket.
  const dashboardMode = !client && Boolean(chat);
  useRunsVersion();
  const session = sessions.find((s) => s.id === activeSessionId);
  // A session created here isn't in the list until its first turn is stored.
  const sessionProfile = session?.profile ?? activeProfile ?? undefined;
  const defaultProfile =
    profileFilter !== "all" ? profileFilter : (profiles.find((p) => p.is_default)?.name ?? profiles[0]?.name ?? "default");
  const [newChatProfile, setNewChatProfile] = useState<string | null>(null);
  const targetProfile = newChatProfile ?? defaultProfile;
  const run = getRun(activeSessionId);
  const busy = Boolean(run?.busy);
  const live = useLive(activeSessionId);
  /** Model and effort picked for a chat that doesn't exist yet. */
  const [newChatOptions, setNewChatOptions] = useState<NewSessionOptions>({});
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>();
  /** The composer holds an edit of the last user message: sending runs it again. */
  const [editing, setEditing] = useState(false);
  /** Output of slash commands run here, shown under the transcript until the next reload. */
  const [slashNotes, setSlashNotes] = useState<ChatItem[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const [history, setHistory] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadHistory = useCallback(
    async (id: string, profile?: string) => {
      setLoading(true);
      try {
        const msgs = await loadMessages({ id, profile });
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
        // A brand-new dashboard session has no stored row until its first turn lands.
        if (getRun(id)?.busy) setHistory([]);
        else setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [loadMessages],
  );

  // The dashboard needs the owning profile, known once the session list loaded.
  const waitingForProfile = dashboardMode && Boolean(activeSessionId) && !sessionProfile;
  useEffect(() => {
    setHistory([]);
    setLoadError(null);
    setSlashNotes([]);
    setEditing(false);
    if (activeSessionId && !waitingForProfile) void loadHistory(activeSessionId, sessionProfile);
  }, [activeSessionId, sessionProfile, waitingForProfile, loadHistory]);

  // A turn picked up from the server (opened mid-reply, or started elsewhere):
  // reload so the part of it already stored isn't shown twice.
  const resumedBusy = Boolean(run?.resumed && run.busy);
  useEffect(() => {
    if (resumedBusy && activeSessionId && !waitingForProfile) void loadHistory(activeSessionId, sessionProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumedBusy]);

  // A remembered session that no longer exists (deleted, other login).
  useEffect(() => {
    if (waitingForProfile && !sessionsLoading && sessions.length > 0) setActiveSessionId(null);
  }, [waitingForProfile, sessionsLoading, sessions.length, setActiveSessionId]);

  // -- scrolling -------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const items = [...history, ...(run?.stream.items ?? []), ...slashNotes];
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

  // -- voice (dashboard mode: the dashboard transcribes and synthesizes) --------
  const voiceProfile = sessionProfile ?? targetProfile;

  const transcribe = dashboard
    ? async (clip: Blob) => dashboard.transcribe(await blobToDataUrl(clip), clip.type.split(";")[0] || "audio/webm", voiceProfile)
    : undefined;

  const speakReply = useCallback(
    (key: string, text: string) => {
      if (!dashboard) return;
      void speak(key, text, (said) => dashboard.speak(said, voiceProfile)).catch((err) =>
        notify(`No se pudo leer la respuesta: ${err instanceof Error ? err.message : String(err)}`, "error"),
      );
    },
    [dashboard, voiceProfile, notify],
  );

  // Read at the end of a turn, so the latest setting counts, not the one at send time.
  const autoSpeakRef = useRef(settings.autoSpeak);
  autoSpeakRef.current = settings.autoSpeak;
  const speakRef = useRef(speakReply);
  speakRef.current = speakReply;

  function speakFinishedTurn(sessionId: string) {
    if (!autoSpeakRef.current || getActiveId() !== sessionId) return;
    const reply = getRun(sessionId)?.stream.items.findLast((it) => it.kind === "assistant" && it.text.trim());
    if (reply?.kind === "assistant") speakRef.current(reply.text, reply.text);
  }

  // Leaving the session (or the chat) stops a reply being read out.
  useEffect(() => stopSpeaking, [activeSessionId]);

  // -- actions ---------------------------------------------------------------
  async function send(text: string, images: string[], files: FileAttachment[] = []) {
    if (chat && !client) return sendDashboard(chat, text, images, files);
    if (!client) return;
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
      if (getActiveId() === sessionId && !endedWithNotice(sessionId)) void loadHistory(sessionId);
    });
  }

  async function sendDashboard(dc: NonNullable<typeof chat>, text: string, images: string[], files: FileAttachment[] = []) {
    if (editing) return retryLast(text);
    let id = activeSessionId;
    let profile = sessionProfile;
    const slash = images.length === 0 && files.length === 0 && /^\/\S/.test(text);
    try {
      if (!id) {
        profile = targetProfile;
        const title = text || files[0]?.name || "Imagen";
        id = await dc.create(profile, slash ? undefined : title.replace(/\s+/g, " ").slice(0, 60), newChatOptions);
        setNewChatOptions({});
        if (slash) setActiveSessionId(id, profile);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
      return;
    }
    if (!profile) return;
    setPinned(true);
    if (slash) return runSlash(dc, id, profile, text);
    const sessionId = id;
    // `send` registers the live run synchronously, before any await.
    stopSpeaking();
    // Its end is handled by the `onRunEnded` listener above.
    void dc.send(sessionId, profile, text, images, undefined, { files });
    if (!activeSessionId) setActiveSessionId(sessionId, profile);
  }

  /** `/command`: output shows as a note; directives send a message or fill the composer. */
  async function runSlash(dc: NonNullable<typeof chat>, sessionId: string, profile: string, line: string) {
    const note = (text: string, tone: "info" | "error" = "info") =>
      setSlashNotes((prev) => [...prev, { kind: "notice", key: `slash-${Date.now()}-${prev.length}`, tone, text }]);
    try {
      const out = await dc.runSlash(sessionId, profile, line);
      if (out.kind === "output") note(`${line.split(/\s/)[0]}\n${out.text}`);
      else if (out.kind === "prefill") setPrefill({ text: out.message, nonce: Date.now() });
      else {
        stopSpeaking();
        void dc.send(sessionId, profile, out.message, []);
      }
      void refreshSessions();
    } catch (err) {
      note(`${line.split(/\s/)[0]}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  const slashComplete = useCallback(
    (text: string) =>
      chat ? chat.completeSlash(text, activeSessionId, voiceProfile) : Promise.resolve({ items: [], replaceFrom: 0 }),
    [chat, activeSessionId, voiceProfile],
  );

  // -- retry / edit the last turn ------------------------------------------------
  const lastUserIndex = history.findLastIndex((it) => it.kind === "user");
  const lastAssistantIndex = history.findLastIndex((it) => it.kind === "assistant");
  const canRetry = dashboardMode && !busy && !run && lastUserIndex !== -1 && Boolean(sessionProfile);

  /** Drop the last user turn (and its reply) and run `text` in its place. */
  function retryLast(text?: string) {
    const item = history[lastUserIndex];
    if (!chat || !activeSessionId || !sessionProfile || item?.kind !== "user") return;
    const sessionId = activeSessionId;
    const profile = sessionProfile;
    const rowId = Number(item.key.replace(/^h-/, ""));
    setEditing(false);
    setPinned(true);
    // The live run re-renders the turn; hide the stored copy it replaces.
    setHistory((prev) => prev.slice(0, lastUserIndex));
    stopSpeaking();
    void chat.retry(
      sessionId,
      profile,
      text ?? item.text,
      undefined,
      Number.isFinite(rowId) ? rowId : undefined,
      item.fileRefs,
    );
  }

  function editLast() {
    const item = history[lastUserIndex];
    if (item?.kind !== "user") return;
    setEditing(true);
    setPrefill({ text: item.text, nonce: Date.now() });
  }

  // -- session actions (dashboard mode) -------------------------------------------
  async function sessionAction(action: SessionAction) {
    if (!dashboard || !chat || !activeSessionId || !sessionProfile) return;
    const id = activeSessionId;
    const profile = sessionProfile;
    const fail = (err: unknown) => notify(err instanceof Error ? err.message : String(err), "error");
    try {
      switch (action) {
        case "rename": {
          const title = window.prompt("Nuevo título", session?.title ?? "");
          if (title == null || !title.trim()) return;
          await dashboard.updateSession(id, profile, { title: title.trim() });
          notify("Sesión renombrada");
          break;
        }
        case "pin":
          await dashboard.updateSession(id, profile, { pinned: !session?.pinned });
          break;
        case "archive":
          await dashboard.updateSession(id, profile, { archived: true });
          setActiveSessionId(null);
          notify("Sesión archivada");
          break;
        case "branch": {
          const child = await chat.branch(id, profile, `${session?.title || "Sesión"} (rama)`);
          await refreshSessions();
          setActiveSessionId(child, profile);
          notify("Sesión ramificada");
          return;
        }
        case "export":
          await exportJson(await dashboard.exportSession(id, profile), `${(session?.title || id).replace(/[^\w.-]+/g, "_")}.json`);
          return;
        case "delete":
          if (!window.confirm("¿Borrar esta sesión? No se puede deshacer.")) return;
          await dashboard.deleteSession(id, profile);
          setActiveSessionId(null);
          notify("Sesión borrada");
          break;
      }
      void refreshSessions();
    } catch (err) {
      fail(err);
    }
  }

  /** Share sheet where there is one (files), a download in browsers, the clipboard otherwise. */
  async function exportJson(json: string, filename: string) {
    const file = new File([json], filename, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
    if (!isNativeApp()) {
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    await navigator.clipboard.writeText(json);
    notify("Exportación copiada al portapapeles");
  }

  /**
   * A stopped or failed turn keeps its live view (partial text + the notice):
   * the stored transcript has neither, so reloading would erase what happened.
   * Opening the session again shows the stored history.
   */
  const endedWithNotice = (sessionId: string) => getRun(sessionId)?.stream.items.at(-1)?.kind === "notice";

  // `activeSessionId` captured by the callback above may be stale.
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const getActiveId = () => activeRef.current;

  // Dashboard turns end here, whoever started them: read the reply aloud,
  // refresh the list and swap the live view for the stored transcript.
  const onRunEndedRef = useRef<(id: string, profile: string) => void>(() => {});
  onRunEndedRef.current = (id, profile) => {
    speakFinishedTurn(id);
    void refreshSessions();
    if (getActiveId() === id && !endedWithNotice(id)) void loadHistory(id, profile);
  };
  useEffect(() => chat?.onRunEnded((id, profile) => onRunEndedRef.current(id, profile)), [chat]);

  // -- writing while Hermes answers (dashboard) ----------------------------------
  const queue = getQueue(activeSessionId);

  async function steer(text: string) {
    if (!chat || !activeSessionId || !sessionProfile) return;
    try {
      if ((await chat.steer(activeSessionId, sessionProfile, text)) === "queued") {
        enqueue(activeSessionId, text, []);
        notify("La respuesta ya no podía tomar la corrección: quedó para después.");
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function sendQueuedNow(key: string) {
    const item = queue.find((q) => q.key === key);
    if (!item || !activeSessionId || !chat) return;
    dropQueued(activeSessionId, key);
    void sendDashboard(chat, item.text, item.images, item.files);
  }

  async function rename() {
    if (!session || !client) return;
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
    if (!session || !client) return;
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
    if (!session || !client || !window.confirm("¿Borrar esta sesión? No se puede deshacer.")) return;
    try {
      await client.deleteSession(session.id);
      setActiveSessionId(null);
      void refreshSessions();
      notify("Sesión borrada");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const title =
    session?.title || (activeSessionId ? "Sesión" : "Nueva conversación");
  const chatDown = dashboardMode && chatStatus.status === "closed" && chatStatus.detail;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-current/20 px-2 sm:px-3">
        {leading}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-sm font-bold text-midground sm:text-base">{title}</h2>
          {!session && activeSessionId && sessionProfile && (
            <p className="truncate font-mono text-xs text-text-tertiary">{sessionProfile}</p>
          )}
          {session && (
            <p className="truncate font-mono text-xs text-text-tertiary">
              {session.profile && `${session.profile} · `}
              {live.info.model || session.model || "hermes-agent"}
              {session.message_count != null && ` · ${session.message_count} mensajes`}
              {session.estimated_cost_usd ? ` · $${session.estimated_cost_usd.toFixed(3)}` : ""}
            </p>
          )}
        </div>
        {busy && <Spinner className="me-2 text-midground" aria-label="Hermes está trabajando" />}
        {dashboardMode && activeSessionId && <ContextMeter usage={live.usage} model={live.info.model} />}
        {session && (
          <>
            <IconButton label="Recargar" onClick={() => void loadHistory(session.id, session.profile)} disabled={busy}>
              <RefreshCw />
            </IconButton>
          </>
        )}
        {session && dashboardMode && (
          <>
            <IconButton label="Acciones de la sesión" onClick={() => setMenuOpen(true)}>
              <Ellipsis />
            </IconButton>
            <SessionMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              pinned={Boolean(session.pinned)}
              busy={busy}
              onAction={(a) => void sessionAction(a)}
            />
          </>
        )}
        {session && client && (
          <>
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
                {dashboardMode && profiles.length > 1 && (
                  <div className="mb-4 flex flex-wrap items-center justify-center gap-2">
                    <SectionLabel>Perfil</SectionLabel>
                    {profiles.map((p) => (
                      <button
                        key={p.name}
                        type="button"
                        aria-pressed={targetProfile === p.name}
                        onClick={() => setNewChatProfile(p.name)}
                        className={cn(
                          "h-9 border px-3 text-sm transition-colors rounded-[var(--radius-sm)]",
                          targetProfile === p.name
                            ? "border-midground bg-midground text-background-base"
                            : "border-current/20 text-text-secondary hover:text-midground",
                        )}
                      >
                        {p.display_name || p.name}
                      </button>
                    ))}
                  </div>
                )}
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

            {items.map((item, i) => {
              switch (item.kind) {
                case "user":
                  return (
                    <UserMessage
                      key={item.key}
                      item={item}
                      onEdit={canRetry && i === lastUserIndex ? editLast : undefined}
                    />
                  );
                case "assistant":
                  return (
                    <AssistantMessage
                      key={item.key}
                      item={item}
                      showReasoning={settings.showReasoning}
                      onSpeak={dashboardMode ? speakReply : undefined}
                      onRetry={canRetry && i === lastAssistantIndex && i > lastUserIndex ? () => retryLast() : undefined}
                    />
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
                        void answerApproval(activeSessionId, item.key, choice).catch((err) =>
                          notify(err instanceof Error ? err.message : String(err), "error"),
                        )
                      }
                    />
                  );
                case "input":
                  return (
                    <InputCard
                      key={item.key}
                      item={item}
                      onAnswer={(result, resolved) =>
                        activeSessionId
                          ? answerInput(activeSessionId, item.key, result, resolved).catch((err) =>
                              notify(err instanceof Error ? err.message : String(err), "error"),
                            )
                          : undefined
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
          {chatDown && (
            <p className="mb-2 flex items-start gap-2 text-xs text-text-secondary">
              <WifiOff className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>{chatStatus.detail} Se reconecta al enviar.</span>
            </p>
          )}
          {dashboardMode && <TodoStrip todos={live.todos} />}
          {dashboardMode && activeSessionId && queue.length > 0 && (
            <QueueStrip
              items={queue}
              busy={busy}
              onDrop={(key) => dropQueued(activeSessionId, key)}
              onSendNow={sendQueuedNow}
            />
          )}
          {editing && (
            <p className="mb-2 flex items-center gap-2 text-xs text-text-secondary">
              <Pencil className="size-3.5 shrink-0 text-midground" />
              <span className="flex-1">Editando tu último mensaje: al enviar se reemplaza junto con su respuesta.</span>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setPrefill({ text: "", nonce: Date.now() });
                }}
                className="inline-flex min-h-9 items-center gap-1 px-2 text-text-tertiary hover:text-midground"
              >
                <X className="size-3.5" /> Cancelar
              </button>
            </p>
          )}
          <Composer
            busy={busy}
            prefill={prefill}
            onSlashComplete={dashboardMode ? slashComplete : undefined}
            toolbar={
              // An open session needs its owning profile before it can be attached.
              dashboardMode && chat && (!activeSessionId || sessionProfile) ? (
                <SessionControls
                  chat={chat}
                  sessionId={activeSessionId}
                  profile={voiceProfile}
                  draft={newChatOptions}
                  onDraftChange={setNewChatOptions}
                  onError={(m) => notify(m, "error")}
                  onNotice={(m) => notify(m)}
                  disabled={busy}
                />
              ) : undefined
            }
            enterSends={settings.enterSends}
            onSend={(t, imgs, files) => void send(t, imgs, files)}
            allowFiles={dashboardMode}
            onQueue={dashboardMode && activeSessionId ? (t, imgs, files) => enqueue(activeSessionId, t, imgs, files) : undefined}
            onSteer={dashboardMode && activeSessionId ? (t) => void steer(t) : undefined}
            onTranscribe={dashboardMode ? transcribe : undefined}
            onError={(message) => notify(message, "error")}
            onStop={() =>
              activeSessionId &&
              void stopRun(activeSessionId).catch((err) => notify(err instanceof Error ? err.message : String(err), "error"))
            }
          />
        </div>
      </div>
    </div>
  );
}
