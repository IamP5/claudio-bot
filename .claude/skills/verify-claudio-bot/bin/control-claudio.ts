#!/usr/bin/env bun
// Drives a throwaway ClaudioBot bridge the way the iPhone app does: POST /pair, then the WebSocket.
// Every run lives in its own folder under $CLAUDIOBOT_VERIFY_DIR (default <tmpdir>/claudiobot-verify):
//   runs/<id>/      the bridge home, project roots, worktrees, logs, token. Removed by cleanup.
//   evidence/<id>/  snapshots taken by `evidence` and by cleanup. Never removed by this script.
// Isolation follows bridge/scripts/e2e.ts: HOME stays real only for the Claude login; CLAUDIOBOT_HOME, roots and
// worktrees point into the run folder; no SSH agent, no GitHub token, no claude.ai connectors; claude is a wrapper that
// refuses --cloud; push goes to a local sink. The user's own bridge (~/.claudiobot, port 7878) is never touched.
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../../../..");
const MAIN = join(REPO, "bridge/src/main.ts");
const base = process.env.CLAUDIOBOT_VERIFY_DIR ?? join(tmpdir(), "claudiobot-verify");
mkdirSync(base, { recursive: true });
/** Resolved, so paths built on it compare equal to the ones lsof and realpath report. */
export const BASE = realpathSync(base);
const CURRENT = join(BASE, "current");
const TURN_S = 240;

export type Run = {
  id: string;
  dir: string;
  home: string;
  roots: string;
  worktrees: string;
  port: number;
  webhookPort: number;
  ntfyPort: number;
  bridgePid: number;
  ntfyPid: number;
  model: string;
  rev: string;
  dirty: boolean;
  startedAt: string;
  budgetUsd: number;
  /** --push off: the bridge has no push URL. */
  pushOff?: boolean;
  /** --card-ttl: seconds a session card waits, so its reminder at half of it can be seen. */
  cardTtlS?: number;
};
type Msg = { kind: string; id: string; at: string; text?: string; [k: string]: unknown };
type Bot = { id: string; name: string; status: string; question: string | null; [k: string]: unknown };
export type Frame = { type: string; [k: string]: unknown };

const args = process.argv.slice(2);
const cmd = args.shift() ?? "help";
// Value flags take the next argument; these never do, so `send --no-wait <bot> <text>` keeps its text.
const BOOLEAN = new Set(["no-wait", "card", "json", "no-evidence"]);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  if (BOOLEAN.has(name)) {
    args.splice(i, 1);
    return "true";
  }
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "true" : v;
};
const die = (s: string): never => {
  console.error(`error: ${s}`);
  process.exit(1);
};
const sh = (cmdline: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmdline, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const git = (repo: string, ...a: string[]) => {
  const r = sh(["git", "-C", repo, "-c", "user.name=verify", "-c", "user.email=verify@example.com", "-c", "commit.gpgsign=false", ...a]);
  if (!r.ok) die(`git ${a.join(" ")} in ${repo}: ${r.err}`);
  return r.out;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listener = (port: number) => sh(["lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN", "-n", "-P"]).out.split("\n").filter(Boolean).map(Number);
const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
};
// Claude Code names a project's transcript folder after its path with every non-alphanumeric character as "-".
export const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

function loadRun(): Run {
  const id = flag("run") ?? process.env.CLAUDIO_RUN ?? (existsSync(CURRENT) ? readFileSync(CURRENT, "utf8").trim() : "");
  if (!id) die("no run: start one with `control-claudio launch`, or pass --run <id>");
  const file = join(BASE, "runs", id, "run.json");
  if (!existsSync(file)) die(`run ${id} not found at ${file} (cleaned up already?)`);
  return JSON.parse(readFileSync(file, "utf8"));
}
const tokenOf = (run: Run) => readFileSync(join(run.dir, "token"), "utf8").trim();
const bridgeLog = (run: Run) => (existsSync(join(run.dir, "bridge.log")) ? readFileSync(join(run.dir, "bridge.log"), "utf8") : "");
export const spent = (run: Run) =>
  [...bridgeLog(run).matchAll(/^result \S+ \S+ session=\S+ totalCostUsd=\S+ deltaUsd=([\d.e-]+)$/gm)].reduce((n, m) => n + Number(m[1]), 0);

/**
 * One socket like the app's: protocol 3, Bearer token. Keeps the bot list and every conversation it has seen. `port`
 * reaches the bridge through a relay; `resume` asks for a replay after the stream position the app holds.
 */
export async function connect(run: Run, opts: { port?: number; resume?: { epoch: string; after: number } | null } = {}) {
  const bots = new Map<string, Bot>();
  const convs = new Map<string, Msg[]>();
  const frames: Frame[] = [];
  const resume = opts.resume ? `&epoch=${encodeURIComponent(opts.resume.epoch)}&after=${opts.resume.after}` : "";
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port ?? run.port}/ws?protocol=3${resume}`, { headers: { Authorization: `Bearer ${tokenOf(run)}` } } as never);
  const upsert = (botId: string, m: Msg) => {
    const list = convs.get(botId) ?? [];
    const i = list.findIndex((x) => x.id === m.id);
    if (i === -1) list.push(m);
    else list[i] = m;
    convs.set(botId, list);
  };
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as Frame;
    frames.push(f);
    if (f.type === "hello") for (const b of f.bots as Bot[]) bots.set(b.id, b);
    if (f.type === "bot") bots.set((f.bot as Bot).id, f.bot as Bot);
    if (f.type === "bot_removed") bots.delete(f.botId as string);
    if (f.type === "conversation") for (const m of f.messages as Msg[]) upsert(f.botId as string, m);
    if (f.type === "message") upsert(f.botId as string, f.message as Msg);
  };
  await new Promise<void>((ok, bad) => {
    ws.onopen = () => ok();
    ws.onerror = () => bad(new Error(`the socket on port ${run.port} did not open (bridge down or token refused)`));
  }).catch((e) => die(e.message));
  const waitFor = async <T>(find: () => T | undefined | null | false, what: string, seconds: number): Promise<T> => {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const v = find();
      if (v !== undefined && v !== null && v !== false) return v;
      if (Date.now() > deadline) die(`timed out after ${seconds}s waiting for ${what}`);
      if (spent(run) > run.budgetUsd) die(`stopped: this run's ledger charged $${spent(run).toFixed(2)}, over its $${run.budgetUsd} budget`);
      // Short, so the timings `sessions` and `thread` print measure the bridge rather than this wait.
      await Bun.sleep(10);
    }
  };
  await waitFor(() => frames.some((f) => f.type === "hello"), "hello", 10);
  const send = (m: object) => ws.send(JSON.stringify(m));
  const resolveBot = (ref: string) =>
    bots.get(ref) ?? [...bots.values()].find((b) => b.name.toLowerCase() === ref.toLowerCase()) ?? die(`no bot "${ref}"; bots: ${[...bots.values()].map((b) => `${b.name} (${b.id})`).join(", ")}`);
  const open = async (botId: string) => {
    const at = frames.length;
    send({ type: "open", botId });
    await waitFor(() => frames.slice(at).some((f) => f.type === "conversation" && f.botId === botId), "the conversation", 10);
    return convs.get(botId) ?? [];
  };
  const resting = (botId: string) => ["idle", "awaiting_approval"].includes(bots.get(botId)?.status ?? "");
  const openCards = (botId: string, after = 0) =>
    (convs.get(botId) ?? []).slice(after).filter((m) => (m.kind === "permission" || m.kind === "question") && m.answer === null);
  return { ws, bots, convs, frames, send, waitFor, resolveBot, open, resting, openCards, close: () => ws.close() };
}

function line(i: number, m: Msg) {
  const t = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").slice(0, 400);
  const head = `#${i} ${m.kind} ${m.id}`;
  switch (m.kind) {
    case "user":
    case "bot":
    case "note":
      return `${head}: ${t(m.text)}`;
    case "permission":
      return `${head} tool=${m.tool} answer=${m.answer ?? "OPEN"} from=${(m.from as { title?: string } | null)?.title ?? "bot"}: ${t(m.label)}: ${t(m.detail)}`;
    case "question":
      return `${head} answer=${m.answer ?? "OPEN"}: ${t(m.question)} options=${JSON.stringify(m.options)}`;
    case "exchange":
      return `${head} peer=${(m.peer as { kind: string }).kind}:${t((m.peer as { title?: string; name?: string }).title ?? (m.peer as { name?: string }).name)} sent=${m.sent} received=${m.received}`;
    default:
      return `${head}: ${t(JSON.stringify(m))}`;
  }
}

// setsid puts each process in its own session, so it outlives this command and the shell that ran it. stdout and
// stderr share one append-mode descriptor: two separate opens of the file overwrite each other's lines.
function detach(argv: string[], logFile: string, env: Record<string, string | undefined>) {
  const fd = openSync(logFile, "a");
  const p = Bun.spawn(["perl", "-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", ...argv], { env, stdout: fd, stderr: fd, stdin: "ignore" });
  closeSync(fd);
  p.unref();
  return p;
}

/** The bridge's environment for a run, everything pointing into the run folder. launch and restart share it. */
function bridgeEnv(run: Pick<Run, "dir" | "home" | "roots" | "port" | "webhookPort" | "ntfyPort" | "model" | "pushOff" | "cardTtlS">) {
  const bin = join(run.dir, "bin");
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDIOBOT_PORT: String(run.port),
    CLAUDIOBOT_ROOTS: run.roots,
    CLAUDIOBOT_HOME: run.home,
    CLAUDIOBOT_MODEL: run.model,
    CLAUDIOBOT_USER_NAME: "Alex",
    CLAUDIOBOT_PUSH_URL: `http://127.0.0.1:${run.ntfyPort}/verify`,
    CLAUDIOBOT_DESKTOP_FAKE: join(run.dir, "desktop-imports.txt"),
    CLAUDIOBOT_WEBHOOK_PORT: String(run.webhookPort),
    CLAUDIOBOT_CLAUDE: join(bin, "claude"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ...(run.cardTtlS && { CLAUDIOBOT_SESSION_CARD_TTL_S: String(run.cardTtlS) }),
  };
  if (run.pushOff) delete env.CLAUDIOBOT_PUSH_URL;
  for (const k of ["CLAUDEBOT_HOME", "SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "CLAUDIOBOT_ALLOWED_DOMAINS", "CLAUDIOBOT_SANDBOX_STRICT_NETWORK", "CLAUDIOBOT_SANDBOX_GH"]) delete env[k];
  // A Claude Code this helper runs inside (the desktop app, a terminal) leaves its session id, entrypoint and messaging
  // socket in the environment; the bridge's own Claude Code children must not inherit them.
  for (const k of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDECODE$|AI_AGENT$)/.test(k)) delete env[k];
  // Inherited CLAUDIOBOT_* settings would leak the user's own configuration into the run. Access and sandbox modes pass
  // through on purpose, so full access can be verified by setting them for one launch.
  const ours = new Set(["CLAUDIOBOT_PORT", "CLAUDIOBOT_ROOTS", "CLAUDIOBOT_HOME", "CLAUDIOBOT_MODEL", "CLAUDIOBOT_USER_NAME", "CLAUDIOBOT_PUSH_URL", "CLAUDIOBOT_DESKTOP_FAKE", "CLAUDIOBOT_WEBHOOK_PORT", "CLAUDIOBOT_CLAUDE", "CLAUDIOBOT_ACCESS", "CLAUDIOBOT_SANDBOX", "CLAUDIOBOT_SESSION_CARD_TTL_S"]);
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDIOBOT_") && !ours.has(k)) delete env[k];
  return env;
}

/**
 * restart: stops the run's bridge and starts it again on the same port, home and roots, as a crash and relaunch would.
 * Sockets drop; the pairing, sessions and transcripts stay. run.json gets the new pid.
 */
async function restart(run: Run) {
  if (run.port === 7878 || !run.home.startsWith(`${run.dir}/`)) die("refusing to restart a bridge that is not a verification run's");
  if (alive(run.bridgePid)) {
    process.kill(run.bridgePid, "SIGTERM");
    for (let i = 0; i < 100 && alive(run.bridgePid); i++) await Bun.sleep(100);
    if (alive(run.bridgePid)) process.kill(run.bridgePid, "SIGKILL");
  }
  for (let i = 0; i < 50 && listener(run.port).length; i++) await Bun.sleep(100);
  const bridge = detach(["bun", "run", MAIN], join(run.dir, "bridge.log"), bridgeEnv(run));
  const next = { ...run, bridgePid: bridge.pid };
  writeFileSync(join(run.dir, "run.json"), JSON.stringify(next, null, 2));
  for (let i = 0; i < 600; i++) {
    await Bun.sleep(100);
    if (!alive(bridge.pid)) die(`the bridge exited at restart; log ${join(run.dir, "bridge.log")}:\n${bridgeLog(run).slice(-2000)}`);
    const ok = await fetch(`http://127.0.0.1:${run.port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return console.log(`RESTARTED run=${run.id} pid ${run.bridgePid} -> ${bridge.pid} on 127.0.0.1:${run.port}`);
  }
  die(`the bridge did not answer /health within 60s of restart; log ${join(run.dir, "bridge.log")}`);
}

async function launch() {
  const model = flag("model") ?? process.env.CLAUDIOBOT_VERIFY_MODEL ?? "claude-sonnet-5-5";
  const budgetUsd = Number(flag("budget") ?? process.env.CLAUDIOBOT_VERIFY_BUDGET_USD ?? 2);
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${crypto.randomUUID().slice(0, 4)}`;
  const dir = join(BASE, "runs", id);
  const home = join(dir, "home");
  const roots = join(dir, "roots");
  const worktrees = join(dir, "worktrees");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Seed projects agents can work in: demo (one commit, .env ignored) and pushme (one commit ahead of a local bare origin).
  const demo = join(roots, "demo");
  mkdirSync(demo, { recursive: true });
  git(demo, "init", "-q", "-b", "main");
  writeFileSync(join(demo, ".gitignore"), ".env\n");
  writeFileSync(join(demo, "README.md"), "# demo\n\nA scratch repository for ClaudioBot verification.\n");
  git(demo, "add", ".");
  git(demo, "commit", "-q", "-m", "init");
  const origin = join(dir, "origin.git");
  const pushme = join(roots, "pushme");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(["git", "clone", "-q", origin, pushme]);
  git(pushme, "commit", "-q", "--allow-empty", "-m", "init");
  git(pushme, "push", "-q", "origin", "main");
  git(pushme, "commit", "-q", "--allow-empty", "-m", "a change to push");
  // The bridge passes no SSH agent, so a user's global commit signing would fail every agent's commit in a seed repo.
  for (const repo of [demo, pushme]) git(repo, "config", "commit.gpgsign", "false");

  const realClaude = Bun.which("claude") ?? die("the claude CLI is not on PATH");
  const wrapper = join(bin, "claude");
  const cloudMarker = join(dir, "cloud-attempt.txt");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --cloud|--remote|--teleport) echo "$*" >> '${cloudMarker}'; echo "cloud agents are off in verification" >&2; exit 1;; esac; done\nexec '${realClaude}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);

  // The ntfy stand-in: every push the bridge sends becomes one JSON line in pushes.jsonl. While the run folder holds
  // sink-fail, it answers 500, as a broken push server would, and the line says so.
  const sink = join(dir, "ntfy-sink.ts");
  writeFileSync(
    sink,
    `import { appendFileSync, existsSync } from "node:fs";
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
  const status = existsSync(${JSON.stringify(join(dir, "sink-fail"))}) ? 500 : 200;
  appendFileSync(${JSON.stringify(join(dir, "pushes.jsonl"))}, JSON.stringify({ at: new Date().toISOString(), path: new URL(req.url).pathname, title: req.headers.get("title"), click: req.headers.get("click"), priority: req.headers.get("priority"), status, body: await req.text() }) + "\\n");
  return new Response("{}", { status });
} });
console.log("ntfy-sink " + s.port);
`,
  );
  const ntfy = detach(["bun", "run", sink], join(dir, "ntfy.log"), process.env);
  let ntfyPort = 0;
  for (let i = 0; i < 100 && !ntfyPort; i++) {
    await Bun.sleep(100);
    ntfyPort = Number(readFileSync(join(dir, "ntfy.log"), "utf8").match(/ntfy-sink (\d+)/)?.[1] ?? 0);
  }
  if (!ntfyPort) die(`the push sink did not start: ${readFileSync(join(dir, "ntfy.log"), "utf8")}`);

  const port = freePort();
  const webhookPort = freePort();
  const pushOff = flag("push") === "off";
  const cardTtlS = Number(flag("card-ttl") ?? 0) || undefined;
  const env = bridgeEnv({ dir, home, roots, port, webhookPort, ntfyPort, model, pushOff, cardTtlS });
  for (const k of ["CLAUDIOBOT_ACCESS", "CLAUDIOBOT_SANDBOX"]) if (process.env[k] !== undefined) console.log(`note: ${k}=${process.env[k]} is passed through from your shell`);

  const inRun = (v: string | undefined) => v !== undefined && v.startsWith(`${dir}/`);
  const rules: [boolean, string][] = [
    [inRun(env.CLAUDIOBOT_HOME), `CLAUDIOBOT_HOME is the run's (${env.CLAUDIOBOT_HOME})`],
    [inRun(env.CLAUDIOBOT_ROOTS), `project roots are the run's (${env.CLAUDIOBOT_ROOTS})`],
    [inRun(env.CLAUDIOBOT_DESKTOP_FAKE), `the Claude app is the run's stand-in, imports go to ${env.CLAUDIOBOT_DESKTOP_FAKE}`],
    [env.SSH_AUTH_SOCK === undefined, "SSH_AUTH_SOCK is unset"],
    [env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined, "GH_TOKEN and GITHUB_TOKEN are unset"],
    [env.ENABLE_CLAUDEAI_MCP_SERVERS === "false", "claude.ai connectors are off"],
    [env.CLAUDIOBOT_CLAUDE === wrapper && env.PATH!.startsWith(`${bin}:`), "claude is the --cloud-refusing wrapper"],
    pushOff
      ? [env.CLAUDIOBOT_PUSH_URL === undefined, "push is off (--push off): no push URL"]
      : [env.CLAUDIOBOT_PUSH_URL?.startsWith("http://127.0.0.1:") === true, "push goes to the local sink"],
    [port !== 7878 && webhookPort !== 7879, `ports ${port}/${webhookPort} are not the real bridge's 7878/7879`],
    [!Object.keys(env).some((k) => k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE"), "no CLAUDE_CODE_* variable of a surrounding Claude Code"],
  ];
  for (const [ok, what] of rules) console.log(`isolation ${ok ? "ok" : "FAILED"}: ${what}`);
  if (rules.some(([ok]) => !ok)) {
    process.kill(ntfy.pid, "SIGTERM");
    die("isolation check failed; the bridge was not started");
  }

  const rev = sh(["git", "-C", REPO, "rev-parse", "HEAD"]).out;
  const dirty = sh(["git", "-C", REPO, "status", "--porcelain", "--", "bridge"]).out !== "";
  const bridge = detach(["bun", "run", MAIN], join(dir, "bridge.log"), env);
  const run: Run = { id, dir, home, roots, worktrees, port, webhookPort, ntfyPort, bridgePid: bridge.pid, ntfyPid: ntfy.pid, model, rev, dirty, startedAt: new Date().toISOString(), budgetUsd, ...(pushOff && { pushOff }), ...(cardTtlS && { cardTtlS }) };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2));
  writeFileSync(CURRENT, id);
  // Printed before the bridge is ready, so a caller can clean up the run even if launch fails or is interrupted from here on.
  console.log(`STARTED run=${id}`);

  let code: string | undefined;
  for (let i = 0; i < 600 && !code; i++) {
    await Bun.sleep(100);
    if (!alive(bridge.pid)) die(`the bridge exited at start; log ${join(dir, "bridge.log")}:\n${bridgeLog(run).slice(-2000)}`);
    code = bridgeLog(run).match(/pair code: ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1];
  }
  if (!code) die(`no pair code within 60s; log ${join(dir, "bridge.log")}`);
  const res = await fetch(`http://127.0.0.1:${port}/pair`, { method: "POST", body: JSON.stringify({ code, name: "verify phone" }) });
  if (res.status !== 200) die(`POST /pair answered ${res.status}: ${await res.text()}`);
  const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
  writeFileSync(join(dir, "token"), token, { mode: 0o600 });

  const c = await connect(run);
  const hello = c.frames.find((f) => f.type === "hello")!;
  if (hello.protocol !== 3) die(`hello is protocol ${hello.protocol}, expected 3`);
  const claudio = [...c.bots.values()].find((b) => b.name === "Claudio Bot") ?? die("first start did not create Claudio Bot");
  c.close();
  console.log(`paired device ${deviceId} with code ${code}`);
  console.log(`bridge ${rev.slice(0, 10)}${dirty ? " (+ uncommitted bridge changes)" : ""} pid ${bridge.pid} on 127.0.0.1:${port}, webhooks :${webhookPort}, push sink :${ntfyPort}, model ${model}, budget $${budgetUsd}`);
  console.log(`run dir ${dir}`);
  console.log(`READY run=${id} bot="Claudio Bot" id=${claudio.id} status=${claudio.status}`);
}

async function doctor() {
  const run = loadRun();
  const checks: [boolean, string][] = [];
  checks.push([alive(run.bridgePid), `bridge pid ${run.bridgePid} is alive`]);
  const owners = listener(run.port);
  checks.push([owners.includes(run.bridgePid), `port ${run.port} is held by our bridge (listeners: ${owners.join(",") || "none"})`]);
  checks.push([alive(run.ntfyPid) && listener(run.ntfyPort).includes(run.ntfyPid), `push sink pid ${run.ntfyPid} holds :${run.ntfyPort}`]);
  const health = await fetch(`http://127.0.0.1:${run.port}/health`).then((r) => r.json()).catch(() => null);
  checks.push([(health as { ok?: boolean } | null)?.ok === true, `/health answers ok`]);
  checks.push([existsSync(join(run.home, "state.json")), `state.json is in the run's home ${run.home}`]);
  const ps = sh(["ps", "-p", String(run.bridgePid), "-o", "command="]).out;
  checks.push([ps.includes(MAIN), `the pid runs this checkout's main.ts (${ps.slice(0, 120)})`]);
  const rev = sh(["git", "-C", REPO, "rev-parse", "HEAD"]).out;
  checks.push([rev === run.rev, `checkout HEAD ${rev.slice(0, 10)} is the launched build ${run.rev.slice(0, 10)}${run.dirty ? " (launched with uncommitted bridge changes)" : ""}`]);
  checks.push([!existsSync(join(run.dir, "cloud-attempt.txt")), "no cloud agent was attempted"]);
  let hello = "no socket";
  if (checks[0]![0]) {
    const c = await connect(run);
    const h = c.frames.find((f) => f.type === "hello")!;
    hello = `protocol ${h.protocol}, user ${h.userName}, bots ${[...c.bots.values()].map((b) => `${b.name}=${b.status}`).join(", ")}`;
    checks.push([h.protocol === 3, `the token opens a protocol 3 socket: ${hello}`]);
    c.close();
  }
  for (const [ok, what] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  console.log(`spent $${spent(run).toFixed(4)} of $${run.budgetUsd}; run ${run.id}`);
  process.exit(checks.every(([ok]) => ok) ? 0 : 1);
}

async function main() {
  mkdirSync(join(BASE, "runs"), { recursive: true });
  mkdirSync(join(BASE, "evidence"), { recursive: true });
  switch (cmd) {
    case "launch":
      return launch();
    case "doctor":
      return doctor();
    case "restart":
      return restart(loadRun());
    case "runs": {
      for (const id of readdirSync(join(BASE, "runs"))) {
        const f = join(BASE, "runs", id, "run.json");
        if (!existsSync(f)) continue;
        const r = JSON.parse(readFileSync(f, "utf8")) as Run;
        console.log(`${id} port=${r.port} bridge=${r.bridgePid}${alive(r.bridgePid) ? " alive" : " dead"} started=${r.startedAt}`);
      }
      return;
    }
    case "bots": {
      const run = loadRun();
      const c = await connect(run);
      for (const b of c.bots.values()) console.log(`${b.id} "${b.name}" status=${b.status} unread=${b.unread} question=${JSON.stringify(b.question)} routines=${(b.routines as unknown[]).length}`);
      c.close();
      return;
    }
    case "messages": {
      const run = loadRun();
      const since = Number(flag("since") ?? 0);
      const json = flag("json");
      const c = await connect(run);
      const bot = c.resolveBot(args[0] ?? "Claudio Bot");
      const ms = await c.open(bot.id);
      if (json) console.log(JSON.stringify(ms.slice(since), null, 2));
      else ms.forEach((m, i) => i >= since && console.log(line(i, m)));
      console.log(`status=${c.bots.get(bot.id)?.status} count=${ms.length}`);
      c.close();
      return;
    }
    case "send": {
      // Waits for the bot to rest, sends as the user, then waits for a reply (or an open card) and rest again.
      const run = loadRun();
      const timeout = Number(flag("timeout") ?? TURN_S);
      const noWait = flag("no-wait");
      const [ref, ...rest] = args;
      const text = rest.join(" ");
      if (!ref || !text) die('usage: send <bot name or id> <text...>');
      const c = await connect(run);
      const bot = c.resolveBot(ref);
      await c.open(bot.id);
      await c.waitFor(() => c.resting(bot.id), `${bot.name} to rest before sending (status ${c.bots.get(bot.id)?.status})`, timeout);
      const before = (c.convs.get(bot.id) ?? []).length;
      const clientId = `verify-${crypto.randomUUID()}`;
      c.send({ type: "send", botId: bot.id, text, uploads: [], clientId });
      await c.waitFor(() => (c.convs.get(bot.id) ?? []).slice(before).some((m) => m.kind === "user" && m.clientId === clientId), "the echo of the send", 15);
      if (!noWait) {
        await c.waitFor(() => c.bots.get(bot.id)?.status === "working" || (c.convs.get(bot.id) ?? []).slice(before).some((m) => m.kind !== "user"), "the turn to start", 60);
        await c.waitFor(() => c.resting(bot.id) && (c.convs.get(bot.id) ?? []).slice(before).some((m) => m.kind !== "user"), `${bot.name}'s turn to end`, timeout);
      }
      (c.convs.get(bot.id) ?? []).forEach((m, i) => i >= before && console.log(line(i, m)));
      console.log(`status=${c.bots.get(bot.id)?.status} open_cards=${c.openCards(bot.id).map((m) => m.id).join(",") || "none"} spent=$${spent(run).toFixed(4)}`);
      c.close();
      return;
    }
    case "wait": {
      const run = loadRun();
      const timeout = Number(flag("timeout") ?? TURN_S);
      const card = flag("card");
      const c = await connect(run);
      const bot = c.resolveBot(args[0] ?? "Claudio Bot");
      const ms = await c.open(bot.id);
      const before = Number(flag("since") ?? ms.length);
      if (card) await c.waitFor(() => c.openCards(bot.id, before)[0], "an open card", timeout);
      await c.waitFor(() => c.resting(bot.id), `${bot.name} to rest`, timeout);
      (c.convs.get(bot.id) ?? []).forEach((m, i) => i >= before && console.log(line(i, m)));
      console.log(`status=${c.bots.get(bot.id)?.status} open_cards=${c.openCards(bot.id).map((m) => m.id).join(",") || "none"}`);
      c.close();
      return;
    }
    case "decide":
    case "answer":
    case "dismiss":
    case "stop": {
      // decide <bot> <messageId> once|always|deny|never; answer <bot> <messageId> <option index>; dismiss <bot> <messageId>; stop <bot>
      const run = loadRun();
      const wait = flag("wait");
      const c = await connect(run);
      const bot = c.resolveBot(args[0] ?? die(`usage: ${cmd} <bot> ...`));
      const ms = await c.open(bot.id);
      const before = ms.length;
      if (cmd === "decide") c.send({ type: "decide", botId: bot.id, messageId: args[1], choice: args[2] });
      if (cmd === "answer") c.send({ type: "answer", botId: bot.id, messageId: args[1], option: Number(args[2]) });
      if (cmd === "dismiss") c.send({ type: "dismiss", botId: bot.id, messageId: args[1] });
      if (cmd === "stop") c.send({ type: "stop", botId: bot.id });
      if (cmd !== "stop") await c.waitFor(() => (c.convs.get(bot.id) ?? []).find((m) => m.id === args[1] && m.answer !== null), `card ${args[1]} to close`, 15);
      if (wait) {
        await c.waitFor(() => c.bots.get(bot.id)?.status === "working" || (c.convs.get(bot.id) ?? []).length > before, "the turn to start", 30);
        await c.waitFor(() => c.resting(bot.id), `${bot.name} to rest`, Number(wait === "true" ? TURN_S : wait));
      } else await Bun.sleep(500);
      const card = (c.convs.get(bot.id) ?? []).findIndex((m) => m.id === args[1]);
      if (card >= 0) console.log(line(card, c.convs.get(bot.id)![card]!));
      (c.convs.get(bot.id) ?? []).forEach((m, i) => i >= before && console.log(line(i, m)));
      console.log(`status=${c.bots.get(bot.id)?.status}`);
      c.close();
      return;
    }
    case "raw": {
      // raw '<ClientMessage JSON>' [--frames type,type] [--for seconds]: send anything the app can send, print the answers.
      const run = loadRun();
      const types = flag("frames")?.split(",");
      const secs = Number(flag("for") ?? 3);
      const c = await connect(run);
      const at = c.frames.length;
      c.send(JSON.parse(args[0] ?? die("usage: raw '<json>'")));
      await Bun.sleep(secs * 1000);
      for (const f of c.frames.slice(at)) if (!types || types.includes(f.type)) console.log(JSON.stringify(f));
      c.close();
      return;
    }
    case "sessions":
      return sessionsList(loadRun());
    case "thread":
      return thread(loadRun(), args[0] ?? die("usage: thread <sessionId|largest> [--after epoch:rev] [--for s]"));
    case "session-flow":
      return sessionFlow(loadRun(), flag("project") ?? "demo", flag("model") ?? "haiku");
    case "evidence":
      return evidence(loadRun(), args[0] ?? "snapshot");
    case "cleanup":
      return cleanup();
    default:
      console.log(readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8").match(/## Helper reference[\s\S]*?(?=\n## |$)/)?.[0] ?? "see SKILL.md");
  }
}

/** Copies what proves a behavior into evidence/<run>/<label>/. Never the token. */
export type Row = { id: string; projectId: string; parentId?: string | null; title: string; origin: string; status: string; holder: string; unread: boolean; agent: unknown; mirror: string; hidden: boolean; branch: string | null; worktree: boolean; lastAt: string; outcome?: unknown };
export type Project = { id: string; name: string; path: string };

const countBy = <T>(xs: T[], key: (x: T) => string) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {})).map(([k, n]) => `${k}=${n}`).join(" ");

/** A session is the run's own when its project lies under the run's roots: only those are printed with their words. */
export const ownProject = (run: Run, p: Project | undefined) => p !== undefined && (p.path === run.roots || p.path.startsWith(`${run.roots}/`));

async function listOf(run: Run, c: Awaited<ReturnType<typeof connect>>) {
  const at = c.frames.length;
  const t = performance.now();
  c.send({ type: "watch_sessions" });
  const f = await c.waitFor(() => c.frames.slice(at).find((x) => x.type === "sessions" || x.type === "error"), "the sessions frame", 60);
  if (f.type === "error") die(`watch_sessions: ${f.message}`);
  return { ms: Math.round(performance.now() - t), bytes: JSON.stringify(f).length, projects: f.projects as Project[], rows: f.rows as Row[] };
}

/**
 * sessions: the Sessions list as the app gets it. The user's own sessions are printed as counts only; the run's seed
 * projects with their rows.
 */
async function sessionsList(run: Run) {
  const c = await connect(run);
  const l = await listOf(run, c);
  console.log(`sessions frame in ${l.ms} ms: ${l.projects.length} projects, ${l.rows.length} rows, ${l.bytes} bytes`);
  console.log(`  origin ${countBy(l.rows, (r) => r.origin)}`);
  console.log(`  status ${countBy(l.rows, (r) => r.status)}; holder ${countBy(l.rows, (r) => r.holder)}; mirror ${countBy(l.rows, (r) => r.mirror)}; unread ${l.rows.filter((r) => r.unread).length}; hidden ${l.rows.filter((r) => r.hidden).length}; worktree ${l.rows.filter((r) => r.worktree).length}`);
  for (const p of l.projects.filter((p) => ownProject(run, p))) {
    const rows = l.rows.filter((r) => r.projectId === p.id);
    console.log(`seed project ${p.name} (${p.id}) ${p.path}: ${rows.length} rows`);
    for (const r of rows) console.log(`  row ${r.id} "${r.title}" origin=${r.origin} status=${r.status} holder=${r.holder} unread=${r.unread} mirror=${r.mirror} branch=${r.branch} worktree=${r.worktree}${r.agent ? ` agent=${JSON.stringify(r.agent)}` : ""}`);
  }
  if (flag("names")) for (const p of l.projects) console.log(`  project ${p.name}: ${l.rows.filter((r) => r.projectId === p.id).length}`);
  c.close();
}

/** A frame in a line: types, revs, item kinds and ids, delta offsets; the words only for the run's own sessions. */
export function frameLine(f: Frame, words: boolean): string {
  const items = (f.items as { kind: string; id: string; text?: string; steps?: { label: string; state: string }[]; card?: { label: string; detail: string; answer: unknown }; state?: string }[] | undefined) ?? [];
  const shown = items.map((i) => {
    const detail = !words
      ? ""
      : i.kind === "work"
        ? ` [${(i.steps ?? []).map((s) => `${s.label}:${s.state}`).join("; ")}]`
        : i.kind === "permission"
          ? ` [${i.card?.label}: ${i.card?.detail} answer=${i.card?.answer}]`
          : i.text !== undefined
            ? ` "${i.text.slice(0, 80).replace(/\n/g, " ")}"`
            : i.state !== undefined
              ? ` ${i.state}`
              : "";
    return `${i.kind}:${i.id}${detail}`;
  });
  switch (f.type) {
    case "session":
      return `session epoch=${f.epoch} rev=${f.rev} items=${items.length} before=${f.before === null ? "null" : "cursor"} live=${f.live ? "yes" : "no"} canSend=${(f.controls as { canSend: boolean }).canSend}${words ? ` ${shown.join(" | ")}` : ` kinds: ${countBy(items, (i) => i.kind)}`}`;
    case "session_items":
      return `session_items rev=${f.rev} items=${items.length} removed=${(f.removed as string[]).length} controls=${f.controls ? "set" : "null"}${words ? ` ${shown.join(" | ")}` : ` kinds: ${countBy(items, (i) => i.kind)}`}`;
    case "session_delta":
      return `session_delta item=${f.itemId} offset=${f.offset} chars=${String(f.text).length}${words ? ` "${String(f.text).slice(0, 60).replace(/\n/g, " ")}"` : ""}`;
    default:
      return words ? JSON.stringify(f).slice(0, 300) : f.type;
  }
}

/** thread <id|largest> [--after epoch:rev] [--for s]: opens one thread as the app does and prints what arrives. */
async function thread(run: Run, ref: string) {
  const after = flag("after");
  const secs = Number(flag("for") ?? 0);
  const c = await connect(run);
  const l = await listOf(run, c);
  let id = ref;
  if (ref === "largest") {
    const listed = new Set(l.rows.map((r) => r.id));
    const projects = join(homedir(), ".claude", "projects");
    let best = { id: "", size: -1 };
    for (const d of readdirSync(projects)) {
      let names: string[] = [];
      try {
        names = readdirSync(join(projects, d));
      } catch {}
      for (const n of names) {
        const sid = n.replace(/\.jsonl$/, "");
        if (n.endsWith(".jsonl") && listed.has(sid)) {
          const size = Bun.file(join(projects, d, n)).size;
          if (size > best.size) best = { id: sid, size };
        }
      }
    }
    if (!best.id) die("no listed transcript found");
    id = best.id;
    console.log(`largest listed transcript: ${id} (${(best.size / 1e6).toFixed(1)} MB)`);
  }
  const row = l.rows.find((r) => r.id === id);
  const words = ownProject(run, l.projects.find((p) => p.id === row?.projectId));
  const at = c.frames.length;
  const t = performance.now();
  const [epoch, rev] = after ? [after.slice(0, after.lastIndexOf(":")), Number(after.slice(after.lastIndexOf(":") + 1))] : [null, 0];
  c.send({ type: "watch_session", sessionId: id, after: epoch === null ? null : { epoch, rev } });
  const first = await c.waitFor(() => c.frames.slice(at).find((f) => ["session", "session_items", "session_removed", "error"].includes(f.type)), "the thread", 120);
  console.log(`opened in ${Math.round(performance.now() - t)} ms, ${JSON.stringify(first).length} bytes`);
  const seen = new Set<Frame>();
  const print = () => {
    for (const f of c.frames.slice(at)) if (!seen.has(f) && f.type !== "session_rows" && f.type !== "activity" && f.type !== "usage") (seen.add(f), console.log(frameLine(f, words)));
  };
  print();
  if (first.type === "session" && first.before !== null && words) {
    c.send({ type: "session_page", sessionId: id, before: first.before });
    await Bun.sleep(500);
  }
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    await Bun.sleep(250);
    print();
  }
  print();
  c.close();
}

async function socketOf(run: Run) {
  const c = await connect(run);
  const t0 = Date.now();
  const timed: { at: number; f: Frame }[] = [];
  const old = c.ws.onmessage;
  c.ws.onmessage = (e) => {
    old?.call(c.ws, e);
    timed.push({ at: Date.now() - t0, f: JSON.parse(String(e.data)) as Frame });
  };
  return { ...c, timed, t0 };
}

type Item = { kind: string; id: string; text?: string; card?: { id: string; answer: unknown; label: string; detail: string }; steps?: { label: string; state: string }[]; tone?: string };
const itemsIn = (f: Frame) => ((f.items as Item[] | undefined) ?? []);

/**
 * session-flow [--project demo] [--model haiku]: the Sessions journey over the socket, asserted step by step: a new
 * session in a seed project, its Bash call held as a permission item, Allow once, the turn's text streamed; a
 * follow-up that streams while the socket drops and a new socket resumes it; Stop in the middle of a turn. Prints
 * each step's evidence and timings.
 */
async function sessionFlow(run: Run, projectName: string, model: string) {
  const step = (s: string) => console.log(`\n== ${s}`);
  const check = (ok: unknown, what: string) => {
    if (!ok) die(`FAILED: ${what}`);
    console.log(`ok: ${what}`);
  };
  let c = await socketOf(run);
  const l = await listOf(run, c);
  const project = l.projects.find((p) => p.name === projectName && ownProject(run, p)) ?? die(`no seed project ${projectName}`);
  step(`list: ${l.rows.length} rows in ${l.projects.length} projects in ${l.ms} ms`);

  step("create");
  let at = c.timed.length;
  const t = Date.now();
  c.send({ type: "session_create", ref: "flow-1", projectId: project.id, model, mode: "default", isolate: "none", text: "Run this Bash command exactly: date > when.txt\nThen reply with one short sentence saying it is done." });
  const created = await c.waitFor(() => c.timed.slice(at).find((x) => x.f.type === "session_created" || x.f.type === "error")?.f, "session_created", 30);
  if (created.type === "error") die(`session_create: ${created.message}`);
  const id = created.sessionId as string;
  console.log(`session ${id} created in ${Date.now() - t} ms`);
  c.send({ type: "watch_session", sessionId: id, after: null });
  const all = () => c.timed.filter((x) => x.f.sessionId === id);
  const perm = await c.waitFor(() => all().flatMap((x) => itemsIn(x.f)).find((i) => i.kind === "permission" && i.card?.answer === null), "a permission item", 120);
  check(perm.card!.detail.includes("date > when.txt"), `permission item "${perm.card!.label}: ${perm.card!.detail}" after ${Date.now() - t} ms`);
  const rowsNow = () => c.timed.filter((x) => x.f.type === "session_rows").flatMap((x) => (x.f.rows as Row[]).filter((r) => r.id === id));
  const td = Date.now();
  at = c.timed.length;
  c.send({ type: "session_decide", sessionId: id, cardId: perm.card!.id, choice: "once" });
  const ran = await c.waitFor(() => all().slice(0).flatMap((x) => itemsIn(x.f)).find((i) => i.kind === "work" && i.steps?.some((s) => s.state === "ok")), "the step to run", 120);
  check(ran, `the Bash step ran: ${ran.steps!.map((s) => `${s.label}:${s.state}`).join("; ")}`);
  const reply = await c.waitFor(() => all().flatMap((x) => itemsIn(x.f)).find((i) => i.kind === "assistant"), "the reply", 120);
  const replyDeltas = all().filter((x) => x.f.type === "session_delta" && x.f.itemId === reply.id);
  check(replyDeltas.length > 0, `the reply streamed as ${replyDeltas.length} delta(s) under ${reply.id} before its upsert: "${reply.text?.slice(0, 80)}"`);
  await c.waitFor(() => rowsNow().some((r) => r.status === "idle"), "the row to go idle", 60);
  console.log(`decide → idle row in ${Date.now() - td} ms; row ${JSON.stringify(rowsNow().at(-1))}`);
  check(existsSync(join(project.path, "when.txt")), "when.txt exists in the seed project");

  step("follow-up, socket drop mid-stream, resume");
  at = c.timed.length;
  c.send({ type: "session_send", sessionId: id, text: "Write a story of about 250 words about a lighthouse keeper. Plain text, no headings.", clientId: "flow-2", interrupt: false });
  const queued = await c.waitFor(() => c.timed.slice(at).flatMap((x) => itemsIn(x.f)).find((i) => i.kind === "user" && i.id === "flow-2"), "the queued message", 20);
  check(queued, "the follow-up shows under its clientId until the transcript has it");
  const firstDelta = await c.waitFor(() => c.timed.slice(at).find((x) => x.f.type === "session_delta" && x.f.sessionId === id), "the story to stream", 120);
  const storyId = firstDelta.f.itemId as string;
  await Bun.sleep(400);
  const last = c.timed.filter((x) => x.f.sessionId === id && (x.f.type === "session_items" || x.f.type === "session")).at(-1)!.f;
  const epoch = (c.timed.find((x) => x.f.type === "session" && x.f.sessionId === id)!.f.epoch as string);
  const position = { epoch, rev: last.rev as number };
  const before = c.timed.filter((x) => x.f.type === "session_delta" && x.f.itemId === storyId).length;
  c.close();
  console.log(`dropped the socket after ${before} story deltas at rev ${position.rev}`);
  await Bun.sleep(300);
  c = await socketOf(run);
  c.send({ type: "watch_sessions" });
  c.send({ type: "watch_session", sessionId: id, after: position });
  const resumed = await c.waitFor(() => c.timed.find((x) => x.f.sessionId === id && (x.f.type === "session_items" || x.f.type === "session"))?.f, "the resume reply", 30);
  console.log(`resumed with ${resumed.type} rev=${resumed.rev}${resumed.type === "session" ? " (snapshot)" : " (ring replay)"}`);
  // The app's live text for the story, kept by the delta rule: a delta applies only at the current length.
  let live = resumed.type === "session" && (resumed.live as { itemId: string } | null)?.itemId === storyId ? String((resumed.live as { text: string }).text) : "";
  let applied = 0;
  let dropped = 0;
  let seen = 0;
  const story = await c.waitFor(() => {
    const frames = c.timed.filter((x) => x.f.sessionId === id);
    for (const x of frames.slice(seen)) {
      if (x.f.type === "session_delta" && x.f.itemId === storyId) {
        if (x.f.offset === live.length) {
          live += String(x.f.text);
          applied++;
        } else dropped++;
      }
    }
    seen = frames.length;
    return frames.flatMap((x) => itemsIn(x.f)).find((i) => i.id === storyId && i.kind === "assistant");
  }, "the story's upsert", 180);
  check(applied > 0 && dropped === 0, `after the resume ${applied} deltas applied in order, ${dropped} dropped`);
  const head = live.trim().slice(0, 80);
  check(head.length > 0 && story.text!.startsWith(head), `the upsert's text (${story.text!.length} chars) is the live text (${live.length} chars) made whole`);

  step("stop mid-turn");
  at = c.timed.length;
  c.send({ type: "session_send", sessionId: id, text: "Count from 1 to 400, one number per line, nothing else.", clientId: "flow-3", interrupt: false });
  await c.waitFor(() => c.timed.slice(at).find((x) => x.f.type === "session_delta" && x.f.sessionId === id), "the count to stream", 120);
  const ts = Date.now();
  const stopAt = c.timed.length;
  c.send({ type: "session_stop", sessionId: id });
  await c.waitFor(() => c.timed.slice(stopAt).some((x) => x.f.sessionId === id && x.f.type === "session_items" && (x.f.controls as { working: boolean } | null)?.working === false), "the turn to stop", 60);
  check(true, `stopped: controls working=false ${Date.now() - ts} ms after session_stop`);
  const noted = await c.waitFor(() => c.timed.slice(stopAt).flatMap((x) => itemsIn(x.f)).find((i) => i.kind === "notice" || (i.kind === "assistant" && /\d/.test(i.text ?? ""))), "the stopped turn in the thread", 30);
  console.log(`the thread shows ${noted.kind}${noted.text ? ` "${noted.text.slice(0, 40).replace(/\n/g, " ")}"` : ""}`);

  step("summary");
  const types = c.timed.concat().map((x) => x.f.type);
  console.log(`frames on the second socket: ${countBy(types, (x) => x)}`);
  console.log(`spent so far: $${spent(run).toFixed(4)}`);
  c.close();
}

async function evidence(run: Run, label: string) {
  const out = join(BASE, "evidence", run.id, label);
  mkdirSync(out, { recursive: true });
  const copy = (from: string, to: string) => existsSync(from) && cpSync(from, join(out, to), { recursive: true });
  copy(join(run.home, "state.json"), "state.json");
  copy(join(run.home, "USER.md"), "USER.md");
  copy(join(run.home, "audit"), "audit");
  copy(join(run.home, "usage"), "usage");
  copy(join(run.dir, "bridge.log"), "bridge.log");
  copy(join(run.dir, "pushes.jsonl"), "pushes.jsonl");
  copy(join(run.dir, "cloud-attempt.txt"), "cloud-attempt.txt");
  const { token: _t, ...rest } = run as Run & { token?: string };
  writeFileSync(join(out, "run.json"), JSON.stringify(rest, null, 2));
  const repos: string[] = [];
  if (existsSync(run.roots))
    for (const name of readdirSync(run.roots)) {
      const r = join(run.roots, name);
      repos.push(`## ${name}\n${sh(["git", "-C", r, "log", "--all", "--graph", "--oneline", "--decorate"]).out}\n${sh(["git", "-C", r, "status", "--short"]).out}`);
    }
  writeFileSync(join(out, "repos.txt"), repos.join("\n\n") + "\n");
  if (alive(run.bridgePid) && listener(run.port).includes(run.bridgePid)) {
    const c = await connect(run);
    const all: Record<string, unknown> = {};
    const text: string[] = [];
    for (const b of [...c.bots.values()]) {
      const ms = await c.open(b.id);
      all[b.id] = { bot: c.bots.get(b.id), messages: ms };
      text.push(`== ${b.name} (${b.id}) status=${c.bots.get(b.id)?.status}`, ...ms.map((m, i) => line(i, m)));
    }
    writeFileSync(join(out, "conversations.json"), JSON.stringify(all, null, 2));
    writeFileSync(join(out, "conversations.txt"), text.join("\n") + "\n");
    c.close();
  }
  writeFileSync(join(out, "summary.txt"), `run ${run.id} label ${label} at ${new Date().toISOString()}\nbuild ${run.rev}${run.dirty ? " +dirty" : ""} model ${run.model}\nspent $${spent(run).toFixed(4)}\n`);
  console.log(`evidence ${out}`);
  console.log(readdirSync(out).join(" "));
}

/** Stops only what this run started (pids from run.json, processes whose command line names the run folder). */
async function cleanup() {
  const run = loadRun();
  const home = join(BASE, "runs", run.id);
  if (!/^[\w-]+$/.test(run.id) || !run.dir || !existsSync(run.dir) || realpathSync(run.dir) !== realpathSync(home))
    die(`refusing to clean up: run.json names dir "${run.dir}", not ${home}`);
  const keepNone = flag("no-evidence");
  if (!keepNone && existsSync(run.dir)) await evidence(run, "final").catch((e) => console.log(`final evidence failed: ${e}`));
  for (const [what, pid] of [["bridge", run.bridgePid], ["push sink", run.ntfyPid]] as const) {
    if (!alive(pid)) {
      console.log(`${what} pid ${pid} already gone`);
      continue;
    }
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) process.kill(pid, "SIGKILL");
    console.log(`${what} pid ${pid} stopped`);
  }
  // Agents, sandboxes and claude children of this run name the run folder in their command line; the tools sessions
  // run (a `sleep`, a dev server) often do not, but their working directory is inside it.
  const dir = realpathSync(run.dir);
  const exact = `${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|[[:space:]"']|$)`;
  const named = sh(["pgrep", "-f", exact]).out.split("\n").filter(Boolean).map(Number);
  let pid = 0;
  const inside: number[] = [];
  for (const l of sh(["lsof", "-w", "-d", "cwd", "-Fpn"]).out.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && (l.slice(1) === dir || l.slice(1).startsWith(`${dir}/`))) inside.push(pid);
  }
  // This process, whatever started it (a shell that cd'd into the run, the runner) and its process group (the rest of
  // a pipeline) are never strays. The bridge is detached into its own session, so nothing of the run shares the group.
  const ours = new Set<number>(sh(["pgrep", "-g", sh(["ps", "-o", "pgid=", "-p", String(process.pid)]).out]).out.split("\n").filter(Boolean).map(Number));
  for (let p = process.pid, hops = 0; p > 1 && hops < 64; p = Number(sh(["ps", "-o", "ppid=", "-p", String(p)]).out) || 0, hops++) ours.add(p);
  const strays = [...new Set([...named, ...inside])].filter((p) => !ours.has(p) && alive(p));
  for (const p of strays) {
    console.log(`stray pid ${p}: ${sh(["ps", "-p", String(p), "-o", "command="]).out.slice(0, 120)}`);
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  }
  await Bun.sleep(strays.length ? 1500 : 0);
  for (const p of strays) if (alive(p)) process.kill(p, "SIGKILL");
  const ports = [run.port, run.webhookPort, run.ntfyPort].filter((p) => listener(p).length);
  if (ports.length) console.log(`WARNING: ports still listening: ${ports.join(",")}`);
  // Claude Code wrote this run's bot and agent transcripts under the real ~/.claude/projects, named after run paths.
  const projects = join(homedir(), ".claude", "projects");
  const prefix = slug(run.dir);
  if (existsSync(projects))
    for (const name of readdirSync(projects))
      if (name.startsWith(prefix)) {
        rmSync(join(projects, name), { recursive: true, force: true });
        console.log(`removed transcripts ~/.claude/projects/${name}`);
      }
  rmSync(dir, { recursive: true, force: true });
  if (existsSync(CURRENT) && readFileSync(CURRENT, "utf8").trim() === run.id) rmSync(CURRENT);
  const ev = join(BASE, "evidence", run.id);
  console.log(`removed ${run.dir}`);
  console.log(existsSync(ev) ? `evidence kept at ${ev}: ${readdirSync(ev).join(" ")}` : "no evidence was captured for this run");
}

// scenario.ts imports the socket and run helpers; only a direct run parses argv as a command.
if (import.meta.main) {
  await main();
  process.exit(0);
}
