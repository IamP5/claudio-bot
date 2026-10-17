import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BotId, RoutineId } from "./protocol";
import type { Scheduler } from "./scheduler";
import type { Persist } from "./store";
import type { BotRecord, RoutineRecord, World } from "./world";

// A webhook routine fires when a program on this Mac POSTs to http://127.0.0.1:<port>/hook/<id>
// with Authorization: Bearer <token>. Loopback only, never 0.0.0.0 or a tunnel; a request with an Origin header, or a
// Host other than the loopback address, is refused; only the token's sha256 is stored (Trigger.tokenHash); the body is
// passed to the routine as data (capped, fenced, never instructions); the scheduler fires at most once per call and a
// cooldown spaces calls.

export const PAYLOAD_MAX_BYTES = 16 * 1024;
export const HOOK_COOLDOWN_MS = 60_000;
const TOKEN_PREFIX = "whk_";

export type Webhooks = {
  /** A new token for the routine, replacing the old one. The token is returned once and never stored. */
  token(botId: BotId, routineId: RoutineId): { url: string; token: string } | { error: string };
  /** The HTTP handler, testable without a socket. */
  handle(req: Request): Promise<Response>;
  /** Listens on 127.0.0.1 when a port is configured. */
  start(): void;
  stop(): void;
};

export type WebhooksDeps = {
  world: World;
  scheduler: Pick<Scheduler, "hook" | "setHookToken">;
  persist: Persist;
  /** null: no listener (tests, or webhooks turned off). */
  port: number | null;
  now: () => Date;
  log: (line: string) => void;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest();

function tokenMatches(presented: string, storedHex: string | null): boolean {
  if (storedHex === null) return false;
  const stored = Buffer.from(storedHex, "hex");
  const digest = sha256(presented);
  return stored.length === digest.length && timingSafeEqual(stored, digest);
}

const reply = (status: number, text: string) => new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export function createWebhooks(deps: WebhooksDeps): Webhooks {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const port = () => server?.port ?? deps.port;

  function find(routineId: string): { bot: BotRecord; routine: RoutineRecord } | null {
    for (const bot of deps.world.bots.values()) {
      const routine = bot.routines.find((r) => r.id === routineId);
      if (routine) return { bot, routine: routine as RoutineRecord };
    }
    return null;
  }

  /** The cooldown is a fact of the run history: a call within a minute of the routine's last webhook fire waits. */
  function coolingDown(r: RoutineRecord): boolean {
    const last = r.runs.find((run) => !run.manual);
    return last !== undefined && deps.now().getTime() - Date.parse(last.at) < HOOK_COOLDOWN_MS;
  }

  async function readBody(req: Request): Promise<string | null> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > PAYLOAD_MAX_BYTES) return null;
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > PAYLOAD_MAX_BYTES) return null;
    return new TextDecoder().decode(bytes);
  }

  async function handle(req: Request): Promise<Response> {
    const p = port();
    const host = req.headers.get("host");
    if (req.headers.has("origin") || p === null || (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`)) {
      return reply(403, "Forbidden: webhooks answer local programs only, never a browser.");
    }
    const match = /^\/hook\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url).pathname);
    if (!match) return reply(404, "Not found");
    if (req.method !== "POST") return reply(405, "Use POST.");

    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    const found = find(match[1]!);
    const stored = found?.routine.trigger.kind === "webhook" ? found.routine.trigger.tokenHash : null;
    if (!found || !tokenMatches(presented, stored)) return reply(401, "Unauthorized: wrong or missing token.");

    const payload = await readBody(req);
    if (payload === null) return reply(413, `Payload too large: at most ${PAYLOAD_MAX_BYTES} bytes.`);

    // From here to the fire nothing awaits, so of two concurrent calls only the first can pass the cooldown.
    const { bot, routine } = found;
    if (coolingDown(routine)) return reply(429, `Too soon: a webhook routine fires at most once a minute.`);
    let why: string | null;
    try {
      why = deps.scheduler.hook(bot.id, routine.id, payload);
    } catch (error) {
      deps.log(`webhook: ${routine.name} for ${bot.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply(500, "The bridge could not fire the routine.");
    }
    if (why !== null) return reply(409, `Not fired: ${why}`);
    deps.log(`webhook: fired ${routine.name} for ${bot.id}`);
    return reply(202, "Fired.");
  }

  return {
    token(botId, routineId) {
      const p = port();
      if (p === null) return { error: "Webhooks are off on this bridge." };
      const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const error = deps.scheduler.setHookToken(botId, routineId, sha256(token).toString("hex"));
      if (error !== null) return { error };
      return { url: `http://127.0.0.1:${p}/hook/${routineId}`, token };
    },

    handle,

    start() {
      if (deps.port === null || server !== null) return;
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port: deps.port, maxRequestBodySize: PAYLOAD_MAX_BYTES, fetch: handle });
        deps.log(`webhook: listening on 127.0.0.1:${server.port}`);
      } catch (error) {
        deps.log(`webhook: could not listen on 127.0.0.1:${deps.port}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    stop() {
      server?.stop(true);
      server = null;
    },
  };
}
