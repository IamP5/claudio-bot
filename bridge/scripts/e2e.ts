// End to end against the real bridge and real Claude Code, through the WebSocket like the app, in a temp home.
// Run: bun run e2e. It spends real usage, never starts a cloud agent, and never touches ~/.claudebot or ~/.claudiobot:
// CLAUDIOBOT_HOME and every project root point into a temp folder, which skips migration. The bridge gets no
// SSH_AUTH_SOCK and no GitHub token, push goes to a fake ntfy server here, and claude.ai connectors are off
// (E2E_CONNECTORS=1 keeps them). E2E_MODEL overrides the model; E2E_BRIDGE_LOG names a file for the bridge's own log.
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotId, ClientMessage, Message, ServerMessage } from "../src/protocol";

// The probe found that haiku 4.5 and sonnet 4.5 silently run in default mode when auto is asked for.
const MODEL = process.env.E2E_MODEL ?? "claude-sonnet-5-5";
const TURN_MS = 240_000;
const USER = "Alex";

const results: { scenario: string; ok: boolean; evidence: string }[] = [];

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

async function scenario(name: string, body: () => Promise<string>) {
  console.log(`\n== ${name}`);
  try {
    const evidence = await body();
    results.push({ scenario: name, ok: true, evidence });
    console.log(`PASS ${name}: ${evidence}`);
  } catch (e) {
    results.push({ scenario: name, ok: false, evidence: (e as Error).message });
    console.log(`FAIL ${name}: ${(e as Error).message}`);
    throw e;
  }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "claudiobot-e2e-")));
const home = join(scratch, "home");
const roots = join(scratch, "roots");
const demo = join(roots, "demo");
const pushme = join(roots, "pushme");
const hooked = join(roots, "hooked");
const origin = join(scratch, "origin.git");
const hookMarker = join(scratch, "hook-ran.txt");
const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} -c user.name=e2e -c user.email=e2e@example.com ${args}`.quiet();
const head = async (repo: string, ref = "main") => (await git(repo, "rev-parse", ref)).text().trim();

/** A bare remote and a clone of it with one more commit than the remote. */
async function pushPair(clone: string, remote: string) {
  await Bun.$`git init -q --bare -b main ${remote}`.quiet();
  await Bun.$`git clone -q ${remote} ${clone}`.quiet();
  await git(clone, "commit", "-q", "--allow-empty", "-m", "init");
  await git(clone, "push", "-q", "origin", "main");
  await git(clone, "commit", "-q", "--allow-empty", "-m", "a change to push");
}

mkdirSync(demo, { recursive: true });
await Bun.$`git init -q -b main ${demo}`.quiet();
await git(demo, "commit", "-q", "--allow-empty", "-m", "init");
await pushPair(pushme, origin);
// A repo whose committed settings run a hook at session start and before every tool call.
mkdirSync(join(hooked, ".claude"), { recursive: true });
await Bun.$`git init -q -b main ${hooked}`.quiet();
const hook = { type: "command", command: `echo "$CLAUDE_PROJECT_DIR" >> ${hookMarker}` };
writeFileSync(join(hooked, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }], PreToolUse: [{ hooks: [hook] }] } }, null, 2));
await git(hooked, "add", ".");
await git(hooked, "commit", "-q", "-m", "commit a project hook");

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);

/** The ntfy topic the bridge pushes to: every post, with the time it arrived. */
const pushes: { at: number; body: string; click: string | null }[] = [];
const ntfy = Bun.serve({
  port: 0,
  fetch: async (req) => {
    pushes.push({ at: Date.now(), body: await req.text(), click: req.headers.get("click") });
    return new Response("{}");
  },
});

let server: Subprocess<"ignore", "pipe", "inherit"> | null = null;
let log = "";

async function startServer() {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDIOBOT_PORT: String(port),
    CLAUDIOBOT_ROOTS: roots,
    CLAUDIOBOT_HOME: home,
    CLAUDIOBOT_MODEL: MODEL,
    CLAUDIOBOT_USER_NAME: USER,
    CLAUDIOBOT_PUSH_URL: `http://127.0.0.1:${ntfy.port}/e2e`,
    ...(process.env.E2E_CONNECTORS === "1" ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
  };
  for (const name of ["CLAUDEBOT_HOME", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDIOBOT_ALLOWED_DOMAINS", "CLAUDIOBOT_SANDBOX_STRICT_NETWORK", "CLAUDIOBOT_SANDBOX_GH"]) delete env[name];
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/main.ts")], { env, stdout: "pipe", stderr: "inherit" });
  const started = log.length;
  (async () => {
    for await (const chunk of server!.stdout) log += new TextDecoder().decode(chunk);
  })();
  while (!/pair code: |paired device/.test(log.slice(started))) {
    if (server.exitCode !== null) throw new Error(`the bridge exited at start:\n${log.slice(started)}`);
    await Bun.sleep(50);
  }
  return log.slice(started).match(/pair code: ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1] ?? null;
}

async function stopServer() {
  server?.kill("SIGTERM");
  await server?.exited;
  server = null;
}

async function pair(code: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", body: JSON.stringify({ code, name: "e2e phone" }) });
  check(res.status === 200, `POST /pair with the printed code answers 200 (got ${res.status})`);
  const body = (await res.json()) as { deviceId: string; token: string };
  check(/^[0-9a-f]{64}$/.test(body.token) && !log.includes(body.token), "the pairing returns a device token the bridge never printed");
  return body.token;
}

/** protocol3 false is a protocol 2 app: no ?protocol=3, so permission cards arrive as questions. */
function connect(token: string, protocol3 = true) {
  const bots = new Map<BotId, Bot>();
  const conversations = new Map<BotId, Message[]>();
  const received: ServerMessage[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${protocol3 ? "?protocol=3" : ""}`, { headers: { Authorization: `Bearer ${token}` } } as never);

  const upsert = (botId: BotId, message: Message) => {
    const list = conversations.get(botId) ?? [];
    const i = list.findIndex((m) => m.id === message.id);
    if (i === -1) list.push(message);
    else list[i] = message;
    conversations.set(botId, list);
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    received.push(m);
    if (m.type === "hello") for (const b of m.bots) bots.set(b.id, b);
    if (m.type === "bot") bots.set(m.bot.id, m.bot);
    if (m.type === "conversation") for (const message of m.messages) upsert(m.botId, message);
    if (m.type === "message") upsert(m.botId, m.message);
    if (m.type === "error") console.log(`server error: ${m.message}`);
  };

  async function waitFor<T>(find: () => T | undefined | null | false, what: string, timeoutMs = TURN_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found !== undefined && found !== null && found !== false) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(250);
    }
  }

  const messages = (botId: BotId) => conversations.get(botId) ?? [];
  const botSays = (botId: BotId, after: number) => messages(botId).slice(after).filter((m): m is Extract<Message, { kind: "bot" }> => m.kind === "bot");
  const status = (botId: BotId) => bots.get(botId)?.status;
  const resting = (botId: BotId) => status(botId) === "idle" || status(botId) === "awaiting_approval";
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

  return {
    bots,
    received,
    messages,
    botSays,
    status,
    resting,
    waitFor,
    send,
    opened: new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket did not open"));
    }),
    close: () => ws.close(),
    /** Sends as the user and waits for the bot to answer and rest. */
    async ask(botId: BotId, text: string, what: string) {
      const before = messages(botId).length;
      send({ type: "send", botId, text, uploads: [] });
      await waitFor(() => botSays(botId, before).length > 0 && resting(botId), what);
      return botSays(botId, before).map((m) => m.text).join("\n");
    },
  };
}

type Client = ReturnType<typeof connect>;
type Permission = Extract<Message, { kind: "permission" }>;
const pids = async (pattern: string) => (await Bun.$`pgrep -f ${pattern}`.nothrow().quiet()).text().trim();
const notesOf = (c: Client, botId: BotId, after = 0) => c.messages(botId).slice(after).flatMap((m) => (m.kind === "note" ? [m.text] : []));
const auditRows = (): { actor: string; tool: string; decision: string; via: string | null; rule: string | null; input: { command?: unknown } }[] => {
  const dir = join(home, "audit");
  return existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))) : [];
};
const stateFile = () => JSON.parse(readFileSync(join(home, "state.json"), "utf8"));

let passed = false;
let token = "";
let connectedAt = 0;
let client: Client | null = null;
let legacy: Client | null = null;
try {
  let claudio = "" as BotId;

  await scenario("pairing and first start", async () => {
    const code = await startServer();
    check(code !== null, `the bridge prints a pair code (${code})`);
    token = await pair(code!);
    client = connect(token);
    await client.opened;
    connectedAt = Date.now();
    const hello = await client.waitFor(() => client!.received.find((m) => m.type === "hello"), "hello", 10_000);
    check(hello.type === "hello" && hello.protocol === 3 && hello.userName === USER && hello.epoch !== "", "hello is protocol 3, names the user, and carries a stream epoch");
    const bot = [...client.bots.values()].find((b) => b.name === "Claudio Bot");
    check(bot?.avatar.shape === "circle" && bot.avatar.color === "white", "first start creates Claudio Bot, a white circle");
    claudio = bot.id;
    client.send({ type: "open", botId: claudio });
    const greeting = await client.waitFor(() => client!.botSays(claudio, 0)[0], "the default bot's greeting");
    await client.waitFor(() => client!.resting(claudio), "the greeting turn to end");
    legacy = connect(token, false);
    await legacy.opened;
    return `code ${code} paired over POST /pair with a Bearer token; greeting "${greeting.text.split("\n")[0]!.slice(0, 80)}"`;
  });
  const c = client as unknown as Client;
  const old = legacy as unknown as Client;

  await scenario("a user turn", async () => {
    const ack = await c.ask(claudio, "Remember the codeword zephyr-42 for later. Reply with just OK.", "the codeword ack");
    check(ack.length > 0, "the bot answers the user's message");
    return `reply "${ack.slice(0, 60)}"`;
  });

  await scenario("the sandbox refuses a bot's command that the gate let through", async () => {
    const canary = `CANARY-${crypto.randomUUID()}`;
    writeFileSync(join(home, "notes.txt"), `${canary}\n`, { mode: 0o600 });
    const command = 'cat "$(dirname "$PWD")/../notes.txt"; touch "$(dirname "$PWD")/../written.txt"';
    const reply = await c.ask(
      claudio,
      `This checks the sandbox. Run exactly this one shell command, once, and reply with its complete output verbatim in a code block:\n${command}`,
      "the sandboxed command's output",
    );
    const row = auditRows().findLast((r) => r.tool === "Bash" && String(r.input.command).includes("notes.txt"));
    check(row?.decision === "pass", `the gate passed the command to Claude Code (audit: ${row?.decision ?? "no row"} ${row?.rule ?? ""})`);
    check(/operation not permitted/i.test(reply), `the OS refused it: "${reply.slice(0, 200)}"`);
    check(!reply.includes(canary) && !c.messages(claudio).some((m) => m.kind === "bot" && m.text.includes(canary)), "the canary in the bridge home never reached the chat");
    check(!existsSync(join(home, "written.txt")), "nothing was written outside the bot's home");
    return `audit pass for \`${command}\`; reply "${reply.replace(/\s+/g, " ").slice(0, 160)}"; no written.txt`;
  });

  await scenario("an agent commits in its repo under the sandbox and reports", async () => {
    const before = c.messages(claudio).length;
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text:
        'Call start_agent now with where "mac", project "demo", title "Add hello file", and this prompt: ' +
        '"Create hello.txt in the repository root containing exactly the line: hello from agent. Commit it on main. There is no remote: do not push and do not open a PR. Then reply DONE." ' +
        "When the agent reports, tell me in one line whether hello.txt exists.",
    });
    const report = await c.waitFor(
      () => c.messages(claudio).slice(before).find((m) => m.kind === "exchange" && m.peer.kind === "agent" && m.received >= 1),
      "the agent's report",
      300_000,
    );
    check(log.includes('[Agent "Add hello file"'), "the report reaches the bot as an agent envelope");
    const at = c.messages(claudio).findIndex((m) => m.id === report.id);
    await c.waitFor(() => c.botSays(claudio, at + 1).length > 0 && c.resting(claudio), "the bot's reply to the report");
    const file = join(demo, "hello.txt");
    check(existsSync(file) && readFileSync(file, "utf8").includes("hello from agent"), "the agent created hello.txt in the demo repo");
    const committed = (await git(demo, "log", "-1", "--name-only", "--format=%s")).text();
    check(committed.includes("hello.txt"), `the agent's commit on main holds hello.txt: ${JSON.stringify(committed.trim())}`);
    c.send({ type: "details", botId: claudio });
    const details = await c.waitFor(() => c.received.findLast((m) => m.type === "details"), "details", 10_000);
    check(details.type === "details" && details.agents.some((a) => a.title === "Add hello file" && a.where === "mac" && a.status === "waiting"), "details lists the mac agent as waiting");
    return `exchange received ${report.kind === "exchange" ? report.received : 0}; demo HEAD ${(await head(demo)).slice(0, 7)} "${committed.split("\n")[0]}"`;
  });

  await scenario("Stop on a running turn", async () => {
    const before = c.messages(claudio).length;
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text: 'Run this exact shell command in the foreground (not in the background) and wait for it to finish: python3 -c "import time; time.sleep(61.5)"',
    });
    const started = await (async () => {
      const deadline = Date.now() + TURN_MS;
      while (Date.now() < deadline) {
        if (await pids("sleep.61.5")) return true;
        await Bun.sleep(250);
      }
      return false;
    })();
    check(started, "the long command is running");
    check(c.status(claudio) === "working", "the bot shows working while the command runs");
    const pressed = Date.now();
    c.send({ type: "stop", botId: claudio });
    await c.waitFor(() => notesOf(c, claudio, before).includes(`Stopped by ${USER}`) && c.resting(claudio), "the stopped turn to end", 30_000);
    const tookMs = Date.now() - pressed;
    await Bun.sleep(1_000);
    check((await pids("sleep.61.5")) === "", "the command's process is gone");
    const notes = notesOf(c, claudio, before);
    check(!notes.some((n) => /crashed|stopped with an error/.test(n)), `the stop is not reported as a failure (notes: ${JSON.stringify(notes)})`);
    return `stopped ${tookMs} ms after Stop; notes ${JSON.stringify(notes)}; python process gone`;
  });

  const openCard = (after: number, test: (m: Permission) => boolean) => () =>
    c.messages(claudio).slice(after).find((m): m is Permission => m.kind === "permission" && m.answer === null && test(m));

  await scenario("an agent's push to a local bare remote is held, then runs once after Allow once", async () => {
    const before = c.messages(claudio).length;
    const remoteBefore = await head(origin);
    const local = await head(pushme);
    check(local !== remoteBefore, "pushme has a commit origin does not");
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text:
        'Call start_agent now with where "mac", project "pushme", title "Push main", and this prompt: ' +
        '"Do not create a branch or a PR. Run exactly this command: git push origin main. If it is held for approval, end your turn at once and say so. ' +
        'When a message says it was allowed, run exactly git push origin main again and reply PUSHED." Then end your turn.',
    });
    const card = await c.waitFor(openCard(before, (m) => m.from?.kind === "agent" && m.tool === "Bash"), "the agent's permission card", 300_000);
    check(card.detail.includes("push origin main") && card.label === "Push to the default branch" && card.from?.title === "Push main", `the agent's push waits on a card from it: "${card.label}: ${card.detail}"`);
    check((await head(origin)) === remoteBefore, "origin's main did not move before approval");
    await c.waitFor(() => c.resting(claudio), "the bot to rest");
    c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "once" });
    const deadline = Date.now() + 300_000;
    while ((await head(origin)) !== local && Date.now() < deadline) await Bun.sleep(500);
    check((await head(origin)) === local, "after Allow once the agent's push ran: origin's main is pushme's main");
    const rows = auditRows().filter((r) => r.actor.startsWith("agent:") && String(r.input.command).includes("push origin main"));
    check(rows.some((r) => r.decision === "ask") && rows.some((r) => r.decision === "allow" && r.via === "grant"), `the gate held it once and allowed it on the grant: ${rows.map((r) => `${r.decision}/${r.via ?? "-"}`).join(", ")}`);
    await c.waitFor(() => c.resting(claudio), "the bot to rest after the agent's report", 300_000);
    return `card from agent "${card.from?.title}": "${card.detail}"; origin main ${remoteBefore.slice(0, 7)} -> ${local.slice(0, 7)} after decide once; audit ${rows.map((r) => r.decision).join(",")}`;
  });

  await scenario("a protocol 2 app approves a bot's held push through its question card", async () => {
    // The bot's commands may write only its own home, so its repo and remote live there.
    const own = join(home, "bots", claudio);
    const work = join(own, "work", "pushme");
    const remote = join(own, "work", "origin.git");
    await pushPair(work, remote);
    const before = c.messages(claudio).length;
    const remoteBefore = await head(remote);
    const local = await head(work);
    c.send({ type: "send", botId: claudio, uploads: [], text: `Run exactly this shell command: git -C ${work} push origin main\nIf it is held for approval, say so in one line and end your turn.` });
    const card = await c.waitFor(openCard(before, (m) => m.from === null && m.tool === "Bash"), "the permission card");
    check(card.detail.includes("push origin main") && card.label === "Push to the default branch", `a permission card holds the push: "${card.label}: ${card.detail}"`);
    await c.waitFor(() => c.resting(claudio), "the held turn to end");
    check(c.status(claudio) === "awaiting_approval", "the bot rests as awaiting approval");
    check((await head(remote)) === remoteBefore, "the remote's main did not move before approval");
    const shown = await old.waitFor(() => old.messages(claudio).find((m) => m.id === card.id), "a protocol 2 app to see the card", 10_000);
    check(shown.kind === "question" && JSON.stringify(shown.options) === JSON.stringify(["Allow once", "Deny"]), "a protocol 2 app sees it as an Allow once / Deny question");
    old.send({ type: "answer", botId: claudio, messageId: card.id, option: 0 });
    await c.waitFor(() => c.messages(claudio).find((m) => m.id === card.id && m.kind === "permission" && m.answer === "once"), "the card to close as once", 10_000);
    const deadline = Date.now() + TURN_MS;
    while ((await head(remote)) !== local && Date.now() < deadline) await Bun.sleep(500);
    check((await head(remote)) === local, "after Allow once the push ran inside the sandbox: the remote's main is the clone's main");
    await c.waitFor(() => c.resting(claudio), "the continuation turn to end");
    return `card "${card.label}: ${card.detail}"; remote main ${remoteBefore.slice(0, 7)} held until answer option 0 from a protocol 2 socket, then ${local.slice(0, 7)}`;
  });

  await scenario("a repo's committed hook does not run until the repo is trusted", async () => {
    const before = c.messages(claudio).length;
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text: 'Call start_agent now with where "mac", project "hooked", title "List files", and this prompt: "Run ls once and reply with the file names. Do not change anything." Then end your turn.',
    });
    const report = () => c.messages(claudio).slice(before).find((m) => m.kind === "exchange" && m.peer.kind === "agent" && m.peer.title === "List files" && m.received >= 1);
    const first = await c.waitFor(report, "the hooked agent's first report", 300_000);
    const card = await c.waitFor(openCard(before, (m) => m.tool === "Claude Code settings"), "the trust card", 10_000);
    check(card.label === "Trust hooked's Claude settings" && card.detail === `.claude/settings.json in ${hooked}`, `the bot's chat asks to trust the repo: "${card.label}: ${card.detail}"`);
    check(!existsSync(hookMarker), "the repo's SessionStart and PreToolUse hooks did not run before trust");
    const agentId = stateFile().agents.find((a: { agent: { title: string } }) => a.agent.title === "List files").agent.id as string;
    const calls = auditRows().filter((r) => r.actor === `agent:${agentId}`);
    check(calls.length > 0, `the untrusted agent did call tools, so its hooks had their chance: ${calls.map((r) => r.tool).join(", ")}`);
    await c.waitFor(() => c.resting(claudio), "the bot to rest");
    c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "always" });
    await c.waitFor(() => c.messages(claudio).find((m) => m.id === card.id && m.kind === "permission" && m.answer === "always"), "the trust card to close as always", 10_000);
    const received = first.kind === "exchange" ? first.received : 0;
    c.send({ type: "send", botId: claudio, uploads: [], text: `Call message_agent now with agentId "${agentId}" and text "Run ls once more and reply with the file names." Then end your turn.` });
    await c.waitFor(() => {
      const r = report();
      return r?.kind === "exchange" && r.received > received;
    }, "the hooked agent's second report", 300_000);
    check(existsSync(hookMarker), "after Always the agent's next query ran the repo's hook");
    const dirs = [...new Set(readFileSync(hookMarker, "utf8").trim().split("\n"))];
    const trust = stateFile().gate.repos;
    check(JSON.stringify(dirs) === JSON.stringify([hooked]) && trust.some((r: { root: string; agentId: string | null; trusted: boolean }) => r.root === hooked && r.agentId === null && r.trusted), `the hook ran from the repo itself and the repo is trusted in state: ${JSON.stringify(dirs)}`);
    await c.waitFor(() => c.resting(claudio), "the bot to rest after the second report", 300_000);
    return `no hook output before trust; card "${card.label}: ${card.detail}"; after Always, CLAUDE_PROJECT_DIR seen by the hook ${JSON.stringify(dirs)}`;
  });

  await scenario("routines are created", async () => {
    const before = c.messages(claudio).length;
    await c.ask(
      claudio,
      'Call set_routine twice now. First: name "quiet-check", schedule "0 3 * * *", prompt "There is never anything here worth reporting." ' +
        'Second: name "ping", schedule "0 4 * * *", prompt "Tell Alex the single word pong. That is always worth telling." Then confirm in one line.',
      "the routines",
    );
    const routines = await c.waitFor(() => {
      const rs = c.bots.get(claudio)?.routines ?? [];
      return rs.length >= 2 && rs;
    }, "both routines on the bot frame", 10_000);
    check(routines.find((r) => r.name === "quiet-check")?.describe === "Every day at 3:00 AM", "quiet-check runs every day at 3:00 AM");
    check(routines.find((r) => r.name === "ping")?.describe === "Every day at 4:00 AM", "ping runs every day at 4:00 AM");
    check(notesOf(c, claudio, before).filter((n) => n === "Created routine {0}").length === 2, "each routine posts a Created routine note");
    return routines.map((r) => `${r.name}: ${r.describe}, next ${r.nextRunAt}`).join("; ");
  });

  const countBefore = c.messages(claudio).length;
  const idsBefore = new Set(c.messages(claudio).map((m) => m.id));
  const botsBefore = [...c.bots.keys()].sort();
  const pushedWhileLive = pushes.filter((p) => p.at >= connectedAt).length;
  c.close();
  old.close();
  await stopServer();

  // Both routines come due while the bridge is down, so its first tick after the restart fires them.
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const due = new Date(Date.now() - 30_000).toISOString();
  for (const b of state.bots) for (const r of b.routines) r.nextRunAt = due;
  writeFileSync(statePath, JSON.stringify(state));
  chmodSync(statePath, 0o600);

  const again = (await startServer()) === null;

  await scenario("push goes out only while no phone is connected", async () => {
    check(pushedWhileLive === 0, `nothing was pushed while a socket was live, through ${countBefore} messages and every card (got ${pushedWhileLive})`);
    const pushed = await (async () => {
      const deadline = Date.now() + TURN_MS;
      while (Date.now() < deadline) {
        const p = pushes.find((x) => x.body.includes("has an update for you"));
        if (p) return p;
        await Bun.sleep(500);
      }
      return null;
    })();
    check(pushed !== null && pushed.body === "Claudio Bot has an update for you" && pushed.click?.startsWith(`claudiobot://bot/${claudio}?message=`), `with no socket, the routine's report pushed: ${JSON.stringify(pushed)}`);
    return `0 pushes while connected; then ${pushes.length} with no socket: ${JSON.stringify(pushes.map((p) => p.body))}`;
  });

  const r = connect(token);
  await r.opened;

  await scenario("restart recovery", async () => {
    check(again, "the restarted bridge prints no pair code: the device stays paired");
    await r.waitFor(() => r.received.find((m) => m.type === "hello"), "hello after restart", 10_000);
    check(JSON.stringify([...r.bots.keys()].sort()) === JSON.stringify(botsBefore), "a restart keeps the bots");
    r.send({ type: "open", botId: claudio });
    await r.waitFor(() => r.received.find((m) => m.type === "conversation"), "the conversation after restart", 10_000);
    check([...idsBefore].every((id) => r.messages(claudio).some((m) => m.id === id)), `a restart keeps all ${countBefore} messages`);
    return `same ${botsBefore.length} bots, all ${countBefore} messages kept, token still accepted`;
  });

  await scenario("a quiet routine run posts nothing; a non-quiet one posts and settles ok", async () => {
    const routineOf = (name: string) => r.bots.get(claudio)?.routines.find((x) => x.name === name);
    await r.waitFor(() => {
      const statuses = ["quiet-check", "ping"].map((n) => routineOf(n)?.runs[0]?.status);
      return statuses.every((s) => s !== undefined && s !== "running") && r.resting(claudio);
    }, "both routine runs to settle");
    const quiet = routineOf("quiet-check")!.runs[0]!;
    const ping = routineOf("ping")!.runs[0]!;
    const said = r.botSays(claudio, countBefore).map((m) => m.text);
    check(log.includes("[Routine quiet-check fired]") && log.includes("[Routine ping fired]"), "both routines fired after the restart");
    check(quiet.status === "quiet", `quiet-check settled quiet (got ${quiet.status}${quiet.note ? `: ${quiet.note}` : ""})`);
    check(ping.status === "ok", `ping settled ok (got ${ping.status}${ping.note ? `: ${ping.note}` : ""})`);
    check(said.length > 0 && said.every((t) => /pong/i.test(t)), `only ping's bubbles reached the chat: ${JSON.stringify(said)}`);
    return `quiet-check ${quiet.status}, ping ${ping.status}; bubbles after restart ${JSON.stringify(said)}`;
  });

  await scenario("the bot resumes its session after the restart", async () => {
    const recalled = await r.ask(claudio, "What codeword did I give you earlier? Reply with only the codeword.", "the recalled codeword");
    check(recalled.toLowerCase().includes("zephyr"), `the bot remembers the codeword: "${recalled}"`);
    return `recalled "${recalled}"`;
  });

  r.close();
  passed = true;
} finally {
  await stopServer();
  let total = 0;
  for (const m of log.matchAll(/^result (\S+) (\S+) session=(\S+) totalCostUsd=\S+ deltaUsd=([\d.e-]+)$/gm)) total += Number(m[4]);
  console.log("\n== results");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"} ${x.scenario}: ${x.evidence}`);
  console.log(`model ${MODEL}; cost charged by the ledger $${total.toFixed(4)}`);
  // Every call the gate did not pass, so a hold or refusal of ordinary work shows up even when the bot worked around it.
  const auditDir = join(home, "audit");
  const audit = existsSync(auditDir)
    ? readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];
  const counts = audit.reduce<Record<string, number>>((n, r) => ({ ...n, [r.decision]: (n[r.decision] ?? 0) + 1 }), {});
  console.log(`gate: ${audit.length} calls ${JSON.stringify(counts)}`);
  for (const r of audit.filter((r) => r.decision !== "pass")) {
    const input = typeof r.input?.command === "string" ? r.input.command : JSON.stringify(r.input);
    console.log(`gate: ${r.decision} ${r.actor.split(":")[0]} ${r.tool} rule=${r.rule ?? "-"} via=${r.via ?? "-"} ${String(input).slice(0, 140)}`);
  }
  if (process.env.E2E_BRIDGE_LOG) writeFileSync(process.env.E2E_BRIDGE_LOG, log);
  ntfy.stop(true);
  if (passed) rmSync(scratch, { recursive: true });
  else console.log(`scratch kept for debugging: ${scratch}`);
}
