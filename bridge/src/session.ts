import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function claudeExecutable(): string | null {
  return process.env.CLAUDEBOT_CLAUDE ?? Bun.which("claude");
}

export type Session = { push(text: string): void; close(): void; readonly working: boolean };

// One long-lived Claude Code session fed one message per turn. It starts on the first push, and after a crash the
// next push starts it again, so options() should resume the stored session id.
export function createSession(spec: {
  options: () => Options;
  onMessage: (message: SDKMessage) => void;
  onWorking: (working: boolean) => void;
  onCrash: (error: string) => void;
}): Session {
  let queue: string[] = [];
  let inTurn = false;
  let live: Query | null = null;
  let generation = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const working = () => inTurn || queue.length > 0;
  const nudge = () => wake?.();

  // Holding the next message until the turn's result keeps one envelope per turn, so working is exact.
  async function* input(gen: number): AsyncGenerator<SDKUserMessage> {
    while (!closed && gen === generation) {
      if (!inTurn && queue.length > 0) {
        inTurn = true;
        yield { type: "user", message: { role: "user", content: queue.shift()! }, parent_tool_use_id: null };
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }

  function crash(error: string) {
    generation++;
    live = null;
    inTurn = false;
    queue = [];
    nudge();
    spec.onWorking(false);
    spec.onCrash(error);
  }

  function start() {
    const executable = claudeExecutable();
    if (!executable) return crash("claude was not found on PATH. Set CLAUDEBOT_CLAUDE.");
    const gen = ++generation;
    let stderr = "";
    const q = query({
      prompt: input(gen),
      options: { ...spec.options(), pathToClaudeCodeExecutable: executable, stderr: (d) => (stderr = (stderr + d).slice(-2000)) },
    });
    live = q;
    (async () => {
      try {
        for await (const message of q) {
          spec.onMessage(message);
          if (message.type !== "result") continue;
          inTurn = false;
          if (queue.length === 0) spec.onWorking(false);
          nudge();
        }
        if (!closed && gen === generation) throw new Error("Claude Code exited");
      } catch (e) {
        if (!closed && gen === generation) crash(`${(e as Error).message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
      }
    })();
  }

  return {
    push(text) {
      if (closed) return;
      const was = working();
      queue.push(text);
      if (!was) spec.onWorking(true);
      if (live) nudge();
      else start();
    },
    close() {
      closed = true;
      nudge();
      live?.close();
      live = null;
    },
    get working() {
      return working();
    },
  };
}
