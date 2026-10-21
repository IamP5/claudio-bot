import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialHub, type Dialer } from "../src/machine/dial";
import { newIdentity, signWith, type Identity } from "../src/machine/identity";
import { fileJournal, type Journal } from "../src/machine/journal";
import { homeHears, homeOpens, machineHears, newNonce, type LinkState } from "../src/machine/link";
import { createLinks, type LinkSession, type Links } from "../src/machine/links";
import { profileOf } from "../src/machine/profile";
import { createRegistry, type Registry } from "../src/machine/registry";
import type { AgentRuntime } from "../src/machine/runtime";
import { newIntentId, profileView, type Event, type EventBody, type HomeFrame, type MachineId } from "../src/machine/wire";

const profile = (() => {
  const view = profileView(profileOf({ env: { CLAUDIOBOT_ACCESS: "full" }, platform: "linux", name: "omarchy", homedir: "/home/alex", username: "alex" }));
  return view;
})();

const dirs: string[] = [];
const servers: { stop(): void }[] = [];
const dialers: Dialer[] = [];
afterEach(() => {
  for (const d of dialers.splice(0)) d.stop();
  for (const s of servers.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "claudiobot-link-"));
  dirs.push(d);
  return d;
};

function enrolledPair() {
  const home = newIdentity("omarchy");
  const mac = newIdentity("MacBook");
  const machine: Identity & { home: NonNullable<Identity["home"]> } = {
    ...mac,
    home: { url: "http://127.0.0.1:1", machineId: home.machineId, publicKey: home.publicKey, name: home.name },
  };
  return { home, mac, machine };
}

const live = (s: { kind: string }) => s.kind;

test("the handshake goes live when each side proves the key the other pinned", () => {
  const { home, mac, machine } = enrolledPair();
  const pinned = (id: MachineId) => (id === mac.machineId ? { publicKey: mac.publicKey, ackedSeq: 3 } : null);
  const opened = homeOpens();
  const hello = machineHears({ kind: "connecting" }, opened.send, machine, () => ({ profile, lastSeq: 5 }));
  expect(hello.kind).toBe("hello");
  if (hello.kind !== "hello") return;
  const welcome = homeHears(opened.state, hello.send as never, home, pinned);
  expect(welcome).toMatchObject({ kind: "welcome", state: { kind: "live", peer: mac.machineId }, ackedSeq: 3 });
  if (welcome.kind !== "welcome") return;
  expect(machineHears(hello.state, welcome.send, machine, () => ({ profile, lastSeq: 5 }))).toEqual({ kind: "live", state: { kind: "live", peer: home.machineId }, ackedSeq: 3 });
});

test("the home refuses a machine that signs with another key than the one it enrolled, and one it never enrolled", () => {
  const { home, mac, machine } = enrolledPair();
  const opened = homeOpens();
  const forged = machineHears({ kind: "connecting" }, opened.send, { ...machine, privateKey: newIdentity("x").privateKey }, () => ({ profile, lastSeq: 0 }));
  if (forged.kind !== "hello") throw new Error("no hello");
  expect(homeHears(opened.state, forged.send as never, home, () => ({ publicKey: mac.publicKey, ackedSeq: 0 }))).toEqual({
    kind: "close",
    reason: `machine ${mac.machineId} did not prove its enrolled key`,
  });
  expect(homeHears(opened.state, forged.send as never, home, () => null)).toEqual({ kind: "close", reason: `machine ${mac.machineId} is not enrolled` });
});

test("the machine refuses a home that cannot prove the key it pinned at enrollment", () => {
  const { machine } = enrolledPair();
  const impostor = newIdentity("impostor");
  const hello = machineHears({ kind: "connecting" }, { t: "challenge", nonce: newNonce() }, machine, () => ({ profile, lastSeq: 0 }));
  if (hello.kind !== "hello") throw new Error("no hello");
  const proof = Buffer.concat([Buffer.from(hello.state.nonce, "hex"), Buffer.from(machine.machineId)]);
  const welcome: HomeFrame = { t: "welcome", sig: signWith(impostor.privateKey, proof), ackedSeq: 0 };
  expect(machineHears(hello.state, welcome, machine, () => ({ profile, lastSeq: 0 }))).toEqual({ kind: "close", reason: "the home did not prove its enrolled key" });
});

test.each([
  ["an intent before the handshake", { kind: "connecting" } as LinkState, { t: "intent", intent: { kind: "snapshot", intentId: "i_1" } } as HomeFrame],
  ["an ack while waiting for welcome", { kind: "challenged", nonce: "00".repeat(32) } as LinkState, { t: "ack", seq: 1 } as HomeFrame],
])("the machine closes the link on %s", (_, state, frame) => {
  const { machine } = enrolledPair();
  expect(machineHears(state, frame, machine, () => ({ profile, lastSeq: 0 })).kind).toBe("close");
});

test("a home that lost a machine's journal position replays the machine from its first event", () => {
  const { home, mac, machine } = enrolledPair();
  const opened = homeOpens();
  const hello = machineHears({ kind: "connecting" }, opened.send, machine, () => ({ profile, lastSeq: 2 }));
  if (hello.kind !== "hello") throw new Error("no hello");
  expect(homeHears(opened.state, hello.send as never, home, () => ({ publicKey: mac.publicKey, ackedSeq: 9 }))).toMatchObject({ kind: "welcome", ackedSeq: 0 });
});

// Over real sockets: a home serving /link, and a machine's runtime reduced to its journal.

type MiniRuntime = Pick<AgentRuntime, "apply" | "events" | "lastSeq" | "ack" | "subscribe"> & { emit(body: EventBody): void };

function miniRuntime(journal: Journal): MiniRuntime {
  const subs = new Set<(e: Event) => void>();
  const emit = (body: EventBody) => {
    const e = { seq: journal.seq() + 1, at: new Date().toISOString(), ...body } as Event;
    journal.append(e);
    for (const f of subs) f(e);
  };
  return {
    emit,
    async apply(intent) {
      if (intent.kind === "snapshot") emit({ kind: "snapshot", agents: [], openCards: [] });
      return { ok: true, reply: intent.kind };
    },
    events: (after) => journal.after(after),
    lastSeq: () => journal.seq(),
    ack: (seq) => journal.ack(seq),
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}

function homeServer(home: Identity, registry: Registry) {
  const log: string[] = [];
  const links: Links = createLinks({ identity: home, registry, log: (l) => log.push(l), now: () => new Date(), applyMs: 2000 });
  const seen: string[] = [];
  links.onEvent((id, e) => seen.push(`${id} ${e.seq} ${e.kind}`));
  const server = Bun.serve<{ session: LinkSession | null }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/link" && srv.upgrade(req, { data: { session: null } })) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.session = links.open({ send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) });
      },
      message: (ws, raw) => links.message(ws.data.session!, String(raw)),
      close: (ws) => links.closed(ws.data.session!),
    },
  });
  servers.push(server);
  return { links, log, seen, url: `http://127.0.0.1:${server.port}` };
}

const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

function machineAt(url: string, pair: ReturnType<typeof enrolledPair>, journalDir: string) {
  const runtime = miniRuntime(fileJournal(journalDir, () => {}));
  const log: string[] = [];
  const dialer = dialHub({
    identity: { ...pair.machine, home: { ...pair.machine.home, url } },
    runtime,
    profile,
    log: (l) => log.push(l),
    backoff: { firstMs: 20, maxMs: 40 },
  });
  dialers.push(dialer);
  return { runtime, dialer, log };
}

test("an enrolled machine comes online, answers an intent over the link, and goes offline when it stops", async () => {
  const pair = enrolledPair();
  const registry = createRegistry({ bridgeHome: tmp(), now: () => new Date() });
  registry.enroll({ id: pair.mac.machineId, name: "MacBook", publicKey: pair.mac.publicKey });
  const h = homeServer(pair.home, registry);
  let changes = 0;
  h.links.onChange(() => changes++);

  const m = machineAt(h.url, pair, tmp());
  await until("online", () => h.links.machines()[0]!.status().online);
  expect(live(m.dialer.state())).toBe("live");
  expect(h.links.machines()[0]!.profile()).toMatchObject({ platform: "linux", access: { full: true, sandbox: false } });

  // The home asks for a snapshot as the machine comes online, then this test asks for another.
  await until("the first snapshot", () => h.seen.length === 1);
  expect(await h.links.machines()[0]!.send({ kind: "snapshot", intentId: newIntentId() })).toEqual({ ok: true, reply: "snapshot" });
  await until("the second snapshot", () => h.seen.length === 2);
  expect(h.seen).toEqual([`${pair.mac.machineId} 1 snapshot`, `${pair.mac.machineId} 2 snapshot`]);
  await until("the ack saved", () => registry.get(pair.mac.machineId)!.ackedSeq === 2);

  m.dialer.stop();
  await until("offline", () => !h.links.machines()[0]!.status().online);
  expect(changes).toBe(2);
  expect(await h.links.machines()[0]!.send({ kind: "snapshot", intentId: newIntentId() })).toEqual({ ok: false, reason: "MacBook is offline" });
  expect(h.links.machines()[0]!.status().since).toBe(registry.get(pair.mac.machineId)!.lastSeenAt);
});

test("events emitted while the link is down, or sent and never acked before a kill, reach the home once after a restart", async () => {
  const pair = enrolledPair();
  const registry = createRegistry({ bridgeHome: tmp(), now: () => new Date() });
  registry.enroll({ id: pair.mac.machineId, name: "MacBook", publicKey: pair.mac.publicKey });
  const h = homeServer(pair.home, registry);
  const journal = tmp();

  const notes = () => h.seen.filter((x) => x.endsWith("note")).length;
  const note = (r: MiniRuntime, text: string) => r.emit({ kind: "note", agentId: "a1" as never, botId: "b1" as never, text });

  const first = machineAt(h.url, pair, journal);
  await until("online", () => h.links.machines()[0]!.status().online);
  note(first.runtime, "one");
  await until("note one acked", () => registry.get(pair.mac.machineId)!.ackedSeq === first.runtime.lastSeq());
  first.dialer.stop();
  await until("offline", () => !h.links.machines()[0]!.status().online);

  // Down: the machine keeps working and its events wait in its journal.
  note(first.runtime, "two");
  note(first.runtime, "three");

  const second = machineAt(h.url, pair, journal);
  await until("notes two and three", () => notes() === 3);
  note(second.runtime, "four");
  await until("note four", () => notes() === 4);
  // Gone before the home's ack reached it: its journal still holds note four. The new link starts after what the home
  // handled, so note four is not heard again.
  second.dialer.stop();
  machineAt(h.url, pair, journal);
  await until("the third link", () => h.log.filter((l) => l.includes("online, replaying after event")).length === 3);
  await until("the third snapshot", () => h.seen.filter((x) => x.endsWith("snapshot")).length === 3);
  await Bun.sleep(100);
  const seqs = h.seen.map((x) => Number(x.split(" ")[1]));
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  expect(h.seen.map((x) => x.split(" ")[2])).toEqual(["snapshot", "note", "note", "note", "snapshot", "note", "snapshot"]);
});

test("a second bridge with the same machine identity takes the link, and the first stops dialing instead of taking it back", async () => {
  const pair = enrolledPair();
  const registry = createRegistry({ bridgeHome: tmp(), now: () => new Date() });
  registry.enroll({ id: pair.mac.machineId, name: "MacBook", publicKey: pair.mac.publicKey });
  const h = homeServer(pair.home, registry);
  const first = machineAt(h.url, pair, tmp());
  await until("online", () => h.links.machines()[0]!.status().online);
  const second = machineAt(h.url, pair, tmp());
  await until("the first gave way", () => first.log.some((l) => l.includes("stops dialing")));
  await Bun.sleep(200);
  expect([first.dialer.state().kind, second.dialer.state().kind]).toEqual(["closed", "live"]);
  expect(h.log.filter((l) => l.includes("online, replaying"))).toHaveLength(2);
});

test("an event the home already handled, sent again on a live link, is dropped", () => {
  const pair = enrolledPair();
  const registry = createRegistry({ bridgeHome: tmp(), now: () => new Date() });
  registry.enroll({ id: pair.mac.machineId, name: "MacBook", publicKey: pair.mac.publicKey });
  const log: string[] = [];
  const links = createLinks({ identity: pair.home, registry, log: (l) => log.push(l), now: () => new Date() });
  const seen: number[] = [];
  links.onEvent((_, e) => seen.push(e.seq));
  const sent: string[] = [];
  const session = links.open({ send: (t) => sent.push(t), close: () => {} });
  const challenge = JSON.parse(sent[0]!) as HomeFrame;
  const hello = machineHears({ kind: "connecting" }, challenge, pair.machine, () => ({ profile, lastSeq: 2 }));
  if (hello.kind !== "hello") throw new Error("no hello");
  links.message(session, JSON.stringify(hello.send));
  const note = (seq: number) => JSON.stringify({ t: "event", event: { seq, at: new Date().toISOString(), kind: "note", agentId: "a1", botId: "b1", text: "x" } });
  for (const seq of [1, 2, 1, 2]) links.message(session, note(seq));
  expect(seen).toEqual([1, 2]);
  expect(log.filter((l) => l.includes("replayed, dropped"))).toHaveLength(2);
  links.closed(session);
});

test("a machine whose key does not match its enrollment is refused with a logged reason, and nothing it sends is heard", async () => {
  const pair = enrolledPair();
  const registry = createRegistry({ bridgeHome: tmp(), now: () => new Date() });
  registry.enroll({ id: pair.mac.machineId, name: "MacBook", publicKey: newIdentity("other").publicKey });
  const h = homeServer(pair.home, registry);
  const m = machineAt(h.url, pair, tmp());
  m.runtime.emit({ kind: "note", agentId: "a1" as never, botId: "b1" as never, text: "sneaky" });
  await until("refused", () => h.log.some((l) => l.includes("did not prove its enrolled key")));
  expect(h.links.machines()[0]!.status().online).toBe(false);
  expect(h.seen).toEqual([]);
  await until("the machine heard why", () => m.log.some((l) => l.includes("did not prove its enrolled key")));
});
