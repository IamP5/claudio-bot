import type { Tickable } from "./clock";
import type { BotId, MessageId, PushState as Reach, SessionAlert, SessionAlertReason, SessionId, Signal } from "./protocol";
import type { Persist } from "./store";
import { BOT_NAME_MAX, displayName, errorText } from "./text";
import { chatOf, own, ownCardId, ownCardOpen, type HeldEnding, type OwnCard, type PushState, type SessionEnd, type World } from "./world";

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
// A session's cards that open within 2 s of the one before share one push (the burst waits at most 6 s); a later card
// waits while that push's cards stay open, at most 10 minutes. A card's reminder pushes at half its time. A retry is
// dropped once nothing is owed: its cards were answered, or a phone came back.
// While a phone is live (an attended socket heard from recently, which the transport decides) nothing pushes. A bot
// card, or a session card, still open when every socket has gone quiet pushes then. A session's other events are sent
// to the sockets as a session_alert, for a local notification, and push once the phone goes quiet unless the alert was
// seen: a socket it went to was heard from, attended, after it went. A socket can die unseen and stay open until the
// transport's idle close, so an alert not seen and still owed that reached no socket open now goes again to the
// sockets that are.
// At start no socket is live yet, though a phone that was open usually reconnects within seconds. So a card or reminder
// push for a bot card already open at start waits START_GRACE_MS and then goes out only if no phone is live. So do a
// run the restart cut off and a session ending still held from before the restart, which is kept on disk for that.
// A muted bot sends no message or result push. Cards and reminders still push: a held call waits on the user.

/** message: a turn's first pushed bubble. result: the last bubble of a turn still running 20 s after that push. */
export type PushReason = "card" | "reminder" | "message" | "result";
export type { SessionEnd };

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
/** A session's card that opens this soon after the one before joins its push, which waits this long for more... */
export const COALESCE_MS = 2_000;
/** ...but never longer than this after its first card. */
export const COALESCE_MAX_MS = 6_000;
export const SEND_TRIES = 3;
/** Longer than any card waits, so an alert is never forgotten while its card can still push. */
const ALERTS_KEPT_MS = 24 * 3_600_000;
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
const ENDED: Record<SessionEnd, string> = {
  finished: `${SESSION} finished`,
  failed: `${SESSION} stopped with an error`,
  lost: `${SESSION} was interrupted by a bridge restart`,
};
/** The most session endings kept owed at once; the oldest go first. */
const HELD_KEPT = 50;

/** The kind every card is, or null when they are mixed or there are none. */
function kindOf(cards: readonly OwnCard[]): OwnCard["kind"] | null {
  const kinds = new Set(cards.map((c) => c.kind));
  return kinds.size === 1 ? cards[0]!.kind : null;
}

/** What a session's cards ask, in a few words: "needs 3 approvals", "is still waiting for your answer". */
function cardsText(reason: "card" | "reminder", cards: readonly OwnCard[]): string {
  const n = cards.length;
  const only = kindOf(cards);
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
/** When a burst of cards goes out: 2 s after its newest card, at most 6 s after its first. */
const burstDue = (cards: readonly OwnCard[]) => Math.min(Math.max(...cards.map(cardAt)) + COALESCE_MS, Math.min(...cards.map(cardAt)) + COALESCE_MAX_MS);

/**
 * The sockets session alerts go to. Ids are the transport's own and are never reused while the bridge runs.
 * alert: sends the frame to every open protocol 3 socket, and returns the ids it went to. heard: whether a socket among
 * ids was heard from, attended, after `since` (ms), a closed one by when it was last heard so. open: the ids of the
 * open protocol 3 sockets.
 */
export type AlertSockets = {
  alert(m: SessionAlert): number[];
  heard(ids: readonly number[], since: number): boolean;
  open(): number[];
};

/** One session_alert: the frame, and each time it went out with the sockets it reached. */
type Alerted = { frame: SessionAlert; sent: { at: number; to: number[] }[] };

export function createPush(deps: {
  world: World;
  persist: Persist;
  /** null disables push. */
  sender: Sender | null;
  /** When the last live socket goes quiet, or null when none is live. A push goes out only when none is. */
  liveUntil: () => Date | null;
  /** Where session alerts go and whether they were seen; absent: nowhere, and never seen. */
  sockets?: AlertSockets;
  /** Live frames to every protocol 3 socket: the push state. */
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
  /** Session keys a session_alert went out for, while a phone was live or push was off. Keys an alert covers share it. */
  const alerted = new Map<string, Alerted>();
  const held = (): readonly HeldEnding[] => (Array.isArray(world.push.held) ? world.push.held : []);
  /** Saves the endings owed; one that cannot be saved is still owed while the bridge runs. */
  function setHeld(next: HeldEnding[]) {
    if (next.length > HELD_KEPT) deps.log(`push: ${next.length - HELD_KEPT} session endings owed were dropped, the oldest first`);
    own<PushState>(world.push).held = next.slice(-HELD_KEPT);
    try {
      deps.persist("now");
    } catch (e) {
      deps.log(`push: could not save the session endings owed: ${errorText(e)}`);
    }
  }
  const readable = (h: Partial<HeldEnding>) =>
    typeof h.key === "string" && typeof h.id === "string" && typeof h.end === "string" && h.end in ENDED && typeof h.at === "string" && !Number.isNaN(Date.parse(h.at));
  if (held().some((h) => !readable(h))) setHeld(held().filter(readable));
  /** Endings held from before this start: a phone that was open may be about to come back. */
  const restored = new Set(held().map((h) => h.key));
  /** A run a restart cut off, or an ending from before the start, waits out the grace a returning phone gets. */
  const waits = (h: HeldEnding, now: number) => now < graceEnds && (h.end === "lost" || restored.has(h.key));
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
  /** The alert for the key was seen: a socket it went to was heard from, attended, after it went. */
  const seen = (key: string) => alerted.get(key)?.sent.some((b) => deps.sockets?.heard(b.to, b.at) === true) ?? false;
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

  /** Never throws into the caller, whatever the sender does. owed: a retry goes out only while it still holds. */
  async function deliver(n: Notification, what: string, owed: () => boolean = () => true) {
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
        if (!owed()) return;
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

  /** cards: what a card or reminder alert covers; none for an ending. */
  function alert(id: SessionId, reason: SessionAlertReason, keys: readonly string[], cards: readonly OwnCard[], now: number) {
    if (keys.every((k) => alerted.has(k))) return;
    const frame: SessionAlert = {
      type: "session_alert",
      sessionId: id,
      reason,
      count: cards.length === 0 ? 1 : cards.length,
      title: deps.title?.(id) ?? "Claude Code session",
      cardId: cards[0] ? ownCardId(cards[0]) : null,
      cardKind: kindOf(cards),
    };
    const a: Alerted = { frame, sent: [{ at: now, to: deps.sockets?.alert(frame) ?? [] }] };
    for (const k of keys) if (!alerted.has(k)) alerted.set(k, a);
  }

  /** Still owed: a card it covers is open and not pushed for that, or an ending it covers is still held. */
  const owes = (a: Alerted) =>
    [...alerted].some(([key, x]) => x === a && !pushed(key) && (key.endsWith("|done") ? held().some((h) => h.key === key) : isOpen(a.frame.sessionId, idOf(key) as MessageId)));

  /** Alerts not seen and still owed that reached no socket open now go to the open ones. */
  function resend(now: number, act: boolean, later: (t: number) => void) {
    const open = deps.sockets?.open() ?? [];
    if (open.length === 0) return;
    for (const a of new Set(alerted.values())) {
      if (a.sent.some((b) => b.to.some((s) => open.includes(s))) || a.sent.some((b) => deps.sockets!.heard(b.to, b.at)) || !owes(a)) continue;
      if (act) a.sent.push({ at: now, to: deps.sockets!.alert(a.frame) });
      else later(now);
    }
  }

  function pushCards(id: SessionId, reason: "card" | "reminder", cards: readonly OwnCard[], now: number) {
    const ids = cards.map(ownCardId);
    const what = `${reason} for session ${id}`;
    if (!record(ids.map((c) => `${c}|${reason}`), what, now)) return;
    if (reason === "card") lastCards.set(id, { at: now, cards: ids });
    // Answered, or the phone came back, while a try failed: nothing is owed any more.
    const owed = () => !live(deps.now().getTime()) && ids.some((c) => isOpen(id, c));
    void deliver({ botId: null, text: `${SESSION} ${cardsText(reason, cards)}`, link: sessionLink(id, ids[0]), high: true }, what, owed);
  }

  function pushEnd(id: SessionId, end: SessionEnd, key: string, now: number) {
    const what = `${end} for session ${id}`;
    if (!record([key], what, now)) return;
    void deliver({ botId: null, text: ENDED[end], link: sessionLink(id), high: false }, what, () => !live(deps.now().getTime()));
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
      const unalerted = fresh.filter((c) => !alerted.has(`${ownCardId(c)}|card`));
      if (isLive || sender === null) {
        // Alerts group the way pushes do, counting every card still owed.
        if (unalerted.length > 0 && now < burstDue(unalerted)) later(burstDue(unalerted));
        else if (unalerted.length > 0 && act) alert(id, "card", fresh.map((c) => `${ownCardId(c)}|card`), fresh, now);
        if (fresh.length > 0) hold();
      } else if (fresh.length > 0) {
        const due = burstDue(fresh);
        const free = cardsFree(id);
        if (now < due) later(due);
        else if (free > now) later(free);
        else if (act) pushCards(id, "card", fresh, now);
      }
      const unreminded = open.filter((c) => !pushed(`${ownCardId(c)}|reminder`));
      for (const c of unreminded) if (remindAt(c) > now) later(remindAt(c));
      const ripe = unreminded.filter((c) => remindAt(c) <= now);
      if (ripe.length === 0) continue;
      const keyOf = (c: OwnCard) => `${ownCardId(c)}|reminder`;
      if (isLive || sender === null) {
        if (act) alert(id, "reminder", ripe.map(keyOf), ripe, now);
        hold();
      } else if (act) {
        const shown = ripe.filter((c) => seen(keyOf(c)));
        if (shown.length > 0) record(shown.map(keyOf), `reminder for session ${id}, seen in the app`, now);
        const unseen = ripe.filter((c) => !shown.includes(c));
        if (unseen.length > 0) pushCards(id, "reminder", unseen, now);
      }
    }
    // An ending the open app saw is owed no push, and one it did not see pushes when the phone goes quiet; one it was
    // not told of yet in this run of the bridge is told now if a phone is live, or pushes.
    let owed = [...held()];
    const before = JSON.stringify(owed);
    const drop = (key: string) => (owed = owed.filter((x) => x.key !== key));
    for (const h of held()) {
      if (pushed(h.key)) {
        if (act) drop(h.key);
        continue;
      }
      if (seen(h.key)) {
        if (act && record([h.key], `${h.end} for session ${h.id}, seen in the app`, now)) drop(h.key);
        continue;
      }
      if (isLive || sender === null) {
        if (!alerted.has(h.key) && act) {
          alert(h.id, h.end, [h.key], [], now);
          owed = owed.flatMap((x) => (x.key !== h.key ? [x] : sender === null ? [] : [{ ...x, alerted: true, at: new Date(now).toISOString() }]));
        }
        if (sender !== null) hold();
        continue;
      }
      if (waits(h, now)) {
        later(graceEnds);
        continue;
      }
      if (!act) continue;
      drop(h.key);
      pushEnd(h.id, h.end, h.key, now);
    }
    if (JSON.stringify(owed) !== before) setHeld(owed);
    if (isLive || sender === null) resend(now, act, later);
    return next;
  }

  return {
    notify: (bot, reason, messageId) => notify(bot, reason, messageId),
    sessionEnded(id, end, at) {
      const now = deps.now().getTime();
      const key = `${id}|${at}|done`;
      if (pushed(key) || held().some((h) => h.key === key) || alerted.has(key)) return;
      const ending: HeldEnding = { key, id, end, at: new Date(now).toISOString(), alerted: false };
      if (sender !== null && !live(now) && waits(ending, now)) return setHeld([...held(), ending]);
      if (sender === null || live(now)) {
        alert(id, end, [key], [], now);
        if (sender !== null) setHeld([...held(), { ...ending, alerted: true }]);
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
      for (const [key, a] of alerted) if (now.getTime() - a.sent[0]!.at > ALERTS_KEPT_MS) alerted.delete(key);
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
