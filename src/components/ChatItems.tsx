import { memo, useState } from "react";
import { Spinner } from "@/components/ds";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Info,
  ShieldAlert,
  Wrench,
  X,
} from "lucide-react";
import type { ChatItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

type Item<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

export const UserMessage = memo(function UserMessage({ item }: { item: Item<"user"> }) {
  return (
    <div className="flex justify-end animate-rise">
      <div
        className={cn(
          "max-w-[85%] sm:max-w-[75%] px-4 py-3",
          "bg-midground/10 border border-midground/15 text-midground",
          "rounded-[var(--radius-lg)] rounded-br-[var(--radius-sm)]",
        )}
      >
        {item.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {item.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                className="max-h-48 rounded-[var(--radius-sm)] border border-current/15 object-cover"
              />
            ))}
          </div>
        )}
        {item.text && <p className="whitespace-pre-wrap break-words">{item.text}</p>}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  item,
  showReasoning,
}: {
  item: Item<"assistant">;
  showReasoning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thinking = item.streaming && !item.text;
  return (
    <div className="flex flex-col gap-2 animate-rise">
      {showReasoning && item.reasoning && (
        <div className="border-s border-current/20 ps-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-h-9 items-center gap-2 text-xs text-text-tertiary hover:text-midground"
          >
            <Brain className="size-3.5" />
            <span className="text-display tracking-[0.12em]">Razonamiento</span>
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          {open && (
            <p className="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-text-secondary">
              {item.reasoning}
            </p>
          )}
        </div>
      )}
      {thinking ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner /> <span>Pensando…</span>
        </div>
      ) : (
        <div className={cn("text-text-primary", item.streaming && "stream-caret")}>
          <Markdown text={item.text} />
        </div>
      )}
    </div>
  );
});

export const ToolActivity = memo(function ToolActivity({ item }: { item: Item<"tool"> }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(item.args || item.result);
  return (
    <div className="animate-fade">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex min-h-10 w-full items-center gap-2.5 px-3 text-start",
          "border border-current/15 bg-card/50 rounded-[var(--radius-sm)]",
          "text-sm text-text-secondary hover:text-midground hover:bg-midground/5",
        )}
      >
        {item.status === "running" ? (
          <Spinner className="text-midground" />
        ) : item.status === "failed" ? (
          <X className="size-4 text-destructive" />
        ) : (
          <Check className="size-4 text-success" />
        )}
        <Wrench className="size-3.5 shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {item.name}
          {!open && item.args && (
            <span className="text-text-tertiary"> · {item.args.replace(/\s+/g, " ").slice(0, 120)}</span>
          )}
        </span>
        {hasDetail && (
          <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2 border border-t-0 border-current/15 px-3 py-2.5 rounded-b-[var(--radius-sm)]">
          {item.args && <Detail label="Argumentos" text={item.args} />}
          {item.result && <Detail label="Resultado" text={item.result} />}
        </div>
      )}
    </div>
  );
});

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-display text-xs tracking-[0.12em] text-text-tertiary">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-secondary">
        {text}
      </pre>
    </div>
  );
}

const CHOICE_LABELS: Record<string, string> = {
  once: "Permitir una vez",
  session: "Permitir en la sesión",
  always: "Permitir siempre",
  deny: "Denegar",
};

export function ApprovalCard({
  item,
  onChoose,
}: {
  item: Item<"approval">;
  onChoose: (choice: string) => void;
}) {
  return (
    <div className="animate-rise border border-warning/40 bg-warning/10 p-4 rounded-[var(--radius-md)]">
      <div className="flex items-center gap-2 text-warning">
        <ShieldAlert className="size-5" />
        <span className="text-display text-sm font-bold tracking-[0.12em]">Aprobación requerida</span>
      </div>
      {item.description && <p className="mt-2 text-sm text-text-secondary">{item.description}</p>}
      {item.command && (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-current/15 bg-background/60 p-3 font-mono text-xs text-midground rounded-[var(--radius-sm)]">
          {item.command}
        </pre>
      )}
      {item.resolved ? (
        <p className="mt-3 text-sm text-text-secondary">
          {item.resolved === "cancelled" ? (
            "El servidor retiró el pedido (turno detenido o vencido)."
          ) : (
            <>
              Respuesta enviada: <strong className="text-midground">{CHOICE_LABELS[item.resolved] ?? item.resolved}</strong>
            </>
          )}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onChoose(choice)}
              className={cn(
                "min-h-11 px-4 text-display text-xs font-bold tracking-[0.15em]",
                "border rounded-[var(--radius-sm)] transition-colors",
                choice === "deny"
                  ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                  : choice === "once"
                    ? "border-midground bg-midground text-background-base hover:opacity-90"
                    : "border-current/25 text-midground hover:bg-midground/10",
              )}
            >
              {CHOICE_LABELS[choice] ?? choice}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Notice({ item }: { item: Item<"notice"> }) {
  const error = item.tone === "error";
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 px-3 py-2.5 text-sm rounded-[var(--radius-sm)] border",
        error
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-current/15 bg-card/50 text-text-secondary",
      )}
    >
      {error ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
      <span className="break-words">{item.text}</span>
    </div>
  );
}
