import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
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
}: {
  busy: boolean;
  enterSends: boolean;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-grow up to ~8 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const canSend = !busy && (text.trim().length > 0 || images.length > 0);

  function submit() {
    if (!canSend) return;
    onSend(text.trim(), images);
    setText("");
    setImages([]);
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
        "border border-current/20 bg-background-base/85 backdrop-blur-md",
        "rounded-[var(--radius-lg)] shadow-[0_-12px_40px_-20px_rgba(0,0,0,0.6)]",
        "focus-within:border-midground/40",
      )}
    >
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
        <IconButton label="Adjuntar imagen" onClick={() => fileRef.current?.click()} disabled={busy}>
          <ImagePlus />
        </IconButton>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder="Escribile a Hermes…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint={enterSends ? "send" : "enter"}
          className={cn(
            "min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-base text-midground",
            "placeholder:text-text-disabled focus:outline-none",
          )}
        />
        {busy ? (
          <button
            type="button"
            aria-label="Detener"
            onClick={onStop}
            className="inline-flex size-11 shrink-0 items-center justify-center border border-current/30 text-midground hover:bg-midground/10 rounded-[var(--radius-md)]"
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Enviar"
            onClick={submit}
            disabled={!canSend}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-opacity",
              "bg-midground text-background-base shadow-[inset_-1px_-1px_0_0_#00000080,inset_1px_1px_0_0_#ffffff80]",
              "disabled:opacity-30",
            )}
          >
            <ArrowUp className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}
