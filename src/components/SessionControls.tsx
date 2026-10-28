import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import { Spinner } from "@/components/ds";
import { Brain, Check, ChevronDown, Cpu, RefreshCw, Search, ShieldOff, Zap } from "lucide-react";
import type { DashboardChat, NewSessionOptions } from "@/lib/dashboardChat";
import {
  capabilitiesOf,
  effortLabel,
  providerMatches,
  REASONING_EFFORTS,
  shortModelName,
  EFFORT_LABELS,
  type ModelOptions,
  type ModelProvider,
} from "@/lib/models";
import { useLive } from "@/lib/sessionLive";
import { cn } from "@/lib/utils";

/**
 * The composer's session pills (dashboard mode), as in Hermes Desktop: model,
 * reasoning effort, fast tier and YOLO. On an open session each pick applies
 * to it right away; on a new chat they are remembered and ride on
 * `session.create`.
 */
export function SessionControls({
  chat,
  sessionId,
  profile,
  draft,
  onDraftChange,
  onError,
  onNotice,
  disabled,
}: {
  chat: DashboardChat;
  /** Stored id of the open session, or null for a chat not created yet. */
  sessionId: string | null;
  profile: string;
  /** New chat: the picks so far. */
  draft: NewSessionOptions;
  onDraftChange: (next: NewSessionOptions) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  disabled?: boolean;
}) {
  const live = useLive(sessionId);
  const [sheet, setSheet] = useState<"model" | "effort" | null>(null);
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Opening a session attaches it, so its model and effort show before the first message.
  useEffect(() => {
    if (sessionId) void chat.attach(sessionId, profile).catch(() => {});
  }, [chat, sessionId, profile]);

  // The catalog drives which pills apply (reasoning, fast); refetched per session/profile.
  useEffect(() => {
    let alive = true;
    setOptions(null);
    chat
      .modelOptions(sessionId, profile)
      .then((o) => alive && setOptions(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chat, sessionId, profile]);

  const model = sessionId ? live.info.model ?? options?.model : draft.model ?? options?.model;
  const provider = sessionId ? live.info.provider ?? options?.provider : draft.provider ?? options?.provider;
  const effort = sessionId ? live.info.reasoning_effort : draft.reasoning_effort;
  const caps = capabilitiesOf(options, provider, model);
  const reasoningOff = caps?.reasoning === false;

  const fail = (err: unknown) => onError(err instanceof Error ? err.message : String(err));

  /** The profile's default too: returns false when the person declined an expensive model. */
  async function saveDefault(p: ModelProvider, m: string): Promise<boolean> {
    let res = await chat.setDefaultModel(profile, m, p.slug);
    if (res.status === "confirm") {
      if (!window.confirm(res.message)) return false;
      res = await chat.setDefaultModel(profile, m, p.slug, true);
    }
    onNotice(`${shortModelName(m)} es el modelo predeterminado de ${profile}`);
    return true;
  }

  async function pickModel(p: ModelProvider, m: string, asDefault: boolean) {
    if (!sessionId) {
      if (asDefault) {
        setSaving("model");
        try {
          if (!(await saveDefault(p, m))) return;
        } catch (err) {
          return fail(err);
        } finally {
          setSaving(null);
        }
      }
      onDraftChange({ ...draft, model: m, provider: p.slug });
      setSheet(null);
      return;
    }
    setSaving("model");
    try {
      if (asDefault && !(await saveDefault(p, m))) return;
      let res = await chat.setModel(sessionId, profile, m, p.slug);
      if (res.status === "confirm") {
        if (!window.confirm(res.message)) return;
        res = await chat.setModel(sessionId, profile, m, p.slug, true);
      }
      if (res.status === "ok") {
        if (res.warning) onNotice(res.warning);
        else if (res.deferred) onNotice(`${shortModelName(m)} se usa desde el próximo mensaje`);
      }
      setSheet(null);
    } catch (err) {
      fail(err);
    } finally {
      setSaving(null);
    }
  }

  async function pickEffort(level: string) {
    if (!sessionId) {
      onDraftChange({ ...draft, reasoning_effort: level });
      setSheet(null);
      return;
    }
    setSaving("effort");
    try {
      await chat.setReasoning(sessionId, profile, level);
      setSheet(null);
    } catch (err) {
      fail(err);
    } finally {
      setSaving(null);
    }
  }

  async function toggle(kind: "fast" | "yolo") {
    if (!sessionId) return;
    setSaving(kind);
    try {
      if (kind === "fast") await chat.setFast(sessionId, profile, !live.info.fast);
      else await chat.setYolo(sessionId, profile, !live.info.yolo);
    } catch (err) {
      fail(err);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-2 pb-2 scrollbar-none">
      <Pill onClick={() => setSheet("model")} disabled={disabled} busy={saving === "model"} icon={<Cpu />}>
        {shortModelName(model)}
        <ChevronDown className="size-3 opacity-60" />
      </Pill>
      {!reasoningOff && (
        <Pill onClick={() => setSheet("effort")} disabled={disabled} busy={saving === "effort"} icon={<Brain />}>
          {effortLabel(effort)}
          {live.info.reasoning_effort_wire && live.info.reasoning_effort_wire !== effort && (
            <span className="opacity-60">→ {effortLabel(live.info.reasoning_effort_wire)}</span>
          )}
          <ChevronDown className="size-3 opacity-60" />
        </Pill>
      )}
      {sessionId && caps?.fast && (
        <Pill
          onClick={() => void toggle("fast")}
          pressed={Boolean(live.info.fast)}
          disabled={disabled}
          busy={saving === "fast"}
          icon={<Zap />}
        >
          Rápido
        </Pill>
      )}
      {sessionId && (
        <Pill
          onClick={() => void toggle("yolo")}
          pressed={Boolean(live.info.yolo)}
          disabled={disabled}
          busy={saving === "yolo"}
          icon={<ShieldOff />}
          tone={live.info.yolo ? "warn" : undefined}
          label={live.info.yolo ? "YOLO activo: los comandos se ejecutan sin pedir aprobación" : "Activar YOLO: no pedir aprobación"}
        >
          YOLO
        </Pill>
      )}

      <ModelSheet
        open={sheet === "model"}
        onClose={() => setSheet(null)}
        options={options}
        model={model}
        provider={provider}
        saving={saving === "model"}
        profile={profile}
        onPick={(p, m, asDefault) => void pickModel(p, m, asDefault)}
        onRefresh={() =>
          chat
            .modelOptions(sessionId, profile, true)
            .then(setOptions)
            .catch(fail)
        }
      />
      <BottomSheet open={sheet === "effort"} onClose={() => setSheet(null)} title="Esfuerzo de razonamiento">
        <div className="flex flex-col p-2">
          {REASONING_EFFORTS.filter((l) => l !== "none" || caps?.can_disable_reasoning !== false).map((level) => (
            <SheetRow key={level} selected={(effort ?? "medium") === level} onClick={() => void pickEffort(level)}>
              <span className="flex-1">{EFFORT_LABELS[level]}</span>
              <span className="font-mono text-xs text-text-tertiary">{level}</span>
            </SheetRow>
          ))}
          <p className="px-3 pt-2 pb-1 text-xs text-text-tertiary">
            {sessionId
              ? "Se aplica a esta sesión. Más esfuerzo: respuestas más pensadas, más lentas y caras."
              : "Se aplica al crear la conversación."}
          </p>
        </div>
      </BottomSheet>
    </div>
  );
}

function ModelSheet({
  open,
  onClose,
  options,
  model,
  provider,
  saving,
  onPick,
  onRefresh,
  profile,
}: {
  open: boolean;
  onClose: () => void;
  options: ModelOptions | null;
  model?: string;
  provider?: string;
  saving: boolean;
  onPick: (p: ModelProvider, model: string, asDefault: boolean) => void;
  onRefresh: () => Promise<void>;
  profile: string;
}) {
  const [query, setQuery] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setAsDefault(false);
    }
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (options?.providers ?? [])
      .map((p) => {
        // Featured first, then the rest; the whole list when searching.
        const featured = p.featured_models?.length ? p.featured_models : p.models;
        const list = q ? p.models : [...new Set([...featured, ...p.models])];
        const models = list.filter((m) => !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
        return { p, models };
      })
      .filter((g) => g.models.length > 0)
      // Usable providers first; the current one on top.
      .sort((a, b) => Number(providerMatches(b.p, provider)) - Number(providerMatches(a.p, provider)) ||
        Number(b.p.authenticated !== false) - Number(a.p.authenticated !== false));
  }, [options, query, provider]);

  return (
    <BottomSheet open={open} onClose={onClose} title="Modelo">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-current/10 bg-background-base px-3 py-2">
        <Search className="size-4 shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar modelo o proveedor"
          className="h-10 min-w-0 flex-1 bg-transparent text-base text-midground placeholder:text-text-disabled focus:outline-none"
        />
        <button
          type="button"
          aria-label="Actualizar lista"
          onClick={() => {
            setRefreshing(true);
            void onRefresh().finally(() => setRefreshing(false));
          }}
          className="inline-flex size-10 items-center justify-center text-text-tertiary hover:text-midground"
        >
          {refreshing ? <Spinner /> : <RefreshCw className="size-4" />}
        </button>
      </div>
      <label className="flex min-h-11 items-center gap-3 border-b border-current/10 px-4 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={asDefault}
          onChange={(e) => setAsDefault(e.target.checked)}
          className="size-4 accent-[var(--color-midground)]"
        />
        También como predeterminado de <span className="font-mono text-midground">{profile}</span>
      </label>
      {!options ? (
        <div className="flex justify-center p-8 text-text-secondary">
          <Spinner />
        </div>
      ) : groups.length === 0 ? (
        <p className="p-6 text-center text-sm text-text-tertiary">No hay modelos que coincidan.</p>
      ) : (
        <div className={cn("flex flex-col gap-3 p-2 pb-6", saving && "pointer-events-none opacity-60")}>
          {groups.map(({ p, models }) => (
            <section key={p.slug}>
              <h3 className="flex items-baseline gap-2 px-3 pt-2 pb-1 text-xs tracking-[0.12em] text-text-tertiary uppercase">
                {p.name}
                {p.authenticated === false && <span className="normal-case tracking-normal text-warning">sin credenciales</span>}
              </h3>
              {p.warning && <p className="px-3 pb-1 text-xs text-warning">{p.warning}</p>}
              {models.map((m) => {
                const price = p.pricing?.[m];
                return (
                  <SheetRow
                    key={m}
                    selected={m === model && providerMatches(p, provider)}
                    disabled={p.authenticated === false}
                    onClick={() => onPick(p, m, asDefault)}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">{m}</span>
                    {price && (
                      <span className="shrink-0 text-xs text-text-tertiary">
                        {price.free ? "gratis" : price.input && price.output ? `${price.input} / ${price.output}` : ""}
                      </span>
                    )}
                  </SheetRow>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}

export function SheetRow({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 text-start text-midground",
        "hover:bg-midground/5 disabled:opacity-40",
        selected && "bg-midground/10",
      )}
    >
      {children}
      <Check className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </button>
  );
}

function Pill({
  children,
  icon,
  onClick,
  disabled,
  busy,
  pressed,
  tone,
  label,
}: {
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  pressed?: boolean;
  tone?: "warn";
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs whitespace-nowrap transition-colors",
        "[&>svg:first-child]:size-3.5 disabled:opacity-50",
        pressed
          ? tone === "warn"
            ? "border-warning/60 bg-warning/15 text-warning"
            : "border-midground/50 bg-midground/15 text-midground"
          : "border-current/20 text-text-secondary hover:border-current/40 hover:text-midground",
      )}
    >
      {busy ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  );
}
