import { useState } from "react";
import { Spinner } from "@/components/ds";
import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Download,
  GitFork,
  GitBranch,
  ListPlus,
  Send,
  ListTodo,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { Queued } from "@/lib/runs";
import { buildSubagentTree, isActive, type Subagent, type SubagentNode } from "@/lib/subagents";
import type { Todo, Usage } from "@/lib/sessionLive";
import { cn } from "@/lib/utils";

// -- session actions ------------------------------------------------------------------

export type SessionAction = "rename" | "pin" | "archive" | "branch" | "export" | "delete";

/** Rename, pin, archive, branch, export and delete, in one sheet for small screens. */
export function SessionMenu({
  open,
  onClose,
  pinned,
  busy,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  pinned: boolean;
  /** A turn is running: branching and deleting wait. */
  busy: boolean;
  onAction: (action: SessionAction) => void;
}) {
  const rows: { action: SessionAction; label: string; icon: typeof Pin; danger?: boolean; off?: boolean }[] = [
    { action: "rename", label: "Renombrar", icon: Pencil },
    { action: "pin", label: pinned ? "Desfijar" : "Fijar arriba", icon: pinned ? PinOff : Pin },
    { action: "branch", label: "Ramificar en una sesión nueva", icon: GitBranch, off: busy },
    { action: "export", label: "Exportar (JSON)", icon: Download },
    { action: "archive", label: "Archivar", icon: Archive },
    { action: "delete", label: "Borrar", icon: Trash2, danger: true, off: busy },
  ];
  return (
    <BottomSheet open={open} onClose={onClose} title="Sesión">
      <div className="flex flex-col p-2 pb-4">
        {rows.map(({ action, label, icon: Icon, danger, off }) => (
          <button
            key={action}
            type="button"
            disabled={off}
            onClick={() => {
              onClose();
              onAction(action);
            }}
            className={cn(
              "flex min-h-12 items-center gap-3 rounded-[var(--radius-sm)] px-3 text-start hover:bg-midground/5 disabled:opacity-40",
              danger ? "text-destructive" : "text-midground",
            )}
          >
            <Icon className="size-4.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

// -- context / usage --------------------------------------------------------------------

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** A ring with how full the context window is; tap for tokens and cost. */
export function ContextMeter({ usage, model }: { usage: Usage | null; model?: string }) {
  const [open, setOpen] = useState(false);
  const pct = usage?.context_percent;
  if (pct == null && !usage?.total) return null;
  const value = Math.max(0, Math.min(100, pct ?? 0));
  const r = 8;
  const c = 2 * Math.PI * r;
  const tone = value >= 85 ? "text-destructive" : value >= 65 ? "text-warning" : "text-midground";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Contexto usado: ${Math.round(value)}%`}
        className="inline-flex h-11 shrink-0 items-center gap-1.5 px-2 text-xs text-text-secondary hover:text-midground"
      >
        <svg viewBox="0 0 20 20" className={cn("size-5 -rotate-90", tone)} aria-hidden>
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2.5} />
          <circle
            cx="10"
            cy="10"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeDasharray={c}
            strokeDashoffset={c * (1 - value / 100)}
            strokeLinecap="round"
          />
        </svg>
        <span className="hidden font-mono sm:inline">{pct != null ? `${Math.round(value)}%` : fmt(usage?.total)}</span>
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Uso de la sesión">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-5 pb-8 text-sm">
          {model && <Stat label="Modelo" value={model} mono wide />}
          <Stat
            label="Contexto"
            value={
              usage?.context_max
                ? `${fmt(usage.context_used)} / ${fmt(usage.context_max)}${pct != null ? ` (${Math.round(value)}%)` : ""}${usage.context_estimated ? " aprox." : ""}`
                : "—"
            }
            wide
          />
          <Stat label="Tokens de entrada" value={fmt(usage?.input)} />
          <Stat label="Tokens de salida" value={fmt(usage?.output)} />
          {usage?.reasoning ? <Stat label="Razonamiento" value={fmt(usage.reasoning)} /> : null}
          <Stat label="Llamadas" value={fmt(usage?.calls)} />
          {usage?.cache_hit_pct != null && <Stat label="Caché" value={`${Math.round(usage.cache_hit_pct)}%`} />}
          {usage?.avg_tps != null && <Stat label="Velocidad" value={`${usage.avg_tps.toFixed(0)} tok/s`} />}
          {usage?.compressions ? <Stat label="Compresiones" value={String(usage.compressions)} /> : null}
          <Stat
            label="Costo"
            value={usage?.cost_usd != null ? `$${usage.cost_usd.toFixed(4)}${usage.cost_status === "estimated" ? " aprox." : ""}` : "—"}
          />
        </dl>
        {value >= 80 && (
          <p className="px-5 pb-6 text-xs text-text-secondary">
            El contexto está casi lleno. Escribí <code className="font-mono text-midground">/compress</code> para resumir la
            conversación y liberar espacio.
          </p>
        )}
      </BottomSheet>
    </>
  );
}

function Stat({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-xs text-text-tertiary">{label}</dt>
      <dd className={cn("truncate text-midground", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}

// -- todos ---------------------------------------------------------------------------------

const TODO_ICON = { pending: Circle, in_progress: CircleDot, completed: CheckCircle2, cancelled: XCircle };

/** The agent's plan for this session, folded to its current step above the composer. */
export function TodoStrip({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  return (
    <div className="mb-2 border border-current/15 bg-card/60 backdrop-blur rounded-[var(--radius-md)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-start text-xs text-text-secondary"
      >
        <ListTodo className="size-4 shrink-0 text-midground" />
        <span className="font-mono text-midground">
          {done}/{todos.length}
        </span>
        <span className="min-w-0 flex-1 truncate">{current ? current.content : "Plan completo"}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {todos.map((t) => {
            const Icon = TODO_ICON[t.status];
            return (
              <li
                key={t.id}
                className={cn(
                  "flex items-start gap-2 text-sm",
                  t.status === "completed" || t.status === "cancelled" ? "text-text-tertiary line-through" : "text-midground",
                )}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", t.status === "in_progress" && "text-warning")} />
                <span>{t.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// -- subagents --------------------------------------------------------------------------

const SUBAGENT_ICON = { completed: CheckCircle2, failed: XCircle, interrupted: XCircle, queued: Circle } as const;

/** The children this session delegated to, folded to a count; opens into their tree. */
export function SubagentStrip({ subagents }: { subagents: Subagent[] }) {
  const [open, setOpen] = useState(false);
  if (subagents.length === 0) return null;
  const active = subagents.filter(isActive).length;
  const failed = subagents.filter((s) => s.status === "failed").length;
  const current = subagents.find((s) => s.status === "running") ?? subagents.find(isActive);
  return (
    <div className="mb-2 border border-current/15 bg-card/60 backdrop-blur rounded-[var(--radius-md)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 text-start text-xs text-text-secondary"
      >
        <GitFork className="size-4 shrink-0 text-midground" />
        <span className="shrink-0 text-midground">
          {active ? `${active} subagente${active === 1 ? "" : "s"} trabajando` : `${subagents.length} subagente${subagents.length === 1 ? "" : "s"}`}
        </span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} con error</span>}
        <span className="min-w-0 flex-1 truncate">{current ? `· ${current.goal}` : ""}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {buildSubagentTree(subagents).map((n) => (
            <SubagentRow key={n.id} node={n} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({ node, depth }: { node: SubagentNode; depth: number }) {
  const Icon = node.status === "running" ? null : SUBAGENT_ICON[node.status];
  const detail = [node.currentTool, node.detail].filter(Boolean).join(" · ");
  return (
    <li style={{ paddingInlineStart: `${depth * 1.25}rem` }}>
      <div className="flex items-start gap-2 py-1 text-sm">
        <span className="mt-0.5 shrink-0">
          {Icon ? (
            <Icon
              className={cn(
                "size-4",
                node.status === "completed" && "text-success",
                (node.status === "failed" || node.status === "interrupted") && "text-destructive",
                node.status === "queued" && "text-text-tertiary",
              )}
            />
          ) : (
            <Spinner />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-midground">{node.goal || "Subagente"}</span>
          {detail && <span className="block truncate text-xs text-text-tertiary">{detail}</span>}
        </span>
        {node.durationSeconds != null && (
          <span className="shrink-0 font-mono text-xs text-text-tertiary">{Math.round(node.durationSeconds)} s</span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <SubagentRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// -- status ------------------------------------------------------------------------------

/** What the agent is doing right now, above the composer while a turn runs. */
export function StatusLine({ text }: { text: string }) {
  return (
    <p role="status" aria-live="polite" className="mb-2 flex min-h-6 items-center gap-2 px-1 text-xs text-text-secondary">
      <Spinner />
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}

// -- queue -----------------------------------------------------------------------------------

/**
 * Messages written while Hermes answered. They go out one by one when the turn
 * ends; after a stopped or failed turn they wait here to be sent or dropped.
 */
export function QueueStrip({
  items,
  busy,
  onDrop,
  onSendNow,
}: {
  items: Queued[];
  busy: boolean;
  onDrop: (key: string) => void;
  onSendNow: (key: string) => void;
}) {
  return (
    <section aria-label="Mensajes en cola" className="mb-2 flex flex-col gap-1">
      <p className="flex items-center gap-1.5 px-1 text-xs text-text-tertiary">
        <ListPlus className="size-3.5" />
        {busy ? "Se mandan cuando Hermes termine" : "En espera: la respuesta anterior no terminó bien"}
      </p>
      <ul className="flex flex-col gap-1">
        {items.map((q, i) => (
          <li
            key={q.key}
            className="flex min-h-11 items-center gap-2 border border-dashed border-current/25 bg-card/60 ps-3 backdrop-blur rounded-[var(--radius-md)]"
          >
            <span className="font-mono text-xs text-text-tertiary">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-midground">
              {q.text || q.files[0]?.name || "Imagen"}
              {(q.images.length > 0 || q.files.length > 0) && (
                <span className="text-text-tertiary"> · {q.images.length + q.files.length} adjunto(s)</span>
              )}
            </span>
            {!busy && i === 0 && (
              <button
                type="button"
                onClick={() => onSendNow(q.key)}
                aria-label="Enviar ahora"
                className="inline-flex size-11 items-center justify-center text-midground hover:bg-midground/10 rounded-[var(--radius-md)]"
              >
                <Send className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onDrop(q.key)}
              aria-label={`Quitar de la cola: ${q.text || "imagen"}`}
              className="inline-flex size-11 items-center justify-center text-text-tertiary hover:text-midground rounded-[var(--radius-md)]"
            >
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
