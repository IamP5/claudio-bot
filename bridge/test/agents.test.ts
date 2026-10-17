import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgents } from "../src/agents";
import type { Headroom, Ledger } from "../src/ledger";
import type { AgentId, AgentStatus, BotId, RoutineId, RunId } from "../src/protocol";
import type { Project } from "../src/projects";
import { emptySession, emptyWorld, type AgentRecord, type Initiator, type World } from "../src/world";

const AT = "2026-10-17T12:00:00.000Z";
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const project: Project = { name: "shop", path: "/code/shop", branch: "main", githubRepo: null };
const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run: { routineId: "r_1" as RoutineId, runId: "run_1" as RunId }, manual: false };
const botMail: Initiator = { kind: "bot", botId: "b_2" as BotId, hops: 1, origin: { kind: "user" } };
const B1 = "b_1" as BotId;

class FakeQuery {
  readonly received: string[] = [];
  interrupts = 0;
  closed = false;
  private queue: SDKMessage[] = [];
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
  ) {
    void (async () => {
      for await (const m of prompt) this.received.push(m.message.content as string);
    })();
  }
  emit(...ms: SDKMessage[]) {
    this.queue.push(...ms);
    this.wake?.();
  }
  crash(error: Error) {
    this.failure = error;
    this.wake?.();
  }
  async interrupt() {
    this.interrupts++;
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

let uuid = 0;
const said = (t: string) =>
  ({ type: "assistant", uuid: `u${++uuid}`, session_id: "s_a", parent_tool_use_id: null, message: { content: [{ type: "text", text: t }] } }) as unknown as SDKMessage;
const result = (text: string, over: object = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: text, errors: [], session_id: "s_a", total_cost_usd: 0.1, ...over }) as unknown as SDKMessage;

const roots: string[] = [];
const configuredClaude = process.env.CLAUDIOBOT_CLAUDE;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (configuredClaude === undefined) delete process.env.CLAUDIOBOT_CLAUDE;
  else process.env.CLAUDIOBOT_CLAUDE = configuredClaude;
});

function harness(opts: { world?: World; headroom?: (i: Initiator) => Headroom } = {}) {
  const world = opts.world ?? emptyWorld();
  const queries: FakeQuery[] = [];
  const reports: { agentId: AgentId; text: string; by: Initiator }[] = [];
  const notes: { agentId: AgentId; text: string }[] = [];
  const statuses: AgentStatus[] = [];
  const ledger: Ledger = {
    add: () => {},
    headroom: (_, i) => (opts.headroom ? opts.headroom(i) : { ok: true, capReached: false }),
    budgetLeft: () => 4.5,
    dailyLeft: () => 10,
  };
  const agents = createAgents({
    world,
    userName: "Alex",
    model: "claude-sonnet-5-5",
    ledger,
    log: () => {},
    claude: {
      query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const q = new FakeQuery(options, prompt);
        queries.push(q);
        return q;
      }) as unknown as typeof query,
      executable: () => "/fake/claude",
    },
    hooks: (actor) => ({ PreToolUse: [{ matcher: actor.kind === "agent" ? actor.agentId : "bot", hooks: [] }] }),
    persist: () => {},
    now: () => AT,
    changed: (rec) => statuses.push(rec.agent.status),
    reported: (rec, text, by) => reports.push({ agentId: rec.agent.id, text, by }),
    note: (rec, text) => notes.push({ agentId: rec.agent.id, text }),
  });
  const start = (where: "mac" | "cloud" = "mac", initiator: Initiator = user, botId: BotId = B1) =>
    agents.start(botId, { title: "Fix tests", prompt: "Make the suite green.", project: where === "cloud" ? cloudProject : project, where, botName: "Ana", initiator, budgetUsd: null });
  return { world, agents, queries, reports, notes, statuses, start, q: () => queries.at(-1)! };
}

const AGENT_PROMPT =
  "You were started by the bot Ana for Alex. Work on a new branch, verify your change, and open a PR when done. " +
  "Your final message each turn is reported to the bot.\n\nMake the suite green.";

let cloudProject: Project = project;

/** A claude executable that answers `--cloud <prompt>` and `-p <text> --cloud <session>` the way the real one does. */
function fakeCloudClaude(ok: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-agents-"));
  roots.push(dir);
  cloudProject = { ...project, path: dir };
  const path = join(dir, "claude");
  const body = ok
    ? `if [ "$1" = "--cloud" ]; then echo "Created cloud session: Fix tests"; echo "View: https://claude.ai/code/session_abc123"; exit 0; fi\necho '{"ok":true}'`
    : `echo "Not logged in" >&2; exit 1`;
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  process.env.CLAUDIOBOT_CLAUDE = path;
}

test("a mac agent starts on its project with the agent prompt, its budget, no resume id and the hooks for its actor", async () => {
  const h = harness();
  const rec = await h.start("mac", routine);
  await flush();
  expect(h.q().received).toEqual([AGENT_PROMPT]);
  const o = h.q().options;
  expect([o.cwd, o.resume, o.maxBudgetUsd, o.permissionMode, o.disallowedTools, o.model, o.hooks?.PreToolUse?.[0]?.matcher]).toEqual([
    "/code/shop",
    undefined,
    4.5,
    "auto",
    ["AskUserQuestion"],
    "claude-sonnet-5-5",
    rec.agent.id,
  ]);
  expect(h.world.agents.get(rec.agent.id)).toMatchObject({
    agent: { botId: B1, title: "Fix tests", where: "mac", projectName: "shop", status: "working", url: null },
    cwd: "/code/shop",
    messages: [{ from: "bot", text: "Make the suite green." }],
    startedBy: routine,
  });
});

test("the turn's final message is reported to the bot with the turn's initiator, and the agent waits", async () => {
  const h = harness();
  const rec = await h.start("mac", routine);
  await flush();
  h.q().emit(said("Working on it."), result("Done: opened PR #4."));
  await flush();
  expect(h.reports).toEqual([{ agentId: rec.agent.id, text: "Done: opened PR #4.", by: routine }]);
  expect(rec.agent.status).toBe("waiting");
  expect(rec.messages.map((m) => [m.from, m.text])).toEqual([
    ["bot", "Make the suite green."],
    ["agent", "Done: opened PR #4."],
  ]);
});

test("an empty final message is reported as such", async () => {
  const h = harness();
  await h.start();
  await flush();
  h.q().emit(result("  "));
  await flush();
  expect(h.reports.map((r) => r.text)).toEqual(["(no final message)"]);
});

test("an error result reports the error and marks the agent failed", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("", { subtype: "error_max_turns", is_error: true, errors: ["Reached the turn limit"] }));
  await flush();
  expect(h.reports.map((r) => r.text)).toEqual(["The agent stopped with an error: Reached the turn limit"]);
  expect(rec.agent.status).toBe("failed");
});

test("a crash after output reports the crash and marks the agent failed", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(said("Running the tests."));
  await flush();
  h.q().crash(new Error("Claude Code exited with code 1"));
  await flush();
  expect(h.reports.map((r) => r.text)).toEqual(["The agent crashed: Claude Code exited with code 1"]);
  expect(rec.agent.status).toBe("failed");
});

test("an agent silent for 30 minutes is noted in its bot's chat once", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  const tick = (min: number) => h.agents.sessions().forEach((s) => s.tick(new Date(Date.now() + min * 60_000)));
  tick(29);
  expect(h.notes).toEqual([]);
  tick(31);
  tick(45);
  expect(h.notes).toEqual([{ agentId: rec.agent.id, text: "The agent has been silent for 30 minutes; you can press Stop." }]);
});

test("Stop interrupts the agent's turn, and the stopped turn reports who stopped it", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  expect(await h.agents.stop(rec)).toBe(true);
  expect(h.q().interrupts).toBe(1);
  h.q().emit(result("", { subtype: "error_during_execution", is_error: true, errors: [] }));
  await flush();
  expect(h.reports.map((r) => r.text)).toEqual(["Stopped by Alex."]);
  expect(rec.agent.status).toBe("waiting");
});

test("Stop on an agent with no session, or a cloud agent, is false", async () => {
  fakeCloudClaude(true);
  const h = harness();
  const cloud = await h.start("cloud");
  const world = emptyWorld();
  const mac = await harness({ world }).start();
  expect([await h.agents.stop(cloud), await h.agents.stop(mac)]).toEqual([false, false]);
});

test("a follow-up from the bot is recorded, marks the agent working, and runs with the bot turn's initiator", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("Done."));
  await flush();
  expect(await h.agents.message(rec, "Also fix the lint.", botMail)).toBe("Sent. Fix tests will report back.");
  expect(rec.agent.status).toBe("working");
  await flush();
  expect(h.q().received.at(-1)).toBe("Also fix the lint.");
  h.q().emit(result("Lint fixed."));
  await flush();
  expect(h.reports.at(-1)).toEqual({ agentId: rec.agent.id, text: "Lint fixed.", by: botMail });
  expect(rec.messages.map((m) => m.text)).toEqual(["Make the suite green.", "Done.", "Also fix the lint.", "Lint fixed."]);
});

test("a decision envelope is queued for the agent and is not recorded in its thread", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("Waiting on approval."));
  await flush();
  h.agents.deliver(rec, { text: "[Alex allowed Bash `bun test` once]", initiator: user, settles: null, ahead: true });
  await flush();
  expect(h.q().received.at(-1)).toBe("[Alex allowed Bash `bun test` once]");
  expect(rec.messages.map((m) => m.text)).toEqual(["Make the suite green.", "Waiting on approval."]);
});

test("a notice tops the agent's next envelope", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("Done."));
  await flush();
  h.agents.notice(rec, "[Your request expired.]");
  await h.agents.message(rec, "Try again.", user);
  await flush();
  expect(h.q().received.at(-1)).toBe("[Your request expired.]\nTry again.");
});

test("an agent whose budget is used up never starts its turn and reports that it used its budget", async () => {
  const h = harness({ headroom: () => ({ ok: false, reason: "agent_budget" }) });
  const rec = await h.start();
  await flush();
  expect(h.queries).toEqual([]);
  expect(rec.agent.status).toBe("failed");
  expect(h.reports.map((r) => r.text)).toEqual(["The agent used its budget."]);
});

test("an agent whose query ran out of budget mid-turn reports that it used its budget", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(said("Running the tests."), result("", { subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($4.5)"] }));
  await flush();
  expect(rec.agent.status).toBe("failed");
  expect(h.reports.map((r) => r.text)).toEqual(["The agent used its budget."]);
});

test("resume starts mac agents with queued work and tells bots about agents a restart cut off", async () => {
  const world = emptyWorld();
  const record = (id: string, status: AgentStatus, where: "mac" | "cloud", queued: boolean): AgentRecord => {
    const session = emptySession("s_old");
    if (queued) session.pending.push({ id: `e_${id}` as never, at: AT, text: `[queued for ${id}]`, initiator: user, settles: null, attempts: 0 });
    return {
      agent: { id: id as AgentId, botId: B1, title: id, where, projectName: "shop", status, url: null, createdAt: AT, updatedAt: AT },
      cwd: "/code/shop",
      messages: [],
      session,
      cloudSession: null,
      budgetUsd: null,
      startedBy: botMail,
    };
  };
  for (const r of [record("a_q", "working", "mac", true), record("a_cut", "working", "mac", false), record("a_idle", "waiting", "mac", false), record("a_cloud", "in_cloud", "cloud", false)])
    world.agents.set(r.agent.id, r);
  const h = harness({ world });
  h.agents.resume();
  await flush();
  expect(h.queries.map((q) => [q.options.resume, q.received])).toEqual([["s_old", ["[queued for a_q]"]]]);
  expect(h.reports).toEqual([
    { agentId: "a_cut" as AgentId, text: "The bridge restarted while this agent was working. Send it a message to resume it.", by: botMail },
  ]);
  expect(world.agents.get("a_cut" as AgentId)!.agent.status).toBe("failed");
  expect(h.agents.sessions()).toHaveLength(1);
});

test("stopFor closes the sessions of that bot's agents only", async () => {
  const h = harness();
  const mine = await h.start("mac", user, B1);
  await flush();
  const theirs = await h.start("mac", user, "b_2" as BotId);
  await flush();
  h.agents.stopFor(B1);
  expect(h.queries.map((q) => q.closed)).toEqual([true, false]);
  expect([h.agents.session(mine.agent.id), h.agents.session(theirs.agent.id) !== null]).toEqual([null, true]);
});

test("a cloud agent is created through claude --cloud and shows its session link", async () => {
  fakeCloudClaude(true);
  const h = harness();
  const rec = await h.start("cloud");
  expect(rec.agent).toMatchObject({ where: "cloud", status: "in_cloud", url: "https://claude.ai/code/session_abc123" });
  expect(rec.cloudSession).toBe("session_abc123");
  h.agents.deliver(rec, { text: "x", initiator: user, settles: null, ahead: true });
  h.agents.notice(rec, "y");
  expect([h.queries, h.agents.session(rec.agent.id)]).toEqual([[], null]);
});

test("a cloud agent that cannot be created is failed with the reason in its thread", async () => {
  fakeCloudClaude(false);
  const h = harness();
  const rec = await h.start("cloud");
  expect(rec.agent.status).toBe("failed");
  // script(1) echoes the tty's ^D and backspaces ahead of what the CLI wrote.
  expect(rec.messages.at(-1)).toMatchObject({ from: "agent", text: expect.stringMatching(/^Could not create the cloud session\. [\s\S]*Not logged in$/) });
});

test("a follow-up to a cloud agent goes to its cloud session, and one with no session says so", async () => {
  fakeCloudClaude(true);
  const h = harness();
  const rec = await h.start("cloud");
  expect(await h.agents.message(rec, "Status?", user)).toBe("Sent to the cloud session. Follow it at https://claude.ai/code/session_abc123");
  expect(rec.messages.at(-1)).toMatchObject({ from: "bot", text: "Status?" });
  rec.cloudSession = null;
  expect(await h.agents.message(rec, "Again?", user)).toBe("This cloud agent has no session to follow up on.");
});
