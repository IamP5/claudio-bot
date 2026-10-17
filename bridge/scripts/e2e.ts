// End to end against the real bridge and real Claude Code, through the WebSocket like the app, in a temp home.
// Run: bun run e2e. It spends real usage and never touches ~/.claudebot, ~/.claudiobot or ~/.claudiobot-worktrees:
// CLAUDIOBOT_HOME, CLAUDIOBOT_WORKTREES and every project root point into a temp folder, which skips migration. HOME
// stays real only for the Claude login. The bridge gets no SSH_AUTH_SOCK and no GitHub token, push goes to a fake ntfy
// server here, pushes go to local bare repositories, claude.ai connectors are off, and CLAUDIOBOT_CLAUDE is a wrapper
// that runs the real claude for local queries and refuses --cloud, so no cloud agent can start. The run checks all of
// this before it starts the bridge and stops once the ledger has charged E2E_BUDGET_USD (default 8).
// E2E_MODEL overrides the model; E2E_BRIDGE_LOG names a file for the bridge's own log.
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotId, ClientMessage, Message, ServerMessage } from "../src/protocol";

// haiku 4.5 and sonnet 4.5 silently run in default mode when auto is asked for.
const MODEL = process.env.E2E_MODEL ?? "claude-sonnet-5-5";
const TURN_MS = 240_000;
const USER = "Alex";
const BUDGET_USD = Number(process.env.E2E_BUDGET_USD ?? 8);

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
const worktrees = join(scratch, "worktrees");
const bin = join(scratch, "bin");
const cloudMarker = join(scratch, "cloud-attempt.txt");
const mcpServer = join(scratch, "e2e-echo-server.ts");
const mcpMarker = join(scratch, "mcp-called.txt");
const realWorktrees = join(homedir(), ".claudiobot-worktrees");
const realWorktreesBefore = existsSync(realWorktrees) ? readdirSync(realWorktrees).sort().join(",") : null;
// Commits here are never signed: the bridge gets no SSH agent, so a signing key could not be used inside its sandbox.
const git = (repo: string, ...args: string[]) => Bun.$`git -C ${repo} -c user.name=e2e -c user.email=e2e@example.com -c commit.gpgsign=false ${args}`.quiet();
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
await git(demo, "config", "commit.gpgsign", "false");
writeFileSync(join(demo, ".gitignore"), ".env\n");
await git(demo, "add", ".gitignore");
await git(demo, "commit", "-q", "-m", "init");
await pushPair(pushme, origin);
// A repo whose committed settings run a hook at session start and before every tool call.
mkdirSync(join(hooked, ".claude"), { recursive: true });
await Bun.$`git init -q -b main ${hooked}`.quiet();
const hook = { type: "command", command: `echo "$CLAUDE_PROJECT_DIR" >> ${hookMarker}` };
writeFileSync(join(hooked, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }], PreToolUse: [{ hooks: [hook] }] } }, null, 2));
await git(hooked, "add", ".");
await git(hooked, "commit", "-q", "-m", "commit a project hook");

const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const free = probe.port;
  probe.stop(true);
  return free;
};
const port = freePort();
const webhookPort = freePort();

// claude for local queries; --cloud is refused and recorded, so a cloud agent can never start.
const realClaude = Bun.which("claude");
if (!realClaude || realClaude.startsWith(scratch)) throw new Error("the real claude CLI is not on PATH");
mkdirSync(bin);
const wrapper = join(bin, "claude");
writeFileSync(
  wrapper,
  `#!/bin/sh\nfor a in "$@"; do case "$a" in --cloud|--remote|--teleport) echo "$*" >> '${cloudMarker}'; echo "cloud agents are off in the e2e" >&2; exit 1;; esac; done\nexec '${realClaude}' "$@"\n`,
  { mode: 0o755 },
);

// A stdio MCP server the bot's project .mcp.json names: its one tool records every call.
const sdk = join(import.meta.dir, "../node_modules/@modelcontextprotocol/sdk/dist/esm/server");
writeFileSync(
  mcpServer,
  `import { McpServer } from ${JSON.stringify(join(sdk, "mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(join(sdk, "stdio.js"))};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "e2e-echo", version: "1.0.0" });
server.tool("ping", "Answers PONG-E2E.", async () => {
  appendFileSync(${JSON.stringify(mcpMarker)}, "called\\n");
  return { content: [{ type: "text", text: "PONG-E2E" }] };
});
await server.connect(new StdioServerTransport());
`,
);
const mcpCalls = () => (existsSync(mcpMarker) ? readFileSync(mcpMarker, "utf8").trim().split("\n").filter(Boolean).length : 0);

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
const spent = () => [...log.matchAll(/^result (\S+) (\S+) session=(\S+) totalCostUsd=\S+ deltaUsd=([\d.e-]+)$/gm)].reduce((n, m) => n + Number(m[4]), 0);

/** Every isolation rule, read from the environment the bridge will get. A failed rule stops the run before it starts. */
function verifyIsolation(env: Record<string, string | undefined>) {
  const inScratch = (v: string | undefined) => v !== undefined && v.startsWith(`${scratch}/`);
  const wrapped = readFileSync(wrapper, "utf8");
  const rules: [boolean, string][] = [
    [env.HOME === homedir(), `HOME is the real home, for the Claude login only (${env.HOME})`],
    [inScratch(env.CLAUDIOBOT_HOME), `CLAUDIOBOT_HOME is temporary (${env.CLAUDIOBOT_HOME})`],
    [inScratch(env.CLAUDIOBOT_ROOTS), `every project root is temporary (${env.CLAUDIOBOT_ROOTS})`],
    [inScratch(env.CLAUDIOBOT_WORKTREES), `worktrees are temporary (${env.CLAUDIOBOT_WORKTREES})`],
    [env.SSH_AUTH_SOCK === undefined, "SSH_AUTH_SOCK is unset"],
    [env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined, "GH_TOKEN and GITHUB_TOKEN are unset"],
    [env.ENABLE_CLAUDEAI_MCP_SERVERS === "false", "claude.ai connectors are off"],
    [env.CLAUDIOBOT_CLAUDE === wrapper && wrapped.includes("--cloud") && wrapped.includes(`exec '${realClaude}'`), `CLAUDIOBOT_CLAUDE refuses --cloud and runs ${realClaude} otherwise`],
    [env.PATH?.startsWith(`${bin}:`) === true, "claude on PATH is the same wrapper"],
    [env.CLAUDIOBOT_PUSH_URL?.startsWith("http://127.0.0.1:") === true, "push goes to a local fake ntfy"],
    [MODEL === "claude-sonnet-5-5" || process.env.E2E_MODEL !== undefined, `model ${MODEL}`],
  ];
  for (const [ok, what] of rules) console.log(`isolation ${ok ? "ok" : "FAILED"}: ${what}`);
  if (rules.some(([ok]) => !ok)) throw new Error("isolation check failed; nothing was started");
}

async function startServer() {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDIOBOT_PORT: String(port),
    CLAUDIOBOT_ROOTS: roots,
    CLAUDIOBOT_HOME: home,
    CLAUDIOBOT_MODEL: MODEL,
    CLAUDIOBOT_USER_NAME: USER,
    CLAUDIOBOT_PUSH_URL: `http://127.0.0.1:${ntfy.port}/e2e`,
    CLAUDIOBOT_WORKTREES: worktrees,
    CLAUDIOBOT_WEBHOOK_PORT: String(webhookPort),
    CLAUDIOBOT_CLAUDE: wrapper,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
  for (const name of ["CLAUDEBOT_HOME", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDIOBOT_ALLOWED_DOMAINS", "CLAUDIOBOT_SANDBOX_STRICT_NETWORK", "CLAUDIOBOT_SANDBOX_GH"]) delete env[name];
  verifyIsolation(env);
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
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stopServer().then(() => process.exit(130)));

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
      if (spent() > BUDGET_USD) throw new Error(`stopped: the ledger charged $${spent().toFixed(2)}, over the $${BUDGET_USD} budget`);
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
    // The bot's project MCP config, approved in its project settings. Its query picks it up when it next reopens.
    const own = join(home, "bots", claudio);
    writeFileSync(join(own, ".mcp.json"), JSON.stringify({ mcpServers: { "e2e-echo": { command: process.execPath, args: [mcpServer] } } }));
    mkdirSync(join(own, ".claude"), { recursive: true, mode: 0o700 });
    writeFileSync(join(own, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["e2e-echo"] }));
    legacy = connect(token, false);
    await legacy.opened;
    return `code ${code} paired over POST /pair with a Bearer token; greeting "${greeting.text.split("\n")[0]!.slice(0, 80)}"`;
  });
  const c = client as unknown as Client;
  const old = legacy as unknown as Client;
  const botHome = join(home, "bots", claudio);
  const userMd = () => readFileSync(join(home, "USER.md"), "utf8");
  const framesOf = <T extends ServerMessage["type"]>(x: Client, type: T, after = 0) =>
    x.received.slice(after).filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  const cardsSince = (after: number) => c.messages(claudio).slice(after).filter((m) => m.kind === "permission");

  await scenario("a user turn", async () => {
    const ack = await c.ask(claudio, "Remember the codeword zephyr-42 for later. Reply with just OK.", "the codeword ack");
    check(ack.length > 0, "the bot answers the user's message");
    return `reply "${ack.slice(0, 60)}"`;
  });

  await scenario("a remembered fact stays a proposal until the user confirms it, and a resent send posts once", async () => {
    const before = c.messages(claudio).length;
    const receivedBefore = c.received.length;
    const send: ClientMessage = { type: "send", botId: claudio, uploads: [], clientId: "e2e-send-1", text: "Remember with your remember tool that I prefer short answers. Then reply with just OK." };
    c.send(send);
    c.send(send);
    await c.waitFor(() => c.botSays(claudio, before).length > 0 && c.resting(claudio), "the remember turn");
    const users = c.messages(claudio).slice(before).filter((m) => m.kind === "user");
    check(users.length === 1 && users[0]!.kind === "user" && users[0]!.clientId === "e2e-send-1", `the send sent twice posted one user message (${users.length})`);
    const echoes = framesOf(c, "message", receivedBefore).filter((m) => m.message.kind === "user" && m.message.clientId === "e2e-send-1");
    check(echoes.length === 2 && echoes[0]!.message.id === echoes[1]!.message.id, `the repeat was answered with the same message (${echoes.length} frames)`);
    check(cardsSince(before).length === 0, "remembering in a user turn opened no card");
    const remembered = auditRows().filter((r) => r.tool === "mcp__claudio__remember");
    check(remembered.length > 0 && remembered.every((r) => r.decision === "pass"), `the remember call passed: ${remembered.map((r) => r.decision).join(",")}`);
    const line = userMd().split("\n").find((l) => /short answers/i.test(l));
    check(line !== undefined && line.includes(`proposed:${claudio}`), `USER.md holds the fact as this bot's proposal: ${JSON.stringify(line)}`);
    const proposed = await c.waitFor(() => framesOf(c, "memory", receivedBefore).at(-1)?.facts.find((f) => /short answers/i.test(f.text) && !f.confirmed), "a memory frame with the proposal", 10_000);

    const at = c.received.length;
    c.send({ type: "confirm_fact", factId: proposed.id });
    await c.waitFor(() => framesOf(c, "memory", at).at(-1)?.facts.find((f) => f.id === proposed.id && f.confirmed), "the confirmed fact", 10_000);
    const confirmedLine = userMd().split("\n").find((l) => l.includes(proposed.id));
    check(confirmedLine !== undefined && !confirmedLine.includes("proposed:"), `confirming drops the proposal mark: ${JSON.stringify(confirmedLine)}`);

    const color = "chartreuse-nine";
    const set = c.received.length;
    c.send({ type: "set_fact", factId: null, text: `${USER}'s favorite color is ${color}` });
    await c.waitFor(() => framesOf(c, "memory", set).at(-1)?.facts.some((f) => f.text.includes(color) && f.confirmed && f.by === null), "the user's own fact", 10_000);
    const recalled = await c.ask(claudio, "Going only by what you know about me, what is my favorite color? Reply with only the color.", "the recalled color");
    check(recalled.toLowerCase().includes(color), `a fact the bot never heard in chat reached its next query: "${recalled}"`);
    return `one user message for two sends; ${JSON.stringify(line)} then confirmed; set_fact color recalled as "${recalled}"`;
  });

  await scenario("a protocol 3 phone sees what the bot is doing; a protocol 2 phone does not", async () => {
    writeFileSync(join(botHome, "activity-check.txt"), "lantern\n");
    const at = c.received.length;
    const reply = await c.ask(claudio, "Use the Read tool on activity-check.txt in your home folder and reply with only the word in it.", "the read");
    const lines = framesOf(c, "activity", at).filter((f) => f.botId === claudio && f.agentId === null);
    const shown = lines.findIndex((f) => f.text !== null);
    check(shown >= 0 && lines.every((f) => !("seq" in f)), `an activity line arrived without a seq: ${JSON.stringify(lines.map((f) => f.text))}`);
    check(lines.slice(shown + 1).some((f) => f.text === null) && lines.at(-1)!.text === null, "the line cleared when the turn ended");
    check(framesOf(old, "activity").length === 0, "the protocol 2 socket received no activity frame");
    check(reply.toLowerCase().includes("lantern"), `the bot read the file: "${reply}"`);
    return `lines ${JSON.stringify(lines.map((f) => f.text))}; protocol 2 got none`;
  });

  await scenario("a skill the bot saves loads in its next turn, and the user deletes it", async () => {
    const description = 'Reply to "greet": say GREET-OK';
    const at = c.received.length;
    await c.ask(
      claudio,
      `Call save_skill now with name "greet", description '${description}', and body "When this skill is used, reply with exactly GREET-OK and nothing else." Then confirm in one line.`,
      "the saved skill",
    );
    const listed = await c.waitFor(() => framesOf(c, "skills", at).find((f) => f.botId === claudio && f.skills.some((k) => k.name === "greet")), "a skills frame with greet", 10_000);
    const file = join(botHome, ".claude", "skills", "greet", "SKILL.md");
    check(existsSync(file) && readFileSync(file, "utf8").includes(`description: ${JSON.stringify(description)}`), "SKILL.md holds the quoted description");
    check(listed.skills.find((k) => k.name === "greet")!.description === description, "the phone lists greet with its description");
    const skillCalls = () => auditRows().filter((r) => r.tool === "Skill").length;
    const callsBefore = skillCalls();
    const used = await c.ask(claudio, "Use the greet skill.", "the skill's reply");
    check(skillCalls() > callsBefore, "the bot called the Skill tool");
    check(used.includes("GREET-OK"), `the skill's body ran: "${used}"`);
    const del = c.received.length;
    c.send({ type: "delete_skill", botId: claudio, name: "greet" });
    await c.waitFor(() => framesOf(c, "skills", del).find((f) => f.botId === claudio && f.skills.length === 0), "the empty skills list", 10_000);
    check(!existsSync(join(botHome, ".claude", "skills", "greet")), "the skill's folder is gone");
    return `saved, Skill tool called, reply "${used}", deleted`;
  });

  await scenario("the user turns a connector off for a bot", async () => {
    const reply = await c.ask(claudio, "Call the ping tool of the MCP server named e2e-echo once (load it with ToolSearch if needed) and reply with exactly what it returned.", "the ping");
    check(mcpCalls() === 1 && reply.includes("PONG-E2E"), `the connector's tool ran once while on: "${reply}"`);
    check(auditRows().some((r) => r.tool === "mcp__e2e-echo__ping" && r.decision === "pass"), "the gate passed the call");
    let at = c.received.length;
    c.send({ type: "connectors", botId: claudio });
    const listed = await c.waitFor(() => framesOf(c, "connectors", at).find((f) => f.botId === claudio), "the connectors list", 10_000);
    const echo = listed.connectors.find((x) => x.name === "e2e-echo");
    check(echo?.status === "connected" && echo.enabled, `the phone sees e2e-echo connected and on: ${JSON.stringify(listed.connectors)}`);
    check(listed.connectors.every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(["enabled", "name", "status"])), "the phone gets names, statuses and switches only");
    at = c.received.length;
    c.send({ type: "set_connector", botId: claudio, name: "e2e-echo", enabled: false });
    await c.waitFor(() => framesOf(c, "connectors", at).find((f) => f.connectors.some((x) => x.name === "e2e-echo" && !x.enabled)), "e2e-echo off", 10_000);
    const off = stateFile().bots.find((b: { id: string }) => b.id === claudio).connectorsOff;
    check(JSON.stringify(off) === JSON.stringify(["e2e-echo"]), `the choice is saved: ${JSON.stringify(off)}`);
    return `ran once (${reply.slice(0, 40)}); listed ${JSON.stringify(listed.connectors.map((x) => `${x.name}:${x.status}`))}; turned off`;
  });

  await scenario("the sandbox confines a bot's command even after Allow once", async () => {
    // A command word built at runtime is held by the gate. Allow once makes the re-run a hook allow, which Claude Code
    // runs without asking its classifier, so only the OS sandbox stands between it and the bridge home.
    const canary = `CANARY-${crypto.randomUUID()}`;
    writeFileSync(join(home, "notes.txt"), `${canary}\n`, { mode: 0o600 });
    const command = '$(printf cat) "$(dirname "$PWD")/../notes.txt"; $(printf touch) "$(dirname "$PWD")/../written.txt"';
    const before = c.messages(claudio).length;
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text: `Run exactly this shell command once:\n${command}\nIf it is held for approval, end your turn. When a message says it was allowed, run exactly the same command again and reply with its complete output verbatim in a code block.`,
    });
    const card = await c.waitFor(
      () => c.messages(claudio).slice(before).find((m): m is Permission => m.kind === "permission" && m.answer === null && m.tool === "Bash"),
      "the card for the command",
    );
    check(card.label === "Run a command it builds at runtime", `the gate held it: "${card.label}: ${card.detail}"`);
    await c.waitFor(() => c.resting(claudio), "the held turn to end");
    c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "once" });
    const at = c.messages(claudio).length;
    await c.waitFor(() => c.botSays(claudio, at).length > 0 && c.resting(claudio), "the re-run's output");
    const reply = c.botSays(claudio, at).map((m) => m.text).join("\n");
    const rows = auditRows().filter((r) => r.tool === "Bash" && String(r.input.command).includes("notes.txt"));
    check(rows.some((r) => r.decision === "allow" && r.via === "grant"), `the re-run went through on the grant: ${rows.map((r) => `${r.decision}/${r.via ?? "-"}`).join(", ")}`);
    check((reply.match(/operation not permitted/gi) ?? []).length >= 2, `the OS refused both the read and the write: "${reply.replace(/\s+/g, " ").slice(0, 300)}"`);
    check(!c.messages(claudio).some((m) => m.kind === "bot" && m.text.includes(canary)), "the canary in the bridge home never reached the chat");
    check(!existsSync(join(home, "written.txt")), "nothing was written outside the bot's home");
    return `card "${card.label}"; audit ${rows.map((r) => `${r.decision}/${r.via ?? "-"}`).join(", ")}; reply "${reply.replace(/\s+/g, " ").slice(0, 220)}"; no written.txt`;
  });

  await scenario("an agent commits in its repo under the sandbox and reports with git's facts", async () => {
    const before = c.messages(claudio).length;
    c.send({
      type: "send",
      botId: claudio,
      uploads: [],
      text:
        'Call start_agent now with where "mac", project "demo", title "Add hello file", and this prompt: ' +
        '"Create hello.txt in the repository root containing exactly the line: hello from agent. Commit it on a new branch named hello-branch. There is no remote: do not push and do not open a PR. Then reply DONE." ' +
        "When the agent reports, tell me in one line the branch and the number of commits ahead that the bridge's Git line reports.",
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
    const committed = (await git(demo, "log", "-1", "--name-only", "--format=%s", "hello-branch")).text();
    check(committed.includes("hello.txt"), `the agent's commit on hello-branch holds hello.txt: ${JSON.stringify(committed.trim())}`);
    c.send({ type: "details", botId: claudio });
    const details = await c.waitFor(() => c.received.findLast((m) => m.type === "details"), "details", 10_000);
    const agent = details.type === "details" ? details.agents.find((a) => a.title === "Add hello file") : undefined;
    check(agent?.where === "mac" && agent.status === "waiting", "details lists the mac agent as waiting");
    check(agent.evidence?.branch === "hello-branch" && agent.evidence.ahead >= 1 && !agent.evidence.dirty, `the agent carries git's facts: ${JSON.stringify(agent.evidence)}`);
    const said = c.botSays(claudio, at + 1).map((m) => m.text).join(" ");
    check(said.includes("hello-branch") && /\b1\b|\bone\b/i.test(said), `the bot read the bridge's Git line: "${said}"`);
    return `exchange received ${report.kind === "exchange" ? report.received : 0}; evidence ${agent.evidence.branch} ahead ${agent.evidence.ahead}; bot said "${said.slice(0, 120)}"`;
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

  const agentTitled = (title: string) => stateFile().agents.find((a: { agent: { title: string } }) => a.agent.title === title) as { agent: { id: string } } | undefined;

  /**
   * Asks the bot to start a mac agent. Claude Code's auto-mode classifier reviews start_agent on its own and may refuse
   * it; when the bot ends its turn with no agent, the user confirms once, as a person at the phone would.
   */
  async function startAgent(project: string, title: string, prompt: string, extra = ""): Promise<{ confirmed: boolean }> {
    const ask = `Call start_agent now with where "mac", project "${project}", title "${title}"${extra}, and this prompt: "${prompt}" Then end your turn.`;
    const before = c.messages(claudio).length;
    c.send({ type: "send", botId: claudio, uploads: [], text: ask });
    await c.waitFor(() => agentTitled(title) ?? (c.botSays(claudio, before).length > 0 && c.resting(claudio)), `the bot to start ${title}`);
    if (agentTitled(title)) return { confirmed: false };
    console.log(`note: no agent after the first ask; the bot said ${JSON.stringify(c.botSays(claudio, before).map((m) => m.text.slice(0, 160)))}`);
    c.send({ type: "send", botId: claudio, uploads: [], text: `Yes, I want this agent started. ${project} is my own test repository and its remote is a local folder. Please call start_agent exactly as I asked.` });
    await c.waitFor(() => agentTitled(title), `the bot to start ${title} after the confirmation`);
    return { confirmed: true };
  }

  await scenario("an agent's push to a local bare remote is held, then runs once after Allow once", async () => {
    const before = c.messages(claudio).length;
    const remoteBefore = await head(origin);
    const local = await head(pushme);
    check(local !== remoteBefore, "pushme has a commit origin does not");
    const started = await startAgent(
      "pushme",
      "Push main",
      "pushme's origin is a local bare repository in a temp folder that I use for testing. Push the commit already on main with exactly: git push origin main. " +
        "If the push is held for my approval, end your turn and say so. When a message says I allowed it, run exactly git push origin main again and reply PUSHED.",
    );
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
    return `${started.confirmed ? "started after one confirmation; " : ""}card from agent "${card.from?.title}": "${card.detail}"; origin main ${remoteBefore.slice(0, 7)} -> ${local.slice(0, 7)} after decide once; audit ${rows.map((r) => r.decision).join(",")}`;
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
    await startAgent("hooked", "List files", "Run ls once and reply with the file names. Do not change anything.");
    // Each report after the bot has spoken starts a new exchange line, so count across them.
    const reports = () =>
      c.messages(claudio).slice(before).reduce((n, m) => n + (m.kind === "exchange" && m.peer.kind === "agent" && m.peer.title === "List files" ? m.received : 0), 0);
    await c.waitFor(() => reports() >= 1, "the hooked agent's first report", 300_000);
    const card = await c.waitFor(openCard(before, (m) => m.tool === "Claude Code settings"), "the trust card", 10_000);
    check(card.label === "Trust hooked's Claude settings" && card.detail === `.claude/settings.json in ${hooked}`, `the bot's chat asks to trust the repo: "${card.label}: ${card.detail}"`);
    check(!existsSync(hookMarker), "the repo's SessionStart and PreToolUse hooks did not run before trust");
    const agentId = agentTitled("List files")!.agent.id;
    const calls = auditRows().filter((r) => r.actor === `agent:${agentId}`);
    check(calls.length > 0, `the untrusted agent did call tools, so its hooks had their chance: ${calls.map((r) => r.tool).join(", ")}`);
    await c.waitFor(() => c.resting(claudio), "the bot to rest");
    c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "always" });
    await c.waitFor(() => c.messages(claudio).find((m) => m.id === card.id && m.kind === "permission" && m.answer === "always"), "the trust card to close as always", 10_000);
    c.send({ type: "send", botId: claudio, uploads: [], text: `Call message_agent now with agentId "${agentId}" and text "Run ls once more and reply with the file names." Then end your turn.` });
    await c.waitFor(() => reports() >= 2, "the hooked agent's second report", 300_000);
    check(existsSync(hookMarker), "after Always the agent's next query ran the repo's hook");
    const dirs = [...new Set(readFileSync(hookMarker, "utf8").trim().split("\n"))];
    const trust = stateFile().gate.repos;
    check(JSON.stringify(dirs) === JSON.stringify([hooked]) && trust.some((r: { root: string; agentId: string | null; trusted: boolean }) => r.root === hooked && r.agentId === null && r.trusted), `the hook ran from the repo itself and the repo is trusted in state: ${JSON.stringify(dirs)}`);
    await c.waitFor(() => c.resting(claudio), "the bot to rest after the second report", 300_000);
    return `no hook output before trust; card "${card.label}: ${card.detail}"; after Always, CLAUDE_PROJECT_DIR seen by the hook ${JSON.stringify(dirs)}`;
  });

  await scenario("an agent in its own worktree commits there, and the user removes the worktree once nothing would be lost", async () => {
    const before = c.messages(claudio).length;
    const demoHead = await head(demo, "HEAD");
    const demoBranch = (await git(demo, "symbolic-ref", "--short", "HEAD")).text().trim();
    await startAgent("demo", "Worktree file", "Create wt.txt containing exactly the line: from the worktree. Commit it. Do not push and do not open a PR. Reply DONE.", ', isolate "worktree"');
    await c.waitFor(
      () => c.messages(claudio).slice(before).some((m) => m.kind === "exchange" && m.peer.kind === "agent" && m.peer.title === "Worktree file" && m.received >= 1),
      "the worktree agent's report",
      300_000,
    );
    await c.waitFor(() => c.resting(claudio), "the bot to rest after the report", 300_000);
    const rec = agentTitled("Worktree file") as unknown as { agent: { id: string; worktree: { path: string; branch: string } | null; evidence: { ahead: number } | null } };
    const wt = rec.agent.worktree;
    check(wt !== null && wt.path.startsWith(`${realpathSync(worktrees)}/demo/`) && wt.branch.startsWith("claudio/"), `the agent got a worktree under CLAUDIOBOT_WORKTREES: ${JSON.stringify(wt)}`);
    const there = (await git(wt.path, "log", "-1", "--name-only", "--format=%s")).text();
    check(there.includes("wt.txt") && (await git(wt.path, "symbolic-ref", "--short", "HEAD")).text().trim() === wt.branch, `the commit landed on ${wt.branch} in the worktree: ${JSON.stringify(there.trim())}`);
    check((await head(demo, "HEAD")) === demoHead && (await git(demo, "symbolic-ref", "--short", "HEAD")).text().trim() === demoBranch && !existsSync(join(demo, "wt.txt")), "the main checkout is untouched");
    check((rec.agent.evidence?.ahead ?? 0) >= 1, `evidence counts the commit from where the worktree started: ${JSON.stringify(rec.agent.evidence)}`);
    check(cardsSince(before).length === 0, `the agent ran with no card: ${JSON.stringify(cardsSince(before).map((m) => m.kind === "permission" && m.label))}`);

    writeFileSync(join(wt.path, ".env"), "TOKEN=e2e\n");
    let at = c.received.length;
    c.send({ type: "remove_worktree", agentId: rec.agent.id as never });
    const refusal = await c.waitFor(() => framesOf(c, "error", at)[0], "the refusal", 30_000);
    check(existsSync(join(wt.path, ".env")) && /\.env/.test(refusal.message), `a worktree holding .env is not removed: "${refusal.message}"`);
    rmSync(join(wt.path, ".env"));
    at = c.received.length;
    c.send({ type: "remove_worktree", agentId: rec.agent.id as never });
    await c.waitFor(() => framesOf(c, "agent", at).find((f) => f.agent.id === rec.agent.id && f.agent.worktree === null), "the agent without its worktree", 30_000);
    check(!existsSync(wt.path), "the worktree folder is gone");
    check((await git(demo, "branch", "--list", wt.branch)).text().includes(wt.branch), "its branch keeps the commit");
    return `${wt.branch} at ${wt.path}; refused with .env ("${refusal.message.slice(0, 80)}"), removed after`;
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

  const routineNamed = (x: Client, name: string) => x.bots.get(claudio)?.routines.find((r) => r.name === name);
  const mint = async (x: Client, routineId: string) => {
    const at = x.received.length;
    x.send({ type: "webhook_token", botId: claudio, routineId: routineId as never });
    return x.waitFor(() => framesOf(x, "webhook_token", at).find((f) => f.routineId === routineId), "a webhook token", 10_000);
  };
  const call = (made: { url: string; token: string }, body: string, headers: Record<string, string> = {}) =>
    fetch(made.url, { method: "POST", headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json", ...headers }, body });

  await scenario("a webhook routine fires once per call with its payload as data", async () => {
    await c.ask(
      claudio,
      'Call set_routine twice now, both with trigger "webhook" and no schedule. First: name "deploys", prompt "A deploy payload arrived. Tell Alex the value of its sha field in one line." ' +
        'Second: name "keeper", prompt "Call the remember tool once with about user and the text: Alex ran the webhook test. Then end your turn." Then confirm in one line.',
      "the webhook routines",
    );
    const deploys = await c.waitFor(() => routineNamed(c, "deploys"), "deploys on the bot frame", 10_000);
    await c.waitFor(() => routineNamed(c, "keeper"), "keeper on the bot frame", 10_000);
    check(deploys.trigger === "webhook" && deploys.schedule === "" && deploys.describe === "When its webhook is called" && deploys.nextRunAt === null, `deploys waits for its webhook: ${JSON.stringify({ ...deploys, runs: undefined })}`);
    const first = await mint(c, deploys.id);
    check(first.url === `http://127.0.0.1:${webhookPort}/hook/${deploys.id}` && /^whk_[\w-]{43}$/.test(first.token) && !log.includes(first.token), `the phone got a loopback URL and a token the bridge never logged: ${first.url}`);
    const before = c.messages(claudio).length;
    const sha = "e2e-7f3a91";
    const fired = await call(first, JSON.stringify({ sha, service: "api" }));
    check(fired.status === 202, `the call fired the routine (${fired.status})`);
    const again = await call(first, JSON.stringify({ sha: "second" }));
    check(again.status === 429, `a second call inside a minute waits (${again.status})`);
    const browser = await call(first, "{}", { origin: "https://evil.example" });
    check(browser.status === 403, `a call with an Origin header is refused (${browser.status})`);
    const second = await mint(c, deploys.id);
    const stale = await call(first, "{}");
    check(stale.status === 401, `a rotated token no longer works (${stale.status})`);
    const fresh = await call(second, "{}");
    check(fresh.status === 429, `the new token is accepted and still inside the cooldown (${fresh.status})`);
    await c.waitFor(() => c.botSays(claudio, before).some((m) => m.text.includes(sha)) && c.resting(claudio), "the bot to report the sha");
    check(cardsSince(before).length === 0, "the webhook turn opened no card");
    await c.waitFor(() => routineNamed(c, "deploys")?.runs[0]?.status === "ok", "the run to settle ok", 30_000);
    return `202, 429, Origin 403, rotated 401, new token 429; bot said "${c.botSays(claudio, before).map((m) => m.text).join(" ").slice(0, 100)}"`;
  });

  const questionCard = (after: number) => c.messages(claudio).slice(after).find((m): m is Extract<Message, { kind: "question" }> => m.kind === "question" && m.answer === null);

  await scenario("the user's answer to a routine's question keeps the routine's initiator", async () => {
    await c.ask(
      claudio,
      'Call set_routine twice now, both with trigger "webhook" and no schedule. First: name "asker", prompt "Use the ask tool now to ask Alex: Which fruit? with the options Apple and Pear, then end your turn. When the answer arrives, call the remember tool once with about user and the text: Alex picked that fruit. Then end your turn." ' +
        'Second: name "capped", prompt "Reply with just OK." Then confirm in one line.',
      "the asker and capped routines",
    );
    const asker = await c.waitFor(() => routineNamed(c, "asker"), "asker on the bot frame", 10_000);
    await c.waitFor(() => routineNamed(c, "capped"), "capped on the bot frame", 10_000);
    const before = c.messages(claudio).length;
    check((await call(await mint(c, asker.id), "{}")).status === 202, "the asker webhook fired");
    const question = await c.waitFor(() => questionCard(before), "the routine's question card");
    await c.waitFor(() => c.resting(claudio), "the asking turn to end");
    c.send({ type: "answer", botId: claudio, messageId: question.id, option: 0 });
    const held = await c.waitFor(
      () => c.messages(claudio).slice(before).find((m): m is Permission => m.kind === "permission" && m.answer === null && m.tool === "mcp__claudio__remember"),
      "the remember card from the answer turn",
    );
    const row = auditRows().findLast((r) => r.tool === "mcp__claudio__remember") as { decision: string; initiator?: { kind: string } } | undefined;
    check(row?.decision === "ask" && row.initiator?.kind === "routine", `the answer turn ran as the routine's: ${JSON.stringify(row && { decision: row.decision, initiator: row.initiator })}`);
    c.send({ type: "decide", botId: claudio, messageId: held.id, choice: "deny" });
    await c.waitFor(() => c.resting(claudio), "the bot to rest after the denial");
    check(!userMd().includes("picked"), "nothing reached USER.md");
    return `question "${question.question}" answered; remember held as "${held.label}" with initiator ${row.initiator!.kind}`;
  });

  await scenario("an interpreter's write to USER.md or CLAUDE.md is held, and a nested CLAUDE.md is refused by the sandbox", async () => {
    const heldFor = async (command: string, what: string) => {
      const before = c.messages(claudio).length;
      c.send({ type: "send", botId: claudio, uploads: [], text: `Run exactly this shell command once and nothing else:\n${command}\nIf it is held for approval, end your turn.` });
      const card = await c.waitFor(() => c.messages(claudio).slice(before).find((m): m is Permission => m.kind === "permission" && m.answer === null && m.tool === "Bash"), what);
      await c.waitFor(() => c.resting(claudio), `${what}: the held turn to end`);
      c.send({ type: "decide", botId: claudio, messageId: card.id, choice: "deny" });
      await c.waitFor(() => c.resting(claudio), `${what}: rest after the denial`);
      return card;
    };
    const userCard = await heldFor(`python3 -c "open('../../USER.md','a').write('- planted-e2e\\n')"`, "the USER.md card");
    check(userCard.label === "Edit USER.md, which every bot reads", `the USER.md write asks: "${userCard.label}"`);
    check(!userMd().includes("planted-e2e"), "USER.md is unchanged");
    const claudeCard = await heldFor(`python3 -c "open('CLAUDE.md','a').write('planted-e2e')"`, "the CLAUDE.md card");
    check(!readFileSync(join(botHome, "CLAUDE.md"), "utf8").includes("planted-e2e"), `the CLAUDE.md write was held ("${claudeCard.label}") and CLAUDE.md is unchanged`);
    mkdirSync(join(botHome, "work"), { recursive: true });
    writeFileSync(join(botHome, "work", "nest.py"), `import os\nos.makedirs("library/deep", exist_ok=True)\nopen(os.path.join("library/deep", "CLAU" + "DE.md"), "w").write("planted")\n`);
    const reply = await c.ask(claudio, "Run exactly this shell command once: python3 work/nest.py\nThen reply with its complete output verbatim in a code block.", "the nested write");
    check(!existsSync(join(botHome, "library", "deep", "CLAUDE.md")), `no nested CLAUDE.md was written: "${reply.replace(/\s+/g, " ").slice(0, 200)}"`);
    check(auditRows().some((r) => r.tool === "Bash" && String(r.input.command).includes("nest.py") && r.decision === "pass"), "the gate passed the script, so the sandbox refused the write");
    return `USER.md card "${userCard.label}", CLAUDE.md card "${claudeCard.label}", nested write refused: "${reply.replace(/\s+/g, " ").slice(0, 120)}"`;
  });

  await scenario("WebFetch of the bridge's own address is refused", async () => {
    const reply = await c.ask(claudio, `Use the WebFetch tool once on http://127.0.0.1:${port}/health and reply with what happened in one line.`, "the local fetch");
    const rows = auditRows().filter((r) => r.tool === "WebFetch");
    check(rows.length > 0 && rows.every((r) => r.decision === "deny" && r.rule === "floor.localnet"), `the fetch was refused: ${JSON.stringify(rows.map((r) => `${r.decision}/${r.rule}`))}`);
    return `refused (${rows.length} call); reply "${reply.slice(0, 80)}"`;
  });

  await scenario("the phone sees today's spend, and the daily cap holds an unattended run until it is raised", async () => {
    const bot = c.bots.get(claudio)!;
    check(bot.spentTodayUsd > 0 && bot.capUsd !== null && bot.capUsd > 0, `the bot frame carries spend ${bot.spentTodayUsd} of ${bot.capUsd}`);
    let at = c.received.length;
    c.send({ type: "details", botId: claudio });
    const details = await c.waitFor(() => framesOf(c, "details", at).find((f) => f.botId === claudio), "details", 10_000);
    const metered = details.agents.filter((a) => a.where === "mac");
    check(metered.length > 0 && metered.every((a) => typeof a.spentUsd === "number") && metered.some((a) => a.spentUsd! > 0), `mac agents carry their spend: ${JSON.stringify(metered.map((a) => [a.spentUsd, a.budgetUsd]))}`);
    c.send({ type: "update_bot", botId: claudio, patch: { dailyCapUsd: 0.01 } });
    await c.waitFor(() => c.bots.get(claudio)?.capUsd === 0.01, "the cap of $0.01", 10_000);
    const before = c.messages(claudio).length;
    const capped = routineNamed(c, "capped")!;
    check((await call(await mint(c, capped.id), "{}")).status === 202, "capped fired");
    await c.waitFor(() => notesOf(c, claudio, before).some((n) => /daily cap/.test(n)) || c.status(claudio) === "parked", "the daily cap to hold the run", 60_000);
    check(c.botSays(claudio, before).length === 0, "the held run said nothing");
    at = c.messages(claudio).length;
    c.send({ type: "update_bot", botId: claudio, patch: { dailyCapUsd: null } });
    await c.waitFor(() => routineNamed(c, "capped")?.runs[0]?.status === "ok" && c.resting(claudio), "the run once the cap is lifted");
    return `spend $${bot.spentTodayUsd.toFixed(3)} of $${bot.capUsd}; held at $0.01 (${notesOf(c, claudio, before).join(" | ").slice(0, 120)}); ran after the cap was lifted`;
  });

  await scenario("a rename reaches the bot's resumed session", async () => {
    c.send({ type: "update_bot", botId: claudio, patch: { name: "Juno" } });
    await c.waitFor(() => c.bots.get(claudio)?.name === "Juno", "the new name", 10_000);
    const said = await c.ask(claudio, "What is your name? Reply with only your name.", "the name");
    check(/juno/i.test(said), `the bot answers to its new name: "${said}"`);
    check(readFileSync(join(botHome, "CLAUDE.md"), "utf8").startsWith("# Juno\n"), "CLAUDE.md's heading is the new name");
    return `"${said}"`;
  });

  const countBefore = c.messages(claudio).length;
  const idsBefore = new Set(c.messages(claudio).map((m) => m.id));
  const botsBefore = [...c.bots.keys()].sort();
  const pushedWhileLive = pushes.filter((p) => p.at >= connectedAt).length;
  const botName = c.bots.get(claudio)!.name;
  c.close();
  old.close();
  await stopServer();

  // Both routines come due while the bridge is down, so its first tick after the restart fires them.
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const due = new Date(Date.now() - 30_000).toISOString();
  for (const b of state.bots) for (const r of b.routines) if (r.trigger.kind === "cron") r.nextRunAt = due;
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
    check(pushed !== null && pushed.body === `${botName} has an update for you` && pushed.click?.startsWith(`claudiobot://bot/${claudio}?message=`), `with no socket, the routine's report pushed: ${JSON.stringify(pushed)}`);
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

  await scenario("the facts about the user survive a restart", async () => {
    const recalled = await r.ask(claudio, "Going only by what you know about me, what is my favorite color? Reply with only the color.", "the color after restart");
    check(recalled.toLowerCase().includes("chartreuse-nine"), `the confirmed fact reached the bot after the restart: "${recalled}"`);
    return `"${recalled}"`;
  });

  await scenario("a connector turned off stays off after a restart, and its tool never runs", async () => {
    const calls = mcpCalls();
    const audited = () => auditRows().filter((x) => x.tool.startsWith("mcp__e2e-echo__")).length;
    const auditedBefore = audited();
    const reply = await r.ask(claudio, "Call the ping tool of the MCP server named e2e-echo once if you can (load it with ToolSearch if needed). If there is no such tool, reply exactly NO-TOOL.", "the ping attempt");
    check(mcpCalls() === calls, `the server's tool did not run (calls ${calls} -> ${mcpCalls()})`);
    check(audited() === auditedBefore, "no PreToolUse for e2e-echo reached the gate");
    const at = r.received.length;
    r.send({ type: "connectors", botId: claudio });
    const listed = await r.waitFor(() => framesOf(r, "connectors", at).find((f) => f.botId === claudio), "the connectors list", 10_000);
    check(listed.connectors.some((x) => x.name === "e2e-echo" && !x.enabled), `the phone still sees it off: ${JSON.stringify(listed.connectors)}`);
    return `reply "${reply.slice(0, 80)}"; tool calls stayed ${calls}; listed ${JSON.stringify(listed.connectors)}`;
  });

  await scenario("a muted bot pushes no update but still pushes a card", async () => {
    r.send({ type: "update_bot", botId: claudio, patch: { muted: true } });
    await r.waitFor(() => r.bots.get(claudio)?.muted === true, "the bot to show muted", 10_000);
    const deploys = await mint(r, routineNamed(r, "deploys")!.id);
    const keeper = await mint(r, routineNamed(r, "keeper")!.id);
    const name = r.bots.get(claudio)!.name;
    r.close();
    await Bun.sleep(1_000);
    const mutedAt = Date.now();
    const runOf = (routine: string) => stateFile().bots.find((b: { id: string }) => b.id === claudio).routines.find((x: { name: string }) => x.name === routine).runs[0];
    let status = 0;
    for (const deadline = Date.now() + 75_000; Date.now() < deadline; await Bun.sleep(5_000)) {
      status = (await call(deploys, JSON.stringify({ sha: "e2e-muted" }))).status;
      if (status !== 429) break;
    }
    check(status === 202, `deploys fired with no phone connected (${status})`);
    for (const deadline = Date.now() + TURN_MS; runOf("deploys")?.status === "running" && Date.now() < deadline; ) await Bun.sleep(1_000);
    check(runOf("deploys")?.status === "ok", `the muted bot's routine ran and reported (${runOf("deploys")?.status})`);
    await Bun.sleep(3_000);
    check(pushes.filter((p) => p.at >= mutedAt).length === 0, `its update was not pushed: ${JSON.stringify(pushes.filter((p) => p.at >= mutedAt).map((p) => p.body))}`);
    check((await call(keeper, "{}")).status === 202, "keeper fired");
    const card = await (async () => {
      for (const deadline = Date.now() + TURN_MS; Date.now() < deadline; await Bun.sleep(500)) {
        const p = pushes.find((x) => x.at >= mutedAt);
        if (p) return p;
        if (spent() > BUDGET_USD) break;
      }
      return null;
    })();
    check(card !== null && card.body === `${name} needs you`, `the card pushed though the bot is muted: ${JSON.stringify(card)}`);
    await Bun.sleep(3_000);
    check(pushes.filter((p) => p.at >= mutedAt).every((p) => p.body.endsWith("needs you")), `only card pushes: ${JSON.stringify(pushes.filter((p) => p.at >= mutedAt).map((p) => p.body))}`);
    const back = connect(token);
    await back.opened;
    back.send({ type: "open", botId: claudio });
    const held = await back.waitFor(() => back.messages(claudio).find((m): m is Permission => m.kind === "permission" && m.answer === null && m.tool === "mcp__claudio__remember"), "the remember card", 10_000);
    back.send({ type: "decide", botId: claudio, messageId: held.id, choice: "deny" });
    back.send({ type: "update_bot", botId: claudio, patch: { muted: false } });
    await back.waitFor(() => back.bots.get(claudio)?.muted === false && back.resting(claudio), "the bot unmuted and resting");
    back.close();
    return `no push for the muted routine report; card push "${card.body}" for "${held.label}"`;
  });

  await scenario("a bot whose transcript Claude Code deleted starts a new conversation and keeps its notes", async () => {
    await stopServer();
    const sessionId = stateFile().bots.find((b: { id: string }) => b.id === claudio).session.id as string;
    const transcripts = [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: join(homedir(), ".claude", "projects"), absolute: true })];
    check(transcripts.length === 1 && transcripts[0]!.includes(claudio), `the bot's own transcript is found: ${JSON.stringify(transcripts)}`);
    rmSync(transcripts[0]!);
    await startServer();
    const x = connect(token);
    await x.opened;
    x.send({ type: "open", botId: claudio });
    await x.waitFor(() => x.received.find((m) => m.type === "conversation"), "the conversation", 10_000);
    const before = x.messages(claudio).length;
    const said = await x.ask(claudio, "Going only by what you know about me, what is my favorite color? Reply with only the color.", "a reply on the new conversation");
    const notes = notesOf(x, claudio, before);
    check(notes.some((n) => n.includes("earlier conversation was cleared")), `the user is told: ${JSON.stringify(notes)}`);
    const fresh = stateFile().bots.find((b: { id: string }) => b.id === claudio).session.id;
    check(fresh !== null && fresh !== sessionId, `the bot runs on a new session (${sessionId} -> ${fresh})`);
    check(said.toLowerCase().includes("chartreuse-nine"), `its facts came along: "${said}"`);
    x.close();
    return `deleted ${sessionId}; note "${notes.find((n) => n.includes("cleared"))}"; new session ${fresh}; "${said}"`;
  });

  await scenario("nothing left the temp folder", async () => {
    check(!existsSync(cloudMarker), "no cloud agent was attempted");
    const now = existsSync(realWorktrees) ? readdirSync(realWorktrees).sort().join(",") : null;
    check(now === realWorktreesBefore, `~/.claudiobot-worktrees is as it was (${realWorktreesBefore} -> ${now})`);
    return "no --cloud call; the real worktrees folder untouched";
  });

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
