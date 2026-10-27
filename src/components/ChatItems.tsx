import { memo, useState, type FormEvent, type ReactNode } from "react";
import { Spinner } from "@/components/ds";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Pencil,
  RotateCcw,
  Info,
  KeyRound,
  MessageCircleQuestion,
  ShieldAlert,
  Square,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import type { ChatItem, ClarifyQuestion } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { stopSpeaking, useSpeech } from "@/lib/voice";
import { Markdown } from "./Markdown";

type Item<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

export const UserMessage = memo(function UserMessage({
  item,
  onEdit,
}: {
  item: Item<"user">;
  /** The latest user message can be edited and run again. */
  onEdit?: () => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1 animate-rise">
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
      {onEdit && (
        <ActionButton onClick={onEdit} icon={<Pencil className="size-3.5" />}>
          Editar
        </ActionButton>
      )}
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  item,
  showReasoning,
  onSpeak,
  onRetry,
}: {
  item: Item<"assistant">;
  showReasoning: boolean;
  /** Read this reply out loud; without it there is no speaker button. */
  onSpeak?: (key: string, text: string) => void;
  /** The latest reply can be generated again. */
  onRetry?: () => void;
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
      {!item.streaming && item.text.trim() && (
        <div className="-ms-2 flex flex-wrap items-center gap-1">
          <CopyButton text={item.text} />
          {onSpeak && (
            // Keyed by text: the live item and the reloaded history item of the same reply match.
            <SpeakButton onSpeak={() => onSpeak(item.text, item.text)} speechKey={item.text} />
          )}
          {onRetry && (
            <ActionButton onClick={onRetry} icon={<RotateCcw className="size-3.5" />}>
              Reintentar
            </ActionButton>
          )}
        </div>
      )}
    </div>
  );
});

function ActionButton({ onClick, icon, children, label }: { onClick: () => void; icon: ReactNode; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-xs text-text-tertiary hover:bg-midground/5 hover:text-midground"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    >
      {copied ? "Copiado" : "Copiar"}
    </ActionButton>
  );
}

function SpeakButton({ speechKey, onSpeak }: { speechKey: string; onSpeak: () => void }) {
  const speech = useSpeech();
  const mine = speech?.key === speechKey ? speech.phase : null;
  return (
    <button
      type="button"
      onClick={() => (mine ? stopSpeaking() : onSpeak())}
      aria-label={mine ? "Dejar de leer" : "Escuchar"}
      className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-xs text-text-tertiary hover:bg-midground/5 hover:text-midground"
    >
      {mine === "loading" ? (
        <Spinner />
      ) : mine === "playing" ? (
        <Square className="size-3.5 fill-current" />
      ) : (
        <Volume2 className="size-4" />
      )}
      <span>{mine === "loading" ? "Generando audio…" : mine === "playing" ? "Detener" : "Escuchar"}</span>
    </button>
  );
}

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
      <span className="min-w-0 break-words whitespace-pre-wrap">{item.text}</span>
    </div>
  );
}

/**
 * The agent asking for input mid-turn (dashboard gateway server→client
 * requests). Answers follow tui_gateway/contracts/server_requests.py:
 * clarify → `{answers: {qid: string | null}}` (multi-select as a JSON array of
 * choice labels; no `answers` cancels them all), sudo / secret → `{value}`
 * (`""` means skipped).
 */
export function InputCard({
  item,
  onAnswer,
}: {
  item: Item<"input">;
  onAnswer: (result: Record<string, unknown>, resolved: "answered" | "skipped") => Promise<void> | void;
}) {
  const [sending, setSending] = useState(false);
  const send = async (result: Record<string, unknown>, resolved: "answered" | "skipped") => {
    setSending(true);
    try {
      await onAnswer(result, resolved);
    } finally {
      setSending(false);
    }
  };

  const title =
    item.method === "clarify" ? "Hermes pregunta" : item.method === "sudo" ? "Contraseña de sudo" : "Hermes necesita un dato";

  return (
    <div className="animate-rise border border-midground/30 bg-midground/5 p-4 rounded-[var(--radius-md)]">
      <div className="flex items-center gap-2 text-midground">
        {item.method === "clarify" ? <MessageCircleQuestion className="size-5" /> : <KeyRound className="size-5" />}
        <span className="text-display text-sm font-bold tracking-[0.12em]">{title}</span>
      </div>
      {item.resolved ? (
        <p className="mt-3 text-sm text-text-secondary">
          {item.resolved === "answered"
            ? "Respuesta enviada."
            : item.resolved === "skipped"
              ? "Omitido."
              : "El servidor retiró la pregunta (turno detenido o vencido)."}
        </p>
      ) : item.method === "clarify" ? (
        <ClarifyForm questions={item.questions ?? []} sending={sending} onSend={send} />
      ) : (
        <SecretForm item={item} sending={sending} onSend={send} />
      )}
    </div>
  );
}

const OTHER = "\u0000other";

function ClarifyForm({
  questions,
  sending,
  onSend,
}: {
  questions: ClarifyQuestion[];
  sending: boolean;
  onSend: (result: Record<string, unknown>, resolved: "answered" | "skipped") => void;
}) {
  // qid → selected choice labels (OTHER = use the free-text box).
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  function toggle(q: ClarifyQuestion, label: string) {
    setPicked((prev) => {
      const cur = prev[q.qid] ?? [];
      const multi = q.multi_select && label !== OTHER && !cur.includes(OTHER);
      const next = cur.includes(label)
        ? cur.filter((l) => l !== label)
        : multi
          ? [...cur, label]
          : [label];
      return { ...prev, [q.qid]: next };
    });
  }

  function answerFor(q: ClarifyQuestion): string | null {
    const sel = picked[q.qid] ?? [];
    const typed = (other[q.qid] ?? "").trim();
    const hasChoices = Boolean(q.choices?.length);
    if (!hasChoices || sel.includes(OTHER)) return typed || null;
    if (!sel.length) return null;
    return q.multi_select ? JSON.stringify(sel) : sel[0];
  }

  const answers = Object.fromEntries(questions.map((q) => [q.qid, answerFor(q)]));
  const anyAnswered = Object.values(answers).some((a) => a != null);

  return (
    <div className="mt-3 flex flex-col gap-4">
      {questions.map((q) => {
        const sel = picked[q.qid] ?? [];
        const showText = !q.choices?.length || sel.includes(OTHER);
        return (
          <div key={q.qid} className="flex flex-col gap-2">
            <p className="text-sm text-midground">{q.question}</p>
            {q.multi_select && <p className="text-xs text-text-tertiary">Podés elegir varias.</p>}
            {Boolean(q.choices?.length) && (
              <div className="flex flex-wrap gap-2">
                {[...(q.choices ?? []), OTHER].map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={sel.includes(c)}
                    onClick={() => toggle(q, c)}
                    className={cn(
                      "min-h-11 border px-3 text-sm transition-colors rounded-[var(--radius-sm)]",
                      sel.includes(c)
                        ? "border-midground bg-midground text-background-base"
                        : "border-current/25 text-text-secondary hover:text-midground",
                    )}
                  >
                    {c === OTHER ? "Otra…" : c}
                  </button>
                ))}
              </div>
            )}
            {showText && (
              <input
                value={other[q.qid] ?? ""}
                onChange={(e) => setOther((prev) => ({ ...prev, [q.qid]: e.target.value }))}
                placeholder="Tu respuesta"
                className="h-11 border border-current/20 bg-background/40 px-3 text-base text-midground placeholder:text-text-disabled focus:outline-none focus:border-midground/40 rounded-[var(--radius-sm)]"
              />
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={sending || !anyAnswered}
          onClick={() => onSend({ answers, outcome: "submitted" }, "answered")}
          className="min-h-11 border border-midground bg-midground px-4 text-display text-xs font-bold tracking-[0.15em] text-background-base disabled:opacity-40 rounded-[var(--radius-sm)]"
        >
          Responder
        </button>
        <button
          type="button"
          disabled={sending}
          // No `answers`: the agent treats every question as cancelled.
          onClick={() => onSend({ outcome: "cancelled" }, "skipped")}
          className="min-h-11 border border-current/25 px-4 text-display text-xs font-bold tracking-[0.15em] text-text-secondary hover:text-midground rounded-[var(--radius-sm)]"
        >
          Omitir
        </button>
      </div>
    </div>
  );
}

function SecretForm({
  item,
  sending,
  onSend,
}: {
  item: Item<"input">;
  sending: boolean;
  onSend: (result: Record<string, unknown>, resolved: "answered" | "skipped") => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    const v = value;
    // Don't keep the secret in component state once it's on its way.
    setValue("");
    onSend({ value: v }, "answered");
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
      {item.method === "sudo" ? (
        <>
          <p className="text-sm text-text-secondary">El agente quiere correr un comando con sudo:</p>
          {item.command && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-current/15 bg-background/60 p-3 font-mono text-xs text-midground rounded-[var(--radius-sm)]">
              {item.command}
            </pre>
          )}
        </>
      ) : (
        <p className="text-sm text-text-secondary">
          {item.prompt || "Un valor secreto para continuar."}
          {item.envVar && (
            <>
              {" "}
              <code>{item.envVar}</code>
            </>
          )}
        </p>
      )}
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={item.method === "sudo" ? "Contraseña" : (item.envVar ?? "Valor")}
        className="h-11 border border-current/20 bg-background/40 px-3 font-mono text-base text-midground placeholder:text-text-disabled focus:outline-none focus:border-midground/40 rounded-[var(--radius-sm)]"
      />
      <p className="text-xs text-text-tertiary">Se envía al servidor y no se guarda en la app.</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={sending || !value}
          className="min-h-11 border border-midground bg-midground px-4 text-display text-xs font-bold tracking-[0.15em] text-background-base disabled:opacity-40 rounded-[var(--radius-sm)]"
        >
          Enviar
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => onSend({ value: "" }, "skipped")}
          className="min-h-11 border border-current/25 px-4 text-display text-xs font-bold tracking-[0.15em] text-text-secondary hover:text-midground rounded-[var(--radius-sm)]"
        >
          Omitir
        </button>
      </div>
    </form>
  );
}
