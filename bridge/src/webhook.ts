import type { BotId, RoutineId } from "./protocol";
import type { Scheduler } from "./scheduler";
import type { Persist } from "./store";
import type { World } from "./world";

// A webhook routine fires when a program on this Mac POSTs to http://127.0.0.1:<port>/hook/<id>
// with Authorization: Bearer <token>. Loopback only, never 0.0.0.0 or a tunnel; a request with an Origin header, or a
// Host other than the loopback address, is refused; only the token's sha256 is stored (Trigger.tokenHash); the body is
// passed to the routine as data (capped, fenced, never instructions); the scheduler fires at most once per call and a
// cooldown spaces calls.

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

export function createWebhooks(_deps: WebhooksDeps): Webhooks {
  return {
    token: () => ({ error: "Webhooks are not available on this bridge yet." }),
    handle: async () => new Response("Not found", { status: 404 }),
    start() {},
    stop() {},
  };
}
