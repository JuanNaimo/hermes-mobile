import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Spinner } from "@/components/ds";
import { Search } from "lucide-react";
import type { Skill, Toolset } from "@/lib/api";
import { useClient } from "@/store";
import { cn } from "@/lib/utils";
import { PageTitle, Panel, SectionLabel } from "@/components/ui";
import { PageShell } from "./JobsPage";

type Tab = "skills" | "toolsets";

export function SkillsPage({ leading }: { leading?: ReactNode }) {
  const client = useClient();
  const [tab, setTab] = useState<Tab>("skills");
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [toolsets, setToolsets] = useState<Toolset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    Promise.all([client.skills(), client.toolsets()])
      .then(([s, t]) => {
        setSkills(s);
        setToolsets(t);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [client]);

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

      {error && <p className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {!error && (!skills || !toolsets) && (
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
                <Panel key={s.name} className="p-3.5">
                  <div className="font-mono text-sm text-midground">{s.name}</div>
                  {s.description && <p className="mt-1 line-clamp-3 text-xs text-text-secondary">{s.description}</p>}
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
