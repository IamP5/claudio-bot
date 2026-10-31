import { createHash } from "node:crypto";
import type { Tickable } from "./clock";
import type { BotId, MessageId, PushState as Reach, SessionAlert, SessionAlertReason, SessionId, Signal } from "./protocol";
import type { Persist } from "./store";
import { BOT_NAME_MAX, displayName, errorText } from "./text";
import { chatOf, own, ownCardId, ownCardOpen, type HeldEnding, type OwedPush, type OwnCard, type PushFailing, type PushState, type SessionEnd, type World } from "./world";

// Phone pushes: an ntfy-style POST to CLAUDIOBOT_PUSH_URL now, APNs later behind the same Sender. The only writer of
// World.push.
// No message content ever leaves the Mac. A bot's push is its name (cleaned, at most 40 characters) and a fixed phrase
// per reason, with the link claudiobot://bot/<id>?message=<id>. A session's push names no session, only what happened
// ("A Claude Code session needs 3 approvals"), with the link claudiobot://session/<id>, plus ?card=<id> for cards: ntfy
// on iOS cannot withdraw a push once delivered, so the app says when the card it names was already answered.
// Every push has keys, recorded and flushed before the send, so a crash never double-pushes: `${messageId}|${reason}`
// for a bot, `${cardId}|card` and `${cardId}|reminder` for each card of a session, `${sessionId}|${at}|done` for a
// session's run that came to rest at `at`. A try the server refused is tried twice more. A try it may have taken (it
// timed out, or the connection broke after the request went) is never sent again before the server is asked whether it
// holds it, since ntfy has no idempotency key and a second publish rings again. While a try is out the push is kept on
// disk as one the server may have taken, so a crash mid-try neither drops it nor repeats it. A push whose tries failed
// stays owed while what it is for still waits on the user (an open card, a session ending no newer run replaced) and no
// phone is live, and the push state reads failing. A bot's update is owed only as its newest, and an owed card is
// never dropped for one. The oldest owed push goes again 15 s after the failure, then 30 s, 1, 2 and 5 minutes apart;
// with none owed the bridge asks the server for its recent pushes within a minute, and a topic it may not read leaves
// the last failure standing until a push gets through. Either one answered puts the state back to on. The failing
// state and the owed pushes are kept on disk; a failing state read at start is checked at once, and pushes owed from
// before the start wait out the start grace.
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

/**
 * What a transport receives. `text` and `link` are the whole user-visible payload. botId null: a session's push. sid:
 * the push's own id, the same on every try, so the server's record of a try can be told from another push's.
 */
type Notification = { botId: BotId | null; text: string; link: string; high: boolean; sid: string };

/** A transport. Errors carry messages the user may read: no URL, no topic. */
export type Sender = {
  /** One try. Rejects with a PushFailure; any other error counts as one the server may have taken. */
  send(n: Notification): Promise<void>;
  /**
   * The pushes the server holds that it took at or after `since` (ms); sid when the server keeps it. Rejects when the
   * server cannot say, with a PollForbidden when it will not let the bridge read.
   */
  taken(since: number): Promise<Taken[]>;
};

/** A push the server holds: at (ms) and sid when it says. */
type Taken = { text: string; link: string; at?: number; sid?: string };

/** The topic is write-only for the bridge: the server will never say what it holds. */
export class PollForbidden extends Error {}

/** A failed try. maybe: the server may have taken the push. */
export class PushFailure extends Error {
  constructor(
    message: string,
    readonly maybe: boolean,
  ) {
    super(message);
  }
}

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
/** After the tries fail, the waits before each try of the oldest owed push; the last repeats. */
export const OWED_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** While failing with nothing owed, how often the bridge asks the server for its recent pushes. */
export const PROBE_MS = 60_000;
/** How far before a try's start the server's record of it is looked for, for a server clock behind the Mac's. */
const TAKEN_SLACK_MS = 60_000;
/**
 * A server that keeps no sequence id is matched by text and link, and only this close to the try: a session's earlier
 * ending reads the same. Its time is in whole seconds.
 */
const UNMARKED_SLACK_MS = 2_000;
const OWED_KEPT = 50;
/** Over OWED_KEPT, the kind dropped first: a bot's update, then an ending, then a card. */
const EVICT: Record<OwedPush["for"]["kind"], number> = { bot: 0, ending: 1, "bot-card": 2, cards: 3 };

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

/** A proxy's answer after it may have handed the push on: a bad gateway, a gateway timeout, Cloudflare's 520 to 524. */
const GATEWAY = new Set([502, 504, 520, 521, 522, 523, 524]);

/** No connection was made, so the server never saw the request. */
const refused = (e: unknown) => (e as { code?: unknown } | null)?.code === "ConnectionRefused" || /ECONNREFUSED/.test(errorText(e));

/** A failed request in words the phone may show: never the URL, which holds the topic. */
function plainFailure(e: unknown): PushFailure {
  if (refused(e)) return new PushFailure("Could not reach the push server", false);
  if (e instanceof Error && e.name === "TimeoutError") return new PushFailure(`The push server did not answer within ${SEND_TIMEOUT_MS / 1000} s`, true);
  return new PushFailure("The connection to the push server broke before it answered", true);
}

export function ntfySender(url: string, fetchFn: typeof fetch = fetch): Sender {
  return {
    async send(n) {
      let res: Response;
      try {
        // Bot names may be non-Latin-1, which fetch rejects in a header, so the name rides in the UTF-8 body.
        res = await fetchFn(url, {
          method: "POST",
          body: n.text,
          // ntfy 2.16.0 and later keeps the sequence id and returns it in its poll; older servers ignore it.
          headers: { Title: "ClaudioBot", Click: n.link, "X-Sequence-ID": n.sid, ...(n.high && { Priority: "high" }) },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (e) {
        throw plainFailure(e);
      }
      // ntfy answers an error status before it publishes, except when its own cache write fails after.
      if (!res.ok) throw new PushFailure(`The push server answered ${res.status}`, GATEWAY.has(res.status));
    },
    // ntfy's poll of the topic's cache: one JSON message per line.
    async taken(since) {
      const poll = new URL(url);
      poll.pathname = `${poll.pathname.replace(/\/$/, "")}/json`;
      poll.searchParams.set("poll", "1");
      poll.searchParams.set("since", String(Math.floor(since / 1000)));
      let res: Response;
      try {
        res = await fetchFn(poll.href, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      } catch (e) {
        throw plainFailure(e);
      }
      if (res.status === 401 || res.status === 403) throw new PollForbidden(`The push server answered ${res.status} to a read of the topic`);
      if (!res.ok) throw new PushFailure(`The push server answered ${res.status}`, true);
      return (await res.text()).split("\n").flatMap((line) => {
        try {
          const m = JSON.parse(line) as { event?: unknown; message?: unknown; click?: unknown; time?: unknown; sequence_id?: unknown };
          if (m.event !== "message") return [];
          return [{ text: String(m.message ?? ""), link: String(m.click ?? ""), ...(typeof m.time === "number" && { at: m.time * 1000 }), ...(typeof m.sequence_id === "string" && { sid: m.sequence_id }) }];
        } catch {
          return [];
        }
      });
    },
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
const iso = (t: number) => new Date(t).toISOString();
const cardAt = (c: OwnCard) => Date.parse(c.kind === "permission" ? c.card.at : c.at);
const cardUntil = (c: OwnCard) => Date.parse(c.kind === "permission" ? c.card.expiresAt : c.expiresAt);
const remindAt = (c: OwnCard) => cardAt(c) + (cardUntil(c) - cardAt(c)) / 2;
/** When a burst of cards goes out: 2 s after its newest card, at most 6 s after its first. */
const burstDue = (cards: readonly OwnCard[]) => Math.min(Math.max(...cards.map(cardAt)) + COALESCE_MS, Math.min(...cards.map(cardAt)) + COALESCE_MAX_MS);

/**
 * The sockets session alerts go to. Ids are the transport's own and are never reused while the bridge runs.
 * alert: sends the frame to every open protocol 3 socket, or to those of `only`, and returns the ids it went to. heard: whether a socket among
 * ids was heard from, attended, after `since` (ms), a closed one by when it was last heard so. open: the ids of the
 * open protocol 3 sockets.
 */
export type AlertSockets = {
  alert(m: SessionAlert, only?: readonly number[]): number[];
  heard(ids: readonly number[], since: number): boolean;
  open(): number[];
  /** When someone last looked at an app (ms): it said it is looked at and spoke. Never a connect alone. */
  lookedAt?(): number;
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
  /** A deadline moved after a try came back: the clock looks again. */
  poke?: () => void;
}): Push {
  const { world, sender } = deps;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceEnds = deps.now().getTime() + START_GRACE_MS;
  const openAtStart = new Set<MessageId>(world.gate.open.map((c) => c.cardId));
  type Deferred = { bot: { id: BotId; name: string }; reason: PushReason; messageId: MessageId };
  const deferred = new Map<string, Deferred>();
  /** Session keys a session_alert went out for, while a phone was live or push was off. Keys an alert covers share it. */
  const alerted = new Map<string, Alerted>();
  const held = (): readonly HeldEnding[] => (Array.isArray(world.push.held) ? world.push.held : []);
  /** What cannot be saved still holds while the bridge runs. */
  function save(what: string) {
    try {
      deps.persist("now");
    } catch (e) {
      deps.log(`push: could not save ${what}: ${errorText(e)}`);
    }
  }
  function setHeld(next: HeldEnding[]) {
    if (next.length > HELD_KEPT) deps.log(`push: ${next.length - HELD_KEPT} session endings owed were dropped, the oldest first`);
    own<PushState>(world.push).held = next.slice(-HELD_KEPT);
    save("the session endings owed");
  }
  const readable = (h: Partial<HeldEnding> | null) =>
    typeof h === "object" && h !== null && typeof h.key === "string" && typeof h.id === "string" && typeof h.end === "string" && h.end in ENDED && typeof h.at === "string" && !Number.isNaN(Date.parse(h.at));
  if (held().some((h) => !readable(h))) setHeld(held().filter(readable));
  /** Endings held from before this start: a phone that was open may be about to come back. */
  const restored = new Set(held().map((h) => h.key));
  /** A run a restart cut off, or an ending from before the start, waits out the grace a returning phone gets. */
  const waits = (h: HeldEnding, now: number) => now < graceEnds && (h.end === "lost" || restored.has(h.key));
  const failing = (): PushFailing | undefined => world.push.failing;
  const owedPushes = (): readonly OwedPush[] => (Array.isArray(world.push.owed) ? world.push.owed : []);
  const reach = (): Reach => {
    const f = failing();
    return sender === null ? { state: "off" } : f ? { state: "failing", error: f.error, at: f.at } : { state: "on" };
  };
  function setFailing(next: PushFailing | null) {
    const before = JSON.stringify(reach());
    if (next === null) delete own<PushState>(world.push).failing;
    else own<PushState>(world.push).failing = next;
    save("the push state");
    const after = reach();
    if (JSON.stringify(after) !== before) deps.signal?.({ type: "push_state", push: after });
  }
  /** A push's identity: its first key, which no other push records. */
  const pid = (o: OwedPush) => o.keys[0]!;
  function setOwed(next: OwedPush[]) {
    if (next.length === owedPushes().length && next.every((o, i) => o === owedPushes()[i])) return;
    let kept = next;
    while (kept.length > OWED_KEPT) {
      const first = kept.reduce((v, o) => (EVICT[o.for.kind] < EVICT[v.for.kind] ? o : v));
      kept = kept.filter((o) => o !== first);
    }
    if (kept.length < next.length) deps.log(`push: ${next.length - kept.length} owed pushes were dropped, updates before cards, the oldest first`);
    if (kept.length === 0) delete own<PushState>(world.push).owed;
    else own<PushState>(world.push).owed = kept;
    // Nothing owed any more: the probe looks within a minute, whatever a long backoff said.
    const f = failing();
    const probeBy = deps.now().getTime() + PROBE_MS;
    if (kept.length === 0 && f && Date.parse(f.retryAt) > probeBy) own<PushState>(world.push).failing = { ...f, retryAt: iso(probeBy) };
    save("the pushes owed");
  }
  const failingRead = (f: Partial<PushFailing> | undefined) =>
    typeof f?.error === "string" && typeof f.at === "string" && typeof f.retryAt === "string" && !Number.isNaN(Date.parse(f.retryAt)) && Number.isInteger(f.retries);
  const texts = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((k) => typeof k === "string");
  const forRead = (f: Partial<Record<string, unknown>> | undefined) =>
    f?.kind === "cards" ? typeof f.session === "string" && texts(f.cards) : f?.kind === "ending" ? typeof f.session === "string" : f?.kind === "bot-card" ? typeof f.card === "string" : f?.kind === "bot";
  const owedRead = (o: Partial<OwedPush> | null) =>
    typeof o === "object" &&
    o !== null &&
    texts(o.keys) &&
    typeof o.text === "string" &&
    typeof o.link === "string" &&
    typeof o.high === "boolean" &&
    forRead(o.for) &&
    [o.unsure, o.at].every((t) => t === undefined || !Number.isNaN(Date.parse(t))) &&
    (o.blind === undefined || typeof o.blind === "boolean");
  if (sender === null || (world.push.failing !== undefined && !failingRead(world.push.failing))) {
    if (world.push.failing !== undefined) setFailing(null);
  } else if (failing()) {
    // Restored from before this start: check now rather than read failing on old evidence.
    own<PushState>(world.push).failing = { ...failing()!, retryAt: deps.now().toISOString() };
  }
  // With push off nothing is owed; turned on later, old pushes would ring out of the blue.
  if (owedPushes().some((o) => sender === null || !owedRead(o))) setOwed(sender === null ? [] : owedPushes().filter(owedRead));
  /** Pushes owed from before this start wait out the grace a returning phone gets. */
  const owedAtStart = new Set(owedPushes().map(pid));
  /** Owed pushes a try is out for. */
  const sending = new Set<string>();
  /** A retry of an owed push, or a probe, is on its way. */
  let retrying = false;

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

  /** A newer run of the session replaced the ending the key names. A session the phone does not drive cannot tell. */
  const current = (id: SessionId, key: string) => {
    const drive = world.sessions.get(id)?.own;
    return drive === undefined || (drive.outcome !== undefined && `${id}|${drive.outcome.at}|done` === key);
  };
  /** Still worth a push: no phone is live or looked since it was first tried, and what it is for still waits on the user. */
  function holds(o: OwedPush, now = deps.now().getTime()): boolean {
    if (live(now) || (o.at !== undefined && (deps.sockets?.lookedAt?.() ?? 0) > Date.parse(o.at))) return false;
    const f = o.for;
    if (f.kind === "cards") return f.cards.some((c) => isOpen(f.session, c));
    if (f.kind === "ending") return current(f.session, o.keys[0]!);
    if (f.kind === "bot-card") return world.gate.open.some((c) => c.cardId === f.card);
    return true;
  }
  const sidOf = (o: OwedPush) => `cb${createHash("sha256").update(pid(o)).digest("hex").slice(0, 32)}`;
  const note = (o: OwedPush): Notification => ({ botId: o.botId, text: o.text, link: o.link, high: o.high, sid: sidOf(o) });
  /** The server's record of a try of o: by sequence id when the server keeps one, else by what it says and links. */
  const isTry = (o: OwedPush) => (t: Taken) =>
    t.sid !== undefined ? t.sid === sidOf(o) : t.text === o.text && t.link === o.link && (t.at === undefined || t.at >= Date.parse(o.unsure!) - UNMARKED_SLACK_MS);
  const failure = (e: unknown) => (e instanceof PushFailure ? e : new PushFailure(displayName(errorText(e), 120), true));

  /**
   * A try failed. retry: a retry of an owed push, which waits longer the next time; a probe keeps the schedule and looks
   * again in a minute. A new push's failure brings a later retry forward to 15 s.
   */
  function failed(error: string, how: "new" | "retry" | "probe") {
    const now = deps.now().getTime();
    const f = failing();
    const retries = how === "retry" && f ? f.retries + 1 : (f?.retries ?? 0);
    const wait = how === "probe" ? PROBE_MS : how === "retry" ? OWED_RETRY_MS[Math.min(retries, OWED_RETRY_MS.length - 1)]! : OWED_RETRY_MS[0];
    const retryAt = how === "new" && f ? Math.min(Date.parse(f.retryAt), now + wait) : now + wait;
    setFailing({ error: displayName(error, 120), at: iso(now), retryAt: iso(retryAt), retries });
  }
  /** Replaces the owed push with the same identity, or adds it last. */
  function putOwed(o: OwedPush) {
    const list = owedPushes();
    setOwed(list.some((x) => pid(x) === pid(o)) ? list.map((x) => (pid(x) === pid(o) ? o : x)) : [...list, o]);
  }
  const dropOwed = (o: OwedPush) => setOwed(owedPushes().filter((x) => pid(x) !== pid(o)));
  const isOwed = (o: OwedPush) => owedPushes().some((x) => pid(x) === pid(o));
  /**
   * One try. While it is out the push is on disk as one the server may have taken, so a crash neither drops it nor sends
   * it again unasked. A refusal clears that, since the server never took it.
   */
  async function attempt(o: OwedPush): Promise<PushFailure | null> {
    const began = deps.now().getTime();
    const { unsure: _, ...plain } = o;
    putOwed({ ...plain, unsure: iso(began) });
    try {
      await sender!.send(note(o));
      dropOwed(o);
      return null;
    } catch (e) {
      const f = failure(e);
      // A push dropped while the try was out (a reminder took its place, a phone came back) stays dropped.
      if (!f.maybe && isOwed(o)) putOwed(plain);
      return f;
    }
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

  /** Owed pushes free for a retry at `now`, oldest first: none a try is out for, none from before the start in its grace. */
  const ready = (now: number) => owedPushes().filter((o) => !sending.has(pid(o)) && !(now < graceEnds && owedAtStart.has(pid(o))));

  /** Never throws into the caller, whatever the sender does. A try goes out only while the push still holds. */
  async function deliver(first: OwedPush, what: string) {
    const o = { ...first, at: iso(deps.now().getTime()) };
    sending.add(pid(o));
    try {
      for (let tries = 1; ; tries++) {
        const f = await attempt(o);
        if (f === null) return void (failing() && setFailing(null));
        if (!f.maybe && tries < SEND_TRIES) {
          await wait(RETRY_MS * 4 ** (tries - 1));
          if (holds(o) && isOwed(o)) continue;
          return dropOwed(o);
        }
        deps.log(f.maybe ? `push: ${what} may not have gone out: ${f.message}` : `push: ${what} failed after ${tries} tries: ${f.message}`);
        if (!holds(o)) dropOwed(o);
        return failed(f.message, "new");
      }
    } finally {
      sending.delete(pid(o));
      deps.poke?.();
    }
  }

  /**
   * The oldest owed push goes again, once the server says it does not hold it if a try may have reached it. With none
   * owed, asking the server for its recent pushes is the probe. Never throws into the caller.
   */
  async function retry() {
    retrying = true;
    let how: "retry" | "probe" = "probe";
    try {
      setOwed(owedPushes().filter((x) => sending.has(pid(x)) || holds(x)));
      const o = ready(deps.now().getTime())[0];
      if (o === undefined) {
        const f = failing();
        if (f) {
          try {
            await sender!.taken(deps.now().getTime());
          } catch (e) {
            if (!(e instanceof PollForbidden)) throw e;
            // A write-only topic never answers a read: the last real failure stands until a push gets through.
            return setFailing({ ...f, retryAt: iso(deps.now().getTime() + PROBE_MS) });
          }
        }
      } else {
        how = "retry";
        let took = false;
        let blind = false;
        if (o.unsure !== undefined) {
          try {
            took = (await sender!.taken(Date.parse(o.unsure) - TAKEN_SLACK_MS)).some(isTry(o));
          } catch (e) {
            if (!(e instanceof PollForbidden)) throw e;
            // A write-only topic never says what it holds. The push goes again once, a second ring over a lost one; a
            // server that again does not answer may be taking each try, so it is not tried a third time.
            if (o.blind) {
              deps.log(`push: ${o.keys.join(", ")} not sent again: the push server did not answer twice and will not say whether it took it`);
              return dropOwed(o);
            }
            blind = true;
          }
        }
        if (took) deps.log(`push: ${o.keys.join(", ")} had gone out`);
        // The card may have been answered, a phone come back, or a reminder taken its place while the server was asked.
        if (!took && (!holds(o) || !isOwed(o))) return dropOwed(o);
        if (took) dropOwed(o);
        else {
          const f = await attempt(blind ? { ...o, blind } : o);
          if (f !== null) throw f;
          deps.log(`push: ${o.keys.join(", ")} went out on a retry`);
        }
      }
      if (failing()) setFailing(null);
    } catch (e) {
      failed(failure(e).message, how);
    } finally {
      retrying = false;
      deps.poke?.();
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
    const card = reason === "card" || reason === "reminder";
    // A reminder speaks for its card, so the card's own push still owed is not sent as well.
    if (reason === "reminder") setOwed(owedPushes().filter((o) => pid(o) !== `${messageId}|card`));
    // One update per bot is owed at most: the newest says all an older one would.
    else if (!card) setOwed(owedPushes().filter((o) => !(o.for.kind === "bot" && o.botId === bot.id)));
    // The name is the one bot-controlled free text that leaves the Mac, so a renamed bot cannot smuggle content out.
    void deliver(
      { keys: [key], botId: bot.id, text: `${displayName(bot.name, BOT_NAME_MAX)} ${PHRASE[reason]}`, link: linkTo(bot.id, messageId), high: card, for: card ? { kind: "bot-card", card: messageId } : { kind: "bot" } },
      what,
    );
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

  /**
   * Alerts not seen and still owed go to each open socket they never reached, such as the one a phone opens after its
   * last died unseen, without waiting for the dead one to close.
   */
  function resend(now: number, act: boolean, later: (t: number) => void) {
    const open = deps.sockets?.open() ?? [];
    if (open.length === 0) return;
    for (const a of new Set(alerted.values())) {
      const fresh = open.filter((s) => !a.sent.some((b) => b.to.includes(s)));
      if (fresh.length === 0 || a.sent.some((b) => deps.sockets!.heard(b.to, b.at)) || !owes(a)) continue;
      if (act) a.sent.push({ at: now, to: deps.sockets!.alert(a.frame, fresh) });
      else later(now);
    }
  }

  function pushCards(id: SessionId, reason: "card" | "reminder", cards: readonly OwnCard[], now: number) {
    const ids = cards.map(ownCardId);
    const what = `${reason} for session ${id}`;
    const keys = ids.map((c) => `${c}|${reason}`);
    if (!record(keys, what, now)) return;
    if (reason === "card") lastCards.set(id, { at: now, cards: ids });
    // A reminder speaks for its cards, so an owed push for those cards alone is not sent as well.
    else setOwed(owedPushes().filter((o) => !(o.for.kind === "cards" && o.keys.every((k) => k.endsWith("|card") && ids.includes(idOf(k) as MessageId)))));
    void deliver({ keys, botId: null, text: `${SESSION} ${cardsText(reason, cards)}`, link: sessionLink(id, ids[0]), high: true, for: { kind: "cards", session: id, cards: ids } }, what);
  }

  function pushEnd(id: SessionId, end: SessionEnd, key: string, now: number) {
    const what = `${end} for session ${id}`;
    if (!record([key], what, now)) return;
    void deliver({ keys: [key], botId: null, text: ENDED[end], link: sessionLink(id), high: false, for: { kind: "ending", session: id } }, what);
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
    // A phone that came back saw what was owed, even if it left again before the next retry; an answered card owes nothing.
    if (act) setOwed(owedPushes().filter((o) => sending.has(pid(o)) || holds(o, now)));
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
      if (!current(h.id, h.key)) {
        if (act) drop(h.key);
        continue;
      }
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
          owed = owed.map((x) => (x.key !== h.key ? x : { ...x, alerted: true, at: new Date(now).toISOString() }));
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
    const f = failing();
    if (sender !== null && !retrying) {
      const free = ready(now);
      if (free.length < owedPushes().filter((o) => !sending.has(pid(o))).length) later(graceEnds);
      if (f || free.length > 0) {
        const due = f ? Date.parse(f.retryAt) : now;
        if (due > now || !act) later(due);
        else void retry();
      }
    }
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
        setHeld([...held(), { ...ending, alerted: true }]);
        return;
      }
      pushEnd(id, end, key, now);
    },
    state: reach,
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
