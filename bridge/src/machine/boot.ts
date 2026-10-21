import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeApps } from "../claudeApps";
import { createClock } from "../clock";
import { createHomes } from "../home";
import { projectFolders, projectRoots, scanProjects } from "../projects";
import type { BotId, SessionId } from "../protocol";
import { createSessions, type Sessions } from "../sessions";
import { createSaver, loadWorld } from "../store";
import { errorText } from "../text";
import { dialHub, type Dialer } from "./dial";
import type { HomeRef, Identity } from "./identity";
import { fileJournal } from "./journal";
import { createMachineNode } from "./node";
import { sessionScope, type MachineProfile } from "./profile";
import { profileView } from "./wire";

// A bridge whose machine.json names a home runs as that home's machine: its agents, gate, ledger, sandbox and
// transcripts, on its own World, and its own Sessions tab, which the phone reaches through the home. No bots, no
// scheduler, no push, no phone socket, no pairing. It listens only for /health, and dials its home for everything else.

export type MachineBoot = { stop(): void };

export function bootMachine(deps: {
  home: string;
  identity: Identity & { home: HomeRef };
  profile: MachineProfile;
  userName: string;
  port: number;
  claude: { query: typeof query };
  /** The Claude app and Claude Code's live sessions on this machine, for its Sessions tab. */
  apps: ClaudeApps;
  log: (line: string) => void;
}): MachineBoot {
  const { home, identity, profile, log } = deps;
  const now = () => new Date();
  const { world } = loadWorld(home);
  const saver = createSaver(world, home, 250, log);
  const homes = createHomes(home);
  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  // Both are made below and called only once the clock and the link run.
  let sessions: Sessions;
  let dialer: Dialer;
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
    projectsDir,
    scan: () => scanProjects(),
    journal: fileJournal(join(home, "machine"), log),
    observe(actor, m) {
      const id = world.agents.get(actor.agentId)?.session.id;
      if (id) sessions.stream(id as SessionId, m);
    },
    turnDone: (rec) => sessions.agentTurnDone(rec),
  });
  sessions = createSessions({
    // Each start its own, so a phone's thread position from before a restart is never replayed.
    epoch: Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex"),
    projectsDir,
    apps: deps.apps,
    cacheDir: join(home, "cache"),
    signal: {
      list: (frame) => dialer.signal(frame),
      thread(id, frame) {
        if (dialer.watched(id)) dialer.signal(frame);
      },
    },
    watchers: (id) => (dialer.watched(id) ? 1 : 0),
    machine: identity.machineId,
    world,
    userName: deps.userName,
    bridgeHome: profile.bridgeHome,
    roots: projectRoots().filter(existsSync).map((r) => realpathSync(r)),
    agents: node.runtime.local,
    send: (intent) => node.runtime.apply(intent),
    decideGate: (botId, cardId, choice) => node.gate.answer(botId as BotId, cardId, { kind: "permission", choice }),
    ledger: node.ledger,
    claude: deps.claude,
    scope: (cwd) => sessionScope(profile, cwd),
    notify: (sessionId, cardId) => node.runtime.emit({ kind: "sessionCard", sessionId, cardId }),
    folders: () => projectFolders().map((f) => f.path),
    persist: saver.schedule,
    now,
    log,
  });
  node.runtime.subscribe((e) => {
    const rec = e.kind === "agent" ? world.agents.get(e.agent.id) : undefined;
    if (rec) sessions.agentChanged(rec);
  });
  const clock = createClock({ tickers: [...node.tickers, sessions], now, log });

  const health = Bun.serve({
    port: deps.port,
    hostname: "0.0.0.0",
    development: false,
    fetch: (req) => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true }) : new Response("Not found", { status: 404 })),
  });

  const view = profileView(profile);
  // Recorded before the link is up, so the home hears this boot's profile, its access mode included, once it is.
  node.runtime.emit({ kind: "profile", profile: view });
  dialer = dialHub({ identity, runtime: node.runtime, profile: view, sessions, log });
  node.boot();
  sessions.resume();
  clock.start();
  void sessions.start().catch((e) => log(`sessions: the index could not start: ${errorText(e)}`));

  console.log(`claudiobot machine "${identity.name}" of "${identity.home.name}" (${identity.home.url})`);
  console.log(`  health on :${health.port}`);

  return {
    stop() {
      dialer.stop();
      clock.stop();
      sessions.stop();
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
