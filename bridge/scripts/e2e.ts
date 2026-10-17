// End to end against the real bridge and real Claude Code, through the WebSocket like the app, in a temp home.
// Run: bun run e2e. It spends real usage (about a dollar or two), never starts a cloud agent, and never touches
// ~/.claudebot or ~/.claudiobot: CLAUDIOBOT_HOME points into a temp folder, which skips migration.
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const origin = join(scratch, "origin.git");
const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} -c user.name=e2e -c user.email=e2e@example.com ${args}`.quiet();
const head = async (repo: string, ref = "main") => (await git(repo, "rev-parse", ref)).text().trim();

mkdirSync(demo, { recursive: true });
await Bun.$`git init -q -b main ${demo}`.quiet();
await git(demo, "commit", "-q", "--allow-empty", "-m", "init");
await Bun.$`git init -q --bare -b main ${origin}`.quiet();
await Bun.$`git clone -q ${origin} ${pushme}`.quiet();
await git(pushme, "commit", "-q", "--allow-empty", "-m", "init");
await git(pushme, "push", "-q", "origin", "main");

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);

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
  };
  delete env.CLAUDIOBOT_PUSH_URL;
  delete env.CLAUDEBOT_HOME;
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

/** protocol3 false is today's app: no ?protocol=3, so permission cards arrive as questions. */
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
const pids = async (pattern: string) => (await Bun.$`pgrep -f ${pattern}`.nothrow().quiet()).text().trim();
const notesOf = (c: Client, botId: BotId, after = 0) => c.messages(botId).slice(after).flatMap((m) => (m.kind === "note" ? [m.text] : []));

let passed = false;
let token = "";
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

  await scenario("an agent report", async () => {
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
    c.send({ type: "details", botId: claudio });
    const details = await c.waitFor(() => c.received.findLast((m) => m.type === "details"), "details", 10_000);
    check(details.type === "details" && details.agents.some((a) => a.title === "Add hello file" && a.where === "mac" && a.status === "waiting"), "details lists the mac agent as waiting");
    return `exchange received ${report.kind === "exchange" ? report.received : 0}; bot said "${c.botSays(claudio, at + 1).map((m) => m.text).join(" ").slice(0, 100)}"; demo HEAD ${(await head(demo)).slice(0, 7)}`;
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

  async function heldPush(viaLegacy: boolean) {
    const before = c.messages(claudio).length;
    const remoteBefore = await head(origin);
    const local = await head(pushme);
    check(local !== remoteBefore, "pushme has a commit origin does not");
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text: `Run exactly this shell command: git -C ${pushme} push origin main\nIf it is held for approval, say so in one line and end your turn.`,
    });
    const card = await c.waitFor(
      () => c.messages(claudio).slice(before).find((m): m is Extract<Message, { kind: "permission" }> => m.kind === "permission" && m.answer === null),
      "the permission card",
    );
    check(card.tool === "Bash" && card.detail.includes("push origin main") && card.label === "Push to the default branch", `a permission card holds the push: "${card.label}: ${card.detail}"`);
    await c.waitFor(() => c.resting(claudio), "the held turn to end");
    check(c.status(claudio) === "awaiting_approval", "the bot rests as awaiting approval");
    check((await head(origin)) === remoteBefore, "origin's main did not move before approval");
    const shown = await old.waitFor(() => old.messages(claudio).find((m) => m.id === card.id), "today's app to see the card", 10_000);
    check(shown.kind === "question" && JSON.stringify(shown.options) === JSON.stringify(["Allow once", "Deny"]), "today's app sees it as an Allow once / Deny question");
    if (viaLegacy) old.send({ type: "answer", botId: claudio, messageId: card.id, option: 0 });
    else c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "once" });
    await c.waitFor(() => c.messages(claudio).find((m) => m.id === card.id && m.kind === "permission" && m.answer === "once"), "the card to close as once", 10_000);
    const pushedAt = Date.now();
    const deadline = pushedAt + TURN_MS;
    while ((await head(origin)) !== local && Date.now() < deadline) await Bun.sleep(500);
    check((await head(origin)) === local, "after Allow once the push ran: origin's main is pushme's main");
    await c.waitFor(() => c.resting(claudio), "the continuation turn to end");
    return `card "${card.label}: ${card.detail}"; origin main ${remoteBefore.slice(0, 7)} held until ${viaLegacy ? "answer option 0 from a protocol 2 socket" : "decide once"}, then ${local.slice(0, 7)}`;
  }

  await scenario("a held git push runs only after Allow once", async () => {
    await git(pushme, "commit", "-q", "--allow-empty", "-m", "first change");
    return heldPush(false);
  });

  await scenario("today's app approves a held push through its question card", async () => {
    await git(pushme, "commit", "-q", "--allow-empty", "-m", "second change");
    return heldPush(true);
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
  if (passed) rmSync(scratch, { recursive: true });
  else console.log(`scratch kept for debugging: ${scratch}`);
}
