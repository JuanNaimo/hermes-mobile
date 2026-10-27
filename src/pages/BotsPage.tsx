import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import { Badge, Button, Spinner, Switch } from "@/components/ds";
import { ChevronDown, ExternalLink, QrCode, RefreshCw, RotateCw, Send, ShieldCheck, UserCheck, UserX } from "lucide-react";
import { useApp } from "@/store";
import type { DashboardClient } from "@/lib/dashboard";
import { isNativeApp } from "@/lib/http";
import {
  platformStatus,
  type MessagingPlatform,
  type PairedUser,
  type PairingRequest,
  type PlatformEnvVar,
  type PlatformTest,
  type TelegramSetup,
  type WhatsAppSetup,
} from "@/lib/messaging";
import { cn } from "@/lib/utils";
import { EmptyState, IconButton, PageTitle, Panel, SectionLabel } from "@/components/ui";
import { ProfileChips } from "@/components/ProfileChips";
import { PageShell } from "./JobsPage";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** On the device, a t.me / wa.me link should open the app; the WebView hands external URLs to Android. */
function openExternal(url: string) {
  if (isNativeApp()) location.href = url;
  else window.open(url, "_blank", "noopener");
}

/** Configured or switched-on platforms first, then alphabetical. */
function byRelevance(a: MessagingPlatform, b: MessagingPlatform) {
  const rank = (p: MessagingPlatform) => (p.state === "connected" ? 0 : p.enabled || p.configured ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function BotsPage({ leading }: { leading?: ReactNode }) {
  const { dashboard, profiles, profileFilter, notify } = useApp();
  const [profile, setProfile] = useState(
    profileFilter !== "all" ? profileFilter : (profiles.find((p) => p.is_default)?.name ?? "default"),
  );
  const [platforms, setPlatforms] = useState<MessagingPlatform[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  /** A change the gateway hasn't picked up yet. */
  const [needsRestart, setNeedsRestart] = useState(false);
  const [setup, setSetup] = useState<"telegram" | "whatsapp" | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!dashboard) return;
    try {
      setPlatforms((await dashboard.messagingPlatforms(profile)).sort(byRelevance));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [dashboard, profile]);

  useEffect(() => {
    setPlatforms(null);
    setNeedsRestart(false);
    setOpen(null);
    void load();
  }, [load]);

  if (!dashboard) {
    return (
      <PageShell leading={leading}>
        <PageTitle>Bots</PageTitle>
        <EmptyState icon={<Send />} title="Solo en modo dashboard">
          Conectar Hermes a Telegram, WhatsApp, Discord o Slack se configura desde el dashboard. Iniciá sesión con usuario
          y contraseña para verlo.
        </EmptyState>
      </PageShell>
    );
  }
  const dash = dashboard;

  async function restart() {
    setRestarting(true);
    try {
      await dash.restartGateway(profile);
      setNeedsRestart(false);
      notify("Reiniciando el gateway…");
      // The new state shows once the gateway is back.
      setTimeout(() => void load(), 6000);
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setRestarting(false);
    }
  }

  const changed = (hot?: boolean) => {
    if (!hot) setNeedsRestart(true);
    void load();
  };

  const active = (platforms ?? []).filter((p) => p.enabled || p.configured);
  const rest = (platforms ?? []).filter((p) => !p.enabled && !p.configured);
  const gatewayRunning = platforms?.some((p) => p.gateway_running);

  return (
    <PageShell leading={leading}>
      <PageTitle
        actions={
          <IconButton label="Actualizar" onClick={() => void load()}>
            <RefreshCw />
          </IconButton>
        }
      >
        Bots
      </PageTitle>

      {profiles.length > 1 && (
        <ProfileChips includeAll={false} profiles={profiles.map((p) => p.name)} value={profile} onChange={setProfile} />
      )}

      {platforms && (
        <Panel className="flex flex-wrap items-center gap-3 p-3.5">
          <span className={cn("size-2 shrink-0 rounded-full", gatewayRunning ? "bg-success" : "bg-warning")} />
          <p className="min-w-0 flex-1 basis-48 text-sm text-text-secondary">
            {needsRestart
              ? "Hay cambios que se aplican al reiniciar el gateway."
              : gatewayRunning
                ? "El gateway de este perfil está corriendo."
                : "El gateway de este perfil está detenido: los bots no responden."}
          </p>
          <Button outlined className="h-10" onClick={() => void restart()} disabled={restarting} prefix={<RotateCw />}>
            {restarting ? "Reiniciando…" : gatewayRunning ? "Reiniciar gateway" : "Iniciar gateway"}
          </Button>
        </Panel>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <QuickSetup
          icon={<Send />}
          title="Crear un bot de Telegram"
          hint="Abre Telegram, creás el bot con BotFather y queda conectado."
          onClick={() => setSetup("telegram")}
        />
        <QuickSetup
          icon={<QrCode />}
          title="Vincular WhatsApp"
          hint="Escaneás un QR desde WhatsApp → Dispositivos vinculados."
          onClick={() => setSetup("whatsapp")}
        />
      </div>

      {error && <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {!error && !platforms && (
        <div className="flex justify-center py-12 text-text-secondary">
          <Spinner />
        </div>
      )}

      {platforms && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Plataformas{active.length ? ` · ${active.length} activas` : ""}</SectionLabel>
          {active.length === 0 && (
            <p className="text-sm text-text-tertiary">Ninguna plataforma configurada todavía en este perfil.</p>
          )}
          {[...active, ...(showAll ? rest : [])].map((p) => (
            <PlatformCard
              key={p.id}
              platform={p}
              dashboard={dash}
              profile={profile}
              open={open === p.id}
              onToggleOpen={() => setOpen((cur) => (cur === p.id ? null : p.id))}
              onChanged={changed}
              onError={(m) => notify(m, "error")}
              onNotice={(m) => notify(m)}
            />
          ))}
          {rest.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex min-h-11 items-center justify-center gap-2 text-sm text-text-secondary hover:text-midground"
            >
              {showAll ? "Ocultar las demás" : `Ver ${rest.length} plataformas más`}
              <ChevronDown className={cn("size-4 transition-transform", showAll && "rotate-180")} />
            </button>
          )}
        </section>
      )}

      {platforms && <PairingSection dashboard={dash} profile={profile} platforms={platforms} />}

      <TelegramSetupSheet
        open={setup === "telegram"}
        onClose={() => setSetup(null)}
        dashboard={dash}
        profile={profile}
        onDone={(restarted) => {
          notify(restarted ? "Telegram conectado. El gateway se está reiniciando." : "Telegram configurado.");
          changed(restarted);
        }}
      />
      <WhatsAppSetupSheet
        open={setup === "whatsapp"}
        onClose={() => setSetup(null)}
        dashboard={dash}
        profile={profile}
        onDone={(restarted) => {
          notify(restarted ? "WhatsApp vinculado. El gateway se está reiniciando." : "WhatsApp configurado.");
          changed(restarted);
        }}
      />
    </PageShell>
  );
}

function QuickSetup({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 border border-current/15 bg-card/50 p-3.5 text-start hover:border-current/30 rounded-[var(--radius-md)] [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-midground"
    >
      {icon}
      <span>
        <span className="block text-sm font-bold text-midground">{title}</span>
        <span className="block text-xs text-text-secondary">{hint}</span>
      </span>
    </button>
  );
}

// -- one platform -----------------------------------------------------------------------

function PlatformCard({
  platform: p,
  dashboard,
  profile,
  open,
  onToggleOpen,
  onChanged,
  onError,
  onNotice,
}: {
  platform: MessagingPlatform;
  dashboard: DashboardClient;
  profile: string;
  open: boolean;
  onToggleOpen: () => void;
  onChanged: (hotServed?: boolean) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const status = platformStatus(p);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<PlatformTest | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraft({});
      setTest(null);
    }
  }, [open]);

  async function toggle(on: boolean) {
    setSaving(true);
    try {
      const res = await dashboard.updatePlatform(p.id, profile, { enabled: on });
      onChanged(res?.hot_served);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    // Only fields the person touched; list fields are sent as edited (blank = keep).
    const env = Object.fromEntries(Object.entries(draft).filter(([, v]) => v.trim()));
    if (!Object.keys(env).length) return;
    setSaving(true);
    try {
      const res = await dashboard.updatePlatform(p.id, profile, { env });
      setDraft({});
      onNotice(`${p.name}: guardado`);
      onChanged(res?.hot_served);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function clear(v: PlatformEnvVar) {
    if (!window.confirm(`¿Borrar ${v.prompt || v.key}?`)) return;
    setSaving(true);
    try {
      const res = await dashboard.updatePlatform(p.id, profile, { clear_env: [v.key] });
      onChanged(res?.hot_served);
    } catch (err) {
      onError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    try {
      setTest(await dashboard.testPlatform(p.id, profile));
    } catch (err) {
      setTest({ ok: false, state: "", message: errorText(err) });
    } finally {
      setTesting(false);
    }
  }

  const fields = p.env_vars.filter((v) => advanced || !v.advanced || v.required);
  const hasAdvanced = p.env_vars.some((v) => v.advanced && !v.required);
  const dirty = Object.values(draft).some((v) => v.trim());

  return (
    <Panel className={cn(open && "border-current/30")}>
      <div className="flex items-center gap-3 p-3.5">
        <button type="button" onClick={onToggleOpen} aria-expanded={open} className="flex min-w-0 flex-1 flex-col text-start">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-midground">{p.name}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
          {(p.error_message || p.description) && (
            <span className={cn("mt-1 line-clamp-2 text-xs", p.error_message ? "text-destructive" : "text-text-secondary")}>
              {p.error_message || p.description}
            </span>
          )}
        </button>
        <Switch
          aria-label={`${p.enabled ? "Apagar" : "Encender"} ${p.name}`}
          checked={p.enabled}
          disabled={saving}
          onCheckedChange={(on) => void toggle(on)}
        />
        <button type="button" aria-label={open ? "Cerrar" : "Configurar"} onClick={onToggleOpen} className="inline-flex size-10 items-center justify-center text-text-tertiary">
          <ChevronDown className={cn("size-5 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-current/10 p-3.5">
          {fields.map((v) => (
            <EnvField
              key={v.key}
              v={v}
              value={draft[v.key]}
              onChange={(value) => setDraft((d) => ({ ...d, [v.key]: value }))}
              onClear={() => void clear(v)}
              disabled={saving}
            />
          ))}
          {hasAdvanced && (
            <button type="button" onClick={() => setAdvanced((a) => !a)} className="w-fit text-xs text-text-tertiary hover:text-midground">
              {advanced ? "Ocultar opciones avanzadas" : "Mostrar opciones avanzadas"}
            </button>
          )}
          {p.home_channel?.name || p.home_channel?.chat_id ? (
            <p className="text-xs text-text-tertiary">
              Canal principal: <span className="font-mono">{p.home_channel.name || p.home_channel.chat_id}</span>
            </p>
          ) : null}

          {test && (
            <p
              className={cn(
                "flex items-start gap-2 border p-2.5 text-sm rounded-[var(--radius-sm)]",
                !test.ok
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : test.auth_posture === "deny_all" || test.auth_posture === "open"
                    ? "border-warning/30 bg-warning/10 text-warning"
                    : "border-success/30 bg-success/10 text-success",
              )}
            >
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              {test.message}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button className="h-11" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? "Guardando…" : "Guardar"}
            </Button>
            <Button outlined className="h-11" onClick={() => void runTest()} disabled={testing}>
              {testing ? "Probando…" : "Probar conexión"}
            </Button>
            {p.docs_url && (
              <Button outlined className="h-11" onClick={() => openExternal(p.docs_url!)} prefix={<ExternalLink />}>
                Guía
              </Button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function EnvField({
  v,
  value,
  onChange,
  onClear,
  disabled,
}: {
  v: PlatformEnvVar;
  value: string | undefined;
  onChange: (value: string) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  // Secrets never come back: show their preview as the placeholder, type a new one to replace.
  const current = v.is_list ? (v.value ?? "") : "";
  const placeholder = v.is_password
    ? v.is_set
      ? `${v.redacted_value || "guardado"} · escribí para reemplazar`
      : "Sin configurar"
    : v.is_list
      ? "IDs separados por coma"
      : v.is_set
        ? (v.redacted_value ?? "guardado")
        : "";
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-2">
        <SectionLabel>{v.prompt || v.key}</SectionLabel>
        {v.required && <span className="text-xs text-warning">requerido</span>}
        {v.is_set && (
          <button type="button" onClick={onClear} disabled={disabled} className="ms-auto text-xs text-text-tertiary hover:text-destructive">
            Quitar
          </button>
        )}
      </span>
      <input
        type={v.is_password ? "password" : "text"}
        autoComplete="off"
        value={value ?? current}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-11 w-full border border-midground/15 bg-background/40 px-3 font-mono text-sm text-midground placeholder:text-text-disabled rounded-[var(--radius-sm)] focus-visible:border-midground/40 focus-visible:outline-none"
      />
      {(v.help || v.description) && <span className="text-xs text-text-tertiary">{v.help || v.description}</span>}
      {v.url && (
        <button type="button" onClick={() => openExternal(v.url!)} className="w-fit text-xs text-midground underline">
          Dónde lo consigo
        </button>
      )}
    </label>
  );
}

// -- who may talk to the bots -------------------------------------------------------------

function PairingSection({
  dashboard,
  profile,
  platforms,
}: {
  dashboard: DashboardClient;
  profile: string;
  platforms: MessagingPlatform[];
}) {
  const { notify } = useApp();
  const [data, setData] = useState<{ pending: PairingRequest[]; approved: PairedUser[] } | null>(null);
  const [code, setCode] = useState("");
  const [codePlatform, setCodePlatform] = useState("");
  const enabled = platforms.filter((p) => p.enabled);
  const nameOf = (id: string) => platforms.find((p) => p.id === id)?.name ?? id;

  const load = useCallback(() => {
    dashboard.pairing(profile).then(setData, () => setData({ pending: [], approved: [] }));
  }, [dashboard, profile]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!codePlatform && enabled[0]) setCodePlatform(enabled[0].id);
  }, [codePlatform, enabled]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok);
      load();
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  if (!data) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Usuarios autorizados</SectionLabel>
      <p className="text-xs text-text-tertiary">
        Quien le escribe al bot por primera vez recibe un código. Aprobalo acá (o pegá el código) para que Hermes le responda.
      </p>

      {data.pending.length > 0 && (
        <Panel className="flex flex-col divide-y divide-current/10">
          {data.pending.map((r) => (
            <div key={`${r.platform}/${r.request_id || r.user_id}`} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-midground">{r.user_name || r.user_id}</p>
                <p className="text-xs text-text-tertiary">
                  {nameOf(r.platform)} · pide acceso{r.age_minutes != null ? ` hace ${r.age_minutes} min` : ""}
                </p>
              </div>
              {r.request_id ? (
                <Button
                  className="h-10"
                  prefix={<UserCheck />}
                  onClick={() =>
                    void act(() => dashboard.approvePairing(profile, r.platform, { request_id: r.request_id }), "Usuario aprobado")
                  }
                >
                  Aprobar
                </Button>
              ) : (
                <span className="text-xs text-text-tertiary">Aprobá con su código</span>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => void act(() => dashboard.clearPendingPairing(profile), "Pedidos descartados")}
            className="min-h-11 text-xs text-text-tertiary hover:text-destructive"
          >
            Descartar todos los pedidos
          </button>
        </Panel>
      )}

      {enabled.length > 0 && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!code.trim() || !codePlatform) return;
            void act(() => dashboard.approvePairing(profile, codePlatform, { code: code.trim() }), "Código aprobado").then(() =>
              setCode(""),
            );
          }}
        >
          <select
            value={codePlatform}
            onChange={(e) => setCodePlatform(e.target.value)}
            aria-label="Plataforma"
            className="h-11 border border-midground/15 bg-background/40 px-2 text-sm text-midground rounded-[var(--radius-sm)]"
          >
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Código de emparejamiento"
            autoCapitalize="characters"
            className="h-11 min-w-0 flex-1 border border-midground/15 bg-background/40 px-3 font-mono text-sm text-midground placeholder:text-text-disabled rounded-[var(--radius-sm)]"
          />
          <Button type="submit" className="h-11" disabled={!code.trim()}>
            Aprobar código
          </Button>
        </form>
      )}

      {data.approved.length > 0 ? (
        <Panel className="flex flex-col divide-y divide-current/10">
          {data.approved.map((u) => (
            <div key={`${u.platform}/${u.user_id}`} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-midground">{u.user_name || u.user_id}</p>
                <p className="font-mono text-xs text-text-tertiary">
                  {nameOf(u.platform)} · {u.user_id}
                </p>
              </div>
              <IconButton
                label={`Quitar acceso a ${u.user_name || u.user_id}`}
                onClick={() =>
                  window.confirm(`¿Quitarle el acceso a ${u.user_name || u.user_id}?`) &&
                  void act(() => dashboard.revokePairing(profile, u.platform, u.user_id), "Acceso revocado")
                }
                className="hover:text-destructive"
              >
                <UserX />
              </IconButton>
            </div>
          ))}
        </Panel>
      ) : (
        data.pending.length === 0 && <p className="text-sm text-text-tertiary">Nadie emparejado todavía.</p>
      )}
    </section>
  );
}

// -- quick setups ---------------------------------------------------------------------------

/** Poll `fn` every `ms` while `active`; stops on unmount or when `fn` returns true. */
function usePoll(active: boolean, ms: number, fn: () => Promise<boolean>) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const done = await fnRef.current().catch(() => false);
      if (alive && !done) timer = setTimeout(() => void tick(), ms);
    };
    timer = setTimeout(() => void tick(), ms);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active, ms]);
}

function QrImage({ payload }: { payload: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void import("qrcode").then((QR) =>
      QR.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width: 240 }).then((url) => alive && setSrc(url)),
    );
    return () => {
      alive = false;
    };
  }, [payload]);
  return src ? (
    <img src={src} alt="Código QR" className="size-60 rounded-[var(--radius-sm)] bg-white p-2" />
  ) : (
    <div className="flex size-60 items-center justify-center">
      <Spinner />
    </div>
  );
}

function TelegramSetupSheet({
  open,
  onClose,
  dashboard,
  profile,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: DashboardClient;
  profile: string;
  onDone: (restarted: boolean) => void;
}) {
  const [session, setSession] = useState<TelegramSetup | null>(null);
  const [ready, setReady] = useState<{ bot_username?: string | null } | null>(null);
  const [ids, setIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Closing abandons the setup on the server too.
  useEffect(() => {
    if (open) return;
    if (session && !ready) void dashboard.telegramSetupCancel(session.pairing_id).catch(() => {});
    setSession(null);
    setReady(null);
    setIds("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  usePoll(Boolean(open && session && !ready), 2500, async () => {
    try {
      const st = await dashboard.telegramSetupStatus(session!.pairing_id);
      if (st.status !== "ready") return false;
      setReady(st);
      if (st.owner_user_id) setIds(st.owner_user_id);
      return true;
    } catch (err) {
      setError(errorText(err));
      return true;
    }
  });

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSession(await dashboard.telegramSetupStart());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!session) return;
    setBusy(true);
    try {
      const list = ids.split(/[\s,]+/).filter(Boolean);
      const res = await dashboard.telegramSetupApply(session.pairing_id, profile, list);
      setSession(null);
      onDone(!res.needs_restart);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Bot de Telegram">
      <div className="flex flex-col gap-4 p-5 pb-8">
        {!session && (
          <>
            <p className="text-sm text-text-secondary">
              Hermes te arma el bot: se abre Telegram con BotFather, confirmás el nombre y el token vuelve solo. Va al perfil{" "}
              <span className="font-mono text-midground">{profile}</span>.
            </p>
            <Button className="h-12" onClick={() => void start()} disabled={busy} prefix={<Send />}>
              {busy ? "Preparando…" : "Empezar"}
            </Button>
          </>
        )}
        {session && !ready && (
          <>
            <ol className="list-decimal space-y-1 ps-5 text-sm text-text-secondary">
              <li>Abrí Telegram y tocá «Iniciar» en el chat que se abre.</li>
              <li>Seguí los pasos para crear el bot{session.suggested_username ? ` (sugerido: @${session.suggested_username})` : ""}.</li>
              <li>Volvé acá: se detecta solo.</li>
            </ol>
            <Button className="h-12" onClick={() => openExternal(session.deep_link)} prefix={<ExternalLink />}>
              Abrir Telegram
            </Button>
            <div className="flex flex-col items-center gap-2">
              <SectionLabel>O escaneá desde otro teléfono</SectionLabel>
              <QrImage payload={session.qr_payload || session.deep_link} />
            </div>
            <p className="flex items-center justify-center gap-2 text-xs text-text-tertiary">
              <Spinner /> Esperando a Telegram…
            </p>
          </>
        )}
        {ready && (
          <>
            <p className="text-sm text-success">
              Bot listo{ready.bot_username ? `: @${ready.bot_username}` : ""}. ¿Quién puede hablarle?
            </p>
            <label className="flex flex-col gap-1">
              <SectionLabel>IDs de Telegram autorizados</SectionLabel>
              <input
                value={ids}
                onChange={(e) => setIds(e.target.value)}
                inputMode="numeric"
                placeholder="123456789, 987654321"
                className="h-11 border border-midground/15 bg-background/40 px-3 font-mono text-sm text-midground rounded-[var(--radius-sm)]"
              />
              <span className="text-xs text-text-tertiary">Tu ID ya está cargado. Separá varios con comas.</span>
            </label>
            <Button className="h-12" onClick={() => void apply()} disabled={busy || !ids.trim()}>
              {busy ? "Guardando…" : "Conectar bot"}
            </Button>
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </BottomSheet>
  );
}

function WhatsAppSetupSheet({
  open,
  onClose,
  dashboard,
  profile,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: DashboardClient;
  profile: string;
  onDone: (restarted: boolean) => void;
}) {
  const [mode, setMode] = useState<"bot" | "self-chat">("bot");
  const [allowed, setAllowed] = useState("");
  const [session, setSession] = useState<WhatsAppSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    if (session && session.status !== "connected") void dashboard.whatsappSetupCancel(session.pairing_id).catch(() => {});
    setSession(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  usePoll(Boolean(open && session && session.status !== "connected" && session.status !== "error"), 2000, async () => {
    try {
      const st = await dashboard.whatsappSetupStatus(session!.pairing_id);
      setSession(st);
      if (st.status === "error") setError(st.error || "La vinculación falló.");
      return st.status === "connected" || st.status === "error";
    } catch (err) {
      setError(errorText(err));
      return true;
    }
  });

  async function start(reset = false) {
    setBusy(true);
    setError(null);
    try {
      setSession(await dashboard.whatsappSetupStart(profile, { mode, allowed_users: allowed.trim(), reset_session: reset }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!session) return;
    setBusy(true);
    try {
      const res = await dashboard.whatsappSetupApply(session.pairing_id, profile, { mode, allowed_users: allowed.trim() || undefined });
      setSession(null);
      onDone(!res.needs_restart);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="WhatsApp">
      <div className="flex flex-col gap-4 p-5 pb-8">
        {!session && (
          <>
            <div className="flex flex-col gap-2">
              <SectionLabel>Cómo lo usás</SectionLabel>
              {(
                [
                  ["bot", "Número propio del bot", "Un número dedicado: otras personas le escriben a Hermes."],
                  ["self-chat", "Mi propio WhatsApp", "Le hablás a Hermes en el chat con vos mismo."],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    "flex flex-col items-start border p-3 text-start rounded-[var(--radius-sm)]",
                    mode === value ? "border-midground bg-midground/10" : "border-current/20",
                  )}
                >
                  <span className="text-sm text-midground">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            {mode === "bot" && (
              <label className="flex flex-col gap-1">
                <SectionLabel>Números autorizados (opcional)</SectionLabel>
                <input
                  value={allowed}
                  onChange={(e) => setAllowed(e.target.value)}
                  inputMode="tel"
                  placeholder="5491122334455, 5491166778899"
                  className="h-11 border border-midground/15 bg-background/40 px-3 font-mono text-sm text-midground rounded-[var(--radius-sm)]"
                />
                <span className="text-xs text-text-tertiary">Vacío: cada persona nueva pide acceso y la aprobás en Bots.</span>
              </label>
            )}
            <Button className="h-12" onClick={() => void start()} disabled={busy} prefix={<QrCode />}>
              {busy ? "Preparando…" : "Mostrar QR"}
            </Button>
          </>
        )}
        {session && session.status !== "connected" && (
          <div className="flex flex-col items-center gap-3">
            {session.qr_payload ? (
              <>
                <p className="text-center text-sm text-text-secondary">
                  En el teléfono con WhatsApp: Ajustes → Dispositivos vinculados → Vincular un dispositivo, y escaneá este código.
                </p>
                <QrImage payload={session.qr_payload} />
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Spinner /> Generando el QR en el servidor…
              </p>
            )}
          </div>
        )}
        {session?.status === "connected" && (
          <>
            <p className="text-sm text-success">
              Vinculado{session.account_name ? ` como ${session.account_name}` : ""}
              {session.account_phone ? ` (+${session.account_phone})` : ""}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button className="h-12 flex-1" onClick={() => void apply()} disabled={busy}>
                {busy ? "Guardando…" : "Activar WhatsApp"}
              </Button>
              <Button outlined className="h-12" onClick={() => void start(true)} disabled={busy}>
                Vincular otro número
              </Button>
            </div>
          </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </BottomSheet>
  );
}
