import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStreamEvent, historyToItems, settle, type StreamState } from "../src/lib/transcript.ts";

function run(events: [string, Record<string, unknown>][]): StreamState {
  let s: StreamState = { items: [], finished: false };
  for (const [name, payload] of events) s = applyStreamEvent(s, name, payload);
  return settle(s);
}

test("streams text, tools and final answer into ordered segments", () => {
  const s = run([
    ["run.started", { run_id: "run_1" }],
    ["assistant.delta", { delta: "Let me " }],
    ["assistant.delta", { delta: "check." }],
    ["tool.started", { tool_name: "terminal", args: { command: "ls" } }],
    ["tool.completed", { tool_name: "terminal", preview: "a.txt" }],
    ["assistant.delta", { delta: "Found a.txt" }],
    ["assistant.completed", { content: "Found a.txt" }],
    ["run.completed", {}],
    ["done", {}],
  ]);
  assert.equal(s.runId, "run_1");
  assert.deepEqual(
    s.items.map((i) => [i.kind, i.kind === "assistant" ? i.text : i.kind === "tool" ? i.status : ""]),
    [
      ["assistant", "Let me check."],
      ["tool", "done"],
      ["assistant", "Found a.txt"],
    ],
  );
});

test("final content without deltas becomes an assistant message", () => {
  const s = run([["assistant.completed", { content: "hola" }], ["done", {}]]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind === "assistant" && s.items[0].text, "hola");
});

test("does not duplicate a final answer already streamed before a closed segment", () => {
  const s = run([
    ["assistant.delta", { delta: "done" }],
    ["assistant.commentary", { text: "note", already_streamed: false }],
    ["assistant.completed", { content: "done" }],
  ]);
  assert.equal(s.items.filter((i) => i.kind === "assistant" && i.text === "done").length, 1);
});

test("errors and approvals surface as items", () => {
  const s = run([
    ["run.started", { run_id: "run_2" }],
    ["approval.request", { run_id: "run_2", command: "rm -rf x", choices: ["once", "deny"], request_id: "p1" }],
    ["error", { message: "boom" }],
  ]);
  const ap = s.items.find((i) => i.kind === "approval");
  assert.ok(ap && ap.kind === "approval" && ap.requestId === "p1" && ap.runId === "run_2");
  assert.ok(s.items.some((i) => i.kind === "notice" && i.text === "boom"));
});

test("history pairs tool results with their calls", () => {
  const items = historyToItems([
    { id: 1, role: "user", content: "hi" },
    {
      id: 2,
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"x"}' } }],
    },
    { id: 3, role: "tool", content: "contents", tool_call_id: "c1" },
    { id: 4, role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["user", "tool", "assistant"],
  );
  const tool = items[1];
  assert.ok(tool.kind === "tool" && tool.result === "contents" && tool.args.includes('"path": "x"'));
});

test("@file: refs at the start of a user message become file chips", async () => {
  const { splitFileRefs, historyToItems } = await import("../src/lib/transcript.ts");
  assert.deepEqual(splitFileRefs('@file:attachments/informe.pdf\n@file:"attachments/mis notas.txt"\n\nresumilos'), {
    text: "resumilos",
    files: ["informe.pdf", "mis notas.txt"],
    refs: ["@file:attachments/informe.pdf", '@file:"attachments/mis notas.txt"'],
  });
  // Only leading lines count: a ref quoted mid-message is the person's text.
  assert.deepEqual(splitFileRefs("mirá @file:x.txt").files, []);
  const [item] = historyToItems([{ id: 7, role: "user", content: "@file:attachments/a.csv" }]);
  assert.ok(item.kind === "user" && item.text === "" && item.files?.[0] === "a.csv" && item.fileRefs?.[0] === "@file:attachments/a.csv");
});

test("the status line says what the running turn is doing", async () => {
  const { describeActivity } = await import("../src/lib/activity.ts");
  const user = { kind: "user" as const, key: "u", text: "hola", images: [] };
  assert.equal(describeActivity([user]), "Trabajando…");
  assert.equal(describeActivity([user, { kind: "assistant", key: "a", text: "", reasoning: "mmm", streaming: true }]), "Pensando…");
  assert.equal(describeActivity([user, { kind: "assistant", key: "a", text: "Dale", reasoning: "", streaming: true }]), "Escribiendo…");
  const tool = { kind: "tool" as const, key: "t", name: "web_search", args: "", result: "", status: "running" as const };
  assert.equal(describeActivity([user, tool]), "Buscando en la web…");
  assert.equal(describeActivity([user, { ...tool, name: "mcp_github" }]), "Usando mcp_github…");
  const card = { kind: "input" as const, key: "i", rpcId: 1, method: "sudo" as const };
  assert.equal(describeActivity([user, tool, card]), "Esperando tu respuesta");
  assert.equal(describeActivity([user, tool], { kind: "compacting", text: "Resumiendo el contexto…" }), "Resumiendo el contexto…");
});

test("subagent events build a tree; late frames don't revive a finished child", async () => {
  const { applySubagentEvent, buildSubagentTree } = await import("../src/lib/subagents.ts");
  let list = applySubagentEvent([], "subagent.spawn_requested", { subagent_id: "a", goal: "padre", task_index: 0, task_count: 2 }, 1);
  list = applySubagentEvent(list, "subagent.start", { subagent_id: "a", goal: "padre" }, 2);
  list = applySubagentEvent(list, "subagent.start", { subagent_id: "b", parent_id: "a", goal: "hijo" }, 3);
  list = applySubagentEvent(list, "subagent.tool", { subagent_id: "b", tool_name: "web_search", tool_preview: "agentes" }, 4);
  assert.deepEqual([list[1].status, list[1].currentTool, list[1].detail], ["running", "web_search", "agentes"]);
  list = applySubagentEvent(list, "subagent.complete", { subagent_id: "b", status: "timeout", summary: "no llegó" }, 5);
  assert.equal(list[1].status, "failed");
  assert.equal(list[1].currentTool, undefined);
  list = applySubagentEvent(list, "subagent.progress", { subagent_id: "b", text: "tarde" }, 6);
  assert.equal(list[1].detail, "no llegó");
  // No ids (older emitters): batch + position.
  list = applySubagentEvent(list, "subagent.start", { goal: "viejo", delegation_id: "d", task_index: 1 }, 7);
  assert.equal(list[2].id, "d#1");
  const tree = buildSubagentTree(list);
  assert.deepEqual(tree.map((n) => [n.id, n.children.map((c) => c.id)]), [["a", ["b"]], ["d#1", []]]);
});
