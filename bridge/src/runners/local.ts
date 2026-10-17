import { query, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Decision, ItemId, Question, TaskId } from "../protocol";
import { newItemId, now, type RunContext, type Runner } from "./types";

type Pending =
  | { kind: "approval"; input: Record<string, unknown>; suggestions: PermissionUpdate[] | undefined; settle: (r: PermissionResult) => void }
  | { kind: "question"; input: Record<string, unknown>; settle: (r: PermissionResult) => void };

type Live = {
  input: ReturnType<typeof inputQueue>;
  query: Query;
  pending: Map<ItemId, Pending>;
  stopped: boolean;
};

const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

function inputQueue() {
  const buffer: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(text: string) {
      buffer.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (buffer.length > 0) yield buffer.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return raw.map((q: Record<string, unknown>) => ({
    question: s(q?.question),
    header: s(q?.header),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Record<string, unknown>) => ({
      label: s(o?.label),
      description: s(o?.description),
    })),
  }));
}

export function claudeExecutable(): string | null {
  return process.env.CLAUDEBOT_CLAUDE ?? Bun.which("claude");
}

export function createLocalRunner(): Runner {
  const sessions = new Map<TaskId, Live>();

  function begin(ctx: RunContext, text: string, resume: string | null) {
    const executable = claudeExecutable();
    if (!executable) {
      ctx.dispatch({ type: "crashed", itemId: newItemId("notice"), error: "claude was not found on PATH. Set CLAUDEBOT_CLAUDE.", at: now() });
      return;
    }
    const input = inputQueue();
    const pending = new Map<ItemId, Pending>();
    let stderr = "";

    const q = query({
      prompt: input,
      options: {
        cwd: ctx.cwd,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        allowDangerouslySkipPermissions: ctx.permissionMode === "bypassPermissions",
        pathToClaudeCodeExecutable: executable,
        resume: resume ?? undefined,
        stderr: (data) => (stderr = (stderr + data).slice(-2000)),
        canUseTool: (toolName, toolInput, { suggestions, toolUseID, signal }) =>
          new Promise<PermissionResult>((resolve) => {
            const isQuestion = toolName === "AskUserQuestion";
            const itemId = `${isQuestion ? "question" : "approval"}:${toolUseID}` as ItemId;
            const settle = (r: PermissionResult) => {
              pending.delete(itemId);
              resolve(r);
            };
            signal.addEventListener(
              "abort",
              () => {
                if (!pending.has(itemId)) return;
                if (!isQuestion) ctx.dispatch({ type: "approval_decided", itemId, decision: "deny", at: now() });
                settle(deny("Cancelled"));
              },
              { once: true },
            );
            if (isQuestion) {
              pending.set(itemId, { kind: "question", input: toolInput, settle });
              ctx.dispatch({ type: "question_asked", itemId, questions: parseQuestions(toolInput), at: now() });
            } else {
              pending.set(itemId, { kind: "approval", input: toolInput, suggestions, settle });
              ctx.dispatch({ type: "approval_requested", itemId, tool: toolName, input: toolInput, at: now() });
            }
          }),
      },
    });

    const live: Live = { input, query: q, pending, stopped: false };
    sessions.set(ctx.taskId, live);
    input.push(text);

    (async () => {
      try {
        for await (const message of q) ctx.dispatch({ type: "sdk", message, at: now() });
        if (!live.stopped) throw new Error("Claude Code exited");
      } catch (e) {
        if (!live.stopped) {
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          ctx.dispatch({ type: "crashed", itemId: newItemId("notice"), error: `${(e as Error).message}${detail}`, at: now() });
        }
      } finally {
        if (sessions.get(ctx.taskId) === live) sessions.delete(ctx.taskId);
      }
    })();
  }

  return {
    start: (ctx, prompt) => begin(ctx, prompt, null),
    send(ctx, text) {
      const live = sessions.get(ctx.taskId);
      if (live) live.input.push(text);
      else begin(ctx, text, ctx.sessionId());
    },
    decide(ctx, itemId, decision: Decision) {
      const p = sessions.get(ctx.taskId)?.pending.get(itemId);
      if (p?.kind !== "approval") return;
      ctx.dispatch({ type: "approval_decided", itemId, decision, at: now() });
      p.settle(
        decision === "deny"
          ? deny("The user denied this from ClaudeBot.")
          : { behavior: "allow", updatedInput: p.input, updatedPermissions: decision === "allow_always" ? p.suggestions : undefined },
      );
    },
    answer(ctx, itemId, answers) {
      const p = sessions.get(ctx.taskId)?.pending.get(itemId);
      if (p?.kind !== "question") return;
      ctx.dispatch({ type: "question_answered", itemId, answers, at: now() });
      p.settle({ behavior: "allow", updatedInput: { ...p.input, answers } });
    },
    stop(ctx) {
      const live = sessions.get(ctx.taskId);
      ctx.dispatch({ type: "stopped", at: now() });
      if (!live) return;
      live.stopped = true;
      sessions.delete(ctx.taskId);
      for (const p of [...live.pending.values()]) p.settle(deny("The user stopped this task."));
      live.input.end();
      live.query
        .interrupt()
        .catch(() => {})
        .finally(() => live.query.close());
    },
  };
}
