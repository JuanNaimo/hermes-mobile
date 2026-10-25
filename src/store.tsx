import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HermesClient, type Connection, type Session } from "@/lib/api";
import { loadJSON, saveJSON } from "@/lib/utils";
import { applyTheme, findTheme, type TextSize } from "@/themes/presets";

export type View = "chat" | "jobs" | "skills" | "server";

interface Settings {
  theme: string;
  textSize: TextSize;
  /** Enter sends (hardware keyboards); otherwise Enter inserts a newline. */
  enterSends: boolean;
  showReasoning: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "default",
  textSize: "normal",
  enterSends: true,
  showReasoning: true,
};

interface Toast {
  message: string;
  type: "error" | "success";
}

interface AppState {
  connection: Connection | null;
  savedConnections: Connection[];
  client: HermesClient | null;
  connect: (conn: Connection) => void;
  disconnect: () => void;
  forgetConnection: (conn: Connection) => void;

  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;

  view: View;
  setView: (v: View) => void;

  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  refreshSessions: () => Promise<void>;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  toast: Toast | null;
  notify: (message: string, type?: Toast["type"]) => void;
}

const Ctx = createContext<AppState | null>(null);

const CONN_KEY = "hermes-mobile:connection";
const SAVED_KEY = "hermes-mobile:connections";
const SETTINGS_KEY = "hermes-mobile:settings";
const ACTIVE_KEY = "hermes-mobile:active-session";

const sameConn = (a: Connection, b: Connection) =>
  a.baseUrl === b.baseUrl && (a.profile ?? "") === (b.profile ?? "");

export function AppProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(() =>
    loadJSON<Connection | null>(CONN_KEY, null),
  );
  const [savedConnections, setSaved] = useState<Connection[]>(() =>
    loadJSON<Connection[]>(SAVED_KEY, []),
  );
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadJSON<Partial<Settings>>(SETTINGS_KEY, {}),
  }));
  const [view, setView] = useState<View>("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() =>
    loadJSON<string | null>(ACTIVE_KEY, null),
  );
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const client = useMemo(() => (connection ? new HermesClient(connection) : null), [connection]);

  useEffect(() => {
    applyTheme(findTheme(settings.theme), settings.textSize);
  }, [settings.theme, settings.textSize]);

  const notify = useCallback((message: string, type: Toast["type"] = "success") => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 5000 : 2500);
  }, []);

  const connect = useCallback((conn: Connection) => {
    // Session ids belong to one profile: switching must not reopen the old one.
    if (!connection || !sameConn(connection, conn)) {
      setSessions([]);
      setActiveSessionIdState(null);
      saveJSON(ACTIVE_KEY, null);
    }
    setConnection(conn);
    saveJSON(CONN_KEY, conn);
    setSaved((prev) => {
      const next = [conn, ...prev.filter((c) => !sameConn(c, conn))].slice(0, 8);
      saveJSON(SAVED_KEY, next);
      return next;
    });
  }, [connection]);

  const disconnect = useCallback(() => {
    setConnection(null);
    saveJSON(CONN_KEY, null);
    setSessions([]);
    setActiveSessionIdState(null);
    saveJSON(ACTIVE_KEY, null);
  }, []);

  const forgetConnection = useCallback((conn: Connection) => {
    setSaved((prev) => {
      const next = prev.filter((c) => !sameConn(c, conn));
      saveJSON(SAVED_KEY, next);
      return next;
    });
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveJSON(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdState(id);
    saveJSON(ACTIVE_KEY, id);
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!client) return;
    setSessionsLoading(true);
    try {
      const res = await client.listSessions(100);
      setSessions(res.data ?? []);
      setSessionsError(null);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (client) void refreshSessions();
  }, [client, refreshSessions]);

  const value: AppState = {
    connection,
    savedConnections,
    client,
    connect,
    disconnect,
    forgetConnection,
    settings,
    updateSettings,
    view,
    setView,
    sessions,
    sessionsLoading,
    sessionsError,
    refreshSessions,
    activeSessionId,
    setActiveSessionId,
    toast,
    notify,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** Narrowed hook for screens that only render while connected. */
export function useClient(): HermesClient {
  const { client } = useApp();
  if (!client) throw new Error("Not connected");
  return client;
}
