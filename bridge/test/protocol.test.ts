import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { parseClientMessage } from "../src/parse";

test.each(fixtures.client.map((m) => [m.type, m] as const))("fixture %s parses to itself", (_, message) => {
  expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message } as never);
});

test.each([
  ["not json", "{nope"],
  ["a non-object", "42"],
  ["an unknown type", { type: "explode" }],
  ["a missing field", { type: "send", taskId: "t1" }],
  ["a wrong field type", { type: "stop", taskId: 7 }],
  ["an unknown decision", { type: "decide", taskId: "t1", itemId: "i1", decision: "maybe" }],
  ["an unknown target kind", { type: "create", prompt: "x", target: { kind: "mars", projectId: "p" }, model: "opus", permissionMode: "default" }],
  ["an unknown permission mode", { type: "create", prompt: "x", target: { kind: "local", projectId: "p" }, model: "opus", permissionMode: "yolo" }],
  ["non-string answers", { type: "answer", taskId: "t1", itemId: "i1", answers: { q: 1 } }],
  ["a prototype key as type", { type: "toString" }],
])("rejects %s", (_, raw) => {
  expect(parseClientMessage(typeof raw === "string" ? raw : JSON.stringify(raw)).ok).toBe(false);
});
