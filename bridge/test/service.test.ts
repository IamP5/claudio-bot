import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedEnv,
  DEFAULT_LABEL,
  install,
  pair,
  parseLaunchdPrint,
  parseSystemctlShow,
  plistXml,
  readInstalled,
  serviceTarget,
  systemdUnit,
  uninstall,
  update,
  type Exec,
  type Ran,
  type ServiceSpec,
  type ServiceTarget,
} from "../src/service";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const no = (code: number, stderr: string): Ran => ({ code, stdout: "", stderr });

const spec = (over: Partial<ServiceSpec["target"]> = {}, env: Record<string, string> = { PATH: "/opt/homebrew/bin:/usr/bin" }): ServiceSpec => ({
  target: { platform: "darwin", label: "com.claudiobot.bridge", uid: 501, unit: "/Users/me/Library/LaunchAgents/com.claudiobot.bridge.plist", log: "/Users/me/Library/Logs/ClaudioBot/bridge.log", bridgeDir: "/Users/me/claudiobot/bridge", ...over },
  bun: "/opt/homebrew/bin/bun",
  env,
});

describe("plist", () => {
  test("is a LaunchAgent that runs main.ts with bun, restarts on crash only, and logs to one file", () => {
    expect(plistXml(spec())).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.claudiobot.bridge</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/homebrew/bin/bun</string>
\t\t<string>/Users/me/claudiobot/bridge/src/main.ts</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>/Users/me/claudiobot/bridge</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/bin</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>/Users/me/Library/Logs/ClaudioBot/bridge.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/me/Library/Logs/ClaudioBot/bridge.log</string>
</dict>
</plist>
`);
  });

  test("escapes XML in keys and values", () => {
    const xml = plistXml(spec({ bridgeDir: "/Users/me/R&D <x>" }, { CLAUDIOBOT_USER_NAME: `O'Brien & "Co" <3` }));
    expect(xml).toContain(`<string>O&apos;Brien &amp; &quot;Co&quot; &lt;3</string>`);
    expect(xml).toContain(`<string>/Users/me/R&amp;D &lt;x&gt;/src/main.ts</string>`);
  });

  const realExec: Exec = async (argv) => {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };

  test.skipIf(!Bun.which("plutil"))("round-trips through plutil with awkward values intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plist-"));
    const env = { PATH: "/a b/bin:/usr/bin", CLAUDIOBOT_USER_NAME: `O'Brien & "Co" <3 ünï` };
    const path = join(dir, "x.plist");
    writeFileSync(path, plistXml(spec({ bridgeDir: "/R&D <x>" }, env)));
    expect((await realExec(["plutil", "-lint", path])).code).toBe(0);
    expect(await readInstalled(realExec, { ...spec().target, unit: path })).toEqual({ bun: "/opt/homebrew/bin/bun", main: "/R&D <x>/src/main.ts", env });
  });
});

describe("systemd unit", () => {
  const linuxSpec = (bridgeDir = "/home/me/claudio-bot/bridge", env: Record<string, string> = { PATH: "/home/me/.bun/bin:/usr/bin", CLAUDIOBOT_ACCESS: "full", CLAUDIOBOT_SANDBOX: "off" }): ServiceSpec => ({
    target: serviceTarget({ platform: "linux", label: DEFAULT_LABEL.linux, uid: 1000, logDir: "/home/me/.local/state/claudiobot", bridgeDir, home: "/home/me" }),
    bun: "/home/me/.bun/bin/bun",
    env,
  });

  test("lives in the user's systemd dir, runs main.ts with bun, restarts on crash only, logs to one file and starts at login", () => {
    const spec = linuxSpec();
    expect(spec.target.unit).toBe("/home/me/.config/systemd/user/claudiobot.service");
    expect(systemdUnit(spec)).toBe(`[Unit]
Description=ClaudioBot bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/me/claudio-bot/bridge
ExecStart="/home/me/.bun/bin/bun" "/home/me/claudio-bot/bridge/src/main.ts"
Environment="PATH=/home/me/.bun/bin:/usr/bin"
Environment="CLAUDIOBOT_ACCESS=full"
Environment="CLAUDIOBOT_SANDBOX=off"
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/me/.local/state/claudiobot/bridge.log
StandardError=append:/home/me/.local/state/claudiobot/bridge.log

[Install]
WantedBy=default.target
`);
  });

  test("reads back what it wrote, with quotes, backslashes, % and $ intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-"));
    const env = { PATH: "/a b/bin:/usr/bin", CLAUDIOBOT_USER_NAME: `O'Brien "100%" $HOME \\o/ ünï` };
    const spec = linuxSpec("/srv/R&D 50%$x", env);
    const target = { ...spec.target, unit: join(dir, "claudiobot.service") };
    writeFileSync(target.unit, systemdUnit({ ...spec, target }));
    expect(readFileSync(target.unit, "utf8")).toContain(`Environment="CLAUDIOBOT_USER_NAME=O'Brien \\"100%%\\" $HOME \\\\o/ ünï"`);
    expect(await readInstalled(async () => no(127, "no exec"), target)).toEqual({ bun: "/home/me/.bun/bin/bun", main: "/srv/R&D 50%$x/src/main.ts", env });
  });
});

test("reads systemd's state of the unit: running, stopped, or not there", () => {
  expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\n")).toEqual({ state: "running", pid: 4242, lastExit: "0" });
  expect(parseSystemctlShow("LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\n")).toEqual({ state: "failed", pid: null, lastExit: "1" });
  expect(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\nMainPID=0\n")).toBeNull();
});

/** The systemd user manager as far as these commands see it: it knows a unit once its file exists. */
function fakeSystemd(target: ServiceTarget) {
  const calls: string[] = [];
  let running = false;
  let enabled = false;
  const exec: Exec = async (argv) => {
    calls.push(argv.join(" "));
    const [tool, user, verb] = argv;
    if (tool !== "systemctl" || user !== "--user") return no(127, `unexpected ${argv.join(" ")}`);
    switch (verb) {
      case "daemon-reload":
        return ok();
      case "show":
        if (!existsSync(target.unit)) return ok("LoadState=not-found\nActiveState=inactive\n");
        return ok(`LoadState=loaded\nActiveState=${running ? "active" : "inactive"}\nSubState=${running ? "running" : "dead"}\nMainPID=${running ? 77 : 0}\n`);
      case "enable":
        enabled = true;
        running = true;
        appendFileSync(target.log, PAIRING);
        return ok();
      case "stop":
        running = false;
        return ok();
      case "disable":
        enabled = false;
        return ok();
      default:
        return no(1, `unknown verb ${verb}`);
    }
  };
  return { exec, calls, state: () => ({ running, enabled }) };
}

describe("install and uninstall on Linux", () => {
  function linuxSandbox() {
    const root = mkdtempSync(join(tmpdir(), "svc-linux-"));
    const target = serviceTarget({ platform: "linux", label: "claudiobot-test", uid: 1000, logDir: join(root, ".local", "state", "claudiobot"), bridgeDir: "/b", home: root });
    let text = "";
    return { root, target, deps: { out: (t: string) => void (text += t), sleep: async () => {} }, output: () => text };
  }

  test("install writes the user unit, enables and starts it, prints the code and how to outlive a logout", async () => {
    const { target, deps, output } = linuxSandbox();
    const systemd = fakeSystemd(target);
    expect(await install({ ...deps, exec: systemd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000)).toBe(0);
    expect(statSync(target.unit).mode & 0o777).toBe(0o600);
    expect(readFileSync(target.unit, "utf8")).toContain('ExecStart="/bin/bun" "/b/src/main.ts"');
    expect(systemd.calls).toContain("systemctl --user enable --now claudiobot-test.service");
    expect(systemd.state()).toEqual({ running: true, enabled: true });
    expect(output()).toContain("loginctl enable-linger");
    expect(output()).toContain("pair code: 7KQM-X2PD");
  });

  test("uninstall stops, disables and removes the unit, and keeps the log", async () => {
    const { root, target, deps, output } = linuxSandbox();
    const systemd = fakeSystemd(target);
    await install({ ...deps, exec: systemd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    expect(await uninstall({ ...deps, exec: systemd.exec }, target, join(root, ".claudiobot"))).toBe(0);
    expect(systemd.state()).toEqual({ running: false, enabled: false });
    expect(existsSync(target.unit)).toBe(false);
    expect(existsSync(target.log)).toBe(true);
    expect(output()).toContain("stopped and removed claudiobot-test.");
  });
});

test("captures PATH, CLAUDIOBOT_* and Claude Code's config dir but not the CLI's own controls or other variables", () => {
  expect(
    capturedEnv({
      PATH: "/bin",
      HOME: "/Users/me",
      CLAUDIOBOT_CLAUDE: "/Users/me/.local/bin/claude",
      CLAUDIOBOT_PORT: "7999",
      CLAUDIOBOT_SERVICE_LABEL: "x",
      CLAUDIOBOT_LOG_DIR: "/tmp",
      GITHUB_TOKEN: "secret",
      CLAUDEBOT_HOME: "/old",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
    }),
  ).toEqual({
    CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
    CLAUDIOBOT_CLAUDE: "/Users/me/.local/bin/claude",
    CLAUDIOBOT_PORT: "7999",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    PATH: "/bin",
  });
});

test("reads the service's own state and pid, not the nested blocks'", () => {
  const text = `gui/501/com.claudiobot.bridge = {
\tactive count = 1
\tpath = /Users/me/Library/LaunchAgents/com.claudiobot.bridge.plist
\tstate = running
\tendpoints = {
\t\t"x" = {
\t\t\tstate = active
\t\t}
\t}
\tpid = 4242
\tlast exit code = (never exited)
}`;
  expect(parseLaunchdPrint(text)).toEqual({ state: "running", pid: 4242, lastExit: "(never exited)" });
  expect(parseLaunchdPrint("gui/501/x = {\n\tstate = not running\n\tlast exit code = 1\n}")).toEqual({ state: "not running", pid: null, lastExit: "1" });
});

/** launchd as far as these commands see it: bootout takes one more print to finish, as the real one does. */
function fakeLaunchd(onStart: (log: string) => string) {
  const jobs = new Map<string, { plist: string; body: string; pid: number; stopping: boolean }>();
  let nextPid = 100;
  const logs = new Map<string, string>();
  const calls: string[] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv.join(" "));
    const [tool, verb, a, b] = argv;
    if (tool !== "launchctl") return no(127, `unexpected ${tool}`);
    if (verb === "print") {
      const label = a!.split("/")[2]!;
      const job = jobs.get(label);
      if (!job) return no(113, `Could not find service "${label}"`);
      if (job.stopping) jobs.delete(label);
      return ok(`gui/501/${label} = {\n\tstate = running\n\tpid = ${job.pid}\n}`);
    }
    if (verb === "bootout") {
      const job = jobs.get(a!.split("/")[2]!);
      if (!job) return no(3, "Boot-out failed: 3: No such process");
      job.stopping = true;
      return ok();
    }
    if (verb === "bootstrap") {
      const body = readFileSync(b!, "utf8");
      const label = body.match(/<key>Label<\/key>\n\t<string>([^<]+)</)![1]!;
      if (jobs.has(label)) return no(5, "Bootstrap failed: 5: Input/output error");
      jobs.set(label, { plist: b!, body, pid: nextPid++, stopping: false });
      const log = body.match(/<key>StandardOutPath<\/key>\n\t<string>([^<]+)</)![1]!;
      logs.set(label, log);
      appendFileSync(log, onStart(log));
      return ok();
    }
    if (verb === "kickstart") {
      const job = jobs.get(argv.at(-1)!.split("/")[2]!);
      if (!job) return no(113, "not found");
      job.pid = nextPid++;
      return ok();
    }
    return no(1, "unknown verb");
  };
  return { exec, jobs, calls };
}

const PAIRING = "claudiobot bridge on Mac\n  ws://10.0.0.2:7878/ws\npair code: 7KQM-X2PD (single use, until 10:10:00)\npair: claudiobot://pair?url=ws&code=7KQM-X2PD\n";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "svc-"));
  const target = serviceTarget({ platform: "darwin", label: "com.claudiobot.bridge.test", uid: 501, logDir: join(root, "Logs", "ClaudioBot"), bridgeDir: "/b", home: root });
  let text = "";
  const deps = { out: (t: string) => void (text += t), sleep: async () => {} };
  return { root, target, deps, output: () => text, reset: () => void (text = "") };
}

describe("install", () => {
  test("writes the plist, pre-creates a 0600 log in a 0700 dir, starts the job and prints the pairing code", async () => {
    const { target, deps, output } = sandbox();
    const launchd = fakeLaunchd(() => PAIRING);
    expect(await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000)).toBe(0);
    expect(statSync(target.log).mode & 0o777).toBe(0o600);
    expect(statSync(join(target.log, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(target.unit).mode & 0o777).toBe(0o600);
    expect(launchd.jobs.get("com.claudiobot.bridge.test")?.body).toBe(readFileSync(target.unit, "utf8"));
    expect(output()).toContain("pair code: 7KQM-X2PD (single use, until 10:10:00)\npair: claudiobot://pair?url=ws&code=7KQM-X2PD\n");
  });

  test("a second install replaces the running job instead of failing on it", async () => {
    const { target, deps, output, reset } = sandbox();
    const launchd = fakeLaunchd(() => PAIRING);
    await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    reset();
    expect(await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin", CLAUDIOBOT_PORT: "7999" } }, 1000)).toBe(0);
    expect(output()).toContain("stopped the running com.claudiobot.bridge.test\n");
    expect([...launchd.jobs.keys()]).toEqual(["com.claudiobot.bridge.test"]);
    expect(launchd.jobs.get("com.claudiobot.bridge.test")!.body).toContain("<key>CLAUDIOBOT_PORT</key>\n\t\t<string>7999</string>");
    expect(launchd.jobs.get("com.claudiobot.bridge.test")!.pid).toBe(101);
  });

  test("a bridge that refuses to start (another holds the lock) is stopped again, so launchd does not loop it", async () => {
    const { target, deps, output } = sandbox();
    const launchd = fakeLaunchd(() => "Another ClaudioBot bridge (pid 9) is using /h. Stop it first; if none is running, delete /h.lock.\n");
    expect(await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000)).toBe(1);
    expect(launchd.jobs.size).toBe(0);
    expect(output()).toContain("Another ClaudioBot bridge (pid 9)");
    expect(existsSync(target.unit)).toBe(true);
  });

  test("echoes only this start's lines, not an older run's code", async () => {
    const { target, deps, output } = sandbox();
    mkdirSync(join(target.log, ".."), { recursive: true });
    writeFileSync(target.log, "pair code: OLD0-OLD0 (single use)\npair: old\n");
    const launchd = fakeLaunchd(() => PAIRING);
    await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    expect(output()).not.toContain("OLD0");
    expect(output()).toContain("7KQM-X2PD");
  });
});

describe("uninstall", () => {
  test("stops the job and removes the plist, but keeps the data home and the log; a rerun is a no-op", async () => {
    const { root, target, deps, output, reset } = sandbox();
    const home = join(root, ".claudiobot");
    mkdirSync(home);
    writeFileSync(join(home, "state.json"), "{}");
    const launchd = fakeLaunchd(() => PAIRING);
    await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    reset();
    expect(await uninstall({ ...deps, exec: launchd.exec }, target, home)).toBe(0);
    expect(launchd.jobs.size).toBe(0);
    expect(existsSync(target.unit)).toBe(false);
    expect(readFileSync(join(home, "state.json"), "utf8")).toBe("{}");
    expect(existsSync(target.log)).toBe(true);
    reset();
    expect(await uninstall({ ...deps, exec: launchd.exec }, target, home)).toBe(0);
    expect(output()).toBe("com.claudiobot.bridge.test is not installed.\n");
  });
});

describe("pair", () => {
  test("runs the bridge with --pair while the service is out of the way, stops it once a phone pairs, then restarts the service", async () => {
    const { target, deps } = sandbox();
    const launchd = fakeLaunchd(() => PAIRING);
    await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    const seen: { argv: string[]; serviceLoaded: boolean; stopped: boolean }[] = [];
    const code = await pair(
      {
        ...deps,
        exec: launchd.exec,
        foreground: async (argv, { onLine }) => {
          const run = { argv, serviceLoaded: launchd.jobs.has(target.label), stopped: false };
          seen.push(run);
          onLine("pair code: AAAA-BBBB (single use)", () => {});
          onLine("paired Bruno's iPhone", () => void (run.stopped = true));
          return 0;
        },
      },
      target,
      { bun: "/bin/bun", env: {} },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ argv: ["/bin/bun", "/b/src/main.ts", "--pair"], serviceLoaded: false, stopped: true }]);
    expect(launchd.jobs.has(target.label)).toBe(true);
  });

  test("restarts the service even when the foreground bridge throws", async () => {
    const { target, deps } = sandbox();
    const launchd = fakeLaunchd(() => PAIRING);
    await install({ ...deps, exec: launchd.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    const failing = pair({ ...deps, exec: launchd.exec, foreground: async () => Promise.reject(new Error("spawn failed")) }, target, { bun: "/bin/bun", env: {} });
    await expect(failing).rejects.toThrow("spawn failed");
    expect(launchd.jobs.has(target.label)).toBe(true);
  });
});

describe("update", () => {
  function repo(incoming: string) {
    const state = { head: "a1", installs: 0 };
    const launchd = fakeLaunchd(() => PAIRING);
    const exec: Exec = async (argv, opts) => {
      if (argv[0] === "launchctl") return launchd.exec(argv, opts);
      if (argv[0] === "bun") return state.installs++, ok();
      const sub = argv.slice(1).join(" ");
      if (sub === "fetch --quiet") return ok();
      if (sub.startsWith("rev-parse")) return ok("origin/main\n");
      if (sub.startsWith("log")) return ok(state.head === "a1" ? incoming : "");
      if (sub === "pull --ff-only") return (state.head = "c3"), ok();
      return no(1, `unexpected ${argv.join(" ")}`);
    };
    return { state, exec, launchd };
  }

  test("shows the incoming commits and changes nothing without a yes", async () => {
    const { target, deps, output } = sandbox();
    const r = repo("c3 Fix the gate\nb2 Add doctor\n");
    const questions: string[] = [];
    const code = await update({ ...deps, exec: r.exec, ask: async () => (questions.push(output()), false) }, target);
    expect(code).toBe(0);
    expect(questions[0]).toContain("Incoming from origin/main:\nc3 Fix the gate\nb2 Add doctor\n");
    expect(r.state).toEqual({ head: "a1", installs: 0 });
    expect(output()).toEndWith("Not updated.\n");
  });

  test("on yes pulls, installs with the frozen lockfile and restarts the running service", async () => {
    const { target, deps, output } = sandbox();
    const r = repo("c3 Fix the gate\n");
    await install({ ...deps, exec: r.exec }, { target, bun: "/bin/bun", env: { PATH: "/bin" } }, 1000);
    const pidBefore = r.launchd.jobs.get(target.label)!.pid;
    expect(await update({ ...deps, exec: r.exec, ask: async () => true }, target)).toBe(0);
    expect(r.state).toEqual({ head: "c3", installs: 1 });
    expect(r.launchd.jobs.get(target.label)!.pid).not.toBe(pidBefore);
    expect(output()).toEndWith(`Updated and restarted ${target.label}.\n`);
  });

  test("asks nothing when there is nothing to pull", async () => {
    const { target, deps, output } = sandbox();
    const r = repo("");
    let asked = 0;
    expect(await update({ ...deps, exec: r.exec, ask: async () => (asked++, true) }, target)).toBe(0);
    expect({ asked, out: output() }).toEqual({ asked: 0, out: "Already up to date with origin/main.\n" });
  });
});
