import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate, failClosed, toCall, toHookOutput, type AuditRow, type GateDeps } from "../src/gate";
import { flushNow, loadWorld } from "../src/store";
import type { Agent, AgentId, BotId, Message, MessageId, RoutineId, RunId } from "../src/protocol";
import type { Envelope } from "../src/prompts";
import { botActor, emptySession, emptyWorld, newBot, post, type Actor, type DailyCount, type GateState, type Initiator, type StandingRule } from "../src/world";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const START = new Date("2026-10-17T12:00:00.000Z");
const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_1" as RunId }, manual: false };
const B1 = "b_1" as BotId;
const A1 = "a_1" as AgentId;

type Persisted = { urgency: "now" | undefined; open: number; grants: number; rules: number; auditRows: number };

function setup(opts: { bridgeName?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-gate-")));
  roots.push(root);
  const bridge = join(root, opts.bridgeName ?? ".claudiobot");
  const own = join(bridge, "bots", "b_1");
  mkdirSync(own, { recursive: true });
  const world = emptyWorld();
  const bot = newBot({ id: B1, name: "Claudio", avatar: { shape: "circle", color: "white" }, at: START.toISOString() });
  world.bots.set(B1, bot);
  const auditDir = join(bridge, "audit");
  const auditRows = (): AuditRow[] =>
    existsSync(auditDir)
      ? readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRow))
      : [];
  let clock = START;
  const turn = { initiator: user as Initiator, stopping: false };
  const events: string[] = [];
  const delivered: { actor: Actor; e: Envelope }[] = [];
  const noticed: { actor: Actor; text: string }[] = [];
  const notified: { reason: string; id: MessageId }[] = [];
  const persisted: Persisted[] = [];
  const logged: string[] = [];
  let denials = 0;
  const deps: GateDeps = {
    world,
    scopeOf: (actor) =>
      actor.kind === "bot"
        ? { bridgeHome: realpathSync(bridge), own: realpathSync(own), userMd: join(realpathSync(bridge), "USER.md"), homedir: root }
        : { bridgeHome: realpathSync(bridge), own: root, userMd: null, homedir: root },
    turnOf: () => turn,
    headroom: () => ({ ok: true, capReached: false }),
    say: (b, m) => {
      post(b, m);
    },
    deliver: (actor, e) => {
      events.push("deliver");
      delivered.push({ actor, e });
    },
    notice: (actor, text) => noticed.push({ actor, text }),
    denied: () => {
      denials++;
    },
    notify: (_, reason, id) => {
      events.push(`notify:${reason}`);
      notified.push({ reason, id });
    },
    persist: (urgency) => {
      events.push(`persist:${urgency ?? "later"}`);
      persisted.push({ urgency, open: world.gate.open.length, grants: world.gate.grants.length, rules: bot.rules.length, auditRows: auditRows().length });
    },
    auditDir,
    userName: "Alex",
    now: () => clock,
    log: (line) => logged.push(line),
  };
  const gate = createGate(deps);
  let n = 0;
  const input = (tool: string, toolInput: unknown, over: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput => ({
    hook_event_name: "PreToolUse",
    session_id: "s_1",
    transcript_path: "/tmp/t.jsonl",
    cwd: own,
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: `toolu_${++n}`,
    ...over,
  });
  const fire = (i: PreToolUseHookInput, actor: Actor = botActor(B1)) =>
    gate.hooks(actor).PreToolUse![0]!.hooks[0]!(i, i.tool_use_id, { signal: new AbortController().signal });
  const call = (tool: string, toolInput: unknown, over: Partial<PreToolUseHookInput> = {}, actor?: Actor) => fire(input(tool, toolInput, over), actor);
  const bash = (command: string, actor?: Actor) => call("Bash", { command, description: "run" }, {}, actor);
  const cards = () => bot.messages.filter((m): m is Extract<Message, { kind: "permission" }> => m.kind === "permission");
  return {
    gate,
    deps,
    world,
    bot,
    root,
    bridge,
    own,
    turn,
    events,
    delivered,
    noticed,
    notified,
    persisted,
    logged,
    denials: () => denials,
    auditRows,
    input,
    fire,
    call,
    bash,
    cards,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
      return clock;
    },
    now: () => clock,
  };
}

const decisionOf = (out: HookJSONOutput) => {
  const s = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
  return s?.hookEventName === "PreToolUse" ? (s.permissionDecision ?? "none") : "pass";
};
const reasonOf = (out: HookJSONOutput) => {
  const s = "hookSpecificOutput" in out ? out.hookSpecificOutput : undefined;
  return s?.hookEventName === "PreToolUse" ? (s.permissionDecisionReason ?? "") : "";
};
const gateState = (world: { gate: unknown }) => world.gate as GateState;

describe("the permission flow", () => {
  test("ask posts a card, Allow once lets the exact call run once, and the next identical call asks again", async () => {
    const t = setup();
    t.turn.initiator = routine;
    const held = await t.bash("git push origin feature");
    expect(decisionOf(held)).toBe("deny");
    const [card] = t.cards();
    expect(card).toMatchObject({
      tool: "Bash",
      label: "Push a branch",
      detail: "git push origin feature",
      always: "Push a branch, without asking, in any turn, routines included",
      answer: null,
      from: null,
      expiresAt: new Date(START.getTime() + 2 * 3600_000).toISOString(),
    });
    expect(reasonOf(held)).toContain(`card ${card!.id}`);
    expect(reasonOf(held)).toContain("It has not run");
    expect(reasonOf(held)).toContain("End your turn now");
    expect(t.notified).toEqual([{ reason: "card", id: card!.id }]);
    expect(t.denials()).toBe(1);

    expect(t.gate.answer(B1, card!.id, { kind: "permission", choice: "once" })).toEqual({ ok: true });
    expect(t.cards()[0]!.answer).toBe("once");
    expect(gateState(t.world).grants).toHaveLength(1);
    expect(gateState(t.world).grants[0]!.expiresAt).toBe(new Date(START.getTime() + 10 * 60_000).toISOString());
    expect(t.delivered).toEqual([
      { actor: botActor(B1), e: { from: "decision", choice: "once", tool: "Bash", detail: "git push origin feature", initiator: routine } },
    ]);

    const rerun = await t.bash("git push origin feature");
    expect(decisionOf(rerun)).toBe("allow");
    expect(gateState(t.world).grants).toHaveLength(0);

    const again = await t.bash("git push origin feature");
    expect(decisionOf(again)).toBe("deny");
    expect(t.cards()).toHaveLength(2);
    expect(t.cards()[1]!.answer).toBeNull();
  });

  test("state is flushed before the audit append whenever a card opens, a grant is used or a rule is added", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    expect(t.persisted.find((p) => p.urgency === "now")).toEqual({ urgency: "now", open: 1, grants: 0, rules: 0, auditRows: 0 });
    expect(t.auditRows()).toHaveLength(1);

    const cardId = t.cards()[0]!.id;
    t.events.length = 0;
    t.gate.answer(B1, cardId, { kind: "permission", choice: "always" });
    expect(t.events).toEqual(["persist:now", "deliver"]);
    expect(t.persisted.at(-1)).toMatchObject({ urgency: "now", open: 0, grants: 1, rules: 1 });

    const before = t.auditRows().length;
    await t.bash("git push origin feature");
    expect(t.persisted.at(-1)).toMatchObject({ urgency: "now", grants: 0, auditRows: before });
    expect(t.auditRows()).toHaveLength(before + 1);
    expect(t.auditRows().at(-1)).toMatchObject({ decision: "allow", via: "grant", cardId });
  });

  test("an identical call while its card is open gets 'already waiting' and no second card; only a tap creates a grant", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    const second = await t.bash("git push origin feature");
    const third = await t.bash("git push origin feature");
    const cardId = t.cards()[0]!.id;
    expect(t.cards()).toHaveLength(1);
    expect(reasonOf(second)).toContain("already waiting");
    expect(reasonOf(third)).toContain(`card ${cardId}`);
    expect(t.notified).toHaveLength(1);
    expect(t.denials()).toBe(3);
    expect(gateState(t.world).grants).toHaveLength(0);
  });

  test("a repeated tool_use_id gets the recorded verdict and records nothing new", async () => {
    const t = setup();
    t.turn.initiator = routine;
    const i = t.input("Bash", { command: "git push origin feature" });
    const first = await t.fire(i);
    const replay = await t.fire(i);
    expect(replay).toEqual(first);
    expect(t.cards()).toHaveLength(1);
    expect(t.auditRows()).toHaveLength(1);
    expect(t.denials()).toBe(1);

    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "once" });
    expect(decisionOf(await t.fire(i))).toBe("deny");
    expect(gateState(t.world).grants).toHaveLength(1);
  });

  test("the first answer wins", () => {
    const t = setup();
    t.turn.initiator = routine;
    return t.bash("git push origin feature").then(() => {
      const cardId = t.cards()[0]!.id;
      expect(t.gate.answer(B1, cardId, { kind: "permission", choice: "once" })).toEqual({ ok: true });
      expect(t.gate.answer(B1, cardId, { kind: "permission", choice: "always" })).toEqual({ ok: false, error: "That request was already answered" });
      expect(t.gate.answer(B1, cardId, { kind: "option", index: 0 })).toEqual({ ok: false, error: "Unknown question" });
      expect(gateState(t.world).grants).toHaveLength(1);
      expect(t.bot.rules).toHaveLength(0);
      expect(t.delivered).toHaveLength(1);
    });
  });

  test("Always from an unattended card covers every turn; the held call runs once on its grant", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "always" });
    expect(t.bot.rules).toEqual([
      { decision: "allow", appliesTo: "all", signature: "Bash:git.push", label: "Push a branch", cardId: t.cards()[0]!.id, at: START.toISOString() } as StandingRule,
    ]);
    expect(decisionOf(await t.bash("git push origin feature"))).toBe("allow");
    expect(decisionOf(await t.bash("git push origin other"))).toBe("allow");
    expect(t.auditRows().at(-1)).toMatchObject({ decision: "allow", via: "always", rule: "Bash:git.push" });
  });

  test("Always from an attended card does not cover routines", async () => {
    const t = setup();
    await t.bash("git push origin main");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "always" });
    expect(t.bot.rules[0]).toMatchObject({ decision: "allow", appliesTo: "attended", signature: "Bash:git.push.default" });
    expect(decisionOf(await t.bash("git push upstream main"))).toBe("allow");
    t.turn.initiator = routine;
    expect(decisionOf(await t.bash("git push fork main"))).toBe("deny");
    expect(t.cards()).toHaveLength(2);
  });

  test("Never stores a deny rule, so the next call of that kind is refused without a card", async () => {
    const t = setup();
    await t.bash("git push origin main");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "never" });
    expect(t.bot.rules[0]).toMatchObject({ decision: "deny", signature: "Bash:git.push.default" });
    expect(t.delivered.at(-1)!.e).toMatchObject({ from: "decision", choice: "never" });
    const denialsBefore = t.denials();
    const refused = await t.bash("git push upstream main");
    expect(decisionOf(refused)).toBe("deny");
    expect(reasonOf(refused)).toContain("said never");
    expect(t.cards()).toHaveLength(1);
    expect(t.denials()).toBe(denialsBefore + 1);
  });

  test("Deny tells the actor and stores nothing", async () => {
    const t = setup();
    await t.bash("git push origin main");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "deny" });
    expect(t.delivered.at(-1)!.e).toMatchObject({ from: "decision", choice: "deny", detail: "git push origin main", initiator: user });
    expect(t.bot.rules).toHaveLength(0);
    expect(gateState(t.world).grants).toHaveLength(0);
  });

  test("an agent's card shows in its bot's chat and the decision goes to the agent", async () => {
    const t = setup();
    const agent: Agent = { id: A1, botId: B1, title: "Fix login", where: "mac", projectName: "app", status: "working", url: null, createdAt: START.toISOString(), updatedAt: START.toISOString() };
    t.world.agents.set(A1, { agent, cwd: t.root, messages: [], session: emptySession(), cloudSession: null, budgetUsd: null });
    const actor: Actor = { kind: "agent", botId: B1, agentId: A1 };
    await t.call("Bash", { command: "npm publish" }, { cwd: t.root }, actor);
    expect(t.cards()[0]!.from).toEqual({ kind: "agent", id: A1, title: "Fix login" });
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "once" });
    expect(t.delivered[0]!.actor).toEqual(actor);
    expect(gateState(t.world).grants[0]!.actor).toBe(`agent:${A1}`);
    expect(decisionOf(await t.call("Bash", { command: "npm publish" }, { cwd: t.root }, actor))).toBe("allow");
  });
});

test("an open card and its held call survive a restart through the state file", async () => {
  const t = setup();
  t.turn.initiator = routine;
  await t.bash("git push origin feature");
  const cardId = t.cards()[0]!.id;
  flushNow(t.world, t.bridge);

  const { world } = loadWorld(t.bridge);
  const delivered: Envelope[] = [];
  const restarted = createGate({ ...t.deps, world, deliver: (_, e) => delivered.push(e), persist: () => {} });
  expect(restarted.answer(B1, cardId, { kind: "permission", choice: "once" })).toEqual({ ok: true });
  expect(delivered).toEqual([{ from: "decision", choice: "once", tool: "Bash", detail: "git push origin feature", initiator: routine }]);
  const out = await restarted.hooks(botActor(B1)).PreToolUse![0]!.hooks[0]!(t.input("Bash", { command: "git push origin feature" }), "toolu_r", {
    signal: new AbortController().signal,
  });
  expect(decisionOf(out)).toBe("allow");
});

describe("deadlines", () => {
  test("an unanswered card reminds once at half its life", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    const card = t.cards()[0]!;
    expect(t.gate.nextDeadline()).toBe(new Date(START.getTime() + 3600_000).toISOString());
    t.gate.tick(t.advance(3600_000 - 1));
    expect(t.notified.filter((x) => x.reason === "reminder")).toHaveLength(0);
    t.gate.tick(t.advance(1));
    t.gate.tick(t.advance(60_000));
    expect(t.notified.filter((x) => x.reason === "reminder")).toEqual([{ reason: "reminder", id: card.id }]);
    expect(t.gate.nextDeadline()).toBe(card.expiresAt);
  });

  test("an expired card says so, leaves a notice that it did not run, and spends no turn", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    const card = t.cards()[0]!;
    t.gate.tick(t.advance(2 * 3600_000));
    expect(t.cards()[0]!.answer).toBe("expired");
    expect(t.noticed).toHaveLength(1);
    expect(t.noticed[0]!.actor).toEqual(botActor(B1));
    expect(t.noticed[0]!.text).toContain("did not run");
    expect(t.noticed[0]!.text).toContain("Alex did not say no");
    expect(t.delivered).toHaveLength(0);
    expect(t.gate.nextDeadline()).toBeNull();
    t.gate.tick(t.advance(60_000));
    expect(t.noticed).toHaveLength(1);
    expect(t.gate.answer(B1, card.id, { kind: "permission", choice: "once" })).toEqual({ ok: false, error: "That request expired" });
    expect(gateState(t.world).grants).toHaveLength(0);
  });

  test("a sleep past both deadlines expires without reminding", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    t.gate.tick(t.advance(5 * 3600_000));
    expect(t.notified.filter((x) => x.reason === "reminder")).toHaveLength(0);
    expect(t.cards()[0]!.answer).toBe("expired");
  });

  test("an unused grant lapses after ten minutes", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "once" });
    expect(t.gate.nextDeadline()).toBe(new Date(START.getTime() + 10 * 60_000).toISOString());
    t.gate.tick(t.advance(10 * 60_000));
    expect(gateState(t.world).grants).toHaveLength(0);
    expect(decisionOf(await t.bash("git push origin feature"))).toBe("deny");
  });
});

describe("question cards", () => {
  test("ask posts an expiring card, an identical open question waits, and an answer is delivered", () => {
    const t = setup();
    expect(t.gate.ask(B1, { question: "Which repo?", options: ["web", "ios"] })).toContain("Card posted");
    expect(t.gate.ask(B1, { question: "Which repo?", options: ["web", "ios", "both"] })).toContain("Already waiting");
    const questions = t.bot.messages.filter((m) => m.kind === "question");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ answer: null, expiresAt: new Date(START.getTime() + 24 * 3600_000).toISOString() });
    expect(t.notified).toEqual([{ reason: "card", id: questions[0]!.id }]);
    expect(t.gate.answer(B1, questions[0]!.id, { kind: "option", index: 1 })).toEqual({ ok: true });
    expect(t.delivered).toEqual([{ actor: botActor(B1), e: { from: "answer", question: "Which repo?", option: "ios" } }]);
    expect(t.gate.nextDeadline()).toBeNull();
  });

  test("an expired question leaves a notice, not a turn", () => {
    const t = setup();
    t.gate.ask(B1, { question: "Ship it?", options: ["yes", "no"] });
    t.gate.tick(t.advance(24 * 3600_000));
    expect(t.bot.messages.find((m) => m.kind === "question")).toMatchObject({ answer: "expired" });
    expect(t.noticed[0]!.text).toContain('"Ship it?" expired unanswered');
    expect(t.delivered).toHaveLength(0);
  });
});

describe("reconciling against the messages", () => {
  test("a question from before protocol 3 stays open forever and can still be answered", () => {
    const t = setup();
    post(t.bot, { kind: "question", id: "m_v2" as MessageId, at: START.toISOString(), question: "Old?", options: ["a", "b"], answer: null, expiresAt: null });
    t.gate.tick(t.advance(30 * 24 * 3600_000));
    expect(t.bot.messages[0]).toMatchObject({ answer: null });
    expect(t.noticed).toHaveLength(0);
    expect(t.gate.answer(B1, "m_v2" as MessageId, { kind: "option", index: 0 })).toEqual({ ok: true });
  });

  test("an open card whose message is gone or settled is dropped; an orphaned permission message expires", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    t.bot.messages.splice(0);
    post(t.bot, {
      kind: "permission", id: "m_orphan" as MessageId, at: START.toISOString(), from: null, tool: "Bash", label: "x", detail: "npm publish",
      always: "x", answer: null, expiresAt: new Date(START.getTime() + 3600_000).toISOString(),
    });
    t.gate.tick(t.advance(1000));
    expect(gateState(t.world).open).toHaveLength(0);
    expect(t.bot.messages[0]).toMatchObject({ id: "m_orphan", answer: "expired" });
    expect(t.gate.answer(B1, "m_orphan" as MessageId, { kind: "permission", choice: "once" })).toEqual({ ok: false, error: "That request expired" });
  });

  test("daily counts from earlier days are pruned", () => {
    const t = setup();
    const stale: DailyCount = { botId: B1, tool: "mcp__claudio__create_bot", day: "2026-10-01", count: 5 };
    gateState(t.world).daily.push(stale);
    t.gate.tick(t.now());
    expect(gateState(t.world).daily).toHaveLength(0);
  });

  test("forgetBot drops the bot's cards, grants, rules and counts", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    await t.bash("npm publish");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "always" });
    gateState(t.world).daily.push({ botId: B1, tool: "mcp__claudio__create_bot", day: "2026-10-17", count: 1 });
    t.gate.forgetBot(B1);
    expect(gateState(t.world)).toEqual({ open: [], grants: [], daily: [] });
    expect(t.bot.rules).toHaveLength(0);
    expect(t.persisted.at(-1)!.urgency).toBe("now");
  });
});

describe("hard stops", () => {
  test("every call is denied while the turn is stopping, a granted one included, and none feeds the breaker", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.bash("git push origin feature");
    t.gate.answer(B1, t.cards()[0]!.id, { kind: "permission", choice: "once" });
    t.turn.stopping = true;
    const denialsBefore = t.denials();
    for (const out of [await t.call("Read", { file_path: "CLAUDE.md" }), await t.bash("git push origin feature"), await t.call("Agent", { prompt: "p" })]) {
      expect(decisionOf(out)).toBe("deny");
      expect(reasonOf(out)).toContain("pressed Stop");
    }
    expect(gateState(t.world).grants).toHaveLength(1);
    expect(t.cards()).toHaveLength(1);
    expect(t.denials()).toBe(denialsBefore);
    expect(t.auditRows().at(-1)).toMatchObject({ decision: "deny", via: "stopping" });
  });

  test("a floor through the real filesystem: the bridge behind a symlink is denied, the bot's own home through it is not", async () => {
    const t = setup({ bridgeName: ".claudebot" });
    symlinkSync(t.bridge, join(t.root, ".claudiobot"));
    const linkedOwn = join(t.root, ".claudiobot", "bots", "b_1");
    expect(decisionOf(await t.call("Bash", { command: "cat ~/.claudiobot/state.json" }, { cwd: linkedOwn }))).toBe("deny");
    expect(decisionOf(await t.call("Bash", { command: `cat ${linkedOwn}/CLAUDE.md` }, { cwd: linkedOwn }))).toBe("pass");
    expect(decisionOf(await t.call("Write", { file_path: `${linkedOwn}/library/new/today.md`, content: "x" }, { cwd: linkedOwn }))).toBe("pass");
    expect(decisionOf(await t.call("Read", { file_path: `${linkedOwn}/../b_2/CLAUDE.md` }, { cwd: linkedOwn }))).toBe("deny");
  });

  test("the daily cap on create_bot counts allowed calls", async () => {
    const t = setup();
    const create = () => t.call("mcp__claudio__create_bot", { name: "x", job: "y" }, { mcp_server: { name: "claudio", source: "sdk" } });
    for (let i = 0; i < 5; i++) expect(decisionOf(await create())).toBe("pass");
    const sixth = await create();
    expect(decisionOf(sixth)).toBe("deny");
    expect(reasonOf(sixth)).toContain("daily limit");
  });
});

describe("failing closed", () => {
  test("malformed tool input is denied and audited, never passed", async () => {
    const t = setup();
    expect(decisionOf(await t.call("Bash", { command: 42 }))).toBe("deny");
    expect(decisionOf(await t.call("Write", "not an object"))).toBe("deny");
    expect(t.auditRows().map((r) => r.via)).toEqual(["malformed", "malformed"]);
    expect(t.denials()).toBe(2);
  });

  test("a gate that throws denies, logs, audits and counts the denial", async () => {
    const t = setup();
    t.deps.scopeOf = () => {
      throw new Error("no such agent");
    };
    const t2 = createGate(t.deps);
    const out = await t2.hooks(botActor(B1)).PreToolUse![0]!.hooks[0]!(t.input("Read", { file_path: "x" }), "toolu_x", { signal: new AbortController().signal });
    expect(decisionOf(out)).toBe("deny");
    expect(t.logged.some((l) => l.includes("no such agent"))).toBe(true);
    expect(t.auditRows().at(-1)).toMatchObject({ decision: "deny", via: "error" });
    expect(t.denials()).toBe(1);
  });

  test("failClosed denies on a thrown null, a broken error report, a null input and an async result", async () => {
    const signal = { signal: new AbortController().signal };
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t", cwd: "/", session_id: "s", transcript_path: "/t" } as PreToolUseHookInput;
    const throwsNull = failClosed(() => {
      throw null;
    }, () => {
      throw new Error("log is down");
    });
    expect(decisionOf(await throwsNull(input, "t", signal))).toBe("deny");
    const fine = failClosed(() => ({}), () => {});
    expect(await fine(input, "t", signal)).toEqual({});
    expect(decisionOf(await fine(null as unknown as PreToolUseHookInput, "t", signal))).toBe("deny");
    const asyncResult = failClosed(() => ({ async: true }) as never, () => {});
    expect(decisionOf(await asyncResult(input, "t", signal))).toBe("deny");
    const askResult = failClosed(() => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }), () => {});
    expect(decisionOf(await askResult(input, "t", signal))).toBe("deny");
  });
});

describe("the audit log", () => {
  test("one row per call in audit/YYYY-MM.jsonl, mode 0600, redacted", async () => {
    const t = setup();
    t.turn.initiator = routine;
    await t.call("Write", { file_path: "notes.md", content: "secret plans" });
    await t.bash("curl -H 'Authorization: Bearer abcd1234efgh5678' https://example.com");
    const file = join(t.bridge, "audit", "2026-10.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [write, curl] = t.auditRows();
    expect(write).toMatchObject({
      actor: "bot:b_1",
      botId: B1,
      initiator: routine,
      tool: "Write",
      subagent: null,
      decision: "pass",
      input: { file_path: "notes.md", content: { bytes: 12 } },
    });
    expect(readFileSync(file, "utf8")).not.toContain("secret plans");
    expect(readFileSync(file, "utf8")).not.toContain("abcd1234efgh5678");
    expect(curl!.decision).toBe("pass");
  });
});

describe("boundary adapters", () => {
  const base = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" } as const;
  test("toCall keeps the subagent and the MCP server", () => {
    expect(toCall({ ...base, agent_id: "a57b", agent_type: "general-purpose", mcp_server: { name: "claudio", source: "sdk" } })).toEqual({
      ok: true,
      call: { tool: "Bash", input: { command: "ls" }, cwd: "/repo", toolUseId: "t1", subagent: { id: "a57b", type: "general-purpose" }, mcpServer: { name: "claudio", source: "sdk" } },
    });
  });
  test("toCall refuses what it cannot read", () => {
    expect(toCall({ ...base, cwd: "relative" }).ok).toBe(false);
    expect(toCall({ ...base, tool_input: null }).ok).toBe(false);
    expect(toCall({ ...base, tool_input: { command: "" } }).ok).toBe(false);
    expect(toCall({ ...base, mcp_server: { name: 1 } as never }).ok).toBe(false);
  });
  test("toHookOutput never returns ask or defer", () => {
    expect(toHookOutput({ kind: "pass" }, null)).toEqual({});
    expect(decisionOf(toHookOutput({ kind: "ask", rule: "r", label: "l", signature: "s" as never, always: "a" }, "m_1" as MessageId))).toBe("deny");
    expect(() => toHookOutput({ kind: "ask", rule: "r", label: "l", signature: "s" as never, always: "a" }, null)).toThrow();
  });
});
