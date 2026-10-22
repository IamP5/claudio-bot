import type { Tickable } from "./clock";
import type { BotId, MessageId, PushState as Reach, SessionAlertReason, SessionId, Signal } from "./protocol";
import type { Persist } from "./store";
import { BOT_NAME_MAX, displayName, errorText } from "./text";
import { chatOf, own, ownCardId, ownCardOpen, type OwnCard, type PushState, type World } from "./world";

// Phone pushes: an ntfy-style POST to CLAUDIOBOT_PUSH_URL now, APNs later behind the same Sender. The only writer of
// World.push.
// No message content ever leaves the Mac. A bot's push is its name (cleaned, at most 40 characters) and a fixed phrase
// per reason, with the link claudiobot://bot/<id>?message=<id>. A session's push names no session, only what happened
// ("A Claude Code session needs 3 approvals"), with the link claudiobot://session/<id>, plus ?card=<id> for cards: ntfy
// on iOS cannot withdraw a push once delivered, so the app says when the card it names was already answered.
// Every push has keys, recorded and flushed before the send, so a crash never double-pushes: `${messageId}|${reason}`
// for a bot, `${cardId}|card` and `${cardId}|reminder` for each card of a session, `${sessionId}|${at}|done` for a
// session's run that came to rest at `at`. A send that fails is tried twice more, then the push state reads failing
// until a send gets through.
// A turn's first bubble pushes at most once per bot per 10 minutes; nothing else counts toward that or is held by it.
// A session's cards that open within 2 s of each other share one push; a later card waits while that push's cards
// stay open, at most 10 minutes. A card's reminder pushes at half its time.
// While a phone is live (an attended socket heard from recently, which the transport decides) nothing pushes. A bot
// card, or a session card, still open when every socket has gone quiet pushes then. A session's other events are sent
// to the sockets as a session_alert, for a local notification, and push once the phone goes quiet only if no attended
// socket was heard from since: a phone that went quiet unseen never got the alert.
// At start no socket is live yet, though a phone that was open usually reconnects within seconds. So a card or reminder
// push for a bot card already open at start waits START_GRACE_MS and then goes out only if no phone is live.
// A muted bot sends no message or result push. Cards and reminders still push: a held call waits on the user.

/** message: a turn's first pushed bubble. result: the last bubble of a turn still running 20 s after that push. */
export type PushReason = "card" | "reminder" | "message" | "result";
/** How a run of a session the phone drives came to rest, when that is worth a push. A user's stop never is. */
export type SessionEnd = "finished" | "failed";

/** tick sends what a live socket held back and what waited out a window; nextDeadline is the earliest of those. */
export type Push = Tickable & {
  /** True when the push was recorded and handed to the sender, false when it was held back, a repeat, or not recorded. */
  notify(bot: { id: BotId; name: string }, reason: PushReason, messageId: MessageId): boolean;
  /** A session's run came to rest at `at`: one push for that ending. */
  sessionEnded?(id: SessionId, end: SessionEnd, at: string): void;
  /** Whether pushes reach the user, for hello. */
  state?(): Reach;
};

/** What a transport receives. `text` and `link` are the whole user-visible payload. botId null: a session's push. */
type Notification = { botId: BotId | null; text: string; link: string; high: boolean };

/** One delivery attempt. Rejects with an Error whose message the user may read: no URL, no topic. */
export type Sender = (n: Notification) => Promise<void>;

export const MESSAGE_THROTTLE_MS = 10 * 60_000;
// Far longer than any card stays open, so a key is never forgotten while its card can still remind.
const RETAIN_MS = 7 * 24 * 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
export const START_GRACE_MS = 60_000;
/** Cards of one session that open this close together share a push. */
export const COALESCE_MS = 2_000;
export const SEND_TRIES = 3;
/** The wait before the second try; each later one waits four times longer. */
export const RETRY_MS = 2_000;

const PHRASE: Record<PushReason, string> = {
  card: "needs you",
  reminder: "is still waiting for you",
  message: "has an update for you",
  result: "has an update for you",
};

const linkTo = (botId: BotId, messageId: MessageId) =>
  `claudiobot://bot/${encodeURIComponent(botId)}?message=${encodeURIComponent(messageId)}`;
const sessionLink = (id: SessionId, card?: MessageId) =>
  `claudiobot://session/${encodeURIComponent(id)}${card ? `?card=${encodeURIComponent(card)}` : ""}`;

const SESSION = "A Claude Code session";
const ENDED: Record<SessionEnd, string> = { finished: `${SESSION} finished`, failed: `${SESSION} stopped with an error` };

/** What a session's cards ask, in a few words: "needs 3 approvals", "is still waiting for your answer". */
function cardsText(reason: "card" | "reminder", cards: readonly OwnCard[]): string {
  const n = cards.length;
  const kinds = new Set(cards.map((c) => c.kind));
  const only = kinds.size === 1 ? cards[0]!.kind : null;
  if (reason === "card") {
    if (only === "permission") return n === 1 ? "needs your approval" : `needs ${n} approvals`;
    if (only === "ask") return n === 1 ? "has a question for you" : `has ${n} questions for you`;
    return n === 1 ? "has a plan for you to review" : `needs you: ${n} requests`;
  }
  if (only === "permission") return n === 1 ? "is still waiting for your approval" : `is still waiting for ${n} approvals`;
  if (only === "ask") return n === 1 ? "is still waiting for your answer" : `is still waiting for ${n} answers`;
  return "is still waiting for you";
}

/** The push server's answer in words the phone may show: never the URL, which holds the topic. */
function plainFailure(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return `The push server did not answer within ${SEND_TIMEOUT_MS / 1000} s`;
  return "Could not reach the push server";
}

export function ntfySender(url: string, fetchFn: typeof fetch = fetch): Sender {
  return async (n) => {
    let res: Response;
    try {
      // Bot names may be non-Latin-1, which fetch rejects in a header, so the name rides in the UTF-8 body.
      res = await fetchFn(url, {
        method: "POST",
        body: n.text,
        headers: { Title: "ClaudioBot", Click: n.link, ...(n.high && { Priority: "high" }) },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(plainFailure(e));
    }
    if (!res.ok) throw new Error(`The push server answered ${res.status}`);
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

const idOf = (key: string) => key.slice(0, key.lastIndexOf("|"));
const cardAt = (c: OwnCard) => Date.parse(c.kind === "permission" ? c.card.at : c.at);
const cardUntil = (c: OwnCard) => Date.parse(c.kind === "permission" ? c.card.expiresAt : c.expiresAt);
const remindAt = (c: OwnCard) => cardAt(c) + (cardUntil(c) - cardAt(c)) / 2;

export function createPush(deps: {
  world: World;
  persist: Persist;
  /** null disables push. */
  sender: Sender | null;
  /** When the last live socket goes quiet, or null when none is live. A push goes out only when none is. */
  liveUntil: () => Date | null;
  /** When an attended socket was last heard from, in ms; absent: never. */
  seen?: () => number;
  /** Live frames to every protocol 3 socket: the push state, and session alerts nothing pushed for. */
  signal?: (m: Signal) => void;
  /** A session's title, for its alert. */
  title?: (id: SessionId) => string;
  now: () => Date;
  log: (line: string) => void;
  /** Waits between tries; tests pass one that does not. */
  wait?: (ms: number) => Promise<void>;
}): Push {
  const { world, sender } = deps;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceEnds = deps.now().getTime() + START_GRACE_MS;
  const openAtStart = new Set<MessageId>(world.gate.open.map((c) => c.cardId));
  type Deferred = { bot: { id: BotId; name: string }; reason: PushReason; messageId: MessageId };
  const deferred = new Map<string, Deferred>();
  let reach: Reach = sender === null ? { state: "off" } : { state: "on" };
  /** Session keys a session_alert went out for, with when, while a phone was live or push was off. */
  const alerted = new Map<string, number>();
  /** Session endings held for a live phone. */
  const held = new Map<string, { id: SessionId; end: SessionEnd; at: number }>();
  /** Each session's last card push: a later card waits while these stay open. */
  const lastCards = new Map<SessionId, { at: number; cards: MessageId[] }>();

  // Derived from the durable log rather than held in memory, so the throttle survives a restart. A record stamped
  // after now (the clock moved back) does not throttle.
  function throttled(botId: BotId, now: number): boolean {
    const ids = new Set(chatOf(world, botId)?.messages.map((m) => m.id));
    return world.push.sent.some((s) => {
      const at = Date.parse(s.at);
      return s.key.endsWith("|message") && ids.has(idOf(s.key) as MessageId) && !Number.isNaN(at) && now - at >= 0 && now - at < MESSAGE_THROTTLE_MS;
    });
  }

  const live = (now: number) => (deps.liveUntil()?.getTime() ?? 0) > now;
  const pushed = (key: string) => world.push.sent.some((s) => s.key === key);
  /** Seen since `at`: an attended socket was heard from after it, so the app got what was sent then. */
  const seenSince = (at: number) => (deps.seen?.() ?? 0) > at;
  /** Open cards whose own push has not gone out, for any reason but a failed record. */
  const heldCards = () => world.gate.open.filter((c) => !pushed(`${c.cardId}|card`));

  function setReach(next: Reach) {
    if (JSON.stringify(next) === JSON.stringify(reach)) return;
    reach = next;
    deps.signal?.({ type: "push_state", push: next });
  }

  /** Records the keys and flushes them. False when they could not be saved: never send unrecorded. */
  function record(keys: readonly string[], what: string, now: number): boolean {
    const state = own<PushState>(world.push);
    state.sent = state.sent.filter((s) => now - Date.parse(s.at) < RETAIN_MS);
    for (const key of keys) state.sent.push({ key, at: new Date(now).toISOString() });
    try {
      deps.persist("now");
      return true;
    } catch (e) {
      // The keys stay in memory, so this push is lost rather than doubled.
      deps.log(`push: ${what} skipped, could not record it: ${errorText(e)}`);
      return false;
    }
  }

  /** Never throws into the caller, whatever the sender does. */
  async function deliver(n: Notification, what: string) {
    for (let tries = 1; ; tries++) {
      try {
        await sender!(n);
        setReach({ state: "on" });
        return;
      } catch (e) {
        if (tries >= SEND_TRIES) {
          const error = displayName(errorText(e), 120);
          setReach({ state: "failing", error, at: deps.now().toISOString() });
          deps.log(`push: ${what} failed after ${tries} tries: ${error}`);
          return;
        }
        await wait(RETRY_MS * 4 ** (tries - 1));
      }
    }
  }

  function notify(bot: { id: BotId; name: string }, reason: PushReason, messageId: MessageId, now = deps.now().getTime()): boolean {
    if (sender === null || live(now)) return false;
    if ((reason === "message" || reason === "result") && chatOf(world, bot.id)?.muted) return false;
    const key = `${messageId}|${reason}`;
    if (pushed(key)) return false;
    if (now < graceEnds && openAtStart.has(messageId)) {
      deferred.set(key, { bot, reason, messageId });
      return false;
    }
    if (reason === "message" && throttled(bot.id, now)) return false;
    const what = `${reason} for ${bot.id}`;
    if (!record([key], what, now)) return false;
    // The name is the one bot-controlled free text that leaves the Mac, so a renamed bot cannot smuggle content out.
    void deliver({ botId: bot.id, text: `${displayName(bot.name, BOT_NAME_MAX)} ${PHRASE[reason]}`, link: linkTo(bot.id, messageId), high: reason === "card" || reason === "reminder" }, what);
    return true;
  }

  function alert(id: SessionId, reason: SessionAlertReason, keys: readonly string[], count: number, cardId: MessageId | null, now: number) {
    if (keys.every((k) => alerted.has(k))) return;
    for (const k of keys) if (!alerted.has(k)) alerted.set(k, now);
    deps.signal?.({ type: "session_alert", sessionId: id, reason, count, title: deps.title?.(id) ?? "Claude Code session", cardId });
  }

  function pushCards(id: SessionId, reason: "card" | "reminder", cards: readonly OwnCard[], now: number) {
    const ids = cards.map(ownCardId);
    const what = `${reason} for session ${id}`;
    if (!record(ids.map((c) => `${c}|${reason}`), what, now)) return;
    if (reason === "card") lastCards.set(id, { at: now, cards: ids });
    void deliver({ botId: null, text: `${SESSION} ${cardsText(reason, cards)}`, link: sessionLink(id, ids[0]), high: true }, what);
  }

  function pushEnd(id: SessionId, end: SessionEnd, key: string, now: number) {
    const what = `${end} for session ${id}`;
    if (!record([key], what, now)) return;
    void deliver({ botId: null, text: ENDED[end], link: sessionLink(id), high: false }, what);
  }

  const isOpen = (id: SessionId, card: MessageId) => world.sessions.get(id)?.own?.cards.some((c) => ownCardId(c) === card && ownCardOpen(c)) ?? false;
  /** A session's next card push waits until then while its last one's cards are still open. */
  const cardsFree = (id: SessionId) => {
    const last = lastCards.get(id);
    return last && last.cards.some((c) => isOpen(id, c)) ? last.at + MESSAGE_THROTTLE_MS : 0;
  };

  /**
   * What the sessions' cards and held endings owe now, and when they next will. act false only computes the deadline,
   * so tick and nextDeadline cannot disagree.
   */
  function sweep(now: number, act: boolean): number {
    let next = Infinity;
    const later = (t: number) => (next = Math.min(next, t));
    const isLive = live(now);
    const quiet = deps.liveUntil()?.getTime() ?? Infinity;
    // Held for a live phone: a push goes out when it goes quiet. With push off there is nothing to wait for.
    const hold = sender === null ? () => {} : () => later(quiet);
    for (const rec of world.sessions.values()) {
      const open = (rec.own?.cards ?? []).filter(ownCardOpen);
      if (open.length === 0) continue;
      const id = rec.id;
      const fresh = open.filter((c) => !pushed(`${ownCardId(c)}|card`));
      if (fresh.length > 0) {
        const due = Math.min(...fresh.map(cardAt)) + COALESCE_MS;
        const free = cardsFree(id);
        if (now < due) later(due);
        else if (isLive || sender === null) {
          if (act) alert(id, "card", fresh.map((c) => `${ownCardId(c)}|card`), fresh.length, ownCardId(fresh[0]!), now);
          hold();
        } else if (free > now) later(free);
        else if (act) pushCards(id, "card", fresh, now);
      }
      const unreminded = open.filter((c) => !pushed(`${ownCardId(c)}|reminder`));
      for (const c of unreminded) if (remindAt(c) > now) later(remindAt(c));
      const ripe = unreminded.filter((c) => remindAt(c) <= now);
      if (ripe.length === 0) continue;
      const keyOf = (c: OwnCard) => `${ownCardId(c)}|reminder`;
      if (isLive || sender === null) {
        if (act) alert(id, "reminder", ripe.map(keyOf), ripe.length, ownCardId(ripe[0]!), now);
        hold();
      } else if (act) {
        const seen = ripe.filter((c) => alerted.has(keyOf(c)) && seenSince(alerted.get(keyOf(c))!));
        if (seen.length > 0) record(seen.map(keyOf), `reminder for session ${id}, seen in the app`, now);
        const unseen = ripe.filter((c) => !seen.includes(c));
        if (unseen.length > 0) pushCards(id, "reminder", unseen, now);
      }
    }
    if (held.size > 0) {
      if (isLive) hold();
      else if (act)
        for (const [key, h] of held) {
          held.delete(key);
          if (seenSince(h.at)) record([key], `${h.end} for session ${h.id}, seen in the app`, now);
          else pushEnd(h.id, h.end, key, now);
        }
    }
    return next;
  }

  return {
    notify: (bot, reason, messageId) => notify(bot, reason, messageId),
    sessionEnded(id, end, at) {
      const now = deps.now().getTime();
      const key = `${id}|${at}|done`;
      if (pushed(key) || held.has(key) || alerted.has(key)) return;
      if (sender === null || live(now)) {
        alert(id, end, [key], 1, null, now);
        if (sender !== null) held.set(key, { id, end, at: now });
        return;
      }
      pushEnd(id, end, key, now);
    },
    state: () => reach,
    tick(now) {
      if (now.getTime() >= graceEnds) {
        for (const d of deferred.values()) if (world.gate.open.some((c) => c.cardId === d.messageId)) notify(d.bot, d.reason, d.messageId, now.getTime());
        deferred.clear();
      }
      for (const card of heldCards()) {
        const bot = world.bots.get(card.actor.botId);
        if (bot) notify(bot, "card", card.cardId, now.getTime());
      }
      sweep(now.getTime(), true);
    },
    nextDeadline() {
      const until = deps.liveUntil();
      const now = deps.now().getTime();
      const botCards = sender !== null && until !== null && heldCards().length > 0 ? until.getTime() : Infinity;
      const grace = deferred.size > 0 ? graceEnds : Infinity;
      const next = Math.min(botCards, grace, sweep(now, false));
      return next === Infinity ? null : new Date(next).toISOString();
    },
  };
}
