import { errorText } from "../text";
import type { HomeRef, Identity } from "./identity";
import { machineHears, type LinkState } from "./link";
import { LINK_REMOVED, LINK_REPLACED } from "./links";
import type { AgentRuntime } from "./runtime";
import { isSessionFrame, type ServerMessage, type SessionClientMessage, type SessionId } from "../protocol";
import { parseHomeFrame, type Event, type IntentId, type MachineFrame, type ProfileView, type SessionReply, type SessionSignal } from "./wire";

// The machine's end of the link: it dials its home's /link, proves itself, replays what the home has not acked, then
// applies intents and streams events until the socket drops, and dials again with backoff. The machine never listens
// for the home: NAT, sleep and a changing address are all fine.

/** The part of a WebSocket the dialer uses, so a test can stand in for one. */
export type DialSocket = {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
};

export type Dialer = {
  state(): LinkState;
  /** A sessions channel frame for the home, sent while the link is live and dropped otherwise. */
  signal(frame: SessionSignal): void;
  /** Whether the home watches this session's thread for a phone, over the link that is live now. */
  watched(id: SessionId): boolean;
  stop(): void;
};

const isReply = (f: ServerMessage): f is SessionReply => isSessionFrame(f) || f.type === "error";

export const BACKOFF = { firstMs: 1000, maxMs: 30_000 } as const;

/** http://host:port → ws://host:port/link, https → wss. */
export function linkUrl(home: HomeRef): string {
  const url = new URL(home.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/link";
  url.search = "";
  return url.toString();
}

export function dialHub(deps: {
  identity: Identity & { home: HomeRef };
  runtime: Pick<AgentRuntime, "apply" | "events" | "lastSeq" | "ack" | "subscribe">;
  profile: ProfileView;
  /** This machine's Sessions tab, for the home's asks. Absent: every ask is refused. */
  sessions?: { handle(m: SessionClientMessage): Promise<ServerMessage[]> };
  log: (line: string) => void;
  connect?: (url: string) => DialSocket;
  backoff?: { firstMs: number; maxMs: number };
}): Dialer {
  const { identity, runtime, log } = deps;
  const home = identity.home;
  const backoff = deps.backoff ?? BACKOFF;
  const connect = deps.connect ?? ((url: string) => new WebSocket(url) as unknown as DialSocket);
  let state: LinkState = { kind: "closed", reason: "not dialed yet" };
  let socket: DialSocket | null = null;
  let delay = backoff.firstMs;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** The threads the home watches over this link; a new link starts with none, and the home watches again. */
  const watching = new Set<SessionId>();

  const send = (s: DialSocket, frame: MachineFrame) => s.send(JSON.stringify(frame));

  // Subscribed once: an event goes out at once while the link is live, and otherwise waits in the journal for the replay.
  runtime.subscribe((e: Event) => {
    if (state.kind === "live" && socket) send(socket, { t: "event", event: e });
  });

  function drop(s: DialSocket, reason: string) {
    if (socket !== s) return;
    socket = null;
    watching.clear();
    const wasLive = state.kind === "live";
    state = { kind: "closed", reason };
    log(`link: ${wasLive ? "lost" : "could not reach"} ${home.name} (${reason})${stopped ? "" : `, dialing again in ${Math.round(delay / 1000)} s`}`);
    if (stopped) return;
    retry = setTimeout(dial, delay);
    delay = Math.min(delay * 2, backoff.maxMs);
  }

  function hear(s: DialSocket, raw: string) {
    if (socket !== s) return;
    const parsed = parseHomeFrame(raw);
    if (!parsed.ok) {
      s.close(4004, "bad frame");
      return drop(s, `${home.name} sent a bad frame: ${parsed.error}`);
    }
    const step = machineHears(state, parsed.value, identity, () => ({ profile: deps.profile, lastSeq: runtime.lastSeq() }));
    switch (step.kind) {
      case "close":
        s.close(4003, step.reason);
        return drop(s, step.reason);
      case "hello":
        state = step.state;
        return send(s, step.send);
      case "live": {
        state = step.state;
        delay = backoff.firstMs;
        const missed = runtime.events(step.ackedSeq);
        log(`link: live with ${home.name}, replaying ${missed.length} event${missed.length === 1 ? "" : "s"} after ${step.ackedSeq}`);
        for (const e of missed) send(s, { t: "event", event: e });
        return;
      }
      case "frame": {
        const frame = step.frame;
        switch (frame.t) {
          case "ack":
            return runtime.ack(frame.seq);
          case "intent": {
            const { intent } = frame;
            void runtime
              .apply(intent)
              .catch((e): { ok: false; reason: string } => ({ ok: false, reason: `The machine failed to apply it: ${errorText(e)}` }))
              .then((applied) => {
                // The answer is in the journal, so a reconnect that resends the intent gets it again.
                if (socket === s && state.kind === "live") send(s, { t: "applied", intentId: intent.intentId, applied });
              });
            return;
          }
          case "ask":
            return void ask(s, frame.id, frame.frame);
        }
      }
    }
  }

  async function ask(s: DialSocket, id: IntentId, m: SessionClientMessage) {
    if (m.type === "watch_session") watching.add(m.sessionId);
    if (m.type === "unwatch_session") watching.delete(m.sessionId);
    let frames: SessionReply[];
    try {
      frames = deps.sessions ? (await deps.sessions.handle(m)).filter(isReply) : [{ type: "error", message: "This machine does not serve sessions." }];
    } catch (e) {
      frames = [{ type: "error", message: `The machine failed to answer: ${errorText(e)}` }];
    }
    if (socket === s && state.kind === "live") send(s, { t: "reply", id, frames });
  }

  function dial() {
    retry = null;
    if (stopped) return;
    state = { kind: "connecting" };
    let s: DialSocket;
    try {
      s = connect(linkUrl(home));
    } catch (e) {
      const failed = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } satisfies DialSocket;
      socket = failed;
      return drop(failed, errorText(e));
    }
    socket = s;
    s.onmessage = (e) => hear(s, String(e.data));
    s.onclose = (e) => {
      // Another bridge with this machine's identity linked after this one: two would take the link from each other
      // forever, so the older one gives way. Only a link the home welcomed can be replaced: before that, the code is
      // nobody's word for it but whoever answered the socket.
      if (e.code === LINK_REPLACED && socket === s && state.kind === "live") {
        stopped = true;
        log(`link: another bridge with this machine's identity linked to ${home.name}, so this one stops dialing. Run one bridge per machine.json.`);
      }
      if (e.code === LINK_REMOVED && socket === s && state.kind === "live") {
        stopped = true;
        log(`link: ${home.name} removed this machine, so it stops dialing. Its agents and files stay here. To join again, run claudiobot machine enroll with a new code.`);
      }
      drop(s, e.reason || `closed with code ${e.code}`);
    };
    s.onerror = () => {};
  }

  dial();
  return {
    state: () => state,
    signal(frame) {
      if (state.kind === "live" && socket) send(socket, { t: "signal", frame });
    },
    watched: (id) => watching.has(id),
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000, "machine stopping");
      socket = null;
      state = { kind: "closed", reason: "stopped" };
    },
  };
}
