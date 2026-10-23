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
