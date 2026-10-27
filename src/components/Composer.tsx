import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, CornerDownRight, ImagePlus, ListPlus, Mic, Square, X } from "lucide-react";
import { Spinner } from "@/components/ds";
import { cn } from "@/lib/utils";
import { startRecording, type Recording } from "@/lib/voice";
import { IconButton } from "./ui";

const MAX_IMAGE_EDGE = 1600;

/** Downscale a picked photo so it travels as a reasonable data URL. */
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function Composer({
  busy,
  enterSends,
  onSend,
  onStop,
  autoFocus,
  allowImages = true,
  onTranscribe,
  onError,
  toolbar,
  prefill,
  onSlashComplete,
  onQueue,
  onSteer,
}: {
  busy: boolean;
  enterSends: boolean;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  autoFocus?: boolean;
  allowImages?: boolean;
  /** Turns a recorded clip into text; without it there is no mic button. */
  onTranscribe?: (clip: Blob) => Promise<string>;
  onError?: (message: string) => void;
  /** Row under the text box (the session pills). */
  toolbar?: ReactNode;
  /** Replace the draft with this text (a new `nonce` re-applies the same text). */
  prefill?: { text: string; nonce: number };
  /** Completions for a `/command` draft; without it there is no autocomplete. */
  onSlashComplete?: (text: string) => Promise<{ items: SlashSuggestion[]; replaceFrom: number }>;
  /** While busy: keep the message for after the running turn (Enter does this). */
  onQueue?: (text: string, images: string[]) => void;
  /** While busy: send the text into the running turn as a correction. */
  onSteer?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<{ items: SlashSuggestion[]; replaceFrom: number } | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [voice, setVoice] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recording = useRef<Recording | null>(null);

  // Tick the recording clock; drop a recording left running when the composer goes away.
  useEffect(() => {
    if (voice !== "recording") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [voice]);
  useEffect(() => () => recording.current?.cancel(), []);

  async function startVoice() {
    setVoice("starting");
    try {
      recording.current = await startRecording(() => void stopVoice());
      setVoice("recording");
    } catch (err) {
      setVoice("idle");
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  /** Dictation fills the box; sending stays a separate tap, as in Hermes Desktop. */
  async function stopVoice() {
    const rec = recording.current;
    recording.current = null;
    if (!rec || !onTranscribe) return;
    setVoice("transcribing");
    try {
      const said = await onTranscribe(await rec.stop());
      if (said) setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${said}` : said));
      else onError?.("No se escuchó nada. Probá de nuevo más cerca del micrófono.");
      ref.current?.focus();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setVoice("idle");
    }
  }

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    ref.current?.focus();
  }, [prefill]);

  // `/co…` → the server's completions, while the command word is being typed.
  useEffect(() => {
    if (!onSlashComplete || !/^\/\S*$/.test(text)) {
      setSuggestions(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      onSlashComplete(text)
        .then((res) => alive && setSuggestions(res.items.length ? res : null))
        .catch(() => alive && setSuggestions(null));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, onSlashComplete]);

  function applySuggestion(s: SlashSuggestion) {
    if (!suggestions) return;
    setText(`${text.slice(0, suggestions.replaceFrom)}${s.text} `);
    setSuggestions(null);
    ref.current?.focus();
  }

  // Auto-grow up to ~8 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const hasDraft = text.trim().length > 0 || images.length > 0;
  const canSend = !busy && hasDraft;
  const canQueue = busy && hasDraft && Boolean(onQueue);
  const canSteer = busy && Boolean(onSteer) && text.trim().length > 0 && images.length === 0;

  function clear() {
    setText("");
    setImages([]);
  }

  function submit() {
    if (canQueue) {
      onQueue!(text.trim(), images);
      return clear();
    }
    if (!canSend) return;
    onSend(text.trim(), images);
    clear();
  }

  function steer() {
    if (!canSteer) return;
    onSteer!(text.trim());
    clear();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const send = enterSends ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (send) {
      e.preventDefault();
      submit();
    }
  }

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    const urls = await Promise.all([...files].slice(0, 4).map(fileToDataUrl));
    setImages((prev) => [...prev, ...urls].slice(0, 4));
  }

  return (
    <div
      className={cn(
        "relative border border-current/20 bg-background-base/85 backdrop-blur-md",
        "rounded-[var(--radius-lg)] shadow-[0_-12px_40px_-20px_rgba(0,0,0,0.6)]",
        "focus-within:border-midground/40",
      )}
    >
      {suggestions && (
        <ul
          role="listbox"
          aria-label="Comandos"
          className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto border border-current/20 bg-background-base p-1 shadow-[0_-12px_40px_-20px_rgba(0,0,0,0.6)] rounded-[var(--radius-md)]"
        >
          {suggestions.items.slice(0, 30).map((s) => (
            <li key={s.text}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => applySuggestion(s)}
                className="flex min-h-11 w-full items-baseline gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-start hover:bg-midground/10"
              >
                <span className="shrink-0 font-mono text-sm text-midground">{s.display || s.text}</span>
                {s.meta && <span className="min-w-0 truncate text-xs text-text-tertiary">{s.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-3 pt-3 scrollbar-none">
          {images.map((src, i) => (
            <div key={i} className="relative shrink-0">
              <img src={src} alt="" className="size-16 rounded-[var(--radius-sm)] border border-current/20 object-cover" />
              <button
                type="button"
                aria-label="Quitar imagen"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -top-2 -right-2 inline-flex size-7 items-center justify-center rounded-full border border-current/30 bg-background-base text-midground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1 p-1.5">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void onPick(e.target.files);
            e.target.value = "";
          }}
        />
        {allowImages && (
          <IconButton label="Adjuntar imagen" onClick={() => fileRef.current?.click()} disabled={busy && !onQueue}>
            <ImagePlus />
          </IconButton>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={
            voice === "recording"
              ? `Escuchando… ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
              : voice === "transcribing"
                ? "Transcribiendo…"
                : busy && onQueue
                  ? "Escribí para después, o corregí el rumbo…"
                  : "Escribile a Hermes…"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint={enterSends ? "send" : "enter"}
          className={cn(
            "min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-base text-midground",
            !allowImages && "ps-3",
            "placeholder:text-text-disabled focus:outline-none",
          )}
        />
        {onTranscribe && (
          <button
            type="button"
            aria-label={voice === "recording" ? "Terminar de dictar" : "Dictar"}
            aria-pressed={voice === "recording"}
            onClick={() => (voice === "recording" ? void stopVoice() : voice === "idle" && void startVoice())}
            disabled={voice === "starting" || voice === "transcribing"}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors",
              voice === "recording"
                ? "bg-destructive text-background-base animate-pulse motion-reduce:animate-none"
                : "text-text-secondary hover:bg-midground/10 hover:text-midground disabled:opacity-50",
            )}
          >
            {voice === "transcribing" || voice === "starting" ? <Spinner /> : <Mic className="size-5" />}
          </button>
        )}
        {canSteer && (
          <button
            type="button"
            onClick={steer}
            title="La lee en el próximo paso, sin cortar la respuesta"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-current/30 px-3 text-display text-xs font-bold tracking-[0.12em] text-midground hover:bg-midground/10 rounded-[var(--radius-md)]"
          >
            <CornerDownRight className="size-4" /> Corregir
          </button>
        )}
        {busy && (
          <button
            type="button"
            aria-label="Detener"
            onClick={onStop}
            className="inline-flex size-11 shrink-0 items-center justify-center border border-current/30 text-midground hover:bg-midground/10 rounded-[var(--radius-md)]"
          >
            <Square className="size-4 fill-current" />
          </button>
        )}
        {(!busy || canQueue) && (
          <button
            type="button"
            aria-label={busy ? "Enviar cuando termine" : "Enviar"}
            title={busy ? "Se manda cuando Hermes termine de responder" : undefined}
            onClick={submit}
            disabled={!canSend && !canQueue}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-opacity",
              "bg-midground text-background-base shadow-[inset_-1px_-1px_0_0_#00000080,inset_1px_1px_0_0_#ffffff80]",
              "disabled:opacity-30",
            )}
          >
            {busy ? <ListPlus className="size-5" /> : <ArrowUp className="size-5" />}
          </button>
        )}
      </div>
      {toolbar}
    </div>
  );
}

export interface SlashSuggestion {
  text: string;
  display?: string;
  meta?: string;
}
