import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { fixturesJson, fixturesPath } from "../src/fixtures";
import { parseClientMessage } from "../src/parse";

test("fixtures/protocol.json is what src/fixtures.ts generates, so tsc has checked every server fixture", async () => {
  expect(await Bun.file(fixturesPath).text()).toBe(fixturesJson());
});

test.each(fixtures.client.map((m) => [m.type, m] as const))("client fixture %s parses to itself", (_, message) => {
  expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message } as never);
});

test.each([
  ["not json", "{nope"],
  ["a non-object", "42"],
  ["an unknown type", { type: "explode" }],
  ["a prototype key as type", { type: "toString" }],
  ["a missing id", { type: "open" }],
  ["a wrong field type", { type: "delete_bot", botId: 7 }],
  ["an empty send", { type: "send", botId: "b1", text: "  ", uploads: [] }],
  ["a negative option", { type: "answer", botId: "b1", messageId: "m1", option: -1 }],
  ["a fractional option", { type: "answer", botId: "b1", messageId: "m1", option: 1.5 }],
  ["an unknown shape", { type: "update_bot", botId: "b1", patch: { avatar: { shape: "square", color: "red" } } }],
  ["a non-boolean pin", { type: "update_bot", botId: "b1", patch: { pinned: "yes" } }],
  ["a malformed upload", { type: "send", botId: "b1", text: "hi", uploads: [{ name: "a.png" }] }],
  ["a non-boolean routine toggle", { type: "set_routine", botId: "b1", routineId: "r1", enabled: 1 }],
])("rejects %s", (_, raw) => {
  expect(parseClientMessage(typeof raw === "string" ? raw : JSON.stringify(raw)).ok).toBe(false);
});

test("a send with only an upload is accepted", () => {
  const parsed = parseClientMessage(JSON.stringify({ type: "send", botId: "b1", text: "", uploads: [{ name: "a.png", mime: "image/png", data: "AA==" }] }));
  expect(parsed.ok).toBe(true);
});
