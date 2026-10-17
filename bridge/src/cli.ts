#!/usr/bin/env bun
import * as fs from "node:fs";
import { homedir } from "node:os";
import { lanAddresses } from "./address";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { doctor, serviceView, status, type DoctorDeps } from "./doctor";
import {
  capturedEnv,
  DEFAULT_LABEL,
  defaultLogDir,
  install,
  pair,
  serviceTarget,
  uninstall,
  update,
  type Exec,
  type Foreground,
  type ServiceDeps,
} from "./service";
import { errorText } from "./text";

const USAGE = `usage: claudiobot <install|uninstall|status|doctor|logs|pair|update> [--label <label>] [--log-dir <dir>]

  install    run the bridge as a LaunchAgent that starts at login, and print the pairing code
  uninstall  stop it and remove the LaunchAgent (your bots and data are kept)
  status     launchd state, pid, /health and the lock holder
  doctor     check everything the service needs; exits 1 on any FAIL
  logs       follow the service log
  pair       stop the service, run the bridge here with --pair until a phone pairs, start it again
  update     fetch, show incoming commits, and on yes pull, install and restart

--label and --log-dir (or CLAUDIOBOT_SERVICE_LABEL, CLAUDIOBOT_LOG_DIR) set up a separate, throwaway service.
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`${name} needs a value\n`);
    process.exit(2);
  }
  return value;
}

const exec: Exec = async (argv, opts) => {
  try {
    const proc = Bun.spawn(argv, { cwd: opts?.cwd, env: opts?.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: errorText(e) };
  }
};

/** The child shares the terminal, so Ctrl-C reaches it directly; this process waits and then restores the service. */
const foreground: Foreground = async (argv, { cwd, env, onLine }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      process.stdout.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line, () => proc.kill("SIGTERM"));
    }
    return await proc.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
};

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const label = flag(argv, "--label") ?? process.env.CLAUDIOBOT_SERVICE_LABEL ?? DEFAULT_LABEL;
  const logDir = flag(argv, "--log-dir") ?? process.env.CLAUDIOBOT_LOG_DIR ?? defaultLogDir();
  const target = serviceTarget({ label, uid: process.getuid!(), logDir, bridgeDir: dirname(import.meta.dir) });
  const out = (text: string) => process.stdout.write(text);
  const deps: ServiceDeps = { exec, out, sleep: Bun.sleep };
  const doctorDeps: DoctorDeps = {
    fs,
    exec,
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(2000) }),
    which: (command, path) => Bun.which(command, { PATH: path }),
    alive,
    lan: lanAddresses,
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  };

  switch (command) {
    case "install": {
      // The PATH symlink, not the resolved Cellar path, so a bun upgrade does not strand the plist.
      const bun = Bun.which("bun") ?? process.execPath;
      return install(deps, { target, bun, env: capturedEnv(process.env) });
    }
    case "uninstall":
      return uninstall(deps, target, (await serviceView(doctorDeps, target)).home);
    case "status":
      return status(doctorDeps, target, out);
    case "doctor":
      return doctor(doctorDeps, target, out);
    case "logs": {
      if (!fs.existsSync(target.log)) {
        out(`No log at ${target.log} yet. Run: claudiobot install\n`);
        return 1;
      }
      const tail = Bun.spawn(["tail", "-n", "200", "-F", target.log], { stdio: ["inherit", "inherit", "inherit"] });
      // A kill aimed at this process alone would otherwise leave tail running.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => tail.kill(signal));
      return tail.exited;
    }
    case "pair": {
      const view = await serviceView(doctorDeps, target);
      return pair({ ...deps, foreground }, target, {
        bun: view.installed?.bun ?? Bun.which("bun") ?? process.execPath,
        env: { ...process.env, ...view.env },
      });
    }
    case "update":
      return update({ ...deps, ask }, target);
    default:
      process.stderr.write(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
