import type { BotId, MessageId } from "./protocol";
import type { Persist } from "./store";
import type { Owned, PushState, World } from "./world";

// "<bot> needs you" when no socket is live: an ntfy-style POST to CLAUDIOBOT_PUSH_URL now, APNs later behind the
// same Sender. The only writer of World.push. Owner: U6.
// No message content ever leaves the Mac: the text is the bot's name (cleaned, at most 40 characters) and a fixed
// phrase per reason, the click link
// claudiobot://bot/<id>?message=<id>.
// Every push has one key, `${messageId}|${reason}`: a card, its reminder, and a turn's first bubble each push at most
// once. The key is recorded and flushed before the send, so a crash never double-pushes and a failed send is not
// retried. Messages push at most once per bot per 10 minutes, counting every push the bot made. Failures only log.

export type PushReason = "card" | "reminder" | "message";

export type Push = { notify(bot: { id: BotId; name: string }, reason: PushReason, messageId: MessageId): void };

/** What a transport receives. `text` and `link` are the whole user-visible payload. */
export type Notification = { botId: BotId; messageId: MessageId; text: string; link: string };

/** One delivery attempt. Rejects on failure; the caller never retries. ntfy now, APNs later. */
export type Sender = (n: Notification) => Promise<void>;

export const MESSAGE_THROTTLE_MS = 10 * 60_000;
// Far longer than any card stays open, so a key is never forgotten while its card can still remind.
const RETAIN_MS = 7 * 24 * 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const NAME_MAX = 40;

const PHRASE: Record<PushReason, string> = {
  card: "needs you",
  reminder: "is still waiting for you",
  message: "has an update for you",
};

export const linkTo = (botId: BotId, messageId: MessageId) =>
  `claudiobot://bot/${encodeURIComponent(botId)}?message=${encodeURIComponent(messageId)}`;

export function ntfySender(url: string, fetchFn: typeof fetch = fetch): Sender {
  return async (n) => {
    // Bot names may be non-Latin-1, which fetch rejects in a header, so the name rides in the UTF-8 body.
    const res = await fetchFn(url, {
      method: "POST",
      body: n.text,
      headers: { Title: "ClaudioBot", Click: n.link },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  };
}

/** CLAUDIOBOT_PUSH_URL unset or blank: push is off. Not an http(s) URL: push is off, with a log line. */
export function senderFromEnv(value: string | undefined, log: (line: string) => void, fetchFn: typeof fetch = fetch): Sender | null {
  const raw = value?.trim();
  if (!raw) return null;
  const url = URL.parse(raw);
  if (url?.protocol !== "https:" && url?.protocol !== "http:") {
    log("push: CLAUDIOBOT_PUSH_URL is not an http(s) URL; push is off");
    return null;
  }
  return ntfySender(url.href, fetchFn);
}

const own = (slice: Owned<PushState>) => slice as PushState;
const idOf = (key: string) => key.slice(0, key.lastIndexOf("|"));

// The name is the one bot-controlled free text that leaves the Mac, so a renamed bot cannot smuggle content out.
const shownName = (name: string) => {
  const chars = Array.from(name.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim());
  return chars.length <= NAME_MAX ? chars.join("") : `${chars.slice(0, NAME_MAX - 1).join("")}\u2026`;
};

export function createPush(deps: {
  world: World;
  persist: Persist;
  /** null disables push. */
  sender: Sender | null;
  /** Open authenticated sockets. A push goes out only when this is 0. */
  live: () => number;
  now: () => Date;
  log: (line: string) => void;
}): Push {
  const { world, sender } = deps;

  // Derived from the durable log rather than held in memory, so the throttle survives a restart. A record stamped
  // after now (the clock moved back) does not throttle.
  function throttled(botId: BotId, now: number): boolean {
    const ids = new Set(world.bots.get(botId)?.messages.map((m) => m.id));
    return world.push.sent.some((s) => {
      const at = Date.parse(s.at);
      return ids.has(idOf(s.key) as MessageId) && !Number.isNaN(at) && now - at >= 0 && now - at < MESSAGE_THROTTLE_MS;
    });
  }

  return {
    notify(bot, reason, messageId) {
      if (sender === null || deps.live() > 0) return;
      const key = `${messageId}|${reason}`;
      if (world.push.sent.some((s) => s.key === key)) return;
      const now = deps.now().getTime();
      if (reason === "message" && throttled(bot.id, now)) return;

      const state = own(world.push);
      state.sent = state.sent.filter((s) => now - Date.parse(s.at) < RETAIN_MS);
      state.sent.push({ key, at: new Date(now).toISOString() });
      try {
        deps.persist("now");
      } catch (e) {
        // Never send unrecorded. The key stays in memory, so this push is lost rather than doubled.
        deps.log(`push: ${reason} for ${bot.id} skipped, could not record it: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      const n: Notification = { botId: bot.id, messageId, text: `${shownName(bot.name)} ${PHRASE[reason]}`, link: linkTo(bot.id, messageId) };
      // Through a promise so a sender that throws synchronously cannot escape into the caller's turn.
      Promise.resolve()
        .then(() => sender(n))
        .catch((e: unknown) => deps.log(`push: ${reason} for ${bot.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    },
  };
}
