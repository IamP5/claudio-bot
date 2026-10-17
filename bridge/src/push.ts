import type { BotId, MessageId } from "./protocol";
import type { Persist } from "./store";
import type { World } from "./world";

// "<bot> needs you" when no socket is live: an ntfy-style POST to CLAUDIOBOT_PUSH_URL now, APNs later behind the
// same interface. The only writer of World.push. Owner: U6.
// No message content ever leaves the Mac: the body is the bot's name, the click link claudiobot://bot/<id>?message=<id>.
// Cards and reminders push once per key (`${cardId}|card`, `${cardId}|reminder`), recorded and flushed before the
// send so a crash never double-pushes. Messages push at most once per bot per 10 minutes. Failures only log.

export type PushReason = "card" | "reminder" | "message";

export type Push = { notify(bot: { id: BotId; name: string }, reason: PushReason, messageId: MessageId): void };

export function createPush(deps: {
  world: World;
  persist: Persist;
  /** null disables push. */
  url: string | null;
  /** Open authenticated sockets. A push goes out only when this is 0. */
  live: () => number;
  now: () => Date;
  log: (line: string) => void;
}): Push {
  throw new Error("not implemented");
}
