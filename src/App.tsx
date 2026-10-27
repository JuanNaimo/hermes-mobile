import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Spinner, Toast } from "@/components/ds";
import { Menu, PanelLeftOpen } from "lucide-react";
import { useApp } from "@/store";
import { cn, loadJSON, saveJSON } from "@/lib/utils";
import { Sidebar } from "@/components/Sidebar";
import { IconButton } from "@/components/ui";
import { ConnectScreen } from "@/pages/ConnectScreen";
import { ChatView } from "@/pages/ChatView";

// Pages besides the chat load on first visit, to keep the startup bundle small.
const JobsPage = lazy(() => import("@/pages/JobsPage").then((m) => ({ default: m.JobsPage })));
const SkillsPage = lazy(() => import("@/pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));
const BotsPage = lazy(() => import("@/pages/BotsPage").then((m) => ({ default: m.BotsPage })));
const ServerPage = lazy(() => import("@/pages/ServerPage").then((m) => ({ default: m.ServerPage })));

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

/** Timing shared by the panel's slide, the column's width and the backdrop's fade. */
const SLIDE = "duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

export default function App() {
  const { client, dashboard, view, toast } = useApp();
  const wide = useMediaQuery(WIDE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadJSON(COLLAPSED_KEY, false));
  const asideRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sidebarVisible = wide ? !collapsed : drawerOpen;

  // Closing makes the panel inert, which drops focus inside it to <body>: hand it to the
  // button that reopens the panel instead. Layout effect: before the browser's focus fixup runs.
  useLayoutEffect(() => {
    if (!sidebarVisible && asideRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
  }, [sidebarVisible]);

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

  const leading = !wide ? (
    <IconButton ref={triggerRef} label="Abrir menú" onClick={() => setDrawerOpen(true)} aria-expanded={drawerOpen}>
      <Menu />
    </IconButton>
  ) : collapsed ? (
    <IconButton ref={triggerRef} label="Mostrar panel" onClick={() => toggleCollapsed(false)}>
      <PanelLeftOpen />
    </IconButton>
  ) : undefined;

  const panel = (
    <aside
      ref={asideRef}
      aria-label="Sesiones"
      inert={!sidebarVisible}
      className={cn(
        "flex h-full min-h-0 w-[20rem] max-w-[85vw] flex-col border-r border-current/20 bg-background-base",
        SLIDE,
        "transition-transform",
        sidebarVisible ? "translate-x-0" : "-translate-x-full",
        !wide && "fixed top-0 bottom-0 left-0 z-50 pt-[var(--safe-top)] pl-[var(--safe-left)]",
      )}
    >
      <Sidebar
        onNavigate={() => !wide && setDrawerOpen(false)}
        onClose={!wide ? () => setDrawerOpen(false) : undefined}
        onCollapse={wide ? () => toggleCollapsed(true) : undefined}
      />
    </aside>
  );

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 overflow-hidden bg-background-base text-text-primary antialiased",
        "pt-[var(--safe-top)] pl-[var(--safe-left)] pr-[var(--safe-right)]",
      )}
    >
      <div aria-hidden className="hermes-backdrop hermes-grain pointer-events-none fixed inset-0 z-0" />

      {!wide && (
        // Stays mounted so it can fade out as well as in.
        <button
          type="button"
          aria-label="Cerrar menú"
          aria-hidden={!drawerOpen}
          tabIndex={drawerOpen ? 0 : -1}
          onClick={() => setDrawerOpen(false)}
          className={cn(
            "fixed inset-0 z-40 bg-black/60",
            SLIDE,
            "transition-opacity",
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
      )}

      {/* Same tree in both layouts (only the classes change), so rotating across the
          breakpoint keeps the sidebar's state (search text, open switcher). Narrow: the
          wrapper is display:contents and the panel is a fixed drawer. Wide: collapsing
          animates the column's width, so the chat slides over as the panel leaves. */}
      <div
        className={cn(
          wide
            ? cn("relative z-50 shrink-0 overflow-hidden", SLIDE, "transition-[width]", sidebarVisible ? "w-[20rem]" : "w-0")
            : "contents",
        )}
      >
        {panel}
      </div>

      <main className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
        {view === "chat" && <ChatView leading={leading} />}
        <Suspense fallback={<PageLoading />}>
          {view === "jobs" && <JobsPage leading={leading} />}
          {view === "skills" && <SkillsPage leading={leading} />}
          {view === "bots" && <BotsPage leading={leading} />}
          {view === "server" && <ServerPage leading={leading} />}
        </Suspense>
      </main>

      <Toast toast={toast} />
    </div>
  );
}

function PageLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-text-tertiary" role="status" aria-label="Cargando">
      <Spinner />
    </div>
  );
}
