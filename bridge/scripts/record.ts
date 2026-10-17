// Records the TaskEvents the real LocalRunner dispatches, for replay in test/task.test.ts.
// Usage: bun run scripts/record.ts <name> "<prompt>" [answer label]
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemId, TaskId } from "../src/protocol";
import { createLocalRunner } from "../src/runners/local";
import type { RunContext } from "../src/runners/types";
import type { TaskEvent } from "../src/task";

const [name, prompt, answerLabel] = Bun.argv.slice(2);
if (!name || !prompt) throw new Error("usage: record.ts <name> <prompt> [answer]");

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claudebot-record-")));
await Bun.$`git init -q ${cwd}`;

const events: TaskEvent[] = [];
let sessionId: string | null = null;
const runner = createLocalRunner();
const done = Promise.withResolvers<void>();

const ctx: RunContext = {
  taskId: "recording" as TaskId,
  cwd,
  model: "haiku",
  permissionMode: "default",
  sessionId: () => sessionId,
  dispatch(event) {
    events.push(event);
    if (event.type === "sdk" && event.message.type === "system" && event.message.subtype === "init") sessionId = event.message.session_id;
    if (event.type === "approval_requested") queueMicrotask(() => runner.decide(ctx, event.itemId, "allow"));
    if (event.type === "question_asked") {
      const q = event.questions[0]!;
      queueMicrotask(() => runner.answer(ctx, event.itemId, { [q.question]: answerLabel ?? q.options[0]!.label }));
    }
    if (event.type === "sdk" && event.message.type === "result") done.resolve();
  },
};

runner.start(ctx, prompt);
await done.promise;
runner.stop(ctx);

// Keep only what the reducer reads, so recordings carry no local plugin, MCP, or account details.
const kept = events
  .filter((e) => e.type !== "sdk" || ["assistant", "user", "result"].includes(e.message.type) || (e.message.type === "system" && e.message.subtype === "init"))
  .map((e) =>
    e.type === "sdk" && e.message.type === "system"
      ? { ...e, message: { type: "system", subtype: "init", session_id: e.message.session_id, uuid: e.message.uuid } }
      : e.type === "sdk" && e.message.type === "result"
        ? { ...e, message: { ...e.message, modelUsage: {}, usage: {}, permission_denials: [] } }
        : e,
  );
const json = JSON.stringify({ cwd: "/repo", events: kept }, null, 2).replaceAll(cwd, "/repo").replaceAll(homedir(), "~");
await Bun.write(join(import.meta.dir, "../test/recordings", `${name}.json`), json + "\n");
console.log(`recorded ${kept.length} events (${events.length} raw) to test/recordings/${name}.json`);
process.exit(0);
