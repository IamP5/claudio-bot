import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, RoutineId, RunId } from "../src/protocol";
import { createSession, WAKE_WAIT_MS, type TurnEnd } from "../src/session";
import { emptySession, type Initiator } from "../src/world";
import { flush } from "./hub-kit";
import { player, replay, type Transcript } from "./transcript";

// Real Claude Code sessions (test/transcripts, recorded by scripts/record-transcript.ts) played through createSession.

const IDLE_MS = 15 * 60_000;
const SCENARIOS = ["background-wake-after-prompt", "background-wake-before-prompt", "ask-rule-prompt"];

const textOf = (m: SDKMessage) =>
  m.type === "assistant"
    ? m.message.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
    : "";
const recorded = (t: Transcript) => t.segments.flat();
const results = (t: Transcript) => recorded(t).filter((m): m is SDKResultMessage => m.type === "result");
const echoes = (m: SDKResultMessage) => m.user_message_uuids ?? (m.user_message_uuid === undefined ? [] : [m.user_message_uuid]);
/** The recorded result Claude Code bound to send `i`. */
const answerTo = (t: Transcript, i: number) => results(t).find((r) => echoes(r).includes(t.outbound[i]!.uuid!))!;
/** The recorded result of the turn a background task woke. */
const wakeOf = (t: Transcript) => results(t).find((r) => r.origin?.kind === "task-notification")!;
const said = (r: SDKResultMessage) => (r.subtype === "success" ? r.result : r.errors.join("\n"));

function sessionOver(t: Transcript) {
  const p = player(t);
  const clock = { t: Date.parse("2026-10-17T12:00:00.000Z") };
  const state = emptySession();
  const ends: { text: string; end: TurnEnd }[] = [];
  const bound: { m: SDKMessage; turn: string | null }[] = [];
  const usage: { usd: number; initiator: Initiator["kind"] }[] = [];
  const session = createSession({
    actor: { kind: "bot", botId: "b_1" as BotId },
    state,
    account: { parkedUntil: null },
    options: () => ({ cwd: "/bots/b_1", resume: state.id ?? undefined }),
    ledger: {
      add: (row) => void usage.push({ usd: row.cumulativeUsd, initiator: row.initiator.kind }),
      headroom: () => ({ ok: true, capReached: false }),
      budgetLeft: () => 5,
      dailyLeft: () => 10,
    },
    onMessage: (m, turn) => bound.push({ m, turn: turn?.text ?? null }),
    onTurnEnd: (pending, end) => ends.push({ text: pending.text, end }),
    onChange: () => {},
    note: () => {},
    persist: () => {},
    log: () => {},
    query: p.query,
    executable: () => "/fake/claude",
    now: () => new Date(clock.t),
  });
  const send = async (i: number) => {
    session.push({ kind: "envelope", text: t.outbound[i]!.message.content as string, initiator: { kind: "user" }, settles: null });
    await flush();
    await flush();
  };
  const finals = (i: number) => ends.filter((e) => e.text === t.outbound[i]!.message.content && e.end.kind !== "deferred");
  return { session, state, clock, ends, bound, usage, send, finals, player: p };
}

async function playAll(t: Transcript) {
  const h = sessionOver(t);
  await flush();
  for (let i = 0; i < t.outbound.length; i++) await h.send(i);
  return h;
}

describe.each(SCENARIOS)("%s", (scenario) => {
  test("every recorded frame reaches the session, and each turn ends done with the result Claude Code bound to it", async () => {
    const t = replay(scenario);
    const h = await playAll(t);
    h.player.done();
    for (let i = 0; i < t.outbound.length; i++) {
      expect(h.finals(i).map((e) => (e.end.kind === "done" ? said(e.end.result) : e.end.kind))).toEqual([said(answerTo(t, i))]);
    }
  });
});

describe("a background task's wake turn, recorded", () => {
  test("after the prompt: idle close waits while the task runs, and the wake's cost is the system's", async () => {
    const t = replay("background-wake-after-prompt");
    const h = sessionOver(t);
    await flush();
    await h.send(0);
    expect(h.finals(0)).toHaveLength(1);
    expect(h.state.background?.map((b) => b.description)).toEqual(["Run sleep 8 then echo BG-DONE in background"]);
    expect(h.session.nextDeadline()).toBeNull();
    await h.send(1);
    h.player.done();
    expect(h.finals(1).map((e) => e.end.kind === "done" && said(e.end.result))).toEqual(["4"]);
    expect(h.state.background).toBeUndefined();
    expect(h.session.nextDeadline()).toBe(new Date(h.clock.t + IDLE_MS).toISOString());
    expect(h.bound.filter((b) => b.m.type === "assistant" && textOf(b.m) !== "").map((b) => [textOf(b.m) === "4" || textOf(b.m) === "STARTED", b.turn !== null])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    expect(h.usage).toEqual([
      { usd: answerTo(t, 0).total_cost_usd, initiator: "user" },
      { usd: answerTo(t, 1).total_cost_usd, initiator: "user" },
      { usd: wakeOf(t).total_cost_usd, initiator: "system" },
    ]);
    h.clock.t += IDLE_MS;
    h.session.tick(new Date(h.clock.t));
    expect(h.player.q()!.closed).toBe(true);
  });

  test("before the prompt: the wake runs first, its result does not end the user's turn, and its cost is the system's", async () => {
    const t = replay("background-wake-before-prompt");
    const h = await playAll(t);
    h.player.done();
    const second = t.outbound[1]!.message.content as string;
    expect(h.ends.filter((e) => e.text === second).map((e) => e.end.kind === "done" && said(e.end.result))).toEqual(["4"]);
    expect(results(t).map((r) => r === wakeOf(t))).toEqual([false, true, false]);
    expect(h.usage).toEqual([
      { usd: answerTo(t, 0).total_cost_usd, initiator: "user" },
      { usd: wakeOf(t).total_cost_usd, initiator: "system" },
      { usd: answerTo(t, 1).total_cost_usd, initiator: "user" },
    ]);
  });

  // Claude Code stamps only a turn's first assistant message with the uuids it consumed, and stamps none on a wake
  // turn's, so session.answers() binds the wake's text to the user's turn queued behind it. The wake turn's
  // system/init carries no echo while every user turn's does: that is the frame that tells them apart.
  test("before the prompt: the wake turn's assistant text is not bound to the user's queued turn", async () => {
    const t = replay("background-wake-before-prompt");
    const h = await playAll(t);
    const second = t.outbound[1]!.message.content as string;
    const toSecond = h.bound.filter((b) => b.turn === second && b.m.type === "assistant").map((b) => textOf(b.m)).filter((s) => s !== "");
    expect(toSecond).toEqual(["4"]);
  });
});

describe("handing a session over to a new query, recorded", () => {
  const routine: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_1" as RunId }, manual: false };

  test("a routine held behind background work waits out the wake turn, then resumes the session on a query whose total continues", async () => {
    const t = replay("background-wake-handoff");
    const h = sessionOver(t);
    await flush();
    h.session.push({ kind: "envelope", text: t.outbound[0]!.message.content as string, initiator: { kind: "user" }, settles: null });
    h.session.push({ kind: "envelope", text: t.outbound[1]!.message.content as string, initiator: routine, settles: null });
    for (let i = 0; i < 4; i++) await flush();
    h.player.done();
    expect([0, 1].map((i) => h.finals(i).map((e) => (e.end.kind === "done" ? said(e.end.result) : e.end.kind)))).toEqual([[said(answerTo(t, 0))], ["4"]]);
    expect(h.usage).toEqual([
      { usd: answerTo(t, 0).total_cost_usd, initiator: "user" },
      { usd: wakeOf(t).total_cost_usd, initiator: "system" },
      { usd: answerTo(t, 1).total_cost_usd, initiator: "routine" },
    ]);
    expect(answerTo(t, 1).total_cost_usd).toBeGreaterThan(wakeOf(t).total_cost_usd);
    expect(h.bound.filter((b) => b.m.type === "assistant" && textOf(b.m).startsWith("The background command")).map((b) => b.turn)).toEqual([null]);
  });

  test("Claude Code starts the wake turn well inside WAKE_WAIT_MS of the notification that announces it", () => {
    const t = replay("background-wake-handoff");
    const frames = recorded(t);
    const notified = frames.findIndex((m) => m.type === "system" && m.subtype === "task_notification");
    const init = frames.slice(notified).find((m) => m.type === "system" && m.subtype === "init")!;
    expect(t.at.get(init)! - t.at.get(frames[notified]!)!).toBeLessThan(WAKE_WAIT_MS / 100);
  });
});

describe("a permissions.ask rule under auto mode, recorded", () => {
  test("Claude Code asks canUseTool once, with the call and a rule reason but no title, and the deny reaches the model", () => {
    const t = replay("ask-rule-prompt");
    expect(t.prompts).toHaveLength(1);
    const [call] = t.prompts;
    expect(call!.tool).toBe("Bash");
    expect(call!.input.command).toBe("echo ASKME hello");
    expect(call!.options).toMatchObject({ decisionReasonType: "rule", displayName: "Bash", toolUseID: expect.stringMatching(/^toolu_/) });
    expect(Object.keys(call!.options).filter((k) => ["title", "decisionReason", "blockedPath", "suggestions"].includes(k))).toEqual([]);
    const denied = recorded(t).find((m) => m.type === "user" && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result"));
    expect(denied).toMatchObject({ message: { content: [{ type: "tool_result", is_error: true, content: "held for approval", tool_use_id: call!.options.toolUseID }] } });
    expect(answerTo(t, 0)).toMatchObject({ permission_denials: [{ tool_name: "Bash", tool_use_id: call!.options.toolUseID }] });
  });
});
