import type { Server, ServerWebSocket } from "bun";
import { rejectsOrigin, type Devices } from "./devices";
import type { Hub } from "./hub";
import type { Legacy } from "./legacy";
import type { Enrollment } from "./machine/enroll";
import type { LinkSession, Links } from "./machine/links";
import { parseClientMessage } from "./parse";
import {
  isSessionRequest,
  type ClientMessage,
  type DeviceId,
  type PairOffer,
  type ServerMessage,
  type SessionId,
  type SessionsChannelFrame,
  type Signal,
  type ThreadChannelFrame,
  type TransportMessage,
} from "./protocol";
import { forProtocol2 } from "./protocol2";
import type { Stream } from "./stream";
import { errorText } from "./text";

// HTTP and the sockets: /health, POST /pair, /ws with resume and the transport messages, and on a home with machines,
// POST /enroll and the machines' /link.

// Broadcasts go out twice: as is to apps that connected with ?protocol=3, and with permission cards shown as questions
// to a protocol 2 app, which sends no protocol and has no permission card.
const TOPIC = { 2: "protocol2", 3: "protocol3" } as const;
// Uploads ride inline in `send` as base64, up to 10 MB a file. The app's socket takes frames this large too.
export const MAX_FRAME_BYTES = 32 << 20;
// Two burned codes' worth. Each burn while unpaired prints a new code, so this also bounds what a guesser can print.
export const PAIR_FAILURES_PER_ADDRESS = 10;
export const PAIR_FAILURE_WINDOW_MS = 10 * 60_000;
/**
 * A socket is live while it was heard from this recently. The app pings every 20 s while it runs; a suspended iPhone
 * stops pinging but keeps the socket open, and push must not mistake it for someone watching.
 */
const LIVE_WINDOW_MS = 45_000;
// Bun pings a socket silent for 44 s and closes it at 60 s, so a dead one goes away instead of lingering for two minutes.
const IDLE_TIMEOUT_S = 60;

/**
 * limited: the protocol 2 shared token, or an app that did not announce protocol 3 (see `refusal`). threads: the
 * sessions this socket watches, so its close unwatches them. turns: the socket's requests run one at a time in the
 * order sent, so an answer never overtakes the one asked before it. attended: the app's last presence, true until it
 * sends one.
 */
type SocketData = {
  deviceId: DeviceId;
  protocol: 2 | 3;
  resume: { epoch: string; after: number } | null;
  heardAt: number;
  attended: boolean;
  limited: boolean;
  threads: Set<SessionId>;
  turns: Promise<void>;
};
/** A machine's link. It proves who it is in its handshake, so it upgrades with no token. */
type LinkData = { link: LinkSession | null };
type Socket = ServerWebSocket<SocketData>;
type AnySocket = ServerWebSocket<SocketData | LinkData>;
const isLink = (ws: AnySocket): ws is ServerWebSocket<LinkData> => "link" in ws.data;

export type ServeDeps = {
  devices: Devices;
  stream: Stream;
  hub: Pick<Hub, "hello" | "greeting" | "handle">;
  legacy: Legacy;
  log: (line: string) => void;
  now: () => Date;
  port: number;
  hostname?: string;
  /** The one way a code is minted for another device: pair_code here and the control socket both call it. */
  offer: () => PairOffer;
  /** A home's machines: their links, enrollment, and join codes (machine_code). Absent: none of the three. */
  machines?: { links: Links; enroll(body: unknown): Enrollment; offer(): PairOffer };
};

export type Transport = {
  readonly port: number;
  /** Stamps the message with the next seq and sends it to every open socket. */
  publish(message: ServerMessage): void;
  /**
   * Sends the message as it is, no seq and not kept for replay, to every protocol 3 socket, or with a topic only to the
   * sockets that watch it: "sessions" (watch_sessions) or `s:<sessionId>` (watch_session). A protocol 2 app never
   * gets one: it may not watch.
   */
  signal(message: Signal): void;
  signal(message: SessionsChannelFrame, topic: "sessions"): void;
  signal(message: ThreadChannelFrame, topic: ThreadTopic): void;
  watchers(sessionId: SessionId): number;
  /** Open authenticated sockets heard from within LIVE_WINDOW_MS whose app is attended. */
  live(): number;
  /** When the last of those goes quiet, or null when none is live. */
  liveUntil(): Date | null;
  stop(): void;
};

export type ThreadTopic = `s:${string}`;
export const threadTopic = (id: SessionId): ThreadTopic => `s:${id}`;
const SESSIONS_TOPIC = "sessions";

/**
 * Watching is the socket's own: subscribed before the hub answers, so a channel frame the answer does not hold yet
 * reaches the socket after it rather than being missed. The hub's answer replaces what came before.
 */
function subscribe(ws: Socket, m: ClientMessage) {
  switch (m.type) {
    case "watch_sessions":
      return ws.subscribe(SESSIONS_TOPIC);
    case "unwatch_sessions":
      return ws.unsubscribe(SESSIONS_TOPIC);
    case "watch_session":
      ws.data.threads.add(m.sessionId);
      return ws.subscribe(threadTopic(m.sessionId));
    case "unwatch_session":
      ws.data.threads.delete(m.sessionId);
      return ws.unsubscribe(threadTopic(m.sessionId));
  }
}

const isTransport = (m: ClientMessage): m is TransportMessage =>
  m.type === "devices" || m.type === "revoke_device" || m.type === "pair_code" || m.type === "machine_code" || m.type === "presence";

/**
 * What a socket may not send. A protocol 2 socket sends no session request: channel frames reach every subscriber
 * without forProtocol2, so it must never watch one. A limited socket may not do the rest: the shared token may sit on
 * more than one old phone, and an app from before protocol 3 offers neither, so a frame asking for one is not the
 * user at that app.
 */
function refusal(data: SocketData, m: ClientMessage): string | null {
  if (data.protocol === 2 && isSessionRequest(m)) return "This app has no Sessions view. Update the app to see your Claude Code sessions.";
  if (!data.limited) return null;
  if (m.type === "revoke_device" && m.deviceId !== data.deviceId) {
    return "A phone paired before protocol 3 can only revoke itself. Revoke other phones from a phone paired with a code.";
  }
  if (m.type === "decide" && m.choice !== "once" && m.choice !== "deny") return "This app can only answer Allow once or Deny. Update the app for Always and Never.";
  return null;
}

export function serve(deps: ServeDeps): Transport {
  const { devices, stream, hub, legacy, log } = deps;
  const sockets = new Map<DeviceId, Set<Socket>>();
  const failures = new Map<string, { since: number; count: number }>();

  // A socket can outlive its device: revoked between the upgrade and open, or while a frame was in flight.
  const isPaired = (id: DeviceId) => devices.list(null).some((d) => d.id === id);

  const limited = (address: string, at: number) => {
    const f = failures.get(address);
    return f !== undefined && at - f.since < PAIR_FAILURE_WINDOW_MS && f.count >= PAIR_FAILURES_PER_ADDRESS;
  };

  const failed = (address: string, at: number) => {
    const f = failures.get(address);
    if (f !== undefined && at - f.since < PAIR_FAILURE_WINDOW_MS) {
      f.count += 1;
      return;
    }
    for (const [key, old] of failures) if (at - old.since >= PAIR_FAILURE_WINDOW_MS) failures.delete(key);
    failures.set(address, { since: at, count: 1 });
  };

  const heard = (ws: Socket) => {
    ws.data.heardAt = deps.now().getTime();
  };
  const quietAt = () => [...sockets.values()].flatMap((set) => [...set].filter((ws) => ws.data.attended).map((ws) => ws.data.heardAt + LIVE_WINDOW_MS));

  const send = (ws: Socket, message: ServerMessage) => {
    const frame = ws.data.protocol === 3 ? message : forProtocol2(message);
    if (frame !== null) ws.send(JSON.stringify(frame));
  };

  function transport(ws: Socket, message: TransportMessage): ServerMessage[] {
    const self = ws.data.deviceId;
    switch (message.type) {
      case "devices":
        return [{ type: "devices", devices: devices.list(self) }];
      case "pair_code":
        if (devices.list(self).find((d) => d.current)?.legacy) {
          return [{ type: "error", message: "This phone still uses the old shared token. Pair it with a code from the Mac before it can pair others." }];
        }
        return [{ type: "pair_code", ...deps.offer() }];
      case "machine_code":
        if (!deps.machines) return [{ type: "error", message: "This bridge does not take machines." }];
        if (devices.list(self).find((d) => d.current)?.legacy) {
          return [{ type: "error", message: "This phone still uses the old shared token. Pair it with a code from the Mac before it can add machines." }];
        }
        log("machine code minted from a phone");
        return [{ type: "machine_code", ...deps.machines.offer() }];
      case "presence":
        ws.data.attended = message.attended;
        return [];
      case "revoke_device": {
        const target = devices.list(null).find((d) => d.id === message.deviceId);
        if (!target) return [{ type: "error", message: "That device is not paired." }];
        try {
          // The legacy token goes first: if the revoke then fails, a restart still cannot import that phone again.
          if (target.legacy) legacy.close();
          devices.revoke(target.id);
        } finally {
          for (const socket of sockets.get(target.id) ?? []) socket.close(4001, "revoked");
        }
        log(`revoked ${target.name}`);
        return [{ type: "devices", devices: devices.list(self) }];
      }
    }
  }

  async function pair(req: Request, address: string): Promise<Response> {
    if (req.method !== "POST") return new Response("Use POST", { status: 405 });
    const at = deps.now().getTime();
    if (limited(address, at)) {
      return Response.json({ error: "Too many failed pairings from this address. Wait ten minutes, then try again." }, { status: 429 });
    }
    const body: unknown = await req.json().catch(() => null);
    const { code, name } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof code !== "string" || typeof name !== "string") return Response.json({ error: "Send {code, name} as JSON." }, { status: 400 });
    let result: ReturnType<Devices["pair"]>;
    try {
      result = devices.pair(code, name);
    } catch (e) {
      log(`pairing not saved: ${errorText(e)}`);
      return Response.json({ error: "The Mac could not save the pairing. Try the same code again." }, { status: 500 });
    }
    if ("error" in result) {
      failed(address, at);
      return Response.json(result, { status: 401 });
    }
    log(`paired ${devices.list(null).find((d) => d.id === result.deviceId)?.name}`);
    return Response.json(result);
  }

  async function enroll(req: Request, address: string): Promise<Response> {
    if (!deps.machines) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Use POST", { status: 405 });
    const at = deps.now().getTime();
    if (limited(address, at)) {
      return Response.json({ error: "Too many failed enrollments from this address. Wait ten minutes, then try again." }, { status: 429 });
    }
    let result: Enrollment;
    try {
      result = deps.machines.enroll(await req.json().catch(() => null));
    } catch (e) {
      log(`enrollment not saved: ${errorText(e)}`);
      return Response.json({ error: "The home could not save the enrollment. Try the same code again." }, { status: 500 });
    }
    if (result.status === 401) failed(address, at);
    if (result.status !== 200) return Response.json(result.body, { status: result.status });
    if (result.created) {
      log(`enrolled machine ${result.machine}`);
      deps.machines.links.enrolled();
    }
    return Response.json(result.body);
  }

  const server: Server<SocketData | LinkData> = Bun.serve<SocketData | LinkData>({
    hostname: deps.hostname ?? "0.0.0.0",
    port: deps.port,
    maxRequestBodySize: 64 * 1024,
    development: false,
    error(e) {
      log(`http: ${e.message}`);
      return new Response("Internal error", { status: 500 });
    },
    async fetch(req, server) {
      if (rejectsOrigin(req)) return new Response("Forbidden", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const proof = devices.prove(url.searchParams.get("device") ?? "", url.searchParams.get("nonce") ?? "");
        return Response.json(proof === null ? { ok: true } : { ok: true, proof });
      }
      if (url.pathname === "/pair") return pair(req, server.requestIP(req)?.address ?? "");
      if (url.pathname === "/enroll") return enroll(req, server.requestIP(req)?.address ?? "");
      if (url.pathname === "/link" && deps.machines) {
        if (server.upgrade(req, { data: { link: null } })) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname === "/ws") {
        const deviceId = devices.authenticate(req);
        if (deviceId === null) return new Response("Unauthorized", { status: 401 });
        const protocol = Number(url.searchParams.get("protocol")) >= 3 ? 3 : 2;
        const epoch = url.searchParams.get("epoch");
        // The ring holds protocol 3 frames, and a protocol 2 app never asks to resume.
        const resume = epoch && protocol === 3 ? { epoch, after: Number(url.searchParams.get("after") ?? NaN) } : null;
        const limited = protocol === 2 || devices.list(null).some((d) => d.id === deviceId && d.legacy);
        if (server.upgrade(req, { data: { deviceId, protocol, resume, heardAt: deps.now().getTime(), attended: true, limited, threads: new Set(), turns: Promise.resolve() } })) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: IDLE_TIMEOUT_S,
      sendPings: true,
      ping: (ws) => void (isLink(ws) || heard(ws as Socket)),
      pong: (ws) => void (isLink(ws) || heard(ws as Socket)),
      open(any) {
        if (isLink(any)) {
          const links = deps.machines!.links;
          any.data.link = links.open({ send: (text) => any.send(text), close: (code, reason) => any.close(code, reason) });
          return;
        }
        const ws = any as Socket;
        const { deviceId, resume } = ws.data;
        if (!isPaired(deviceId)) return ws.close(4001, "revoked");
        const missed = resume ? stream.since(resume.epoch, resume.after) : null;
        // Hello, replay and subscribe in one tick, so no broadcast falls between them. Signals are not replayed, so a
        // protocol 3 socket gets the latest of those (plan usage) as it connects.
        send(ws, hub.hello(stream.position(missed !== null)));
        for (const frame of missed ?? []) ws.send(frame);
        if (ws.data.protocol === 3) for (const live of hub.greeting()) send(ws, live);
        ws.subscribe(TOPIC[ws.data.protocol]);
        sockets.set(deviceId, (sockets.get(deviceId) ?? new Set()).add(ws));
        devices.seen(deviceId);
      },
      close(any) {
        if (isLink(any)) {
          if (any.data.link) deps.machines!.links.closed(any.data.link);
          return;
        }
        const ws = any as Socket;
        sockets.get(ws.data.deviceId)?.delete(ws);
        // Bun drops a closed socket's topics; the hub hears it left each thread, after the requests already sent.
        ws.data.turns = ws.data.turns.then(async () => {
          for (const sessionId of ws.data.threads) await hub.handle({ type: "unwatch_session", sessionId }).catch(() => {});
          ws.data.threads.clear();
        });
      },
      message(any, raw) {
        if (isLink(any)) {
          if (any.data.link) deps.machines!.links.message(any.data.link, String(raw));
          return;
        }
        const ws = any as Socket;
        heard(ws);
        ws.data.turns = ws.data.turns.then(() => handle(ws, String(raw))).catch((e) => log(`serve: ${errorText(e)}`));
      },
    },
  });

  async function handle(ws: Socket, raw: string) {
    if (ws.readyState !== 1) return;
    if (!isPaired(ws.data.deviceId)) return ws.close(4001, "revoked");
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
    const refused = refusal(ws.data, parsed.message);
    if (refused !== null) return send(ws, { type: "error", message: refused });
    try {
      subscribe(ws, parsed.message);
      const replies = isTransport(parsed.message) ? transport(ws, parsed.message) : await hub.handle(parsed.message);
      for (const reply of replies) send(ws, reply);
    } catch (e) {
      send(ws, { type: "error", message: errorText(e) });
    }
  }

  return {
    get port() {
      return server.port!;
    },
    publish: (message) => {
      const frame = stream.append(message);
      server.publish(TOPIC[3], frame);
      const old = forProtocol2(message);
      if (old !== null) server.publish(TOPIC[2], old === message ? frame : JSON.stringify({ ...old, seq: stream.seq }));
    },
    signal: (message: Signal | SessionsChannelFrame | ThreadChannelFrame, topic?: string) => {
      server.publish(topic ?? TOPIC[3], JSON.stringify(message));
    },
    watchers: (sessionId) => server.subscriberCount(threadTopic(sessionId)),
    live: () => quietAt().filter((t) => t > deps.now().getTime()).length,
    liveUntil: () => {
      const last = Math.max(0, ...quietAt());
      return last > deps.now().getTime() ? new Date(last) : null;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
