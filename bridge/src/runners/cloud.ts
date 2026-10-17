import type { Subprocess } from "bun";
import type { TaskId } from "../protocol";
import { truncate } from "../summary";
import { claudeExecutable } from "./local";
import { newItemId, now, type RunContext, type Runner } from "./types";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

export type CloudCreated = { title: string; url: string; sessionId: string };

export function parseCloudCreated(stdout: string): CloudCreated | null {
  const text = stripAnsi(stdout);
  const title = text.match(/Created cloud session:[ \t]*(.+)/)?.[1]?.trim();
  const view = text.match(/View:[ \t]*(https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+))/);
  if (!view?.[1] || !view[2]) return null;
  return { title: title ?? "", url: view[1], sessionId: view[2] };
}

const RUN_TIMEOUT_MS = 90_000;

export function createCloudRunner(): Runner {
  const procs = new Map<TaskId, Subprocess>();
  const stopped = new Set<TaskId>();
  // A follow-up sent while the session is still being created must wait for its session id.
  const queues = new Map<TaskId, Promise<void>>();
  const enqueue = (taskId: TaskId, op: () => Promise<void>) => {
    const next = (queues.get(taskId) ?? Promise.resolve()).then(() => (stopped.has(taskId) ? undefined : op()));
    queues.set(taskId, next.catch(() => {}));
  };

  async function run(ctx: RunContext, argv: string[]): Promise<{ code: number; stdout: string; stderr: string } | null> {
    const proc = Bun.spawn(argv, { cwd: ctx.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.set(ctx.taskId, proc);
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    procs.delete(ctx.taskId);
    return stopped.has(ctx.taskId) ? null : { code, stdout, stderr };
  }

  const failure = (what: string, out: { stdout: string; stderr: string }) =>
    `${what}\n${truncate(stripAnsi(out.stderr || out.stdout).trim(), 2000)}`.trim();

  function fail(ctx: RunContext, error: string) {
    ctx.dispatch({ type: "cloud_failed", itemId: newItemId("notice"), error, at: now() });
  }

  return {
    start(ctx, prompt) {
      const claude = claudeExecutable();
      if (!claude) return fail(ctx, "claude was not found on PATH. Set CLAUDEBOT_CLAUDE.");
      // claude --cloud refuses to run without a terminal, so give it one through script(1).
      enqueue(ctx.taskId, () =>
        run(ctx, ["script", "-q", "/dev/null", claude, "--cloud", prompt]).then((out) => {
          if (!out) return;
          const created = parseCloudCreated(out.stdout);
          if (!created) return fail(ctx, failure("Could not create the cloud session.", out));
          ctx.dispatch({ type: "cloud_created", itemId: newItemId("notice"), ...created, at: now() });
        }, (e) => fail(ctx, `Could not create the cloud session.\n${(e as Error).message}`)),
      );
    },
    send(ctx, text) {
      enqueue(ctx.taskId, async () => {
        const claude = claudeExecutable();
        const sessionId = ctx.sessionId();
        if (!claude) return fail(ctx, "claude was not found on PATH. Set CLAUDEBOT_CLAUDE.");
        if (!sessionId) return fail(ctx, "This task has no cloud session to follow up on.");
        const out = await run(ctx, [claude, "-p", text, "--cloud", sessionId, "--output-format", "json"]).catch((e: Error) => {
          fail(ctx, `Could not send the follow-up.\n${e.message}`);
          return null;
        });
        if (!out) return;
        if (out.code !== 0 || !followUpAccepted(out.stdout)) return fail(ctx, failure("Could not send the follow-up.", out));
        ctx.dispatch({ type: "cloud_followup", itemId: newItemId("notice"), at: now() });
      });
    },
    decide() {},
    answer() {},
    stop(ctx) {
      stopped.add(ctx.taskId);
      procs.get(ctx.taskId)?.kill();
      ctx.dispatch({ type: "stopped", at: now() });
    },
  };
}

// The JSON shape of a cloud follow-up is not documented, so accept anything that does not say it failed.
export function followUpAccepted(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stripAnsi(stdout).trim());
    return !(parsed && typeof parsed === "object" && (parsed.ok === false || parsed.is_error === true));
  } catch {
    return false;
  }
}
