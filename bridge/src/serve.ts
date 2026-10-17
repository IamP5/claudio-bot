import type { Server, ServerWebSocket } from "bun";
import { rejectsOrigin, type Devices } from "./devices";
import type { Hub } from "./hub";
import type { Legacy } from "./legacy";
import { parseClientMessage } from "./parse";
import type { ClientMessage, DeviceId, ServerMessage, TransportMessage } from "./protocol";
import { forProtocol2 } from "./protocol2";
import type { Stream } from "./stream";
import { errorText } from "./text";

// HTTP and the socket: /health, POST /pair, /ws with resume, and the transport messages.

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

/** limited: the protocol 2 shared token, or an app that did not announce protocol 3 (see `refusal`). */
type SocketData = { deviceId: DeviceId; protocol: 2 | 3; resume: { epoch: string; after: number } | null; heardAt: number; limited: boolean };
type Socket = ServerWebSocket<SocketData>;

export type ServeDeps = {
  devices: Devices;
  stream: Stream;
  hub: Pick<Hub, "hello" | "handle">;
  legacy: Legacy;
  log: (line: string) => void;
  now: () => Date;
  port: number;
  hostname?: string;
};

export type Transport = {
  readonly port: number;
  /** Stamps the message with the next seq and sends it to every open socket. */
  publish(message: ServerMessage): void;
  /** Open authenticated sockets heard from within LIVE_WINDOW_MS. */
  live(): number;
  /** When the last of those goes quiet, or null when none is live. */
  liveUntil(): Date | null;
  stop(): void;
};

const isTransport = (m: ClientMessage): m is TransportMessage => m.type === "devices" || m.type === "revoke_device" || m.type === "pair_code";

/**
 * What a limited socket may not send. The shared token may sit on more than one old phone, and an app from before
 * protocol 3 offers neither of these, so a frame asking for one is not the user at that app.
 */
function refusal(data: SocketData, m: ClientMessage): string | null {
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
  const quietAt = () => [...sockets.values()].flatMap((set) => [...set].map((ws) => ws.data.heardAt + LIVE_WINDOW_MS));

  const send = (ws: Socket, message: ServerMessage) => {
    ws.send(JSON.stringify(ws.data.protocol === 3 ? message : forProtocol2(message)));
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
        return [{ type: "pair_code", ...devices.newCode() }];
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

  const server: Server<SocketData> = Bun.serve<SocketData>({
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
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/pair") return pair(req, server.requestIP(req)?.address ?? "");
      if (url.pathname === "/ws") {
        const deviceId = devices.authenticate(req);
        if (deviceId === null) return new Response("Unauthorized", { status: 401 });
        const protocol = Number(url.searchParams.get("protocol")) >= 3 ? 3 : 2;
        const epoch = url.searchParams.get("epoch");
        // The ring holds protocol 3 frames, and a protocol 2 app never asks to resume.
        const resume = epoch && protocol === 3 ? { epoch, after: Number(url.searchParams.get("after") ?? NaN) } : null;
        const limited = protocol === 2 || devices.list(null).some((d) => d.id === deviceId && d.legacy);
        if (server.upgrade(req, { data: { deviceId, protocol, resume, heardAt: deps.now().getTime(), limited } })) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: IDLE_TIMEOUT_S,
      sendPings: true,
      ping: heard,
      pong: heard,
      open(ws) {
        const { deviceId, resume } = ws.data;
        if (!isPaired(deviceId)) return ws.close(4001, "revoked");
        const missed = resume ? stream.since(resume.epoch, resume.after) : null;
        // Hello, replay and subscribe in one tick, so no broadcast falls between them.
        send(ws, hub.hello(stream.position(missed !== null)));
        for (const frame of missed ?? []) ws.send(frame);
        ws.subscribe(TOPIC[ws.data.protocol]);
        sockets.set(deviceId, (sockets.get(deviceId) ?? new Set()).add(ws));
        devices.seen(deviceId);
      },
      close(ws) {
        sockets.get(ws.data.deviceId)?.delete(ws);
      },
      async message(ws, raw) {
        heard(ws);
        if (!isPaired(ws.data.deviceId)) return ws.close(4001, "revoked");
        const parsed = parseClientMessage(String(raw));
        if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
        const refused = refusal(ws.data, parsed.message);
        if (refused !== null) return send(ws, { type: "error", message: refused });
        try {
          const replies = isTransport(parsed.message) ? transport(ws, parsed.message) : await hub.handle(parsed.message);
          for (const reply of replies) send(ws, reply);
        } catch (e) {
          send(ws, { type: "error", message: errorText(e) });
        }
      },
    },
  });

  return {
    get port() {
      return server.port!;
    },
    publish: (message) => {
      const frame = stream.append(message);
      server.publish(TOPIC[3], frame);
      const old = forProtocol2(message);
      server.publish(TOPIC[2], old === message ? frame : JSON.stringify({ ...old, seq: stream.seq }));
    },
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
