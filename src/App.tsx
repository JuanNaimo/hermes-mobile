import { useEffect, useState } from "react";
import { Toast } from "@/components/ds";
import { Menu, PanelLeftOpen } from "lucide-react";
import { useApp } from "@/store";
import { cn, loadJSON, saveJSON } from "@/lib/utils";
import { Sidebar } from "@/components/Sidebar";
import { IconButton } from "@/components/ui";
import { ConnectScreen } from "@/pages/ConnectScreen";
import { ChatView } from "@/pages/ChatView";
import { JobsPage } from "@/pages/JobsPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { ServerPage } from "@/pages/ServerPage";

/** Landscape tablets and up get a persistent sidebar; portrait gets a drawer. */
const WIDE_QUERY = "(min-width: 1024px)";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const COLLAPSED_KEY = "hermes-mobile:sidebar-collapsed";

export default function App() {
  const { client, dashboard, view, toast } = useApp();
  const wide = useMediaQuery(WIDE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadJSON(COLLAPSED_KEY, false));

  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const toggleCollapsed = (value: boolean) => {
    setCollapsed(value);
    saveJSON(COLLAPSED_KEY, value);
  };

  if (!client && !dashboard) {
    return (
      <>
        <ConnectScreen />
        <Toast toast={toast} />
      </>
    );
  }

  const sidebarVisible = wide ? !collapsed : drawerOpen;
  const leading = !wide ? (
    <IconButton label="Abrir menú" onClick={() => setDrawerOpen(true)} aria-expanded={drawerOpen}>
      <Menu />
    </IconButton>
  ) : collapsed ? (
    <IconButton label="Mostrar panel" onClick={() => toggleCollapsed(false)}>
      <PanelLeftOpen />
    </IconButton>
  ) : undefined;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 overflow-hidden bg-background-base text-text-primary antialiased",
        "pt-[var(--safe-top)] pl-[var(--safe-left)] pr-[var(--safe-right)]",
      )}
    >
      <div aria-hidden className="hermes-backdrop hermes-grain pointer-events-none fixed inset-0 z-0" />

      {!wide && drawerOpen && (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 animate-fade"
        />
      )}

      <aside
        aria-label="Sesiones"
        className={cn(
          "z-50 flex min-h-0 w-[20rem] max-w-[85vw] shrink-0 flex-col border-r border-current/20 bg-background-base",
          wide
            ? cn("relative", !sidebarVisible && "hidden")
            : cn(
                "fixed top-0 bottom-0 left-0 pt-[var(--safe-top)] pl-[var(--safe-left)]",
                "transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                sidebarVisible ? "translate-x-0" : "-translate-x-full",
              ),
        )}
      >
        <Sidebar
          onNavigate={() => !wide && setDrawerOpen(false)}
          onClose={!wide ? () => setDrawerOpen(false) : undefined}
          onCollapse={wide ? () => toggleCollapsed(true) : undefined}
        />
      </aside>

      <main className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
        {(view === "chat" || (!client && (view === "jobs" || view === "skills"))) && <ChatView leading={leading} />}
        {/* Jobs and skills still go through the API server; dashboard mode gets them later. */}
        {client && view === "jobs" && <JobsPage leading={leading} />}
        {client && view === "skills" && <SkillsPage leading={leading} />}
        {view === "server" && <ServerPage leading={leading} />}
      </main>

      <Toast toast={toast} />
    </div>
  );
}
