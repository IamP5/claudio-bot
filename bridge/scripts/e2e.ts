// End to end against the real bridge and real Claude Code (haiku), through the WebSocket like the app. Run: bun run e2e
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotId, ClientMessage, Message, ServerMessage } from "../src/protocol";

const TURN_MS = 180_000;

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "claudebot-e2e-")));
const home = join(scratch, "home");
const roots = join(scratch, "roots");
const repo = join(roots, "demo");
mkdirSync(repo, { recursive: true });
await Bun.$`git init -q -b main ${repo} && git -C ${repo} -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m init`;

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);

let server: Subprocess<"ignore", "pipe", "inherit"> | null = null;
let log = "";

async function startServer(): Promise<string> {
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/main.ts")], {
    env: {
      ...process.env,
      CLAUDEBOT_PORT: String(port),
      CLAUDEBOT_ROOTS: roots,
      CLAUDEBOT_HOME: home,
      CLAUDEBOT_MODEL: "haiku",
      CLAUDEBOT_USER_NAME: "Bruno",
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const started = log.length;
  (async () => {
    for await (const chunk of server!.stdout) log += new TextDecoder().decode(chunk);
  })();
  while (!/token: [0-9a-f]{64}/.test(log.slice(started))) {
    if (server.exitCode !== null) throw new Error(`server exited before printing its token:\n${log}`);
    await Bun.sleep(50);
  }
  return log.slice(started).match(/token: ([0-9a-f]{64})/)![1]!;
}

async function stopServer() {
  server?.kill("SIGTERM");
  await server?.exited;
  server = null;
}

function connect(token: string) {
  const bots = new Map<BotId, Bot>();
  const conversations = new Map<BotId, Message[]>();
  const received: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);

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
    for (const wake of waiters) wake();
  };

  function waitFor<T>(find: () => T | undefined | null | false, what: string, timeoutMs = TURN_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(poll, 1000);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        waiters.delete(poll);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      function poll() {
        const found = find();
        if (found === undefined || found === null || found === false) return;
        clearInterval(timer);
        clearTimeout(deadline);
        waiters.delete(poll);
        resolve(found);
      }
      waiters.add(poll);
      poll();
    });
  }

  const messages = (botId: BotId) => conversations.get(botId) ?? [];
  const botSays = (botId: BotId, after: number) => messages(botId).slice(after).filter((m) => m.kind === "bot");
  const idle = (botId: BotId) => bots.get(botId)?.status === "idle";

  return {
    bots,
    received,
    messages,
    waitFor,
    send: (m: ClientMessage) => ws.send(JSON.stringify(m)),
    opened: new Promise<void>((resolve) => (ws.onopen = () => resolve())),
    close: () => ws.close(),
    // Sends text and waits for the bot to finish a turn that said something.
    async ask(botId: BotId, text: string, what: string) {
      const before = messages(botId).length;
      this.send({ type: "send", botId, text, uploads: [] });
      await waitFor(() => botSays(botId, before).length > 0 && idle(botId), what);
      return botSays(botId, before).map((m) => (m.kind === "bot" ? m.text : "")).join("\n");
    },
    botSays,
    idle,
  };
}

let passed = false;
try {
  let client = connect(await startServer());
  await client.opened;
  const hello = await client.waitFor(() => client.received.find((m) => m.type === "hello"), "hello");
  check(hello.type === "hello" && hello.userName === "Bruno", "hello names the user from CLAUDEBOT_USER_NAME");
  const claudeBot = [...client.bots.values()].find((b) => b.name === "Claude Bot");
  check(claudeBot?.avatar.shape === "circle" && claudeBot.avatar.color === "white", "first start creates Claude Bot, a white circle");
  client.send({ type: "open", botId: claudeBot.id });
  const greeting = await client.waitFor(() => client.botSays(claudeBot.id, 0)[0], "the default bot's greeting");
  check(greeting.kind === "bot" && greeting.text.length > 0, `(a) the default bot greets on first start: "${greeting.kind === "bot" && greeting.text.split("\n")[0]}"`);
  await client.waitFor(() => client.idle(claudeBot.id), "the greeting turn to end");

  const ack = await client.ask(claudeBot.id, "Remember the codeword zephyr-42 for later. Reply with just OK.", "the codeword ack");
  check(ack.length > 0, "the bot acknowledges the codeword before the restart");

  client.send({ type: "create_bot", ref: "c1" });
  const created = await client.waitFor(() => client.received.find((m) => m.type === "created" && m.ref === "c1"), "created");
  const newBotId = created.type === "created" ? created.botId : ("" as BotId);
  check(client.bots.get(newBotId)?.name === "New Bot", "create_bot from the app makes New Bot");
  const card = await client.waitFor(
    () =>
      client
        .messages(newBotId)
        .find((m): m is Extract<Message, { kind: "question" }> => m.kind === "question" && client.bots.get(newBotId)?.question === m.question),
    "the onboarding question card",
  );
  check(card.options.length >= 2, `(b) the new bot asks an onboarding card: "${card.question}"`);
  await client.waitFor(() => client.idle(newBotId), "the onboarding turn to end");
  const beforeAnswer = client.messages(newBotId).length;
  client.send({ type: "answer", botId: newBotId, messageId: card.id, option: 0 });
  await client.waitFor(() => client.messages(newBotId).find((m) => m.id === card.id && m.kind === "question" && m.answer === 0), "the answered card");
  await client.waitFor(() => log.includes(`[Bruno answered "${card.question}": ${card.options[0]}]`), "the answer envelope", 10_000);
  check(true, "(b) answering the card delivers the answer envelope");
  await client.waitFor(() => client.botSays(newBotId, beforeAnswer).length > 0 && client.idle(newBotId), "the reply to the answer");
  check(true, `(b) the bot replies to the answer, and is now named ${client.bots.get(newBotId)?.name}`);

  const beforeAgent = client.messages(claudeBot.id).length;
  client.send({
    type: "send",
    botId: claudeBot.id,
    uploads: [],
    text:
      'Call start_agent now with where "mac", project "demo", title "Add hello file", and this prompt: ' +
      '"Create a file named hello.txt in the repository root containing exactly the line: hello from agent. Commit it. There is no remote, so skip the PR. Then reply DONE." ' +
      "When the agent reports, tell me in one line whether hello.txt exists.",
  });
  const agentExchange = await client.waitFor(
    () => client.messages(claudeBot.id).slice(beforeAgent).find((m) => m.kind === "exchange" && m.peer.kind === "agent" && m.received >= 1),
    "the agent's report",
    300_000,
  );
  const sent = client.messages(claudeBot.id).slice(beforeAgent).filter((m) => m.kind === "exchange" && m.peer.kind === "agent");
  check(sent.some((m) => m.kind === "exchange" && m.sent >= 1), "(c) starting a mac agent posts an exchange with the agent");
  check(agentExchange.kind === "exchange", "(c) the agent's report comes back as a received exchange message");
  check(log.includes('[Agent "'), "(c) the report reaches the bot as an agent envelope");
  const exchangeAt = client.messages(claudeBot.id).findIndex((m) => m.id === agentExchange.id);
  await client.waitFor(() => client.botSays(claudeBot.id, exchangeAt + 1).length > 0 && client.idle(claudeBot.id), "the bot's reply to the report");
  check(true, `(c) the bot replies after the report: "${client.botSays(claudeBot.id, exchangeAt + 1).map((m) => (m.kind === "bot" ? m.text : "")).join(" ").slice(0, 120)}"`);
  check(existsSync(join(repo, "hello.txt")) && readFileSync(join(repo, "hello.txt"), "utf8").includes("hello from agent"), "(c) the agent created hello.txt in the demo repo");

  client.send({ type: "details", botId: claudeBot.id });
  const details = await client.waitFor(() => client.received.findLast((m) => m.type === "details" && m.botId === claudeBot.id), "details", 10_000);
  check(details.type === "details" && details.agents.some((a) => a.title === "Add hello file" && a.where === "mac" && a.status === "waiting"), "details lists the mac agent as waiting");
  client.send({ type: "agent", agentId: details.type === "details" ? details.agents[0]!.id : ("" as never) });
  const agentView = await client.waitFor(() => client.received.findLast((m) => m.type === "agent" && m.messages.length >= 2), "the agent view", 10_000);
  check(agentView.type === "agent" && agentView.messages[0]?.from === "bot" && agentView.messages.at(-1)?.from === "agent", "the agent view has the bot's prompt and the agent's report");
  const errorsBefore = client.received.filter((m) => m.type === "error").length;
  client.send({ type: "file", botId: claudeBot.id, path: "../../state.json" });
  await client.waitFor(() => client.received.filter((m) => m.type === "error").length > errorsBefore, "the path escape refusal", 10_000);
  check(!client.received.some((m) => m.type === "file" && m.path === "../../state.json"), "file refuses a path outside the bot home");
  client.send({ type: "file", botId: claudeBot.id, path: "CLAUDE.md" });
  const memory = await client.waitFor(() => client.received.find((m) => m.type === "file" && m.path === "CLAUDE.md"), "CLAUDE.md", 10_000);
  check(memory.type === "file" && memory.content?.startsWith("# Claude Bot"), "file reads the bot's CLAUDE.md from its home");

  const routineAsked = Date.now();
  const beforeRoutine = client.messages(newBotId).length;
  client.send({
    type: "send",
    botId: newBotId,
    uploads: [],
    text: 'Call set_routine now with name "ping", schedule "* * * * *" and prompt "Reply with exactly the word pong." Then confirm in one line.',
  });
  const routine = await client.waitFor(() => client.bots.get(newBotId)?.routines.find((r) => r.name === "ping"), "the routine");
  check(routine.describe === "Every minute", "(d) set_routine makes a routine described as Every minute");
  check(
    client.messages(newBotId).slice(beforeRoutine).some((m) => m.kind === "note" && m.text === "Created routine {0}" && m.refs[0]?.kind === "routine"),
    "(d) set_routine posts a Created routine note with a routine chip",
  );
  const fired = await client.waitFor(() => client.bots.get(newBotId)?.routines.find((r) => r.name === "ping" && r.lastRunAt), "the routine to fire", 75_000);
  const firedAfter = (Date.now() - routineAsked) / 1000;
  check(log.includes("[Routine ping fired]") && firedAfter <= 75, `(d) the routine fired ${firedAfter.toFixed(0)} s after the request`);
  const firedAt = client.messages(newBotId).length;
  client.send({ type: "set_routine", botId: newBotId, routineId: fired.id, enabled: false });
  await client.waitFor(() => client.bots.get(newBotId)?.routines.find((r) => r.id === fired.id && !r.enabled), "the routine to pause", 10_000);
  await client.waitFor(() => client.botSays(newBotId, firedAt).length > 0 && client.idle(newBotId), "the routine's bot message");
  check(true, `(d) the routine run produced a bot message: "${client.botSays(newBotId, firedAt).map((m) => (m.kind === "bot" ? m.text : "")).join(" ").slice(0, 80)}"`);

  const countBefore = client.messages(claudeBot.id).length;
  const botsBefore = [...client.bots.keys()].sort();
  client.close();
  await stopServer();

  client = connect(await startServer());
  await client.opened;
  await client.waitFor(() => client.received.find((m) => m.type === "hello"), "hello after restart");
  check(JSON.stringify([...client.bots.keys()].sort()) === JSON.stringify(botsBefore), "(e) a restart keeps the bots");
  check(client.bots.get(newBotId)?.routines[0]?.enabled === false, "(e) a restart keeps the paused routine");
  client.send({ type: "open", botId: claudeBot.id });
  await client.waitFor(() => client.messages(claudeBot.id).length >= countBefore, "the conversation after restart", 10_000);
  check(client.messages(claudeBot.id).length === countBefore, "(e) a restart keeps the conversation");
  const recalled = await client.ask(claudeBot.id, "What codeword did I give you earlier? Reply with only the codeword.", "the recalled codeword");
  check(recalled.toLowerCase().includes("zephyr"), `(e) the bot resumes its session and remembers the codeword: "${recalled}"`);
  client.close();
  passed = true;
} finally {
  await stopServer();
  const totals = new Map<string, { label: string; usd: number }>();
  for (const m of log.matchAll(/^result (.+) session=(\S+) totalCostUsd=([\d.e-]+)$/gm)) {
    totals.set(m[2]!, { label: m[1]!, usd: Math.max(totals.get(m[2]!)?.usd ?? 0, Number(m[3])) });
  }
  for (const [session, { label, usd }] of totals) console.log(`cost: ${label} session ${session} $${usd.toFixed(4)}`);
  console.log(`cost: total $${[...totals.values()].reduce((a, b) => a + b.usd, 0).toFixed(4)}`);
  if (passed) rmSync(scratch, { recursive: true });
  else console.log(`scratch kept for debugging: ${scratch}`);
}
