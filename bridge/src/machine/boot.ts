import { homedir } from "node:os";
import { join } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { createClock } from "../clock";
import { createHomes } from "../home";
import { scanProjects } from "../projects";
import { createSaver, loadWorld } from "../store";
import { errorText } from "../text";
import { dialHub } from "./dial";
import type { HomeRef, Identity } from "./identity";
import { fileJournal } from "./journal";
import { createMachineNode } from "./node";
import type { MachineProfile } from "./profile";
import { profileView } from "./wire";

// A bridge whose machine.json names a home runs as that home's machine: its agents, gate, ledger, sandbox and
// transcripts, on its own World, and nothing else. No bots, no scheduler, no push, no phone socket, no pairing. It
// listens only for /health, and dials its home for everything else.

export type MachineBoot = { stop(): void };

export function bootMachine(deps: {
  home: string;
  identity: Identity & { home: HomeRef };
  profile: MachineProfile;
  userName: string;
  port: number;
  claude: { query: typeof query };
  log: (line: string) => void;
}): MachineBoot {
  const { home, identity, profile, log } = deps;
  const now = () => new Date();
  const { world } = loadWorld(home);
  const saver = createSaver(world, home, 250, log);
  const homes = createHomes(home);
  const node = createMachineNode({
    world,
    profile,
    userName: deps.userName,
    model: process.env.CLAUDIOBOT_MODEL || undefined,
    claude: deps.claude,
    persist: saver.schedule,
    log,
    now,
    root: home,
    agentConfig: (id) => homes.agentConfig(id),
    projectsDir: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
    scan: () => scanProjects(),
    journal: fileJournal(join(home, "machine"), log),
  });
  const clock = createClock({ tickers: node.tickers, now, log });

  const health = Bun.serve({
    port: deps.port,
    hostname: "0.0.0.0",
    development: false,
    fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true }) : new Response("Not found", { status: 404 })),
  });

  const view = profileView(profile);
  // Recorded before the link is up, so the home hears this boot's profile, its access mode included, once it is.
  node.runtime.emit({ kind: "profile", profile: view });
  node.boot();
  clock.start();
  const dialer = dialHub({ identity, runtime: node.runtime, profile: view, log });

  console.log(`claudiobot machine "${identity.name}" of "${identity.home.name}" (${identity.home.url})`);
  console.log(`  health on :${health.port}`);

  return {
    stop() {
      dialer.stop();
      clock.stop();
      health.stop(true);
      try {
        node.close();
      } catch (e) {
        log(`shutdown: closing the agents failed: ${errorText(e)}`);
      }
      saver.flush();
    },
  };
}
