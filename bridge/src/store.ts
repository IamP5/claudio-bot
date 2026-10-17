import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { World, AgentRecord, BotRecord } from "./world";

export const bridgeHome = () => process.env.CLAUDEBOT_HOME ?? join(homedir(), ".claudebot");

type StateFile = { version: 2; bots: BotRecord[]; agents: AgentRecord[] };

// firstRun is true when there is no v2 state yet, including a v1 file of tasks, which v2 does not carry over.
export function loadWorld(home = bridgeHome()): { world: World; firstRun: boolean } {
  const path = join(home, "state.json");
  const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>) : null;
  if (parsed?.version !== 2) return { world: { bots: new Map(), agents: new Map() }, firstRun: true };
  return {
    world: {
      bots: new Map((parsed.bots ?? []).map((b) => [b.id, b])),
      agents: new Map((parsed.agents ?? []).map((a) => [a.agent.id, a])),
    },
    firstRun: false,
  };
}

export function createSaver(world: World, home = bridgeHome(), delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    mkdirSync(home, { recursive: true });
    const path = join(home, "state.json");
    const body: StateFile = { version: 2, bots: [...world.bots.values()], agents: [...world.agents.values()] };
    // Synchronous write then rename: a crash mid-write never leaves a truncated file, and shutdown can flush.
    writeFileSync(`${path}.tmp`, JSON.stringify(body));
    renameSync(`${path}.tmp`, path);
  };
  return {
    schedule() {
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}

export async function loadOrCreateToken(home = bridgeHome()): Promise<string> {
  const file = Bun.file(join(home, "token"));
  if (await file.exists()) {
    const token = (await file.text()).trim();
    if (token !== "") return token;
  }
  mkdirSync(home, { recursive: true });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await Bun.write(file, token + "\n");
  chmodSync(join(home, "token"), 0o600);
  return token;
}
