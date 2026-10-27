/**
 * The model catalog as the dashboard serves it (`model.options` over the
 * socket, `GET /api/model/options` over REST; same shape), plus the reasoning
 * effort levels Hermes accepts.
 */

export interface ModelCapabilities {
  fast?: boolean;
  ultrafast?: boolean;
  reasoning?: boolean;
  can_disable_reasoning?: boolean;
}

export interface ModelPricing {
  input?: string;
  output?: string;
  cache?: string;
  free?: boolean;
}

export interface ModelProvider {
  slug: string;
  name: string;
  aliases?: string[];
  is_current?: boolean;
  models: string[];
  featured_models?: string[];
  total_models?: number;
  authenticated?: boolean;
  warning?: string | null;
  capabilities?: Record<string, ModelCapabilities>;
  pricing?: Record<string, ModelPricing>;
}

export interface ModelOptions {
  providers: ModelProvider[];
  /** The current model and provider (of the session when asked with one). */
  model?: string;
  provider?: string;
}

export function normalizeModelOptions(raw: unknown): ModelOptions {
  const r = (raw ?? {}) as { providers?: unknown; model?: unknown; provider?: unknown };
  const providers = (Array.isArray(r.providers) ? r.providers : [])
    .filter((p): p is ModelProvider => Boolean(p) && typeof p === "object" && typeof (p as ModelProvider).slug === "string")
    .map((p) => ({ ...p, name: p.name || p.slug, models: Array.isArray(p.models) ? p.models.map(String) : [] }));
  return {
    providers,
    model: typeof r.model === "string" ? r.model : undefined,
    provider: typeof r.provider === "string" ? r.provider : undefined,
  };
}

/** A session's `provider` may be a slug, the display name or an alias. */
export function providerMatches(p: ModelProvider, name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return [p.slug, p.name, ...(p.aliases ?? [])].some((x) => x?.toLowerCase() === n);
}

export function capabilitiesOf(options: ModelOptions | null, provider?: string, model?: string): ModelCapabilities | undefined {
  if (!options || !model) return undefined;
  const p = options.providers.find((x) => providerMatches(x, provider)) ?? options.providers.find((x) => x.models.includes(model));
  return p?.capabilities?.[model];
}

/** `hermes_constants.VALID_REASONING_EFFORTS`, lightest first; `none` turns thinking off. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Sin razonar",
  minimal: "Mínimo",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  xhigh: "Muy alto",
  max: "Máximo",
  ultra: "Ultra",
};

export function effortLabel(effort: string | undefined): string {
  return (effort && EFFORT_LABELS[effort as ReasoningEffort]) || effort || "Medio";
}

/** `gpt-5.1-codex` → `gpt-5.1-codex`; `anthropic/claude-x` → `claude-x`: the part worth a pill. */
export function shortModelName(model: string | undefined): string {
  if (!model) return "Modelo";
  return model.split("/").at(-1) ?? model;
}
