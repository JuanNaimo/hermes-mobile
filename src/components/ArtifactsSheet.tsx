import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import { Spinner } from "@/components/ds";
import { ExternalLink, FileText, ImageIcon, Link2, X } from "lucide-react";
import type { DashboardClient } from "@/lib/dashboard";
import { extractArtifacts, type Artifact, type ArtifactKind } from "@/lib/artifacts";
import { dataUrlToFile, shareOrDownload } from "@/lib/share";
import { cn, relativeTime } from "@/lib/utils";

/** Sessions read per page of the "recent" gallery: each costs one history request. */
const PAGE = 20;
const FILTERS: { value: "all" | ArtifactKind; label: string }[] = [
  { value: "all", label: "Todo" },
  { value: "image", label: "Imágenes" },
  { value: "file", label: "Archivos" },
  { value: "link", label: "Links" },
];

/**
 * What the agent made or pointed to: the open session's, or across the most
 * recent sessions (a page at a time, since each needs its whole history).
 */
export function ArtifactsSheet({
  open,
  onClose,
  dashboard,
  sessionId,
  profile,
  sessionTitle,
  profileFilter,
  onOpenSession,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: DashboardClient;
  sessionId: string | null;
  profile?: string;
  sessionTitle: string;
  /** The sidebar's profile filter, for the recent gallery. */
  profileFilter: string;
  onOpenSession: (id: string, profile: string) => void;
  onError: (message: string) => void;
}) {
  const [scope, setScope] = useState<"session" | "recent">(sessionId ? "session" : "recent");
  const [filter, setFilter] = useState<"all" | ArtifactKind>("all");
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ artifact: Artifact; src: string } | null>(null);
  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError]);

  const loadRecent = useCallback(
    async (from: number) => {
      setLoading(true);
      try {
        const sessions = await dashboard.sessions(profileFilter, PAGE, from);
        const found: Artifact[] = [];
        // A few at a time: each is a full history read.
        for (let i = 0; i < sessions.length; i += 4) {
          const batch = await Promise.all(
            sessions.slice(i, i + 4).map(async (s) => {
              const msgs = await dashboard.messages(s.id, s.profile).catch(() => []);
              return extractArtifacts(msgs, { id: s.id, profile: s.profile, title: s.title || s.preview || s.id, at: (s.last_active ?? 0) * 1000 });
            }),
          );
          found.push(...batch.flat());
        }
        setItems((prev) => [...(from ? (prev ?? []) : []), ...found].sort((a, b) => b.at - a.at));
        setOffset(from + sessions.length);
        setMore(sessions.length === PAGE);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    },
    [dashboard, profileFilter, fail],
  );

  useEffect(() => {
    setPreview(null);
    if (!open) return;
    setItems(null);
    if (scope === "recent") return void loadRecent(0);
    if (!sessionId || !profile) return setItems([]);
    setLoading(true);
    dashboard
      .messages(sessionId, profile)
      .then((msgs) => setItems(extractArtifacts(msgs, { id: sessionId, profile, title: sessionTitle }).reverse()))
      .catch((err) => {
        setItems([]);
        fail(err);
      })
      .finally(() => setLoading(false));
  }, [open, scope, sessionId, profile, sessionTitle, dashboard, loadRecent, fail]);

  /** Server paths come through the dashboard; URLs open directly. */
  async function openArtifact(a: Artifact) {
    if (a.kind === "link" || (/^https?:/i.test(a.value) && a.kind !== "image")) {
      window.open(a.value, "_blank", "noopener");
      return;
    }
    try {
      const src = /^(https?:|data:)/i.test(a.value) ? a.value : await dashboard.readFile(a.value, a.profile, a.sessionId);
      if (a.kind === "image") setPreview({ artifact: a, src });
      else if (!(await shareOrDownload(await dataUrlToFile(src, a.label)))) window.open(src, "_blank");
    } catch (err) {
      fail(err);
    }
  }

  const shown = (items ?? []).filter((a) => filter === "all" || a.kind === filter);

  return (
    <BottomSheet open={open} onClose={onClose} title="Archivos y links">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-current/10 bg-background-base px-3 py-2">
        <div role="tablist" className="flex gap-1">
          {sessionId && (
            <Tab active={scope === "session"} onClick={() => setScope("session")}>
              Esta conversación
            </Tab>
          )}
          <Tab active={scope === "recent"} onClick={() => setScope("recent")}>
            Recientes{profileFilter !== "all" ? ` · ${profileFilter}` : ""}
          </Tab>
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "h-9 border px-3 text-xs rounded-full",
                filter === f.value ? "border-midground bg-midground text-background-base" : "border-current/20 text-text-secondary",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {preview && (
        <div className="relative m-3 border border-current/15 p-2 rounded-[var(--radius-md)]">
          <img src={preview.src} alt={preview.artifact.label} className="mx-auto max-h-[60vh] rounded-[var(--radius-sm)] object-contain" />
          <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
            <span className="min-w-0 flex-1 truncate">{preview.artifact.label}</span>
            <button
              type="button"
              onClick={() => void dataUrlToFile(preview.src, preview.artifact.label).then(shareOrDownload).catch(fail)}
              className="min-h-9 px-2 text-midground"
            >
              Guardar
            </button>
            <button type="button" aria-label="Cerrar vista" onClick={() => setPreview(null)} className="inline-flex size-9 items-center justify-center">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      <ul className="flex flex-col p-2 pb-6">
        {shown.map((a) => (
          <li key={`${a.sessionId}/${a.value}`}>
            <button
              type="button"
              onClick={() => void openArtifact(a)}
              className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-start hover:bg-midground/5"
            >
              <Thumb artifact={a} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-midground">{a.label}</span>
                <span className="block truncate text-xs text-text-tertiary">
                  {scope === "recent" ? `${a.sessionTitle} · ${relativeTime(a.at / 1000)}` : a.value}
                </span>
              </span>
              {a.kind === "link" && <ExternalLink className="size-4 shrink-0 text-text-tertiary" />}
            </button>
            {scope === "recent" && (
              <button
                type="button"
                onClick={() => {
                  onOpenSession(a.sessionId, a.profile);
                  onClose();
                }}
                className="ms-14 mb-1 text-xs text-text-tertiary underline-offset-2 hover:text-midground hover:underline"
              >
                Abrir la conversación
              </button>
            )}
          </li>
        ))}
        {loading && (
          <li className="flex justify-center py-6 text-text-secondary">
            <Spinner />
          </li>
        )}
        {!loading && items && shown.length === 0 && (
          <li className="p-6 text-center text-sm text-text-tertiary">
            {scope === "session" ? "Esta conversación no tiene archivos ni links." : "Nada en estas sesiones."}
          </li>
        )}
        {scope === "recent" && more && !loading && (
          <li className="flex justify-center pt-2">
            <button type="button" onClick={() => void loadRecent(offset)} className="min-h-11 px-4 text-sm text-midground">
              Buscar en {PAGE} sesiones más
            </button>
          </li>
        )}
      </ul>
    </BottomSheet>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn("min-h-10 flex-1 border-b-2 px-2 text-sm", active ? "border-midground text-midground" : "border-transparent text-text-tertiary")}
    >
      {children}
    </button>
  );
}

/** URLs and data: images show inline; server images load on tap (each is a download). */
function Thumb({ artifact }: { artifact: Artifact }) {
  const inline = artifact.kind === "image" && /^(https?:|data:)/i.test(artifact.value);
  if (inline) {
    return <img src={artifact.value} alt="" loading="lazy" className="size-10 shrink-0 rounded-[var(--radius-sm)] border border-current/15 object-cover" />;
  }
  const Icon = artifact.kind === "image" ? ImageIcon : artifact.kind === "file" ? FileText : Link2;
  return (
    <span className="inline-flex size-10 shrink-0 items-center justify-center border border-current/15 text-text-secondary rounded-[var(--radius-sm)]">
      <Icon className="size-4" />
    </span>
  );
}
