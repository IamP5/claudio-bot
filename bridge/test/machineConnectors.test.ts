import { expect, test } from "bun:test";
import type { McpServerStatus, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONNECTOR_PROBE_MS, connectorsOf, kindOf, probeConnectors, watchConnectors } from "../src/machine/connectors";
import type { MachineConnector } from "../src/protocol";
import { flush } from "./hub-kit";

test("a server is chrome or computer-use by its name, and any other is other", () => {
  const names = ["chrome", "chrome-devtools", "claude-in-chrome", "Chrome-Beta", "computer-use", "mac-computer-use", "playwright", "claude.ai Gmail"];
  expect(names.map((n) => [n, kindOf(n)])).toEqual([
    ["chrome", "chrome"],
    ["chrome-devtools", "chrome"],
    ["claude-in-chrome", "chrome"],
    ["Chrome-Beta", "chrome"],
    ["computer-use", "computer-use"],
    ["mac-computer-use", "computer-use"],
    ["playwright", "other"],
    ["claude.ai Gmail", "other"],
  ]);
});

test("only a connected server of the machine's counts, by name", () => {
  const statuses = [
    { name: "claudio", status: "connected", source: "sdk" },
    { name: "playwright", status: "connected" },
    { name: "chrome-devtools", status: "connected" },
    { name: "computer-use", status: "failed" },
    { name: "claude.ai Gmail", status: "needs-auth" },
    { name: "linear", status: "pending" },
    { name: "notion", status: "disabled" },
  ] as McpServerStatus[];
  expect(connectorsOf(statuses)).toEqual([
    { name: "chrome-devtools", kind: "chrome" },
    { name: "playwright", kind: "other" },
  ]);
});

test("the probe sends no message, waits out servers still connecting, and closes its query", async () => {
  let yielded = 0;
  let closed = false;
  let seen: Options | undefined;
  const answers: McpServerStatus["status"][][] = [
    ["pending", "pending"],
    ["connected", "pending"],
    ["connected", "connected"],
  ];
  const query = ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    seen = options;
    void (async () => {
      for await (const _ of prompt as AsyncIterable<SDKUserMessage>) yielded++;
    })();
    return {
      mcpServerStatus: async () => {
        const [a, b] = answers.length > 1 ? answers.shift()! : answers[0]!;
        return [
          { name: "chrome-devtools", status: a },
          { name: "computer-use", status: b },
        ];
      },
      close: () => void (closed = true),
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as Query;
  };
  const found = await probeConnectors({ query, executable: () => "/x/claude" }, { settingSources: ["user"] }, { pollMs: 0 });
  await Bun.sleep(0);
  expect(found).toEqual([
    { name: "chrome-devtools", kind: "chrome" },
    { name: "computer-use", kind: "computer-use" },
  ]);
  expect([yielded, closed, seen?.persistSession, seen?.pathToClaudeCodeExecutable, seen?.settingSources]).toEqual([0, true, false, "/x/claude", ["user"]]);
});

const CHROME: MachineConnector[] = [{ name: "chrome-devtools", kind: "chrome" }];

function watched(answers: (MachineConnector[] | Error)[]) {
  const sent: (readonly MachineConnector[])[] = [];
  const log: string[] = [];
  let probes = 0;
  const watch = watchConnectors({
    probe: async () => {
      const next = answers[Math.min(probes++, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    changed: (list) => sent.push(list),
    log: (line) => log.push(line),
  });
  return { watch, sent, log, probes: () => probes };
}

test("the machine reports its connectors when a probe finds a change, and stays quiet when nothing changed", async () => {
  const w = watched([CHROME, CHROME, []]);
  const t0 = Date.parse("2026-10-21T12:00:00.000Z");
  w.watch.tick(new Date(t0));
  await flush();
  expect(w.sent).toEqual([CHROME]);
  expect(w.watch.list()).toEqual(CHROME);

  w.watch.tick(new Date(t0 + CONNECTOR_PROBE_MS - 1));
  await flush();
  expect(w.probes()).toBe(1);
  expect(w.watch.nextDeadline()).toBe(new Date(t0 + CONNECTOR_PROBE_MS).toISOString());

  w.watch.tick(new Date(t0 + CONNECTOR_PROBE_MS));
  await flush();
  expect(w.sent).toEqual([CHROME]);

  w.watch.tick(new Date(t0 + 2 * CONNECTOR_PROBE_MS));
  await flush();
  expect(w.sent).toEqual([CHROME, []]);
});

test("a failed probe keeps the last list and logs once until one succeeds", async () => {
  const w = watched([CHROME, new Error("claude was not found"), new Error("claude was not found"), CHROME, new Error("timed out")]);
  const t0 = Date.parse("2026-10-21T12:00:00.000Z");
  for (let i = 0; i < 5; i++) {
    w.watch.tick(new Date(t0 + i * CONNECTOR_PROBE_MS));
    await flush();
  }
  expect(w.watch.list()).toEqual(CHROME);
  expect(w.sent).toEqual([CHROME]);
  expect(w.log).toHaveLength(2);
  expect(w.log[0]).toContain("claude was not found");
});

test("a probe still running is not started again", async () => {
  let release = () => {};
  let probes = 0;
  const watch = watchConnectors({
    probe: () => {
      probes++;
      return new Promise((resolve) => (release = () => resolve(CHROME)));
    },
    changed: () => {},
    log: () => {},
  });
  const t0 = Date.parse("2026-10-21T12:00:00.000Z");
  watch.tick(new Date(t0));
  watch.tick(new Date(t0 + 2 * CONNECTOR_PROBE_MS));
  expect(probes).toBe(1);
  release();
  await flush();
  expect(watch.list()).toEqual(CHROME);
});
