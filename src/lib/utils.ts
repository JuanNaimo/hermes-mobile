import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// `text-display` is the DS uppercase utility, not a colour: without this,
// tailwind-merge drops it (or the colour next to it) as a text-color conflict.
const twMerge = extendTailwindMerge<"text-display">({
  extend: { classGroups: { "text-display": ["text-display"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Short relative time ("3 min", "2 h", "ayer") for session timestamps (seconds). */
export function relativeTime(epochSeconds?: number | null): string {
  if (!epochSeconds) return "";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 172800) return "ayer";
  if (diff < 604800) return `${Math.floor(diff / 86400)} d`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

/** Formats either epoch seconds or an ISO string. */
export function formatDate(value?: string | number | null): string {
  if (value == null || value === "") return "—";
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) */
  }
}
