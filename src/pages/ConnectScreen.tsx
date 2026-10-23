import { useState, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ds";
import { Server, Trash2 } from "lucide-react";
import { HermesClient, normalizeBaseUrl, type Connection } from "@/lib/api";
import { useApp } from "@/store";
import { IconButton, Panel, SectionLabel, TextField } from "@/components/ui";

export function ConnectScreen() {
  const { connect, savedConnections, forgetConnection } = useApp();
  const last = savedConnections[0];
  const [baseUrl, setBaseUrl] = useState(last?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(last?.apiKey ?? "");
  const [profile, setProfile] = useState(last?.profile ?? "");
  const [label, setLabel] = useState(last?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function tryConnect(conn: Connection) {
    setBusy(true);
    setError(null);
    try {
      const client = new HermesClient(conn);
      await client.health();
      // /health is public; this call proves the key is valid.
      const caps = await client.capabilities();
      connect({ ...conn, label: conn.label || caps.model || undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!baseUrl.trim()) return;
    void tryConnect({
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: apiKey.trim(),
      profile: profile.trim() || undefined,
      label: label.trim() || undefined,
    });
  }

  return (
    <div className="hermes-backdrop relative flex h-full w-full items-center justify-center overflow-y-auto px-4 pt-[calc(var(--safe-top)+1.5rem)] pb-[calc(var(--safe-bottom)+1.5rem)]">
      <div className="hermes-grain pointer-events-none fixed inset-0" aria-hidden />
      <div className="relative z-10 grid w-full max-w-4xl gap-8 md:grid-cols-[1fr_1.15fr] md:items-center">
        <div className="flex flex-col gap-4">
          <h1 className="font-mondwest text-display text-5xl leading-[0.9] tracking-[0.06em] text-midground md:text-6xl">
            Hermes
            <br />
            Agent
          </h1>
          <p className="max-w-sm text-text-secondary">
            Conectate a tu servidor Hermes desde la tablet. Necesitás el API server del gateway habilitado
            (<code>API_SERVER_ENABLED=true</code>) y su <code>API_SERVER_KEY</code>.
          </p>
          <div className="hidden text-xs text-text-tertiary md:block">
            Recordá agregar el origen de esta app a <code>API_SERVER_CORS_ORIGINS</code>:
            <br />
            <code>{location.origin}</code>
          </div>
        </div>

        <Panel className="p-5 sm:p-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
              <TextField
                label="Nombre (opcional)"
                placeholder="Casa"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            {error && (
              <p role="alert" className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy || !baseUrl.trim()} className="h-12 w-full">
              {busy ? <Spinner /> : "Conectar"}
            </Button>
          </form>

          {savedConnections.length > 0 && (
            <div className="mt-6 flex flex-col gap-2 border-t border-current/15 pt-4">
              <SectionLabel>Servidores guardados</SectionLabel>
              <ul className="flex flex-col">
                {savedConnections.map((c) => (
                  <li key={`${c.baseUrl}|${c.profile ?? ""}`} className="flex items-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void tryConnect(c)}
                      className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-2 text-start hover:bg-midground/5"
                    >
                      <Server className="size-4 shrink-0 text-text-tertiary" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-midground">{c.label || c.baseUrl}</span>
                        <span className="block truncate font-mono text-xs text-text-tertiary">
                          {c.baseUrl}
                          {c.profile ? ` · ${c.profile}` : ""}
                        </span>
                      </span>
                    </button>
                    <IconButton label="Olvidar servidor" onClick={() => forgetConnection(c)}>
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
