// End to end against a real server and real Claude Code (haiku). Run: bun run e2e
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, Item, ServerMessage, TaskId } from "../src/protocol";

const TURN_TIMEOUT_MS = 180_000;

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "claudebot-e2e-")));
const roots = join(scratch, "roots");
const repo = join(roots, "demo");
mkdirSync(repo, { recursive: true });
await Bun.$`git init -q ${repo}`;

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);

let server: Subprocess<"ignore", "pipe", "inherit"> | null = null;

async function startServer(): Promise<{ banner: string; token: string }> {
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/main.ts")], {
    env: { ...process.env, CLAUDEBOT_PORT: String(port), CLAUDEBOT_ROOTS: roots, CLAUDEBOT_HOME: join(scratch, "home") },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = server.stdout.getReader();
  let banner = "";
  while (!/token: [0-9a-f]{64}/.test(banner)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before printing its token:\n${banner}`);
    banner += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { banner, token: banner.match(/token: ([0-9a-f]{64})/)![1]! };
}

async function stopServer() {
  server?.kill("SIGTERM");
  await server?.exited;
  server = null;
}

function connect(token: string, autoApprove = true) {
  const received: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.onmessage = (e) => {
    received.push(JSON.parse(String(e.data)));
    for (const wake of waiters) wake();
  };

  function waitFor<T>(find: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (waiters.delete(poll), reject(new Error(`timed out waiting for ${what}`))), timeoutMs);
      const poll = () => {
        const found = find();
        if (found === undefined) return;
        clearTimeout(timer);
        waiters.delete(poll);
        resolve(found);
      };
      waiters.add(poll);
      poll();
    });
  }

  // Approve everything the moment it shows up, the way a user tapping Allow would.
  const decided = new Set<string>();
  waiters.add(() => {
    if (!autoApprove) return;
    for (const m of received) {
      if (m.type !== "item" || m.item.kind !== "approval" || m.item.state !== "pending" || decided.has(m.item.id)) continue;
      decided.add(m.item.id);
      send({ type: "decide", taskId: m.taskId, itemId: m.item.id, decision: "allow" });
    }
  });

  const send = (m: ClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(m));
  const latestTask = () => received.filter((m) => m.type === "task").map((m) => m.task).at(-1);
  const items = (taskId: TaskId) => {
    const byId = new Map<string, Item>();
    for (const m of received) if (m.type === "item" && m.taskId === taskId) byId.set(m.item.id, m.item);
    return [...byId.values()];
  };
  const results = (taskId: TaskId) => items(taskId).filter((i): i is Extract<Item, { kind: "result" }> => i.kind === "result");
  const turnDone = (taskId: TaskId, resultCount: number) =>
    waitFor(
      () => {
        const task = latestTask();
        return task?.id === taskId && task.status === "idle" && results(taskId).length >= resultCount ? task : undefined;
      },
      `turn ${resultCount} to finish`,
      TURN_TIMEOUT_MS,
    );
  const hello = () => waitFor(() => received.find((m) => m.type === "hello"), "hello");

  return { ws, received, send, waitFor, latestTask, items, results, turnDone, hello };
}

const QUOTE_FIRST = "Quote my very first message to you verbatim, with no other text.";
const FIRST_PROMPT = "Create hello.txt containing hi, then reply DONE";

try {
  const { banner, token } = await startServer();
  check(banner.includes(`claudebot://pair?url=ws%3A%2F%2F`) && banner.includes(`&token=${token}`), "startup prints a pairing deep link");

  const base = `http://127.0.0.1:${port}`;
  check(((await (await fetch(`${base}/health`)).json()) as { ok: boolean }).ok === true, "GET /health returns ok");
  check((await fetch(`${base}/ws?token=wrong`)).status === 401, "a wrong token is rejected with 401");

  const c = connect(token);
  const hello = await c.hello();
  const project = hello.projects.find((p) => p.name === "demo");
  check(project && project.path === repo, "hello lists the temp git repo as a project");

  c.send({ type: "nonsense" });
  await c.waitFor(() => c.received.find((m) => m.type === "error"), "an error for bad input");
  check(true, "bad input gets an error message");

  c.send({ type: "create", target: { kind: "local", projectId: project.id }, model: "haiku", permissionMode: "default", prompt: FIRST_PROMPT });
  const created = await c.waitFor(c.latestTask, "the new task");
  const taskId = created.id;
  check(created.title === FIRST_PROMPT, "task title is the prompt's first line");

  const sawNeedsInput = c.waitFor(() => (c.latestTask()?.status === "needs_input" ? true : undefined), "needs_input", TURN_TIMEOUT_MS);
  const first = await c.turnDone(taskId, 1);
  check(await sawNeedsInput, "task passed through needs_input while an approval was pending");
  check(c.items(taskId).some((i) => i.kind === "approval"), "an approval item arrived");
  check(c.items(taskId).some((i) => i.kind === "approval" && i.state === "allowed"), "the approval was recorded as allowed");
  check(c.items(taskId).some((i) => i.kind === "tool" && i.state === "ok"), "a tool item reached ok");
  check(c.results(taskId)[0]?.ok === true, "the result item is ok");
  check(first.status === "idle" && first.costUsd > 0, `task is idle with cost $${first.costUsd}`);
  const helloFile = join(repo, "hello.txt");
  check(existsSync(helloFile) && (await Bun.file(helloFile).text()).trim() === "hi", "hello.txt exists and contains hi");

  c.send({ type: "subscribe", taskId });
  const transcript = await c.waitFor(() => c.received.find((m) => m.type === "transcript"), "transcript");
  check(transcript.items.length === c.items(taskId).length, `subscribe returns the full transcript (${transcript.items.length} items)`);

  c.send({ type: "send", taskId, text: "Now delete hello.txt" });
  const second = await c.turnDone(taskId, 2);
  check(!existsSync(helloFile), "hello.txt is gone after the follow-up");
  check(c.results(taskId)[1]?.ok === true, "the follow-up result is ok");
  check(second.costUsd > first.costUsd, `task cost grew from $${first.costUsd} to $${second.costUsd}`);

  // Only a continued conversation can quote the first prompt, which is not in the repo anywhere.
  c.send({ type: "send", taskId, text: QUOTE_FIRST });
  await c.turnDone(taskId, 3);
  const quoted = c.results(taskId)[2]?.text ?? "";
  check(quoted.includes(FIRST_PROMPT), `follow-ups share one live conversation (quoted: ${JSON.stringify(quoted)})`);
  c.ws.close();

  await stopServer();
  const restarted = await startServer();
  check(restarted.token === token, "the token survives a restart");
  const r = connect(token, false);
  const helloAfter = await r.hello();
  const restored = helloAfter.tasks.find((t) => t.id === taskId);
  check(restored?.status === "idle", "the idle task is still idle after a restart");
  r.send({ type: "subscribe", taskId });
  const restoredTranscript = await r.waitFor(() => r.received.find((m) => m.type === "transcript"), "transcript after restart");
  check(restoredTranscript.items.filter((i) => i.kind === "result").length === 3, "the transcript survives a restart");

  r.send({ type: "send", taskId, text: QUOTE_FIRST });
  await r.waitFor(() => (r.results(taskId).length >= 1 && r.latestTask()?.status === "idle" ? true : undefined), "resumed turn", TURN_TIMEOUT_MS);
  const resumedQuote = r.results(taskId)[0]?.text ?? "";
  check(resumedQuote.includes(FIRST_PROMPT), `a follow-up after restart resumes the session (quoted: ${JSON.stringify(resumedQuote)})`);

  r.send({ type: "create", target: { kind: "local", projectId: project.id }, model: "haiku", permissionMode: "default", prompt: "Run this exact shell command with the Bash tool: touch stopped.txt" });
  const blocked = await r.waitFor(() => (r.latestTask()?.id !== taskId && r.latestTask()?.status === "needs_input" ? r.latestTask() : undefined), "an approval to stop at", TURN_TIMEOUT_MS);
  r.send({ type: "stop", taskId: blocked.id });
  await r.waitFor(() => (r.latestTask()?.id === blocked.id && r.latestTask()?.status === "stopped" ? true : undefined), "stopped");
  check(r.items(blocked.id).some((i) => i.kind === "approval" && i.state === "denied"), "stop denies the pending approval");
  r.send({ type: "send", taskId: blocked.id, text: "continue" });
  const refused = await r.waitFor(() => r.received.find((m) => m.type === "error" && m.message === "Task is stopped"), "a refused follow-up");
  check(refused, "a stopped task refuses follow-ups");
  await Bun.sleep(2000);
  check(!existsSync(join(repo, "stopped.txt")), "the stopped task never ran its command");
  r.ws.close();

  console.log("E2E PASS");
} finally {
  await stopServer();
}
