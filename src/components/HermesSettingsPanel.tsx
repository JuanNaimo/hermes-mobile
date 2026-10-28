import { useState, type ReactNode } from "react";
import { Spinner, Switch } from "@/components/ds";
import { Plus, RefreshCw, X } from "lucide-react";
import type { DashboardClient } from "@/lib/dashboard";
import { getPath, personalityOptions, SETTING_GROUPS, type SettingField } from "@/lib/hermesSettings";
import { loadServerConfig, setServerConfigValue, useServerConfig } from "@/lib/serverConfig";
import { cn } from "@/lib/utils";
import { ProfileChips } from "./ProfileChips";
import { IconButton, Panel, SectionLabel } from "./ui";

const SELECT_CLASS =
  "h-11 max-w-[min(60vw,16rem)] border border-current/20 bg-background-base px-2 text-sm text-midground rounded-[var(--radius-sm)] focus:outline-none focus:border-midground/40";

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * A curated slice of the profile's config.yaml (see lib/hermesSettings.ts).
 * Each change saves right away; the rest of the file is left as it is.
 */
export function HermesSettingsPanel({
  dashboard,
  profiles,
  defaultProfile,
  onError,
}: {
  dashboard: DashboardClient;
  profiles: string[];
  defaultProfile: string;
  onError: (message: string) => void;
}) {
  const [profile, setProfile] = useState(defaultProfile);
  const config = useServerConfig(dashboard, profile);
  const [saving, setSaving] = useState<string | null>(null);

  async function save(key: string, value: unknown) {
    setSaving(key);
    try {
      await setServerConfigValue(dashboard, profile, key, value);
    } catch (err) {
      onError(`No se guardó: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Panel className="flex flex-col gap-4 p-5 lg:col-span-2">
      <div className="flex items-center gap-2">
        <SectionLabel className="flex-1">Ajustes de Hermes</SectionLabel>
        <IconButton label="Recargar ajustes" onClick={() => void loadServerConfig(dashboard, profile, true).catch(() => {})}>
          <RefreshCw />
        </IconButton>
      </div>
      {profiles.length > 1 && <ProfileChips includeAll={false} profiles={profiles} value={profile} onChange={setProfile} />}
      {!config ? (
        <div className="flex justify-center py-6 text-text-secondary">
          <Spinner />
        </div>
      ) : (
        SETTING_GROUPS.map((group) => (
          <section key={group.title} className="flex flex-col">
            <h3 className="pt-2 text-xs tracking-[0.12em] text-text-tertiary uppercase">{group.title}</h3>
            {group.fields.map((field) => (
              <FieldRow key={field.key} field={field} busy={saving === field.key}>
                <FieldInput field={field} config={config} onChange={(v) => void save(field.key, v)} />
              </FieldRow>
            ))}
          </section>
        ))
      )}
      <p className="text-xs text-text-tertiary">
        Se guarda en el config.yaml del perfil. Algunos cambios se aplican desde la próxima conversación.
      </p>
    </Panel>
  );
}

function FieldRow({ field, busy, children }: { field: SettingField; busy: boolean; children: ReactNode }) {
  const stacked = field.kind === "list";
  return (
    <div className={cn("flex min-h-16 gap-4 border-b border-current/10 py-2 last:border-0", stacked ? "flex-col" : "items-center justify-between")}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-midground">
          {field.label}
          {busy && <Spinner />}
        </div>
        <div className="text-xs text-text-tertiary">{field.hint}</div>
      </div>
      {children}
    </div>
  );
}

function FieldInput({
  field,
  config,
  onChange,
}: {
  field: SettingField;
  config: Record<string, unknown>;
  onChange: (value: unknown) => void;
}) {
  const value = getPath(config, field.key);
  switch (field.kind) {
    case "boolean":
      return <Switch aria-label={field.label} checked={value === true} onCheckedChange={(on) => onChange(on)} />;
    case "select":
      return (
        <select aria-label={field.label} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "personality": {
      const current = String(value ?? "");
      const names = personalityOptions(config);
      return (
        <select aria-label={field.label} value={current} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
          <option value="">Ninguna</option>
          {current && !names.includes(current) && <option value={current}>{current}</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      );
    }
    case "timezone": {
      const current = String(value ?? "");
      const zones = timezones();
      return (
        <select aria-label={field.label} value={current} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
          <option value="">La del servidor</option>
          {current && !zones.includes(current) && <option value={current}>{current}</option>}
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      );
    }
    case "list":
      return <ListInput label={field.label} items={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />;
  }
}

function ListInput({ label, items, onChange }: { label: string; items: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-1 border border-current/20 ps-2.5 font-mono text-xs text-midground rounded-[var(--radius-sm)]">
              {item}
              <button
                type="button"
                aria-label={`Quitar ${item}`}
                onClick={() => onChange(items.filter((i) => i !== item))}
                className="inline-flex size-8 items-center justify-center text-text-tertiary hover:text-midground"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="git status"
          aria-label={`Agregar a ${label}`}
          className="h-11 min-w-0 flex-1 border border-current/20 bg-background/40 px-3 font-mono text-sm text-midground placeholder:text-text-disabled focus:outline-none focus:border-midground/40 rounded-[var(--radius-sm)]"
        />
        <IconButton label="Agregar" onClick={add} disabled={!draft.trim()}>
          <Plus />
        </IconButton>
      </form>
    </div>
  );
}
