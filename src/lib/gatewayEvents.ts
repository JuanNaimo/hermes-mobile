import type { StreamPayload } from "./api.ts";
import type { GatewayEvent, ServerRequest } from "./gateway.ts";

/**
 * Translate dashboard gateway events (tui_gateway/contracts/events.py) into
 * the event vocabulary the chat reducer (transcript.ts) already speaks for
 * the API server's SSE stream, so both backends render through one path.
 */
export type StreamEvent = [name: string, payload: StreamPayload];

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksFailed(result: unknown): boolean {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    return Boolean(r.error) || (typeof r.exit_code === "number" && r.exit_code !== 0);
  }
  return false;
}

export function gatewayEventToStream(event: GatewayEvent): StreamEvent[] {
  const p = event.payload ?? {};
  const text = typeof p.text === "string" ? p.text : "";
  switch (event.type) {
    case "message.delta":
      // `text: null` marks a reply segment boundary (before tool lines).
      return p.text == null ? [["assistant.segment_end", {}]] : text ? [["assistant.delta", { delta: text }]] : [];
    case "reasoning.delta":
    case "thinking.delta":
    case "reasoning.available":
      return text ? [["tool.progress", { tool_name: "_thinking", delta: text }]] : [];
    case "message.interim":
      return text ? [["assistant.commentary", { text, already_streamed: Boolean(p.already_streamed) }]] : [];
    case "tool.start":
      return [
        [
          "tool.started",
          {
            tool_name: String(p.name ?? "tool"),
            tool_id: p.tool_id,
            args: p.args ?? undefined,
            preview: p.preview ?? p.args_text ?? "",
          },
        ],
      ];
    case "tool.complete": {
      const preview = stringify(p.summary || p.result_text || p.result).slice(0, 2000);
      return [[looksFailed(p.result) ? "tool.failed" : "tool.completed", { tool_name: String(p.name ?? ""), tool_id: p.tool_id, preview }]];
    }
    case "approval.cancelled":
      return [["approval.cancelled", { request_ids: p.request_ids }]];
    case "request.cancel":
      return p.method === "approval" ? [["approval.cancelled", { rpc_id: p.id }]] : [];
    case "message.complete": {
      const content = typeof p.text === "string" ? p.text : stringify(p.text);
      const out: StreamEvent[] = [["assistant.completed", { content }]];
      if (p.status === "error") {
        out.push(["error", { message: String(p.error || p.failure_reason || p.warning || "El turno falló") }]);
      } else if (p.status === "interrupted") {
        out.push(["run.cancelled", {}]);
      } else {
        out.push(["run.completed", { usage: p.usage }]);
      }
      return out;
    }
    case "error":
      return [["error", { message: String(p.message ?? "Error del gateway") }]];
    default:
      // message.start, status.update, session.info, tool.generating, tool.progress, usage… : no card.
      return [];
  }
}

/** The approval card for a server→client `approval` request. */
export function approvalToStream(req: ServerRequest): StreamEvent {
  const p = req.params;
  return [
    "approval.request",
    {
      rpc_id: req.id,
      request_id: p.request_id,
      command: p.command,
      description: p.description || (p.tool_name ? `Herramienta: ${p.tool_name}` : ""),
      choices: Array.isArray(p.choices) && p.choices.length ? p.choices : ["once", "deny"],
    },
  ];
}
