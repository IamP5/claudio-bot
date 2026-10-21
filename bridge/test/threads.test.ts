import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { activityOf } from "../src/activity";
import type { ItemId, ServerMessage, SessionId, SessionItem, ThreadChannelFrame } from "../src/protocol";
import { createThreads, DELTA_COALESCE_MS } from "../src/threads";

// The streaming text of the bridge's own query: deltas coalesced per item, offsets that fit the app's live text, and a
// live seed for whoever opens the thread mid-block.

const ID = "s1" as SessionId;
const ORDER = "s2" as SessionId;
const frames: ThreadChannelFrame[] = [];
let overlay: SessionItem[] = [];
const threads = createThreads({
  epoch: "e1",
  transcript: () => null,
  context: () => ({ cwd: "/x", userName: "Alex", agent: false }),
  overlay: (id) => (id === ORDER ? overlay : []),
  steps: () => new Map(),
  cuts: () => [],
  controls: () => ({ canSend: true, reason: null, working: true, queued: 0, model: null, models: [], mode: "default", modes: [] }),
  publish: (_, f) => frames.push(structuredClone(f)),
  watched: () => true,
  now: () => new Date(),
  log: () => {},
});

const ev = (event: object, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: ID }) as unknown as SDKMessage;
const start = (id: string) => ev({ type: "message_start", message: { id } });
const block = (index: number, type: string) => ev({ type: "content_block_start", index, content_block: { type } });
const text = (index: number, t: string) => ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
const thinking = (index: number, t: string) => ev({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } });
const stop = (index: number) => ev({ type: "content_block_stop", index });
const wait = () => Bun.sleep(DELTA_COALESCE_MS + 30);
const deltas = (): object[] => frames.splice(0).filter((f) => f.type === "session_delta");

test("text streams as coalesced deltas whose offsets follow on; thinking, tool input and subagents stream nothing", async () => {
  const first = (await threads.watch(ID, null))[0] as Extract<ServerMessage, { type: "session" }>;
  expect(first.live).toBeNull();
  for (const m of [start("msg_1"), block(0, "thinking"), thinking(0, "hmm"), stop(0), block(1, "text"), text(1, "Hel"), text(1, "lo")]) threads.stream(ID, m);
  threads.stream(ID, text(0, "into a block that ended"));
  threads.stream(ID, ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ignored" } }, "toolu_task"));
  await wait();
  expect(deltas()).toEqual([{ type: "session_delta", sessionId: ID, itemId: "msg_1:1", offset: 0, text: "Hello" }]);
  threads.stream(ID, text(1, " wor"));
  threads.stream(ID, text(1, "ld"));
  await wait();
  expect(deltas()).toEqual([{ type: "session_delta", sessionId: ID, itemId: "msg_1:1", offset: 5, text: " world" }]);

  const late = (await threads.watch(ID, null))[0] as Extract<ServerMessage, { type: "session" }>;
  expect(late.live).toEqual({ itemId: "msg_1:1" as never, text: "Hello world" });
  const resumed = await threads.watch(ID, { epoch: late.epoch, rev: late.rev });
  expect(resumed.at(-1) as object).toEqual({ type: "session_delta", sessionId: ID, itemId: "msg_1:1", offset: 0, text: "Hello world" });

  threads.stream(ID, text(1, "!"));
  threads.stream(ID, stop(1));
  expect(deltas()).toEqual([{ type: "session_delta", sessionId: ID, itemId: "msg_1:1", offset: 11, text: "!" }]);
  for (const m of [block(2, "tool_use"), ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } }), stop(2)]) threads.stream(ID, m);
  await wait();
  expect(deltas()).toEqual([]);
});

test("a thread lists the bridge's items by their time, and a message Claude Code has not taken yet after everything", async () => {
  const at = (s: number) => `2026-10-21T10:00:0${s}.000Z`;
  const card = { id: "m_card", kind: "permission", tool: "Bash", title: "Run", detail: "ls", answer: "once", at: at(2), expiresAt: at(9), suggestions: [] };
  overlay = [
    { kind: "notice", id: "n_late" as ItemId, at: at(5), text: "Stopped by you.", tone: "info", reason: "stop" },
    { kind: "user", id: "c_queued" as ItemId, at: at(1), text: "Then this", from: "user", queued: true },
    { kind: "permission", id: "m_card" as ItemId, at: at(2), card } as unknown as SessionItem,
    { kind: "user", id: "c_sent" as ItemId, at: at(0), text: "Do it", from: "user", queued: false },
    { kind: "notice", id: "n_same" as ItemId, at: at(5), text: "Same moment, listed second.", tone: "info" },
  ];
  const snap = (await threads.watch(ORDER, null))[0] as Extract<ServerMessage, { type: "session" }>;
  expect(snap.items.map((i) => i.id)).toEqual(["c_sent", "m_card", "n_late", "n_same", "c_queued"] as ItemId[]);
});

test("a watch's reply goes out before any later frame of its thread, however the thread's own work interleaves with it", async () => {
  const at = () => new Date().toISOString();
  overlay = [];
  await threads.watch(ORDER, null);
  for (let ticks = 0; ticks < 30; ticks++) {
    frames.length = 0;
    const newerFirst = threads.watch(ORDER, null).then((r) => {
      const rev = (r[0] as Extract<ServerMessage, { type: "session" }>).rev;
      return frames.filter((f) => f.type === "session_items" && f.rev > rev).length;
    });
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    overlay = [...overlay, { kind: "notice", id: `n${ticks}` as ItemId, at: at(), text: "x", tone: "info" }];
    threads.refresh(ORDER);
    expect(await newerFirst).toBe(0);
    await Bun.sleep(1);
  }
});

test("the activity line and turn output read assistant messages only, never a stream event", () => {
  expect(activityOf(text(0, "Running tests"))).toBeNull();
  expect(activityOf(block(0, "tool_use"))).toBeNull();
});
