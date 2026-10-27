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
import { HermesClient, type Message, type Session } from "@/lib/api";
import { DashboardClient, DashboardError, type DashboardProfile, type DashboardTokens } from "@/lib/dashboard";
import { DashboardChat } from "@/lib/dashboardChat";
import type { GatewayStatus } from "@/lib/gateway";
import { connectionKey, isDashboard, type AnyConnection } from "@/lib/connection";
import { loadJSON, saveJSON } from "@/lib/utils";
import { applyTheme, findTheme, type TextSize } from "@/themes/presets";

export type View = "chat" | "jobs" | "skills" | "bots" | "server";

interface Settings {
  theme: string;
  textSize: TextSize;
  /** Enter sends (hardware keyboards); otherwise Enter inserts a newline. */
  enterSends: boolean;
  showReasoning: boolean;
  /** Read each finished reply out loud (dashboard mode). */
  autoSpeak: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "default",
  textSize: "normal",
  enterSends: true,
  showReasoning: true,
  autoSpeak: false,
};

interface Toast {
  message: string;
  type: "error" | "success";
}

interface AppState {
  connection: AnyConnection | null;
  savedConnections: AnyConnection[];
  /** API-key mode (:8642). */
  client: HermesClient | null;
  /** Dashboard mode (:9119). */
  dashboard: DashboardClient | null;
  /** Dashboard mode: chat over the gateway socket. */
  chat: DashboardChat | null;
  chatStatus: { status: GatewayStatus; detail?: string };
  connect: (conn: AnyConnection) => void;
  disconnect: () => void;
  forgetConnection: (conn: AnyConnection) => void;
  /** Set when the dashboard session expired, so the login form can explain why. */
  authNotice: string | null;

  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;

  view: View;
  setView: (v: View) => void;

  /** Dashboard mode: every profile the login can see. */
  profiles: DashboardProfile[];
  /** Dashboard mode: "all" or a profile name. */
  profileFilter: string;
  setProfileFilter: (p: string) => void;

  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  refreshSessions: () => Promise<void>;
  activeSessionId: string | null;
  /** `profile`: dashboard mode, the owning profile (a new session isn't listed yet). */
  setActiveSessionId: (id: string | null, profile?: string) => void;
  /** Dashboard mode: profile of the active session, known before the list has it. */
  activeProfile: string | null;
  /** History of a session through whichever backend is connected. */
  loadMessages: (session: Session | { id: string; profile?: string }) => Promise<Message[]>;

  toast: Toast | null;
  notify: (message: string, type?: Toast["type"]) => void;
}

const Ctx = createContext<AppState | null>(null);

const CONN_KEY = "hermes-mobile:connection";
const SAVED_KEY = "hermes-mobile:connections";
const SETTINGS_KEY = "hermes-mobile:settings";
const ACTIVE_KEY = "hermes-mobile:active-session";
const ACTIVE_PROFILE_KEY = "hermes-mobile:active-profile";
const PROFILE_FILTER_KEY = "hermes-mobile:profile-filter";

const sameConn = (a: AnyConnection, b: AnyConnection) => connectionKey(a) === connectionKey(b);

export function AppProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<AnyConnection | null>(() =>
    loadJSON<AnyConnection | null>(CONN_KEY, null),
  );
  const [savedConnections, setSaved] = useState<AnyConnection[]>(() =>
    loadJSON<AnyConnection[]>(SAVED_KEY, []),
  );
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadJSON<Partial<Settings>>(SETTINGS_KEY, {}),
  }));
  const [view, setView] = useState<View>("chat");
  const [profiles, setProfiles] = useState<DashboardProfile[]>([]);
  const [profileFilter, setProfileFilterState] = useState<string>(() => loadJSON(PROFILE_FILTER_KEY, "all"));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() =>
    loadJSON<string | null>(ACTIVE_KEY, null),
  );
  const [activeProfile, setActiveProfile] = useState<string | null>(() => loadJSON(ACTIVE_PROFILE_KEY, null));
  const [chatStatus, setChatStatus] = useState<{ status: GatewayStatus; detail?: string }>({ status: "idle" });
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const notify = useCallback((message: string, type: Toast["type"] = "success") => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), type === "error" ? 5000 : 2500);
  }, []);

  useEffect(() => {
    applyTheme(findTheme(settings.theme), settings.textSize);
  }, [settings.theme, settings.textSize]);

  const persistConnection = useCallback((conn: AnyConnection | null) => {
    setConnection(conn);
    saveJSON(CONN_KEY, conn);
    if (!conn) return;
    setSaved((prev) => {
      const next = [conn, ...prev.filter((c) => !sameConn(c, conn))].slice(0, 8);
      saveJSON(SAVED_KEY, next);
      return next;
    });
  }, []);

  // Clients are keyed by connection identity, not object: rotating dashboard
  // tokens rewrites the stored connection without rebuilding the client.
  const key = connection ? connectionKey(connection) : "";
  const client = useMemo(
    () => (connection && !isDashboard(connection) ? new HermesClient(connection) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const hasAuth = isDashboard(connection) && Boolean(connection.auth);
  const dashboard = useMemo(() => {
    if (!isDashboard(connection) || !connection.auth) return null;
    const conn = connection;
    return new DashboardClient(conn.baseUrl, connection.auth, (auth: DashboardTokens) =>
      persistConnection({ ...conn, auth }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasAuth]);

  // One gateway socket per login; opened lazily by the first chat call.
  // `refreshSessions` is declared below; the gateway only calls this later, from events.
  const refreshRef = useRef<() => void>(() => {});
  const chat = useMemo(
    () =>
      dashboard
        ? new DashboardChat(dashboard, {
            onStatus: (status, detail) => setChatStatus({ status, detail }),
            onSessionsChanged: () => refreshRef.current(),
          })
        : null,
    [dashboard],
  );
  useEffect(() => () => chat?.close(), [chat]);

  const resetSessions = useCallback(() => {
    setSessions([]);
    setProfiles([]);
    setActiveSessionIdState(null);
    setActiveProfile(null);
    saveJSON(ACTIVE_KEY, null);
    saveJSON(ACTIVE_PROFILE_KEY, null);
  }, []);

  const connect = useCallback(
    (conn: AnyConnection) => {
      // Session ids belong to one backend: switching must not reopen the old one.
      if (!connection || !sameConn(connection, conn)) resetSessions();
      // A saved login whose session expired lands on the form, which says why.
      setAuthNotice(isDashboard(conn) && !conn.auth ? "La sesión venció. Ingresá la contraseña de nuevo." : null);
      persistConnection(conn);
    },
    [connection, persistConnection, resetSessions],
  );

  const disconnect = useCallback(() => {
    setConnection(null);
    saveJSON(CONN_KEY, null);
    resetSessions();
  }, [resetSessions]);

  /** Drop expired tokens, keep the username so the form can be prefilled. */
  const expireDashboard = useCallback(
    (message: string) => {
      if (!isDashboard(connection)) return;
      const { auth: _expired, ...rest } = connection;
      setSaved((prev) => {
        const next = prev.map((c) => (sameConn(c, rest) ? rest : c));
        saveJSON(SAVED_KEY, next);
        return next;
      });
      setAuthNotice(message);
      disconnect();
    },
    [connection, disconnect],
  );

  const forgetConnection = useCallback((conn: AnyConnection) => {
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

  const setActiveSessionId = useCallback((id: string | null, profile?: string) => {
    setActiveSessionIdState(id);
    setActiveProfile(profile ?? null);
    saveJSON(ACTIVE_KEY, id);
    saveJSON(ACTIVE_PROFILE_KEY, profile ?? null);
  }, []);

  const setProfileFilter = useCallback((p: string) => {
    setProfileFilterState(p);
    saveJSON(PROFILE_FILTER_KEY, p);
  }, []);

  const handleError = useCallback(
    (err: unknown): string => {
      if (err instanceof DashboardError && err.code === "session_expired") {
        expireDashboard(err.message);
      }
      return err instanceof Error ? err.message : String(err);
    },
    [expireDashboard],
  );

  const refreshSessions = useCallback(async () => {
    if (!client && !dashboard) return;
    setSessionsLoading(true);
    try {
      if (dashboard) {
        setSessions(await dashboard.sessions(profileFilter));
      } else if (client) {
        const res = await client.listSessions(100);
        setSessions(res.data ?? []);
      }
      setSessionsError(null);
    } catch (err) {
      setSessionsError(handleError(err));
    } finally {
      setSessionsLoading(false);
    }
  }, [client, dashboard, profileFilter, handleError]);

  useEffect(() => {
    if (client || dashboard) void refreshSessions();
  }, [client, dashboard, refreshSessions]);

  // Server-side changes (titles, sessions from other clients) arrive in bursts: refetch once.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    refreshRef.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refreshSessions(), 600);
    };
    return () => clearTimeout(timer);
  }, [refreshSessions]);

  useEffect(() => {
    if (!dashboard) return;
    dashboard
      .profiles()
      .then((list) => {
        setProfiles(list);
        // A profile deleted on the server must not leave the list filtered to nothing.
        if (profileFilter !== "all" && !list.some((p) => p.name === profileFilter)) setProfileFilter("all");
      })
      .catch((err) => {
        const message = handleError(err);
        // An expired session already sends the person back to the login form.
        if (!(err instanceof DashboardError && err.code === "session_expired")) notify(message, "error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard]);

  const loadMessages = useCallback(
    async (session: Session | { id: string; profile?: string }) => {
      try {
        if (dashboard) return await dashboard.messages(session.id, session.profile ?? "default");
        if (client) return await client.messages(session.id);
        return [];
      } catch (err) {
        handleError(err);
        throw err;
      }
    },
    [client, dashboard, handleError],
  );

  const value: AppState = {
    connection,
    savedConnections,
    client,
    dashboard,
    chat,
    chatStatus,
    connect,
    disconnect,
    forgetConnection,
    authNotice,
    settings,
    updateSettings,
    view,
    setView,
    profiles,
    profileFilter,
    setProfileFilter,
    sessions,
    sessionsLoading,
    sessionsError,
    refreshSessions,
    activeSessionId,
    activeProfile,
    setActiveSessionId,
    loadMessages,
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

/** Narrowed hook for screens that only render in API-key mode. */
export function useClient(): HermesClient {
  const { client } = useApp();
  if (!client) throw new Error("Not connected");
  return client;
}
