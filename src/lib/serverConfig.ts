import { useEffect, useSyncExternalStore } from "react";
import type { DashboardClient } from "./dashboard.ts";
import { getPath, patchFor, withPath } from "./hermesSettings.ts";

/**
 * Each profile's config.yaml as the dashboard reports it, shared by the
 * settings panel and the chat (which reads `display.message_reactions`).
 * Changes are optimistic: shown at once, rolled back if the save fails.
 */

type Config = Record<string, unknown>;

const configs = new Map<string, Config>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function getServerConfig(profile: string | null | undefined): Config | undefined {
  return profile ? configs.get(profile) : undefined;
}

export function loadServerConfig(dashboard: DashboardClient, profile: string, force = false): Promise<void> {
  if (!force && configs.has(profile)) return Promise.resolve();
  let pending = loading.get(profile);
  if (!pending) {
    pending = dashboard
      .config(profile)
      .then((cfg) => {
        configs.set(profile, cfg);
        emit();
      })
      .finally(() => loading.delete(profile));
    loading.set(profile, pending);
  }
  return pending;
}

/** Save one setting; throws (after restoring the old value) when the server refuses. */
export async function setServerConfigValue(dashboard: DashboardClient, profile: string, path: string, value: unknown) {
  const before = configs.get(profile) ?? {};
  configs.set(profile, withPath(before, path, value));
  emit();
  try {
    await dashboard.updateConfig(profile, patchFor(path, value));
  } catch (err) {
    configs.set(profile, withPath(configs.get(profile) ?? {}, path, getPath(before, path)));
    emit();
    throw err;
  }
}

/** The connection changed: another server's config doesn't apply. */
export function forgetServerConfigs() {
  configs.clear();
  emit();
}

/** The profile's config (loaded on first use); undefined until it arrives. */
export function useServerConfig(dashboard: DashboardClient | null, profile: string | null | undefined): Config | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (dashboard && profile) void loadServerConfig(dashboard, profile).catch(() => {});
  }, [dashboard, profile]);
  return getServerConfig(profile);
}
