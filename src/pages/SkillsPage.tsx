import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Spinner, Switch } from "@/components/ds";
import { Search } from "lucide-react";
import type { Skill, Toolset } from "@/lib/api";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { PageTitle, Panel, SectionLabel } from "@/components/ui";
import { ProfileChips } from "@/components/ProfileChips";
import { PageShell } from "./JobsPage";

const PROVENANCE: Record<string, string> = {
  hub: "del hub",
  bundled: "incluida",
  external: "externa",
  agent: "creada por el agente",
};

type Tab = "skills" | "toolsets";

export function SkillsPage({ leading }: { leading?: ReactNode }) {
  const { client, dashboard, profiles, profileFilter, notify } = useApp();
  // Skills and toolsets are per profile on the dashboard (there is no "all").
  const [profile, setProfile] = useState(
    profileFilter !== "all" ? profileFilter : (profiles.find((p) => p.is_default)?.name ?? "default"),
  );
  const [tab, setTab] = useState<Tab>("skills");
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [toolsets, setToolsets] = useState<Toolset[] | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({});
  const [query, setQuery] = useState("");

  // Loaded independently: a broken skills listing on the server must not hide the toolsets.
  useEffect(() => {
    setSkills(null);
    setToolsets(null);
    setErrors({});
    const fail = (key: Tab) => (err: unknown) =>
      setErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }));
    if (dashboard) {
      dashboard.skills(profile).then(setSkills, fail("skills"));
      dashboard.toolsets(profile).then(setToolsets, fail("toolsets"));
    } else if (client) {
      client.skills().then(setSkills, fail("skills"));
      client.toolsets().then(setToolsets, fail("toolsets"));
    }
  }, [client, dashboard, profile]);

  async function toggleSkill(name: string, enabled: boolean) {
    if (!dashboard) return;
    const set = (on: boolean) =>
      setSkills((prev) => prev?.map((s) => (s.name === name ? { ...s, enabled: on } : s)) ?? prev);
    set(enabled);
    try {
      await dashboard.setSkillEnabled(profile, name, enabled);
    } catch (err) {
      set(!enabled);
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const error = errors[tab];
  const loaded = tab === "skills" ? skills : toolsets;

  const q = query.trim().toLowerCase();
  const groupedSkills = useMemo(() => {
    const groups = new Map<string, Skill[]>();
    for (const s of skills ?? []) {
      if (q && !`${s.name} ${s.description ?? ""}`.toLowerCase().includes(q)) continue;
      const cat = s.category || "general";
      groups.set(cat, [...(groups.get(cat) ?? []), s]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [skills, q]);

  const filteredToolsets = (toolsets ?? []).filter(
    (t) => !q || `${t.name} ${t.label ?? ""} ${t.description ?? ""} ${(t.tools ?? []).join(" ")}`.toLowerCase().includes(q),
  );

  return (
    <PageShell leading={leading}>
      <PageTitle>Capacidades</PageTitle>

      {dashboard && profiles.length > 1 && (
        <ProfileChips
          includeAll={false}
          profiles={profiles.map((p) => p.name)}
          value={profile}
          onChange={setProfile}
        />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex border border-current/20 rounded-[var(--radius-sm)]">
          {(["skills", "toolsets"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "h-11 flex-1 px-5 text-display text-xs font-bold tracking-[0.15em] transition-colors sm:flex-none",
                tab === t ? "bg-midground text-background-base" : "text-text-secondary hover:text-midground",
              )}
            >
              {t === "skills" ? `Skills${skills ? ` · ${skills.length}` : ""}` : `Toolsets${toolsets ? ` · ${toolsets.length}` : ""}`}
            </button>
          ))}
        </div>
        <label className="flex h-11 flex-1 items-center gap-2 border border-current/15 bg-background/40 px-3 rounded-[var(--radius-sm)]">
          <Search className="size-4 text-text-tertiary" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar"
            className="min-w-0 flex-1 bg-transparent text-base text-midground placeholder:text-text-disabled focus:outline-none"
          />
        </label>
      </div>

      {error && (
        <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {tab === "skills" ? `El servidor no pudo listar las skills: ${error}` : error}
        </p>
      )}
      {!error && !loaded && (
        <div className="flex justify-center py-12 text-text-secondary">
          <Spinner />
        </div>
      )}

      {tab === "skills" &&
        groupedSkills.map(([cat, list]) => (
          <section key={cat} className="flex flex-col gap-2">
            <SectionLabel>{cat}</SectionLabel>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {list.map((s) => (
                <Panel key={s.name} className={cn("flex gap-3 p-3.5", s.enabled === false && "opacity-70")}>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm text-midground">{s.name}</div>
                    {s.description && <p className="mt-1 line-clamp-3 text-xs text-text-secondary">{s.description}</p>}
                    {(s.provenance || s.usage != null) && (
                      <p className="mt-1.5 text-xs text-text-tertiary">
                        {[
                          s.provenance && (PROVENANCE[s.provenance] ?? s.provenance),
                          s.usage ? `usada ${s.usage} ${s.usage === 1 ? "vez" : "veces"}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  {dashboard && s.enabled !== undefined && (
                    <Switch
                      aria-label={`${s.enabled ? "Desactivar" : "Activar"} ${s.name}`}
                      checked={s.enabled}
                      onCheckedChange={(on) => void toggleSkill(s.name, on)}
                    />
                  )}
                </Panel>
              ))}
            </div>
          </section>
        ))}

      {tab === "toolsets" && (
        <div className="grid gap-3 md:grid-cols-2">
          {filteredToolsets.map((t) => (
            <Panel key={t.name} className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-midground">{t.label || t.name}</span>
                <div className="flex gap-1.5">
                  {t.enabled === false ? (
                    <Badge tone="secondary">Off</Badge>
                  ) : (
                    <Badge tone="success">On</Badge>
                  )}
                  {t.configured === false && <Badge tone="warning">Sin config</Badge>}
                </div>
              </div>
              {t.description && <p className="text-xs text-text-secondary">{t.description}</p>}
              {t.tools && t.tools.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.tools.map((tool) => (
                    <span
                      key={tool}
                      className="border border-current/15 px-1.5 py-0.5 font-mono text-xs text-text-tertiary rounded-[var(--radius-sm)]"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
    </PageShell>
  );
}
