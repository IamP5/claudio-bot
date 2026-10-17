import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query, SandboxSettings, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgents } from "../src/agents";
import type { Headroom, Ledger } from "../src/ledger";
import type { AgentId, AgentStatus, BotId, RoutineId, RunId } from "../src/protocol";
import type { Project } from "../src/projects";
import { emptySession, emptyWorld, own, type AgentRecord, type GateState, type Initiator, type OpenCard, type World } from "../src/world";

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

function harness(opts: { world?: World; headroom?: (i: Initiator) => Headroom; project?: Project; sandbox?: () => SandboxSettings; budgetLeft?: number } = {}) {
  const world = opts.world ?? emptyWorld();
  const queries: FakeQuery[] = [];
  const reports: { agentId: AgentId; text: string; by: Initiator }[] = [];
  const notes: { agentId: AgentId; text: string }[] = [];
  const statuses: AgentStatus[] = [];
  const begun: string[] = [];
  const trustCards: { agentId: AgentId; root: string; name: string; found: readonly string[] }[] = [];
  const ledger: Ledger = {
    add: () => {},
    headroom: (_, i) => (opts.headroom ? opts.headroom(i) : { ok: true, capReached: false }),
    budgetLeft: () => opts.budgetLeft ?? 4.5,
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
    beginTurn: (actor) => begun.push(actor.kind === "agent" ? actor.agentId : actor.botId),
    sandbox: opts.sandbox ?? ((actor) => ({ enabled: true, filesystem: { allowWrite: [actor.kind === "agent" ? actor.agentId : actor.botId] } })),
    configRoot: (id) => `/bridge/agent-config/${id}`,
    trustCard: (actor, repo) => trustCards.push({ agentId: actor.agentId, ...repo }),
    settings: () => ({ autoMemoryEnabled: false }),
    observe: () => {},
    idle: () => {},
    persist: () => {},
    now: () => AT,
    changed: (rec) => statuses.push(rec.agent.status),
    reported: (rec, text, by) => reports.push({ agentId: rec.agent.id, text, by }),
    note: (rec, text) => notes.push({ agentId: rec.agent.id, text }),
  });
  const start = (where: "mac" | "cloud" = "mac", initiator: Initiator = user, botId: BotId = B1) =>
    agents.start(botId, { title: "Fix tests", prompt: "Make the suite green.", project: where === "cloud" ? cloudProject : (opts.project ?? project), where, isolate: "auto", botName: "Ana", initiator, budgetUsd: null });
  return { world, agents, queries, reports, notes, statuses, begun, trustCards, start, q: () => queries.at(-1)! };
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
  expect(o.sandbox).toEqual({ enabled: true, filesystem: { allowWrite: [rec.agent.id] } });
  expect([o.env?.PATH, o.env?.GIT_CONFIG_KEY_0, o.env?.GIT_CONFIG_VALUE_0]).toEqual([process.env.PATH, "url.https://github.com/.insteadOf", "git@github.com:"]);
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
  h.agents.deliver(rec, { text: "[Alex allowed Bash `bun test` once]", initiator: user, settles: null, kind: "continuation" });
  await flush();
  expect(h.q().received.at(-1)).toBe("[Alex allowed Bash `bun test` once]");
  expect(rec.messages.map((m) => m.text)).toEqual(["Make the suite green.", "Waiting on approval."]);
  expect(h.begun).toEqual([rec.agent.id]);
});

test("an agent shows working while the continuation after Allow once runs, and waiting once it reports", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("Waiting on approval."));
  await flush();
  expect(rec.agent.status).toBe("waiting");
  h.agents.deliver(rec, { text: "[Alex allowed Bash `bun test` once]", initiator: user, settles: null, kind: "continuation" });
  expect([rec.agent.status, h.statuses.at(-1)]).toEqual(["working", "working"]);
  await flush();
  h.q().emit(result("Tests pass."));
  await flush();
  expect(rec.agent.status).toBe("waiting");
});

test("an agent whose work waits on the daily cap shows parked, and working once the cap lifts", async () => {
  let capped = true;
  const h = harness({ headroom: (i) => (capped && i.kind !== "user" ? { ok: false, reason: "daily_cap", until: "2026-10-18T03:00:00.000Z" } : { ok: true, capReached: false }) });
  const rec = await h.start("mac", routine);
  expect([rec.agent.status, h.statuses.at(-1)]).toEqual(["parked", "parked"]);
  capped = false;
  h.agents.session(rec.agent.id)!.recheck();
  expect(rec.agent.status).toBe("working");
});

test("an agent whose turn ended with a permission card open shows awaiting_approval until the card closes", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  const card = { kind: "permission", cardId: "m_card", actor: { kind: "agent", botId: B1, agentId: rec.agent.id }, remindAt: null, expiresAt: AT, call: {} } as unknown as OpenCard;
  const open = h.world.gate.open as OpenCard[];
  open.push(card);
  h.q().emit(result("I need to run bun test."));
  await flush();
  expect([rec.agent.status, h.statuses.at(-1)]).toEqual(["awaiting_approval", "awaiting_approval"]);
  open.splice(0);
  h.agents.notice(rec, "[Your request to run Bash `bun test` expired unanswered.]");
  expect([rec.agent.status, h.statuses.at(-1)]).toEqual(["waiting", "waiting"]);
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
  const h = harness({ headroom: () => ({ ok: false, reason: "agent_budget" }), budgetLeft: 0 });
  const rec = await h.start();
  await flush();
  expect(h.queries).toEqual([]);
  expect(rec.agent.status).toBe("failed");
  expect(h.reports.map((r) => r.text)).toEqual(["The agent used its budget."]);
});

test("an agent whose query ran out of budget mid-turn reports that it used its budget", async () => {
  const h = harness({ budgetLeft: 0 });
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
    if (queued) session.pending.push({ id: `e_${id}` as never, kind: "envelope", at: AT, text: `[queued for ${id}]`, initiator: user, settles: null, attempts: 0 });
    return {
      agent: { id: id as AgentId, botId: B1, title: id, where, projectName: "shop", status, url: null, createdAt: AT, updatedAt: AT, evidence: null, worktree: null },
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

test("a finished agent's session is let go once its idle query closes; the record stays and a follow-up resumes it", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(result("Done."));
  await flush();
  const tick = (min: number) => h.agents.sessions().forEach((s) => s.tick(new Date(Date.now() + min * 60_000)));
  tick(14);
  expect([h.q().closed, h.agents.sessions().length]).toEqual([false, 1]);
  tick(15);
  expect([h.q().closed, h.agents.session(rec.agent.id), h.world.agents.get(rec.agent.id)?.agent.status]).toEqual([true, null, "waiting"]);
  await h.agents.message(rec, "Also fix the lint.", user);
  await flush();
  expect(h.queries.map((q) => [q.options.resume, q.received.at(-1)])).toEqual([
    [undefined, AGENT_PROMPT],
    ["s_a", "Also fix the lint."],
  ]);
});

test("a crashed agent's session is let go at the next tick", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();
  h.q().emit(said("Running the tests."));
  await flush();
  h.q().crash(new Error("Claude Code exited with code 1"));
  await flush();
  h.agents.sessions().forEach((s) => s.tick(new Date()));
  expect([h.agents.session(rec.agent.id), rec.agent.status]).toEqual([null, "failed"]);
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
  h.agents.deliver(rec, { text: "x", initiator: user, settles: null, kind: "continuation" });
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

/** A repo whose committed settings carry a hook that would run on every tool call. */
function repoWithHook(): Project {
  const dir = mkdtempSync(join(tmpdir(), "claudiobot-repo-"));
  roots.push(dir);
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }] } }));
  writeFileSync(join(dir, ".mcp.json"), "{}");
  return { name: "shop", path: dir, branch: "main", githubRepo: null };
}

test("an agent in a repo nobody trusts loads its config from the bridge's empty folder, and the bot is asked once", async () => {
  const repo = repoWithHook();
  const h = harness({ project: repo });
  const rec = await h.start();
  await flush();

  expect(h.q().options.projectConfigRoot).toBe(`/bridge/agent-config/${rec.agent.id}`);
  expect(h.trustCards).toEqual([{ agentId: rec.agent.id, root: repo.path, name: "shop", found: [".claude/settings.json", ".mcp.json"] }]);
});

test("once the repo is trusted the agent's next query loads the repo's own config", async () => {
  const repo = repoWithHook();
  const h = harness({ project: repo });
  const rec = await h.start();
  await flush();
  h.q().emit(result("Done."));
  await flush();
  own<GateState>(h.world.gate).repos.push({ root: repo.path, agentId: null, trusted: true, cardId: "m_card" as never, at: AT });
  h.agents.trusted(repo.path);
  await h.agents.message(rec, "Now add a test.", user);
  await flush();

  expect(h.queries.map((q) => [q.closed, q.options.projectConfigRoot ?? "the repo's own"])).toEqual([
    [true, `/bridge/agent-config/${rec.agent.id}`],
    [false, "the repo's own"],
  ]);
});

test("a repo with no config of its own asks nothing and still runs on the empty folder", async () => {
  const h = harness();
  const rec = await h.start();
  await flush();

  expect([h.trustCards, h.q().options.projectConfigRoot]).toEqual([[], `/bridge/agent-config/${rec.agent.id}`]);
});

test("an agent whose Claude Code cannot start shows unavailable, and its bot hears why", async () => {
  const h = harness({ sandbox: () => { throw new Error("no sandbox for you"); } });
  const rec = await h.start();
  await flush();

  expect([rec.agent.status, h.statuses.at(-1), h.queries.length]).toEqual(["unavailable", "unavailable", 0]);
  expect(h.notes.map((n) => n.text)).toEqual(["Claude Code could not start: no sandbox for you. Queued messages are kept, and it keeps trying."]);
});

test("an agent the daily cap stopped mid-turn is capped, not failed, and says how it resumes", async () => {
  const h = harness({ budgetLeft: 3 });
  const rec = await h.start("mac", routine);
  await flush();
  h.q().emit(said("Running the tests."), result("", { subtype: "error_max_budget_usd", is_error: true, errors: ["Reached maximum budget ($0.4)"] }));
  await flush();
  expect(rec.agent.status).toBe("capped");
  expect(h.reports.map((r) => r.text)).toEqual(["Paused at today's spending cap; it resumes when you message it tomorrow or raise the cap."]);
  h.agents.session(rec.agent.id)?.recheck();
  await flush();
  expect(rec.agent.status).toBe("capped");
});
