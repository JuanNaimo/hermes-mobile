import type { ChatItem } from "./transcript.ts";
import type { LiveStatus } from "./sessionLive.ts";

const TOOL_LABELS: Record<string, string> = {
  terminal: "Ejecutando un comando",
  web_search: "Buscando en la web",
  web_extract: "Leyendo una página",
  browser_navigate: "Navegando",
  read_file: "Leyendo un archivo",
  write_file: "Escribiendo un archivo",
  patch: "Editando un archivo",
  search_files: "Buscando en archivos",
  execute_code: "Ejecutando código",
  delegate_task: "Delegando en un subagente",
  todo: "Actualizando el plan",
  memory: "Guardando en memoria",
  vision_analyze: "Mirando una imagen",
};

/**
 * One line saying what the agent is doing in a running turn: the server's
 * own status when it sent one, else read off the turn's latest item.
 */
export function describeActivity(items: ChatItem[], status?: LiveStatus | null): string {
  if (status?.text) return status.text;
  const waiting = items.some(
    (it) => (it.kind === "approval" || it.kind === "input") && !it.resolved,
  );
  if (waiting) return "Esperando tu respuesta";
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.status === "running") {
      return `${TOOL_LABELS[it.name] ?? `Usando ${it.name}`}…`;
    }
    if (it.kind === "assistant") {
      if (it.streaming && it.text) return "Escribiendo…";
      if (it.streaming && it.reasoning) return "Pensando…";
      break;
    }
    if (it.kind === "user") break;
  }
  return "Trabajando…";
}
