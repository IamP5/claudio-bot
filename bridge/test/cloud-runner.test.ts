import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskId } from "../src/protocol";
import { createCloudRunner } from "../src/runners/cloud";
import type { RunContext } from "../src/runners/types";
import type { TaskEvent } from "../src/task";

// A stand-in for the claude CLI that prints what the real one printed in a probe, and logs its argv.
const dir = mkdtempSync(join(tmpdir(), "claudebot-fake-claude-"));
const log = join(dir, "calls.log");
const fake = join(dir, "claude");
writeFileSync(
  fake,
  `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "--cloud" ]; then
  [ -t 1 ] || { echo "Error: --cloud needs a terminal" >&2; exit 1; }
  sleep 0.3
  printf '\\033[32mCreated cloud session: README summary\\033[39m\\r\\n'
  printf 'View: https://claude.ai/code/session_01FAKE?from=cli&m=0\\r\\n'
  exit 0
fi
printf '{"ok":true,"session_id":"%s","url":"https://claude.ai/code/%s?from=cli&m=0"}\\n' "$4" "$4"
`,
);
chmodSync(fake, 0o755);
const previous = process.env.CLAUDEBOT_CLAUDE;
process.env.CLAUDEBOT_CLAUDE = fake;
afterAll(() => (previous === undefined ? delete process.env.CLAUDEBOT_CLAUDE : (process.env.CLAUDEBOT_CLAUDE = previous)));

function context() {
  const events: TaskEvent[] = [];
  let sessionId: string | null = null;
  const ctx: RunContext = {
    taskId: crypto.randomUUID() as TaskId,
    cwd: dir,
    model: "opus",
    permissionMode: "default",
    sessionId: () => sessionId,
    dispatch(event) {
      events.push(event);
      if (event.type === "cloud_created") sessionId = event.sessionId;
    },
  };
  return { ctx, events };
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 100 && !pred(); i++) await Bun.sleep(50);
};

test("creates a cloud session in a pty, and a follow-up sent meanwhile waits for it", async () => {
  const runner = createCloudRunner();
  const { ctx, events } = context();
  runner.start(ctx, "Summarize the README");
  runner.send(ctx, "Also list the TODOs");
  await until(() => events.length >= 2);

  expect(events.map((e) => e.type)).toEqual(["cloud_created", "cloud_followup"]);
  expect(events[0]).toMatchObject({ title: "README summary", url: "https://claude.ai/code/session_01FAKE", sessionId: "session_01FAKE" });
  const calls = (await Bun.file(log).text()).trim().split("\n");
  expect(calls).toContain("-p Also list the TODOs --cloud session_01FAKE --output-format json");
});

test("stopping during creation reports nothing after the stop", async () => {
  const runner = createCloudRunner();
  const { ctx, events } = context();
  runner.start(ctx, "Summarize the README");
  runner.stop(ctx);
  await Bun.sleep(600);
  expect(events.map((e) => e.type)).toEqual(["stopped"]);
});
