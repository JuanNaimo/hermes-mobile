import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Spinner, Switch } from "@/components/ds";
import { Check, Copy, KeyRound, Plus, Trash2, Webhook as WebhookIcon, X } from "lucide-react";
import type { DashboardClient, Webhook } from "@/lib/dashboard";
import { cn } from "@/lib/utils";
import { IconButton, Panel, SectionLabel, TextField } from "./ui";

/**
 * Webhook routes of one profile: an outside service POSTs to the route's URL
 * (signed with its HMAC secret) and Hermes runs the route's prompt, logging or
 * delivering the answer. The secret shows once, right after creating.
 */
export function WebhooksPanel({
  dashboard,
  profile,
  onError,
  onNotice,
}: {
  dashboard: DashboardClient;
  profile: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [state, setState] = useState<{ enabled: boolean; subscriptions: Webhook[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [enabling, setEnabling] = useState(false);
  /** Shown once after creating; never stored. */
  const [fresh, setFresh] = useState<{ name: string; url: string; secret: string } | null>(null);
  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError]);

  const load = useCallback(async () => {
    try {
      setState(await dashboard.webhooks(profile));
    } catch (err) {
      fail(err);
    }
  }, [dashboard, profile, fail]);

  useEffect(() => {
    setState(null);
    setFresh(null);
    setCreating(false);
    void load();
  }, [load]);

  async function enable() {
    setEnabling(true);
    try {
      const res = await dashboard.enableWebhooks(profile);
      onNotice(res.restart_started ? "Webhooks activados: el gateway se está reiniciando." : "Webhooks activados. Reiniciá el gateway para usarlos.");
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setEnabling(false);
    }
  }

  async function toggle(name: string, on: boolean) {
    setState((s) => s && { ...s, subscriptions: s.subscriptions.map((w) => (w.name === name ? { ...w, enabled: on } : w)) });
    try {
      await dashboard.setWebhookEnabled(profile, name, on);
    } catch (err) {
      fail(err);
      void load();
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`¿Borrar el webhook ${name}? Quien lo llame va a recibir un error.`)) return;
    try {
      await dashboard.deleteWebhook(profile, name);
      if (fresh?.name === name) setFresh(null);
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Webhooks{state?.subscriptions.length ? ` · ${state.subscriptions.length}` : ""}</SectionLabel>
        {state?.enabled && !creating && (
          <Button outlined className="h-9" prefix={<Plus />} onClick={() => setCreating(true)}>
            Nuevo
          </Button>
        )}
      </div>

      {!state ? (
        <div className="flex justify-center py-6 text-text-secondary">
          <Spinner />
        </div>
      ) : !state.enabled ? (
        <Panel className="flex flex-wrap items-center gap-3 p-3.5">
          <WebhookIcon className="size-5 shrink-0 text-text-secondary" />
          <p className="min-w-0 flex-1 basis-48 text-sm text-text-secondary">
            Los webhooks dejan que otro servicio (GitHub, un formulario, un sensor) le pida cosas a Hermes. Están apagados
            en este perfil.
          </p>
          <Button outlined className="h-10" onClick={() => void enable()} disabled={enabling}>
            {enabling ? "Activando…" : "Activar webhooks"}
          </Button>
        </Panel>
      ) : (
        <>
          {fresh && <SecretOnce {...fresh} onClose={() => setFresh(null)} />}
          {creating && (
            <NewWebhookForm
              onCancel={() => setCreating(false)}
              onCreate={async (draft) => {
                const created = await dashboard.createWebhook(profile, draft);
                setFresh({ name: created.name, url: created.url, secret: created.secret });
                setCreating(false);
                await load();
              }}
              onError={fail}
            />
          )}
          {state.subscriptions.length === 0 && !creating && (
            <p className="text-sm text-text-tertiary">Ningún webhook en este perfil todavía.</p>
          )}
          {state.subscriptions.map((w) => (
            <Panel key={w.name} className={cn("flex items-start gap-3 p-3.5", !w.enabled && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-midground">{w.name}</p>
                {w.description && <p className="text-sm text-text-secondary">{w.description}</p>}
                <CopyLine text={w.url} label="URL" />
                <p className="mt-1 text-xs text-text-tertiary">
                  {[
                    w.events.length ? `eventos: ${w.events.join(", ")}` : "todos los eventos",
                    w.deliver === "log" ? "respuesta al log" : `responde por ${w.deliver}`,
                    w.secret_set ? "firmado (HMAC)" : "sin firma",
                  ].join(" · ")}
                </p>
              </div>
              <Switch
                aria-label={`${w.enabled ? "Pausar" : "Activar"} ${w.name}`}
                checked={w.enabled}
                onCheckedChange={(on) => void toggle(w.name, on)}
              />
              <IconButton label={`Borrar ${w.name}`} onClick={() => void remove(w.name)}>
                <Trash2 />
              </IconButton>
            </Panel>
          ))}
        </>
      )}
    </section>
  );
}

function NewWebhookForm({
  onCancel,
  onCreate,
  onError,
}: {
  onCancel: () => void;
  onCreate: (draft: { name: string; description: string; events: string[]; prompt: string; deliver: string }) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState("");
  const [prompt, setPrompt] = useState("");
  const [deliver, setDeliver] = useState("log");
  const [saving, setSaving] = useState(false);
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  const validName = /^[a-z0-9][a-z0-9_-]*$/.test(slug);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validName) return;
    setSaving(true);
    try {
      await onCreate({
        name: slug,
        description: description.trim(),
        events: events.split(",").map((s) => s.trim()).filter(Boolean),
        prompt: prompt.trim(),
        deliver: deliver.trim() || "log",
      });
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel className="p-4">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <TextField
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="github-prs"
          hint={name && !validName ? "Minúsculas, números, guiones." : slug ? `Queda en …/webhooks/${slug}` : undefined}
          autoFocus
        />
        <TextField label="Descripción" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="PRs nuevos del repo" />
        <TextField
          label="Eventos"
          value={events}
          onChange={(e) => setEvents(e.target.value)}
          placeholder="pull_request, issues"
          hint="Separados por coma. Vacío: todos."
        />
        <label className="flex flex-col gap-1.5">
          <SectionLabel>Qué hace Hermes</SectionLabel>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Resumí el evento y avisame si hace falta hacer algo. {payload}"
            className="w-full border border-midground/15 bg-background/40 px-3.5 py-2.5 text-base text-midground placeholder:text-text-disabled focus:outline-none focus:border-midground/40 rounded-[var(--radius-sm)]"
          />
        </label>
        <TextField
          label="Respuesta por"
          value={deliver}
          onChange={(e) => setDeliver(e.target.value)}
          placeholder="log"
          hint="log (solo queda registrada), telegram, discord, slack…"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={!validName || saving}>
            {saving ? "Creando…" : "Crear webhook"}
          </Button>
          <Button type="button" outlined onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** The new route's secret, visible this one time. */
function SecretOnce({ name, url, secret, onClose }: { name: string; url: string; secret: string; onClose: () => void }) {
  return (
    <Panel className="flex flex-col gap-2 border-warning/40 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-warning" />
        <p className="flex-1 text-sm text-midground">
          Webhook <span className="font-mono">{name}</span> creado. Copiá el secreto ahora: el servidor no lo vuelve a mostrar.
        </p>
        <IconButton label="Ya lo guardé" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <CopyLine text={url} label="URL" />
      <CopyLine text={secret} label="Secreto" />
    </Panel>
  );
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-text-tertiary">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">{text}</span>
      <button
        type="button"
        aria-label={`Copiar ${label.toLowerCase()}`}
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        className="inline-flex size-9 shrink-0 items-center justify-center text-text-tertiary hover:text-midground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
