import type { PermissionMode as SdkPermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { fixturesJson, fixturesPath } from "../scripts/fixtures";
import { parseClientMessage } from "../src/parse";
import { PERMISSION_MODES, type PermissionMode } from "../src/protocol";

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
  ["a watch_session without a session", { type: "watch_session", after: null }],
  ["a watch_session that leaves after out", { type: "watch_session", sessionId: "s1" }],
  ["a watch_session at a negative rev", { type: "watch_session", sessionId: "s1", after: { epoch: "e_1", rev: -1 } }],
  ["a watch_session with an empty epoch", { type: "watch_session", sessionId: "s1", after: { epoch: "", rev: 3 } }],
  ["an unwatch_session without a session", { type: "unwatch_session" }],
  ["a session_page without a cursor", { type: "session_page", sessionId: "s1" }],
  ["a blank session_send", { type: "session_send", sessionId: "s1", text: " \n ", clientId: "c1", interrupt: false }],
  ["a session_send without a clientId", { type: "session_send", sessionId: "s1", text: "hi", interrupt: false }],
  ["a session_send whose interrupt is not a boolean", { type: "session_send", sessionId: "s1", text: "hi", clientId: "c1", interrupt: "yes" }],
  ["a session_stop without a session", { type: "session_stop" }],
  ["a session_stop with a target the bridge does not know", { type: "session_stop", sessionId: "s1", target: "everything" }],
  ["a session_stop aimed at a task without an id", { type: "session_stop", sessionId: "s1", target: { task: "" } }],
  ["a session_stop whose turnStartedAt is not a string", { type: "session_stop", sessionId: "s1", turnStartedAt: 3 }],
  ["a session_unqueue without a clientId", { type: "session_unqueue", sessionId: "s1" }],
  ["a session_decide with an unknown choice", { type: "session_decide", sessionId: "s1", cardId: "m1", choice: "approve" }],
  ["a session_decide without a card", { type: "session_decide", sessionId: "s1", choice: "once" }],
  ["a session_answer with no answers", { type: "session_answer", sessionId: "s1", cardId: "m1", answers: {} }],
  ["a session_answer that leaves answers out", { type: "session_answer", sessionId: "s1", cardId: "m1" }],
  ["a session_answer with a non-string answer", { type: "session_answer", sessionId: "s1", cardId: "m1", answers: { "Which?": 2 } }],
  ["a session_answer to five questions", { type: "session_answer", sessionId: "s1", cardId: "m1", answers: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i}?`, "a"])) }],
  ["a session_create in bypassPermissions", { type: "session_create", ref: "s1", projectId: "p1", text: "hi", model: null, mode: "bypassPermissions", isolate: "none" }],
  ["a session_create with an unknown isolate", { type: "session_create", ref: "s1", projectId: "p1", text: "hi", model: null, mode: null, isolate: "clone" }],
  ["a blank session_create", { type: "session_create", ref: "s1", projectId: "p1", text: "", model: null, mode: null, isolate: "none" }],
  ["a session_create without a project", { type: "session_create", ref: "s1", text: "hi", model: null, mode: null, isolate: "none" }],
  ["a session_set to bypassPermissions", { type: "session_set", sessionId: "s1", patch: { mode: "bypassPermissions" } }],
  ["a session_set with a blank title", { type: "session_set", sessionId: "s1", patch: { title: "  " } }],
  ["a session_set whose hidden is not a boolean", { type: "session_set", sessionId: "s1", patch: { hidden: 1 } }],
  ["a session_open_desktop without a session", { type: "session_open_desktop" }],
  ["a session_tool without a tool call", { type: "session_tool", sessionId: "s1" }],
  ["a session_prefs with a mirror the bridge does not know", { type: "session_prefs", mirror: "ask" }],
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

test("PERMISSION_MODES names exactly the SDK's permission modes", () => {
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const same: Same<PermissionMode, SdkPermissionMode> = true;
  expect(same).toBe(true);
  expect(new Set(PERMISSION_MODES).size).toBe(PERMISSION_MODES.length);
});
