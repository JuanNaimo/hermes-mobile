import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Spinner, Switch } from "@/components/ds";
import { LogOut, RefreshCw } from "lucide-react";
import type { Capabilities } from "@/lib/api";
import { isDashboard } from "@/lib/connection";
import { formatDate } from "@/lib/utils";
import { useApp, useClient } from "@/store";
import { THEMES, type TextSize } from "@/themes/presets";
import { cn } from "@/lib/utils";
import { IconButton, PageShell, PageTitle, Panel, SectionLabel, StatusDot } from "@/components/ui";
import { HermesSettingsPanel } from "@/components/HermesSettingsPanel";

interface Readiness {
  status?: string;
  readiness?: { checks?: Record<string, { status?: string } | string> };
  [key: string]: unknown;
}

export function ServerPage({ leading }: { leading?: ReactNode }) {
  const { connection } = useApp();
  return isDashboard(connection) ? <DashboardServerPage leading={leading} /> : <ApiServerPage leading={leading} />;
}

function ApiServerPage({ leading }: { leading?: ReactNode }) {
  const client = useClient();
  const { connection, disconnect } = useApp();
  const profile = connection && !isDashboard(connection) ? connection.profile : undefined;
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [health, setHealth] = useState<Readiness | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, h, m] = await Promise.all([
        client.capabilities(),
        client.healthDetailed().catch(() => null),
        client.models().catch(() => []),
      ]);
      setCaps(c);
      setHealth(h as Readiness | null);
      setModels(m);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const checks = Object.entries(health?.readiness?.checks ?? {});
  const overall = health?.status ?? (caps ? "ok" : undefined);

  return (
    <PageShell leading={leading}>
      <PageTitle
        actions={
          <IconButton label="Recargar" onClick={() => void load()}>
            {loading ? <Spinner /> : <RefreshCw />}
          </IconButton>
        }
      >
        Servidor
      </PageTitle>

      {error && <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <SectionLabel>Conexión</SectionLabel>
            {overall && (
              <Badge tone={overall === "ok" ? "success" : "warning"}>{overall}</Badge>
            )}
          </div>
          <Row label="Nombre" value={connection?.label || "—"} />
          <Row label="URL" value={connection?.baseUrl ?? ""} mono />
          {profile && <Row label="Perfil" value={profile} mono />}
          <Row label="Modelo" value={caps?.model || models[0] || "—"} mono />
          <Row label="Plataforma" value={caps?.platform || "—"} mono />
          <Button outlined onClick={disconnect} className="mt-2 h-12" prefix={<LogOut />}>
            Desconectar
          </Button>
        </Panel>

        <Panel className="flex flex-col gap-3 p-5">
          <SectionLabel>Estado</SectionLabel>
          {checks.length === 0 && <p className="text-sm text-text-tertiary">Sin datos de readiness.</p>}
          <ul className="flex flex-col">
            {checks.map(([name, value]) => {
              const status = typeof value === "string" ? value : (value?.status ?? "unknown");
              return (
                <li key={name} className="flex min-h-10 items-center gap-3 border-b border-current/10 last:border-0">
                  <StatusDot tone={status === "ok" ? "ok" : status === "error" || status === "failed" ? "error" : "warn"} />
                  <span className="flex-1 font-mono text-sm text-text-secondary">{name}</span>
                  <span className="text-xs text-text-tertiary">{status}</span>
                </li>
              );
            })}
          </ul>
          {caps?.features && (
            <>
              <SectionLabel className="mt-2">Funciones</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(caps.features)
                  .filter(([, on]) => on)
                  .map(([f]) => (
                    <span
                      key={f}
                      className="border border-current/15 px-1.5 py-0.5 font-mono text-xs text-text-tertiary rounded-[var(--radius-sm)]"
                    >
                      {f}
                    </span>
                  ))}
              </div>
            </>
          )}
        </Panel>

        <AppearancePanel />
      </div>
    </PageShell>
  );
}

function DashboardServerPage({ leading }: { leading?: ReactNode }) {
  const { connection, dashboard, disconnect, profiles, profileFilter, notify } = useApp();
  const [me, setMe] = useState<{ user_id: string; display_name?: string; provider: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dashboard
      ?.me()
      .then(setMe)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [dashboard]);

  const conn = isDashboard(connection) ? connection : null;

  return (
    <PageShell leading={leading}>
      <PageTitle>Servidor</PageTitle>
      {error && <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between">
            <SectionLabel>Sesión</SectionLabel>
            <Badge tone="success">Dashboard</Badge>
          </div>
          <Row label="Usuario" value={me?.display_name || me?.user_id || conn?.username || "—"} />
          <Row label="Login" value={me?.provider || conn?.auth?.provider || "—"} mono />
          <Row label="Dashboard" value={conn?.baseUrl ?? ""} mono />
          <Row label="Token vence" value={formatDate(conn?.auth?.expiresAt)} />
          <Button outlined onClick={disconnect} className="mt-2 h-12" prefix={<LogOut />}>
            Cerrar sesión
          </Button>
        </Panel>

        <Panel className="flex flex-col gap-3 p-5">
          <SectionLabel>Perfiles</SectionLabel>
          {profiles.length === 0 && <p className="text-sm text-text-tertiary">Cargando perfiles…</p>}
          <ul className="flex flex-col">
            {profiles.map((p) => (
              <li key={p.name} className="flex min-h-14 items-center gap-3 border-b border-current/10 py-2 last:border-0">
                <StatusDot tone={p.gateway_running ? "ok" : "idle"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-midground">
                    {p.display_name || p.name}
                    {p.is_default && p.name !== "default" && (
                      <span className="ms-2 text-xs text-text-tertiary">default</span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-xs text-text-tertiary">
                    {[p.model, p.provider].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-tertiary">{p.skill_count ?? 0} skills</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-tertiary">
            Punto verde: el gateway de ese perfil está corriendo.
          </p>
        </Panel>

        {dashboard && profiles.length > 0 && (
          <HermesSettingsPanel
            dashboard={dashboard}
            profiles={profiles.map((p) => p.name)}
            defaultProfile={profileFilter !== "all" ? profileFilter : (profiles.find((p) => p.is_default)?.name ?? profiles[0].name)}
            onError={(m) => notify(m, "error")}
          />
        )}

        <AppearancePanel />
      </div>
    </PageShell>
  );
}

function AppearancePanel() {
  const { settings, updateSettings } = useApp();
  return (
    <Panel className="flex flex-col gap-4 p-5 lg:col-span-2">
      <SectionLabel>Apariencia</SectionLabel>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {THEMES.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => updateSettings({ theme: t.name })}
            className={cn(
              "flex flex-col gap-2 border p-2.5 text-start rounded-[var(--radius-sm)] transition-colors",
              settings.theme === t.name ? "border-midground" : "border-current/15 hover:border-current/35",
            )}
          >
            <span
              className="flex h-10 items-end gap-1 p-1.5 rounded-[var(--radius-sm)]"
              style={{ background: t.background }}
            >
              <span className="h-full w-2" style={{ background: t.midground }} />
              <span className="h-2/3 w-2 opacity-60" style={{ background: t.midground }} />
              <span className="h-1/3 w-2 opacity-30" style={{ background: t.midground }} />
            </span>
            <span className="text-xs text-midground">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col divide-y divide-current/10">
        <Setting label="Texto grande" hint="Más cómodo para leer en tablet a distancia">
          <Switch
            checked={settings.textSize === "large"}
            onCheckedChange={(on) => updateSettings({ textSize: (on ? "large" : "normal") as TextSize })}
          />
        </Setting>
        <Setting label="Enter envía" hint="Con teclado físico. Si está apagado, usá ⌘/Ctrl+Enter">
          <Switch checked={settings.enterSends} onCheckedChange={(on) => updateSettings({ enterSends: on })} />
        </Setting>
        <Setting label="Mostrar razonamiento" hint="Bloque plegable con el pensamiento del modelo">
          <Switch
            checked={settings.showReasoning}
            onCheckedChange={(on) => updateSettings({ showReasoning: on })}
          />
        </Setting>
        <Setting label="Leer respuestas en voz alta" hint="Modo dashboard: cada respuesta se lee al terminar, con la voz configurada en el servidor">
          <Switch checked={settings.autoSpeak} onCheckedChange={(on) => updateSettings({ autoSpeak: on })} />
        </Setting>
      </div>
    </Panel>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-text-tertiary">{label}</span>
      <span className={cn("min-w-0 truncate text-sm text-midground", mono && "font-mono")}>{value}</span>
    </div>
  );
}

function Setting({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-4 py-2">
      <div>
        <div className="text-sm text-midground">{label}</div>
        <div className="text-xs text-text-tertiary">{hint}</div>
      </div>
      {children}
    </div>
  );
}
