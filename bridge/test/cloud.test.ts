import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudSession, followUpAccepted, followUpCloudSession, isolated, parseCloudCreated } from "../src/cloud";

const captured =
  "\x1b[?25l\x1b[2K\x1b[1G\x1b[32mCreated cloud session: README summary\x1b[39m\r\n" +
  "\x1b[2mView: \x1b[22m\x1b[4mhttps://claude.ai/code/session_7fK2pQx9LmV4wR8sT3uY6zA1?from=cli&m=0\x1b[24m\r\n" +
  "Resume with: claude --teleport session_7fK2pQx9LmV4wR8sT3uY6zA1\r\n\x1b[?25h";

test("parses title, url without query, and session id from claude --cloud output", () => {
  expect(parseCloudCreated(captured)).toEqual({
    title: "README summary",
    url: "https://claude.ai/code/session_7fK2pQx9LmV4wR8sT3uY6zA1",
    sessionId: "session_7fK2pQx9LmV4wR8sT3uY6zA1",
  });
  expect(parseCloudCreated("Error: not logged in\r\n")).toBeNull();
});

test("follow-up JSON from claude -p --cloud is accepted unless it reports failure", () => {
  expect(followUpAccepted('{"ok":true,"session_id":"session_abc","url":"https://claude.ai/code/session_abc?from=cli"}')).toBe(true);
  expect(followUpAccepted('{"ok":false,"error":"nope"}')).toBe(false);
  expect(followUpAccepted("Error: session not found")).toBe(false);
});

// A stand-in for the claude CLI that prints what the real one prints, and logs its argv.
const dir = mkdtempSync(join(tmpdir(), "claudiobot-fake-claude-"));
const log = join(dir, "calls.log");
const fake = join(dir, "claude");
writeFileSync(
  fake,
  `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "--cloud" ]; then
  [ -t 1 ] || { echo "Error: --cloud needs a terminal" >&2; exit 1; }
  printf '\\033[32mCreated cloud session: README summary\\033[39m\\r\\n'
  printf 'View: https://claude.ai/code/session_FAKE?from=cli&m=0\\r\\n'
  exit 0
fi
printf '{"ok":true,"session_id":"%s"}\\n' "$4"
`,
);
chmodSync(fake, 0o755);
const previous = process.env.CLAUDIOBOT_CLAUDE;
process.env.CLAUDIOBOT_CLAUDE = fake;
afterAll(() => (previous === undefined ? delete process.env.CLAUDIOBOT_CLAUDE : (process.env.CLAUDIOBOT_CLAUDE = previous)));

test("creates a cloud session through a terminal, then follows up on it, never loading the repo's own settings or MCP servers", async () => {
  expect(await createCloudSession(dir, "Summarize the README")).toEqual({
    title: "README summary",
    url: "https://claude.ai/code/session_FAKE",
    sessionId: "session_FAKE",
  });
  await followUpCloudSession(dir, "session_FAKE", "Also list the TODOs");
  expect((await Bun.file(log).text()).trim().split("\n")).toEqual([
    "--cloud Summarize the README --setting-sources user --strict-mcp-config",
    "-p Also list the TODOs --cloud session_FAKE --output-format json --setting-sources user --strict-mcp-config",
  ]);
});

test("leaves out --strict-mcp-config when an admin's managed MCP config exists, since claude exits on it", () => {
  const managed = join(dir, "managed-mcp.json");
  expect(isolated(managed)).toEqual(["--setting-sources", "user", "--strict-mcp-config"]);
  writeFileSync(managed, "{}");
  expect(isolated(managed)).toEqual(["--setting-sources", "user"]);
});
