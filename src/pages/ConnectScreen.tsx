import { useState, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ds";
import { KeyRound, Server, Trash2, UserRound } from "lucide-react";
import { HermesClient, normalizeBaseUrl, type Connection } from "@/lib/api";
import {
  dashboardLogin,
  dashboardOrigin,
  devProxyTarget,
  listAuthProviders,
  refreshTokens,
} from "@/lib/dashboard";
import { isNativeApp } from "@/lib/http";
import { connectionKey, isDashboard, type AnyConnection, type DashboardConnection } from "@/lib/connection";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";
import { IconButton, Panel, SectionLabel, TextField } from "@/components/ui";
import { Wordmark } from "@/components/Brand";

type Mode = "dashboard" | "apikey";

export function ConnectScreen() {
  const { connect, savedConnections, forgetConnection, authNotice } = useApp();
  const last = savedConnections[0];
  const [mode, setMode] = useState<Mode>(last && !isDashboard(last) ? "apikey" : "dashboard");
  const lastDashboard = savedConnections.find(isDashboard);
  const lastApiKey = savedConnections.find((c): c is Connection => !isDashboard(c));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(authNotice);
  // Bumped to remount a form with a saved connection's values.
  const [prefill, setPrefill] = useState<AnyConnection | undefined>(undefined);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reopen(c: AnyConnection) {
    if (isDashboard(c)) {
      if (!c.auth) {
        setMode("dashboard");
        setPrefill(c);
        setError("La sesión venció. Ingresá la contraseña de nuevo.");
        return;
      }
      const auth = c.auth;
      void run(async () => {
        try {
          connect({ ...c, auth: await refreshTokens(c.baseUrl, auth) });
        } catch (err) {
          setMode("dashboard");
          setPrefill({ ...c, auth: undefined });
          throw err;
        }
      });
    } else {
      void run(() => connectApiKey(c, connect));
    }
  }

  return (
    <div className="hermes-backdrop [--theme-artwork-opacity:0.35] relative flex h-full w-full items-center justify-center overflow-y-auto px-4 pt-[calc(var(--safe-top)+1.5rem)] pb-[calc(var(--safe-bottom)+1.5rem)]">
      <div className="hermes-grain pointer-events-none fixed inset-0" aria-hidden />
      <div className="relative z-10 grid w-full max-w-4xl gap-8 md:grid-cols-[1fr_1.15fr] md:items-center">
        <div className="flex flex-col gap-4">
          <h1 className="font-mondwest text-display text-5xl leading-[0.9] tracking-[0.06em] text-midground md:text-6xl">
            <Wordmark className="gap-4" markClassName="h-24" />
          </h1>
          {mode === "dashboard" ? (
            <p className="max-w-sm text-text-secondary">
              Entrá con el usuario del dashboard de Hermes (<code>hermes dashboard</code>, puerto 9119). Un solo
              login te da todos los perfiles, igual que la app de escritorio.
            </p>
          ) : (
            <>
              <p className="max-w-sm text-text-secondary">
                Conectate al API server de un perfil (<code>API_SERVER_ENABLED=true</code>) con su{" "}
                <code>API_SERVER_KEY</code>.
              </p>
              <div className="hidden text-xs text-text-tertiary md:block">
                Recordá agregar el origen de esta app a <code>API_SERVER_CORS_ORIGINS</code>:
                <br />
                <code>{location.origin}</code>
              </div>
            </>
          )}
        </div>

        <Panel className="p-5 sm:p-6">
          <div role="tablist" className="mb-5 grid grid-cols-2 border border-current/20 rounded-[var(--radius-sm)]">
            {(
              [
                ["dashboard", "Usuario", UserRound],
                ["apikey", "API key", KeyRound],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={cn(
                  "flex h-11 items-center justify-center gap-2 text-display text-xs font-bold tracking-[0.15em] transition-colors",
                  mode === m ? "bg-midground text-background-base" : "text-text-secondary hover:text-midground",
                )}
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>

          {mode === "dashboard" ? (
            <DashboardForm
              key={prefill ? connectionKey(prefill) : "dashboard"}
              initial={(prefill && isDashboard(prefill) ? prefill : undefined) ?? lastDashboard}
              busy={busy}
              onSubmit={(conn, password) =>
                run(async () => {
                  // Pick the server's password provider ("basic" on a stock install).
                  const providers = await listAuthProviders(conn.baseUrl);
                  const provider = providers.find((p) => p.supports_password)?.name;
                  if (!provider) throw new Error("Este dashboard no tiene login con usuario y contraseña habilitado.");
                  const auth = await dashboardLogin({ baseUrl: conn.baseUrl, username: conn.username, password, provider });
                  connect({ ...conn, auth });
                })
              }
            />
          ) : (
            <ApiKeyForm
              key={prefill && !isDashboard(prefill) ? connectionKey(prefill) : "apikey"}
              initial={(prefill && !isDashboard(prefill) ? prefill : undefined) ?? lastApiKey}
              busy={busy}
              onSubmit={(conn) => run(() => connectApiKey(conn, connect))}
            />
          )}

          {error && (
            <p role="alert" className="mt-4 border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {error}
            </p>
          )}

          {savedConnections.length > 0 && (
            <div className="mt-6 flex flex-col gap-2 border-t border-current/15 pt-4">
              <SectionLabel>Conexiones guardadas</SectionLabel>
              <ul className="flex flex-col">
                {savedConnections.map((c) => (
                  <li key={connectionKey(c)} className="flex items-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => reopen(c)}
                      className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-2 text-start hover:bg-midground/5"
                    >
                      {isDashboard(c) ? (
                        <UserRound className="size-4 shrink-0 text-text-tertiary" />
                      ) : (
                        <Server className="size-4 shrink-0 text-text-tertiary" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-midground">
                          {isDashboard(c) ? `${c.username} · ${c.label || "dashboard"}` : c.label || c.baseUrl}
                        </span>
                        <span className="block truncate font-mono text-xs text-text-tertiary">
                          {c.baseUrl}
                          {!isDashboard(c) && c.profile ? ` · ${c.profile}` : ""}
                          {isDashboard(c) && !c.auth ? " · sesión vencida" : ""}
                        </span>
                      </span>
                    </button>
                    <IconButton label="Olvidar conexión" onClick={() => forgetConnection(c)}>
                      <Trash2 />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

async function connectApiKey(conn: Connection, connect: (c: AnyConnection) => void) {
  const client = new HermesClient(conn);
  await client.health();
  // /health is public; this call proves the key is valid.
  const caps = await client.capabilities();
  connect({ ...conn, label: conn.label || caps.model || undefined });
}

function DashboardForm({
  initial,
  busy,
  onSubmit,
}: {
  initial?: DashboardConnection;
  busy: boolean;
  onSubmit: (conn: DashboardConnection, password: string) => void;
}) {
  const native = isNativeApp();
  const proxy = devProxyTarget();
  // In a browser only the dev proxy can carry the login (see lib/dashboard.ts).
  let unsupported: string | null = null;
  if (!native) {
    try {
      dashboardOrigin("");
    } catch (err) {
      unsupported = err instanceof Error ? err.message : String(err);
    }
  }
  const [baseUrl, setBaseUrl] = useState(native ? (initial?.baseUrl ?? "") : (proxy ?? ""));
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState(initial?.label ?? "");

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(
      {
        mode: "dashboard",
        baseUrl: normalizeBaseUrl(baseUrl),
        username: username.trim(),
        label: label.trim() || undefined,
      },
      password,
    );
  }

  if (unsupported) {
    return <p className="border border-warning/40 bg-warning/10 p-3 text-sm text-text-secondary">{unsupported}</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {native ? (
        <TextField
          label="Dashboard"
          placeholder="http://192.168.0.107:9119"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Dashboard</SectionLabel>
          <div className="flex h-12 items-center border border-current/15 bg-background/20 px-3.5 font-mono text-base text-text-secondary rounded-[var(--radius-sm)]">
            {proxy}
          </div>
          <span className="text-xs text-text-tertiary">
            Vía el proxy de <code>pnpm dev</code>. Para otro server:{" "}
            <code>HERMES_DASHBOARD=http://ip:9119 pnpm dev</code>
          </span>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Usuario"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="username"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <TextField
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <TextField label="Nombre (opcional)" placeholder="Casa" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Button type="submit" disabled={busy || !baseUrl.trim() || !username.trim() || !password} className="h-12 w-full">
        {busy ? <Spinner /> : "Iniciar sesión"}
      </Button>
    </form>
  );
}

function ApiKeyForm({
  initial,
  busy,
  onSubmit,
}: {
  initial?: Connection;
  busy: boolean;
  onSubmit: (conn: Connection) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [profile, setProfile] = useState(initial?.profile ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!baseUrl.trim()) return;
    onSubmit({
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: apiKey.trim(),
      profile: profile.trim() || undefined,
      label: label.trim() || undefined,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField
        label="Servidor"
        placeholder="http://192.168.1.20:8642"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        required
      />
      <TextField
        label="API key"
        type="password"
        placeholder="API_SERVER_KEY"
        autoCapitalize="off"
        autoComplete="current-password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Perfil (opcional)"
          placeholder="default"
          autoCapitalize="off"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          hint="Para gateways multi-perfil (/p/<perfil>)"
        />
        <TextField label="Nombre (opcional)" placeholder="Casa" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <Button type="submit" disabled={busy || !baseUrl.trim()} className="h-12 w-full">
        {busy ? <Spinner /> : "Conectar"}
      </Button>
    </form>
  );
}
