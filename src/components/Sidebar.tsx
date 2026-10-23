import { useMemo, useState } from "react";
import { Spinner } from "@/components/ds";
import {
  CalendarClock,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Puzzle,
  Search,
  Server,
  X,
} from "lucide-react";
import { useApp, type View } from "@/store";
import { busySessions, useRunsVersion } from "@/lib/runs";
import { cn, relativeTime } from "@/lib/utils";
import { IconButton, SectionLabel, StatusDot } from "./ui";

const NAV: { view: View; label: string; icon: typeof MessageSquare }[] = [
  { view: "chat", label: "Chat", icon: MessageSquare },
  { view: "jobs", label: "Jobs", icon: CalendarClock },
  { view: "skills", label: "Skills", icon: Puzzle },
  { view: "server", label: "Servidor", icon: Server },
];

export function Sidebar({
  onNavigate,
  onClose,
  onCollapse,
}: {
  /** Called after any selection (closes the drawer in portrait). */
  onNavigate: () => void;
  onClose?: () => void;
  onCollapse?: () => void;
}) {
  const {
    sessions,
    sessionsLoading,
    sessionsError,
    activeSessionId,
    setActiveSessionId,
    view,
    setView,
    connection,
    refreshSessions,
  } = useApp();
  useRunsVersion();
  const running = new Set(busySessions());
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sessions.filter((s) => !s.archived);
    if (!q) return list;
    return list.filter(
      (s) => (s.title ?? "").toLowerCase().includes(q) || (s.preview ?? "").toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const pinned = filtered.filter((s) => s.pinned);
  const rest = filtered.filter((s) => !s.pinned);

  function open(id: string | null) {
    setActiveSessionId(id);
    setView("chat");
    onNavigate();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Brand header — same lockup as the dashboard sidebar. */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-current/20 ps-4 pe-1">
        <span className="font-bold text-[1.125rem] leading-[0.95] tracking-[0.0525rem] text-midground uppercase">
          Hermes
          <br />
          Agent
        </span>
        <div className="flex items-center">
          {onCollapse && (
            <IconButton label="Ocultar panel" onClick={onCollapse}>
              <PanelLeftClose />
            </IconButton>
          )}
          {onClose && (
            <IconButton label="Cerrar menú" onClick={onClose}>
              <X />
            </IconButton>
          )}
        </div>
      </div>

      <nav aria-label="Navegación" className="shrink-0 border-b border-current/10 py-1.5">
        <ul className="grid grid-cols-4">
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = view === v;
            return (
              <li key={v}>
                <button
                  type="button"
                  onClick={() => {
                    setView(v);
                    onNavigate();
                  }}
                  className={cn(
                    "relative flex h-14 w-full flex-col items-center justify-center gap-1",
                    "text-display text-[0.7rem] tracking-[0.12em] transition-colors",
                    active ? "text-midground" : "text-text-secondary hover:text-midground",
                  )}
                >
                  <Icon className="size-4.5" />
                  {label}
                  {active && <span aria-hidden className="absolute inset-x-4 bottom-0 h-px bg-midground" />}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={() => open(null)}
          className={cn(
            "flex h-12 items-center justify-center gap-2 rounded-[var(--radius-sm)]",
            "bg-midground text-background-base font-bold text-display text-xs tracking-[0.2em]",
            "shadow-[inset_-1px_-1px_0_0_#00000080,inset_1px_1px_0_0_#ffffff80] active:invert",
          )}
        >
          <Plus className="size-4" /> Nueva conversación
        </button>
        <label className="flex h-11 items-center gap-2 border border-current/15 bg-background/40 px-3 rounded-[var(--radius-sm)] focus-within:border-midground/40">
          <Search className="size-4 shrink-0 text-text-tertiary" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar sesiones"
            className="min-w-0 flex-1 bg-transparent text-base text-midground placeholder:text-text-disabled focus:outline-none"
          />
        </label>
      </div>

      <div className="scroll-area min-h-0 flex-1 pb-2">
        {sessionsLoading && sessions.length === 0 && (
          <div className="flex justify-center py-8 text-text-secondary">
            <Spinner />
          </div>
        )}
        {sessionsError && (
          <div className="mx-3 my-2 border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {sessionsError}
            <button type="button" onClick={() => void refreshSessions()} className="mt-2 block underline">
              Reintentar
            </button>
          </div>
        )}
        {pinned.length > 0 && <Group label="Fijadas" />}
        {pinned.map((s) => (
          <SessionRow
            key={s.id}
            title={s.title || s.preview || s.id}
            meta={relativeTime(s.last_active ?? s.started_at)}
            active={view === "chat" && s.id === activeSessionId}
            running={running.has(s.id)}
            onClick={() => open(s.id)}
          />
        ))}
        {rest.length > 0 && <Group label="Recientes" />}
        {rest.map((s) => (
          <SessionRow
            key={s.id}
            title={s.title || s.preview || s.id}
            meta={[relativeTime(s.last_active ?? s.started_at), s.source && s.source !== "api_server" ? s.source : ""]
              .filter(Boolean)
              .join(" · ")}
            active={view === "chat" && s.id === activeSessionId}
            running={running.has(s.id)}
            onClick={() => open(s.id)}
          />
        ))}
        {!sessionsLoading && !sessionsError && filtered.length === 0 && (
          <p className="px-5 py-6 text-sm text-text-tertiary">
            {query ? "Sin resultados." : "Todavía no hay sesiones."}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-current/20 px-4 py-3 pb-[calc(var(--safe-bottom)+0.75rem)]">
        <StatusDot tone={sessionsError ? "error" : "ok"} />
        <div className="min-w-0">
          <div className="truncate text-sm text-midground">{connection?.label || "Hermes"}</div>
          <div className="truncate font-mono text-xs text-text-tertiary">
            {connection?.baseUrl}
            {connection?.profile ? ` · ${connection.profile}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <SectionLabel className="block px-5 pt-3 pb-1">{label}</SectionLabel>;
}

function SessionRow({
  title,
  meta,
  active,
  running,
  onClick,
}: {
  title: string;
  meta: string;
  active: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/row relative flex min-h-14 w-full items-center gap-3 px-5 py-2 text-start transition-colors",
        active ? "text-midground" : "text-text-secondary hover:text-midground",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        {meta && <span className="block truncate text-xs text-text-tertiary">{meta}</span>}
      </span>
      {running && <Spinner className="shrink-0 text-midground" aria-label="En curso" />}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0.5 left-1.5 right-1.5 bg-midground transition-opacity duration-200",
          active ? "opacity-[0.07]" : "opacity-0 group-hover/row:opacity-5",
        )}
      />
      {active && <span aria-hidden className="absolute top-0 bottom-0 left-0 w-px bg-midground" />}
    </button>
  );
}
