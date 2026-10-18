import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { fixturesJson, fixturesPath } from "../scripts/fixtures";
import { parseClientMessage } from "../src/parse";

test("fixtures/protocol.json is what scripts/fixtures.ts generates, so tsc has checked every server fixture", async () => {
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
  ["a permission choice the bridge does not know", { type: "decide", botId: "b1", messageId: "m8", choice: "maybe" }],
  ["a decide without a card", { type: "decide", botId: "b1", choice: "once" }],
  ["a stop without a bot", { type: "stop" }],
  ["a stop_agent without an agent", { type: "stop_agent", botId: "b1" }],
  ["a run_routine without a routine", { type: "run_routine", botId: "b1" }],
  ["a revoke_device without a device", { type: "revoke_device", deviceId: "" }],
  ["a negative daily cap", { type: "update_bot", botId: "b1", patch: { dailyCapUsd: -1 } }],
  ["a daily cap that is not a number", { type: "update_bot", botId: "b1", patch: { dailyCapUsd: "10" } }],
  ["an empty clientId", { type: "send", botId: "b1", text: "hi", uploads: [], clientId: "" }],
  ["a mute that is not a boolean", { type: "update_bot", botId: "b1", patch: { muted: 1 } }],
  ["a set_fact with a numeric fact id", { type: "set_fact", factId: 3, text: "x" }],
  ["a set_fact with no text", { type: "set_fact", factId: null, text: "" }],
  ["a forget_fact with a null fact id", { type: "forget_fact", factId: null }],
  ["a confirm_fact with no fact id", { type: "confirm_fact" }],
  ["a set_connector without enabled", { type: "set_connector", botId: "b1", name: "slack" }],
  ["a delete_skill without a name", { type: "delete_skill", botId: "b1" }],
  ["a webhook_token without a routine", { type: "webhook_token", botId: "b1" }],
  ["a remove_worktree without an agent", { type: "remove_worktree" }],
  ["eleven mentions", { type: "send", botId: "b1", text: "hi", uploads: [], mentions: Array.from({ length: 11 }, () => ({ kind: "connector", name: "github" })) }],
  ["a mention of an unknown kind", { type: "send", botId: "b1", text: "hi", uploads: [], mentions: [{ kind: "agent", name: "x" }] }],
  ["a bot mention without an id", { type: "send", botId: "b1", text: "hi", uploads: [], mentions: [{ kind: "bot", name: "engineer" }] }],
  ["a mention with an empty name", { type: "send", botId: "b1", text: "hi", uploads: [], mentions: [{ kind: "connector", name: "" }] }],
  ["a mention name over 64 characters", { type: "send", botId: "b1", text: "hi", uploads: [], mentions: [{ kind: "connector", name: "x".repeat(65) }] }],
  ["a group of one", { type: "create_group", ref: "c2", name: "crew", members: ["b1"] }],
  ["a group of nine", { type: "create_group", ref: "c2", name: "crew", members: Array.from({ length: 9 }, (_, i) => `b${i}`) }],
  ["a group naming a bot twice", { type: "create_group", ref: "c2", name: "crew", members: ["b1", "b1"] }],
  ["a group with a blank name", { type: "create_group", ref: "c2", name: "   ", members: ["b1", "b2"] }],
  ["a group name over the bot name limit", { type: "create_group", ref: "c2", name: "x".repeat(41), members: ["b1", "b2"] }],
  ["a group member that is not a string", { type: "create_group", ref: "c2", name: "crew", members: ["b1", 2] }],
  ["a members patch of one bot", { type: "update_bot", botId: "g1", patch: { members: ["b1"] } }],
])("rejects %s", (_, raw) => {
  expect(parseClientMessage(typeof raw === "string" ? raw : JSON.stringify(raw)).ok).toBe(false);
});

test("a send with only an upload is accepted", () => {
  const parsed = parseClientMessage(JSON.stringify({ type: "send", botId: "b1", text: "", uploads: [{ name: "a.png", mime: "image/png", data: "AA==" }] }));
  expect(parsed.ok).toBe(true);
});

test("a group name is trimmed", () => {
  const parsed = parseClientMessage(JSON.stringify({ type: "create_group", ref: "c2", name: "  crew ", members: ["b1", "b2"] }));
  expect(parsed).toEqual({ ok: true, message: { type: "create_group", ref: "c2", name: "crew", members: ["b1", "b2"] } } as never);
});

test("a daily cap of null goes back to the bridge default", () => {
  const parsed = parseClientMessage(JSON.stringify({ type: "update_bot", botId: "b1", patch: { dailyCapUsd: null } }));
  expect(parsed).toEqual({ ok: true, message: { type: "update_bot", botId: "b1", patch: { dailyCapUsd: null } } } as never);
});
