import type { Connection } from "./api";
import type { DashboardTokens } from "./dashboard";

/** Signed in to the dashboard (:9119) with a username: one login, every profile. */
export interface DashboardConnection {
  mode: "dashboard";
  /** The dashboard URL; in `pnpm dev` the proxy target, shown for reference only. */
  baseUrl: string;
  username: string;
  label?: string;
  /** Missing once the session expired: reconnecting asks for the password again. */
  auth?: DashboardTokens;
}

export type AnyConnection = Connection | DashboardConnection;

export function isDashboard(conn: AnyConnection | null | undefined): conn is DashboardConnection {
  return conn?.mode === "dashboard";
}

/** Identity of a saved connection (an API key per profile, a login per user). */
export function connectionKey(conn: AnyConnection): string {
  return isDashboard(conn)
    ? `dashboard|${conn.baseUrl}|${conn.username}`
    : `apikey|${conn.baseUrl}|${conn.profile ?? ""}`;
}
