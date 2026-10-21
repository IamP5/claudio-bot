import { errorText } from "../text";
import type { HomeRef, Identity } from "./identity";
import { machineHears, type LinkState } from "./link";
import { LINK_REPLACED } from "./links";
import type { AgentRuntime } from "./runtime";
import { parseHomeFrame, type Event, type MachineFrame, type ProfileView } from "./wire";

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

export type Dialer = { state(): LinkState; stop(): void };

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

  const send = (s: DialSocket, frame: MachineFrame) => s.send(JSON.stringify(frame));

  // Subscribed once: an event goes out at once while the link is live, and otherwise waits in the journal for the replay.
  runtime.subscribe((e: Event) => {
    if (state.kind === "live" && socket) send(socket, { t: "event", event: e });
  });

  function drop(s: DialSocket, reason: string) {
    if (socket !== s) return;
    socket = null;
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
        }
      }
    }
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
      // forever, so the older one gives way.
      if (e.code === LINK_REPLACED && socket === s) {
        stopped = true;
        log(`link: another bridge with this machine's identity linked to ${home.name}, so this one stops dialing. Run one bridge per machine.json.`);
      }
      drop(s, e.reason || `closed with code ${e.code}`);
    };
    s.onerror = () => {};
  }

  dial();
  return {
    state: () => state,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000, "machine stopping");
      socket = null;
      state = { kind: "closed", reason: "stopped" };
    },
  };
}
