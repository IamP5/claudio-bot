import type { Identity } from "./identity";
import { homeHears, homeOpens, type LinkState } from "./link";
import type { Machine, Sent } from "./machines";
import type { Registry } from "./registry";
import { newIntentId, parseMachineFrame, type Event, type HomeFrame, type IntentId, type MachineId, type ProfileView, type Seq } from "./wire";

// The home's end of every machine's link (GET /link): the handshake, the remote Machine each enrolled machine is, its
// events in, and acks out once the registry has saved them.

/** The socket a link runs over, as serve.ts hands it in. */
export type LinkSocket = { send(text: string): void; close(code: number, reason: string): void };

export type LinkSession = {
  socket: LinkSocket;
  state: LinkState;
  profile: ProfileView | null;
  since: string;
  /** Intents sent and not yet answered, by id. */
  pending: Map<IntentId, (a: Sent) => void>;
  handshake: ReturnType<typeof setTimeout> | null;
  flush: ReturnType<typeof setTimeout> | null;
};

export type Links = {
  open(socket: LinkSocket): LinkSession;
  message(session: LinkSession, raw: string): void;
  /** The socket closed, from either side. */
  closed(session: LinkSession): void;
  /** Every enrolled machine, online or not. */
  machines(): Machine[];
  /** Each event a machine sends, once, in seq order. */
  onEvent(f: (machine: MachineId, e: Event) => void): void;
  /** A machine came online, went offline or enrolled. */
  onChange(f: () => void): void;
  /** After registry.enroll, so the phone sees the new machine. */
  enrolled(): void;
};

/** Close codes: a refused handshake, a malformed frame, a link replaced by a newer one from the same machine. */
export const LINK_REFUSED = 4003;
export const LINK_BAD_FRAME = 4004;
export const LINK_REPLACED = 4005;
const HANDSHAKE_MS = 10_000;
/** How long the home waits for a machine to apply an intent. A start scans the machine's projects and may make a worktree. */
const APPLY_MS = 120_000;
/** Events in a burst share one registry save and one ack. */
const FLUSH_MS = 50;

export function createLinks(deps: { identity: Identity; registry: Registry; log: (line: string) => void; now: () => Date; applyMs?: number }): Links {
  const { registry, log } = deps;
  const live = new Map<MachineId, LinkSession>();
  /**
   * The newest event seq handled from each machine, saved to the registry and acked a moment later. One per machine,
   * not per link: a newer link from the same machine must not take an event the older one already handled.
   */
  const handled = new Map<MachineId, Seq>();
  const handledFrom = (id: MachineId) => Math.max(handled.get(id) ?? 0, registry.get(id)?.ackedSeq ?? 0);
  const eventSubscribers: ((machine: MachineId, e: Event) => void)[] = [];
  const changeSubscribers: (() => void)[] = [];
  const changed = () => changeSubscribers.forEach((f) => f());
  const nameOf = (id: MachineId) => registry.get(id)?.name ?? id;

  function close(session: LinkSession, code: number, reason: string) {
    if (session.state.kind === "closed") return;
    session.socket.close(code, reason);
    ended(session, reason);
  }

  function ended(session: LinkSession, reason: string) {
    const was = session.state;
    session.state = { kind: "closed", reason };
    if (session.handshake) clearTimeout(session.handshake);
    if (was.kind !== "live") return;
    save(session, was.peer);
    for (const resolve of session.pending.values()) resolve({ ok: false, reason: `${nameOf(was.peer)} went offline`, undelivered: true });
    session.pending.clear();
    if (live.get(was.peer) === session) {
      live.delete(was.peer);
      log(`link: ${nameOf(was.peer)} offline (${reason})`);
      changed();
    }
  }

  const send = (session: LinkSession, frame: HomeFrame) => session.socket.send(JSON.stringify(frame));

  /** Saves what the link handled, then tells the machine it may drop it. */
  function save(session: LinkSession, peer: MachineId) {
    if (session.flush) clearTimeout(session.flush);
    session.flush = null;
    const record = registry.get(peer);
    if (!record) return;
    registry.update(peer, { ackedSeq: handledFrom(peer), lastSeenAt: deps.now().toISOString(), ...(session.profile && { profile: session.profile }) });
    if (session.state.kind === "live") send(session, { t: "ack", seq: handledFrom(peer) });
  }

  function event(session: LinkSession, peer: MachineId, e: Event) {
    const last = handledFrom(peer);
    if (e.seq <= last) {
      log(`link: ${nameOf(peer)} event ${e.seq} replayed, dropped`);
    } else {
      if (e.seq !== last + 1) log(`link: ${nameOf(peer)} skipped from event ${last} to ${e.seq}`);
      handled.set(peer, e.seq);
      if (e.kind === "profile") session.profile = e.profile;
      log(`link: ${nameOf(peer)} event ${e.seq} ${e.kind}`);
      for (const f of eventSubscribers) f(peer, e);
    }
    session.flush ??= setTimeout(() => save(session, peer), FLUSH_MS);
  }

  function remote(id: MachineId): Machine {
    const record = () => registry.get(id);
    const session = () => live.get(id) ?? null;
    return {
      id,
      name: record()?.name ?? id,
      profile: () => session()?.profile ?? record()?.profile ?? null,
      status() {
        const s = session();
        return s ? { online: true, since: s.since } : { online: false, since: record()?.lastSeenAt ?? null };
      },
      send(intent) {
        const s = session();
        if (!s) return Promise.resolve({ ok: false, reason: `${nameOf(id)} is offline`, undelivered: true });
        return new Promise<Sent>((resolve) => {
          const timer = setTimeout(() => {
            s.pending.delete(intent.intentId);
            resolve({ ok: false, reason: `${nameOf(id)} did not answer`, undelivered: true });
          }, deps.applyMs ?? APPLY_MS);
          s.pending.set(intent.intentId, (a) => {
            clearTimeout(timer);
            resolve(a);
          });
          send(s, { t: "intent", intent });
        });
      },
    };
  }

  return {
    open(socket) {
      const opened = homeOpens();
      const session: LinkSession = {
        socket,
        state: opened.state,
        profile: null,
        since: deps.now().toISOString(),
        pending: new Map(),
        handshake: null,
        flush: null,
      };
      session.handshake = setTimeout(() => close(session, LINK_REFUSED, "handshake timed out"), HANDSHAKE_MS);
      send(session, opened.send);
      return session;
    },

    message(session, raw) {
      if (session.state.kind === "closed") return;
      const parsed = parseMachineFrame(raw);
      if (!parsed.ok) {
        log(`link: closed a link that sent a bad frame: ${parsed.error}`);
        return close(session, LINK_BAD_FRAME, "bad frame");
      }
      const step = homeHears(session.state, parsed.value, deps.identity, (id) => {
        const record = registry.get(id);
        return record && { publicKey: record.publicKey, ackedSeq: handledFrom(id) };
      });
      switch (step.kind) {
        case "close":
          log(`link: refused: ${step.reason}`);
          return close(session, LINK_REFUSED, step.reason);
        case "welcome": {
          const peer = step.state.peer;
          if (session.handshake) clearTimeout(session.handshake);
          session.state = step.state;
          session.profile = step.hello.profile;
          if (step.ackedSeq < handledFrom(peer)) log(`link: ${nameOf(peer)} lost its outbox, so it replays from its first event`);
          handled.set(peer, step.ackedSeq);
          const old = live.get(peer);
          live.set(peer, session);
          if (old) close(old, LINK_REPLACED, "replaced by a newer link");
          send(session, step.send);
          registry.update(peer, { profile: step.hello.profile, lastSeenAt: session.since, ackedSeq: step.ackedSeq });
          log(`link: ${nameOf(peer)} online, replaying after event ${step.ackedSeq} of ${step.hello.lastSeq}`);
          changed();
          // Its agents and open cards as they are now, after the replay, so the home's view of it starts current.
          void remote(peer).send({ kind: "snapshot", intentId: newIntentId() });
          return;
        }
        case "frame": {
          const frame = step.frame;
          switch (frame.t) {
            case "event":
              return event(session, step.peer, frame.event);
            case "applied": {
              const resolve = session.pending.get(frame.intentId);
              session.pending.delete(frame.intentId);
              return resolve?.(frame.applied);
            }
          }
        }
      }
    },

    closed(session) {
      ended(session, session.state.kind === "closed" ? session.state.reason : "the socket closed");
    },

    machines: () => registry.list().map((r) => remote(r.id)),
    onEvent: (f) => void eventSubscribers.push(f),
    onChange: (f) => void changeSubscribers.push(f),
    enrolled: changed,
  };
}
