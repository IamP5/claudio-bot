import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ItemId, TaskId } from "./protocol";
import { apply, fromStored, isLive, toStored, type StoredTask, type TaskState } from "./task";

export const bridgeHome = () => process.env.CLAUDEBOT_HOME ?? join(homedir(), ".claudebot");

type StateFile = { version: 1; tasks: StoredTask[] };

export async function loadTasks(home = bridgeHome()): Promise<Map<TaskId, TaskState>> {
  const file = Bun.file(join(home, "state.json"));
  const tasks = new Map<TaskId, TaskState>();
  if (!(await file.exists())) return tasks;
  const parsed = (await file.json()) as StateFile;
  const at = new Date().toISOString();
  for (const stored of parsed.tasks ?? []) {
    let task = fromStored(stored);
    // The process that ran a live task died with the old bridge; nothing will ever answer it.
    if (isLive(task.summary.status)) {
      const notice = { itemId: `notice:restart:${at}` as ItemId, text: "The bridge restarted, so this task was stopped." };
      task = apply(task, { type: "stopped", at, notice }).state;
    }
    tasks.set(task.summary.id, task);
  }
  return tasks;
}

export function createSaver(home = bridgeHome(), delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: () => TaskState[] = () => [];
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    mkdirSync(home, { recursive: true });
    const path = join(home, "state.json");
    const body: StateFile = { version: 1, tasks: latest().map(toStored) };
    // Synchronous write then rename: a crash mid-write never leaves a truncated file, and shutdown can flush.
    writeFileSync(`${path}.tmp`, JSON.stringify(body));
    renameSync(`${path}.tmp`, path);
  };
  return {
    schedule(snapshot: () => TaskState[]) {
      latest = snapshot;
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
