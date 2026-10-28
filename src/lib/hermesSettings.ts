/**
 * The few config.yaml settings worth changing from a tablet, per profile.
 * Keys are dot paths into the config (`/api/config`); the server deep-merges
 * a partial update, so each change sends just its own path.
 */

export type SettingKind = "boolean" | "select" | "list" | "timezone" | "personality";

export interface SettingField {
  key: string;
  label: string;
  hint: string;
  kind: SettingKind;
  options?: { value: string; label: string }[];
}

export interface SettingGroup {
  title: string;
  fields: SettingField[];
}

/** hermes_cli/personality.py BUILTIN_PERSONALITIES (custom ones come from `personalities`). */
export const BUILTIN_PERSONALITIES = [
  "helpful", "concise", "technical", "creative", "teacher", "kawaii", "catgirl", "pirate",
  "shakespeare", "surfer", "noir", "uwu", "philosopher", "hype",
];

export const SETTING_GROUPS: SettingGroup[] = [
  {
    title: "Conversación",
    fields: [
      { key: "display.personality", label: "Personalidad", hint: "El tono con que responde Hermes.", kind: "personality" },
      { key: "timezone", label: "Zona horaria", hint: "Para fechas y jobs. Vacío: la del servidor.", kind: "timezone" },
      { key: "display.show_reasoning", label: "Mostrar razonamiento", hint: "Que el servidor mande lo que piensa el modelo.", kind: "boolean" },
      {
        key: "display.message_reactions",
        label: "Reacciones",
        hint: "Reaccionar a mensajes con emojis; Hermes las ve en el próximo turno y puede reaccionar también.",
        kind: "boolean",
      },
    ],
  },
  {
    title: "Seguridad",
    fields: [
      {
        key: "approvals.mode",
        label: "Aprobación de comandos",
        hint: "Qué hace con un comando peligroso.",
        kind: "select",
        options: [
          { value: "manual", label: "Preguntar siempre" },
          { value: "smart", label: "Inteligente (pregunta si hace falta)" },
          { value: "off", label: "No preguntar" },
        ],
      },
      { key: "command_allowlist", label: "Comandos permitidos", hint: "Patrones que nunca piden aprobación.", kind: "list" },
      { key: "checkpoints.enabled", label: "Checkpoints", hint: "Guarda una copia de los archivos antes de que Hermes los edite.", kind: "boolean" },
    ],
  },
  {
    title: "Memoria",
    fields: [
      { key: "memory.memory_enabled", label: "Memoria", hint: "Lo que Hermes aprende y recuerda entre sesiones.", kind: "boolean" },
      { key: "memory.user_profile_enabled", label: "Perfil del usuario", hint: "Lo que sabe de vos.", kind: "boolean" },
    ],
  },
];

export function getPath(obj: unknown, path: string): unknown {
  let node = obj;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** `{"a": {"b": value}}` for `"a.b"`: the partial body for one change. */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  return path
    .split(".")
    .reverse()
    .reduce<unknown>((acc, part) => ({ [part]: acc }), value) as Record<string, unknown>;
}

/** A copy of `obj` with `path` set (for the optimistic local view). */
export function withPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  if (!rest.length) return { ...obj, [head]: value };
  const child = obj[head] && typeof obj[head] === "object" ? (obj[head] as Record<string, unknown>) : {};
  return { ...obj, [head]: withPath(child, rest.join("."), value) };
}

/** Built-ins plus the profile's own `personalities`. */
export function personalityOptions(config: Record<string, unknown>): string[] {
  const custom = config.personalities && typeof config.personalities === "object" ? Object.keys(config.personalities) : [];
  return [...new Set([...BUILTIN_PERSONALITIES, ...custom])];
}
