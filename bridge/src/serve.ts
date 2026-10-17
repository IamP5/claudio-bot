import type { Server, ServerWebSocket } from "bun";
import { rejectsOrigin, type Devices } from "./devices";
import type { Hub } from "./hub";
import type { Legacy } from "./legacy";
import { parseClientMessage } from "./parse";
import type { ClientMessage, DeviceId, ServerMessage, TransportMessage } from "./protocol";
import type { Stream } from "./stream";

// HTTP and the socket: /health, POST /pair, /ws with resume, and the transport messages. Owner: U5.

const TOPIC = "all";

type SocketData = { deviceId: DeviceId; resume: { epoch: string; after: number } | null };
type Socket = ServerWebSocket<SocketData>;

export type ServeDeps = {
  devices: Devices;
  stream: Stream;
  hub: Pick<Hub, "hello" | "handle">;
  legacy: Legacy;
  log: (line: string) => void;
  port: number;
  hostname?: string;
};

export type Transport = {
  readonly port: number;
  /** Stamps the message with the next seq and sends it to every open socket. */
  publish(message: ServerMessage): void;
  /** Open authenticated sockets. */
  live(): number;
  stop(): void;
};

const isTransport = (m: ClientMessage): m is TransportMessage => m.type === "devices" || m.type === "revoke_device" || m.type === "pair_code";

export function serve(deps: ServeDeps): Transport {
  const { devices, stream, hub, legacy, log } = deps;
  const sockets = new Map<DeviceId, Set<Socket>>();

  const send = (ws: Socket, message: ServerMessage) => {
    ws.send(JSON.stringify(message));
  };

  function transport(ws: Socket, message: TransportMessage): ServerMessage[] {
    const self = ws.data.deviceId;
    switch (message.type) {
      case "devices":
        return [{ type: "devices", devices: devices.list(self) }];
      case "pair_code":
        return [{ type: "pair_code", ...devices.newCode() }];
      case "revoke_device": {
        const target = devices.list(null).find((d) => d.id === message.deviceId);
        if (!target || !devices.revoke(target.id)) return [{ type: "error", message: "That device is not paired." }];
        if (target.legacy) legacy.close();
        log(`revoked ${target.name}`);
        for (const socket of sockets.get(target.id) ?? []) socket.close(4001, "revoked");
        return [{ type: "devices", devices: devices.list(self) }];
      }
    }
  }

  async function pair(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("Use POST", { status: 405 });
    const body: unknown = await req.json().catch(() => null);
    const { code, name } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof code !== "string" || typeof name !== "string") return Response.json({ error: "Send {code, name} as JSON." }, { status: 400 });
    const result = devices.pair(code, name);
    if ("error" in result) return Response.json(result, { status: 401 });
    log(`paired ${devices.list(null).find((d) => d.id === result.deviceId)?.name}`);
    return Response.json(result);
  }

  const server: Server<SocketData> = Bun.serve<SocketData>({
    hostname: deps.hostname ?? "0.0.0.0",
    port: deps.port,
    maxRequestBodySize: 64 * 1024,
    async fetch(req, server) {
      if (rejectsOrigin(req)) return new Response("Forbidden", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname === "/pair") return pair(req);
      if (url.pathname === "/ws") {
        const deviceId = devices.authenticate(req);
        if (deviceId === null) return new Response("Unauthorized", { status: 401 });
        const epoch = url.searchParams.get("epoch");
        const resume = epoch ? { epoch, after: Number(url.searchParams.get("after") ?? NaN) } : null;
        if (server.upgrade(req, { data: { deviceId, resume } })) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const { deviceId, resume } = ws.data;
        const missed = resume ? stream.since(resume.epoch, resume.after) : null;
        // Hello, replay and subscribe in one tick, so no broadcast falls between them.
        send(ws, hub.hello(stream.position(missed !== null)));
        for (const frame of missed ?? []) ws.send(frame);
        ws.subscribe(TOPIC);
        sockets.set(deviceId, (sockets.get(deviceId) ?? new Set()).add(ws));
        devices.seen(deviceId);
      },
      close(ws) {
        sockets.get(ws.data.deviceId)?.delete(ws);
      },
      async message(ws, raw) {
        const parsed = parseClientMessage(String(raw));
        if (!parsed.ok) return send(ws, { type: "error", message: parsed.error });
        try {
          const replies = isTransport(parsed.message) ? transport(ws, parsed.message) : await hub.handle(parsed.message);
          for (const reply of replies) send(ws, reply);
        } catch (e) {
          send(ws, { type: "error", message: (e as Error).message });
        }
      },
    },
  });

  return {
    get port() {
      return server.port!;
    },
    publish: (message) => {
      server.publish(TOPIC, stream.append(message));
    },
    live: () => [...sockets.values()].reduce((n, set) => n + set.size, 0),
    stop: () => {
      server.stop(true);
    },
  };
}
