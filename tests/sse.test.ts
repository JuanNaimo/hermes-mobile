import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../src/lib/sse.ts";

test("parses frames split across chunks", () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: assistant.delta\ndata: {"del'), []);
  const frames = p.push('ta":"hi"}\n\n: keepalive\n\nevent: done\ndata: {}\n\n');
  assert.deepEqual(frames, [
    { event: "assistant.delta", data: '{"delta":"hi"}', id: undefined },
    { event: "done", data: "{}", id: undefined },
  ]);
});

test("handles CRLF, ids and multi-line data", () => {
  const p = new SseParser();
  const frames = p.push("id: 3\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n");
  assert.deepEqual(frames, [{ event: "x", data: "a\nb", id: "3" }]);
});

test("defaults event name and flushes a trailing frame", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: 1"), []);
  assert.deepEqual(p.end(), [{ event: "message", data: "1", id: undefined }]);
});
