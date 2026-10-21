#!/usr/bin/env bun
// Runs a named UX scenario (scenarios.ts) against a throwaway bridge launched by control-claudio, records what the
// phone would see, and judges the scenario's rubric. With --sim it also leases a pool simulator (pool.ts), installs the
// app, pairs it with the run's bridge when someone taps Pair, and takes the scenario's screenshots.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, connect as tcp, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BASE, connect, frameLine, ownProject, slug, spent, type Frame, type Project, type Row, type Run } from "./control-claudio";
import * as pool from "./pool";
import { SCENARIOS, type Action, type Controls, type Drop, type Ev, type Item, type Resume, type Scenario, type Snap } from "./scenarios";

const CONTROL = join(import.meta.dir, "control-claudio.ts");
const args = process.argv.slice(2);
const cmd = args.shift() ?? "help";
const flag = (name: string, boolean = false) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  if (boolean) return args.splice(i, 1) && "true";
  return args.splice(i, 2)[1];
};
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
class PreconditionFailed extends Error {}

/** The run whose bridge is up, so every way out (the end, SIGINT, SIGTERM, a crash) stops it. */
let live: { id: string; out: string } | null = null;
function cleanupBridge() {
  if (!live) return null;
  const { id, out } = live;
  live = null;
  log(`cleaning up bridge run ${id}`);
  return sh(["bun", CONTROL, "cleanup", "--run", id], join(out, "cleanup.log")).out;
}
process.on("exit", cleanupBridge);
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.on(sig, () => process.exit(code));

/** seen: the order each item was first seen in. */
type Thread = { items: Map<string, Item>; seen: Map<string, number>; controls: Controls | null; epoch: string | null; rev: number };

/**
 * An item put where the app's ThreadModel puts it (the order bridge/src/threads.ts ordered() gives a snapshot): by
 * time, a message Claude Code has not taken yet after everything, and items at one time in the order first seen.
 */
function land(t: Thread, item: Item) {
  if (!t.seen.has(item.id)) t.seen.set(item.id, t.seen.size);
  const place = (i: Item) => `${i.kind === "user" && i.queued === true ? 1 : 0}${i.at}`;
  const before = (a: Item, b: Item) => place(a) < place(b) || (place(a) === place(b) && t.seen.get(a.id)! < t.seen.get(b.id)!);
  const old = t.items.get(item.id);
  if (old && place(old) === place(item)) return void t.items.set(item.id, item);
  const rest = [...t.items.values()].filter((i) => i.id !== item.id);
  let slot = rest.length;
  while (slot > 0 && before(item, rest[slot - 1]!)) slot--;
  rest.splice(slot, 0, item);
  t.items = new Map(rest.map((i) => [i.id, i]));
}

/**
 * One direction of a WebSocket connection, split after its HTTP upgrade into whole frames: each frame's bytes, and its
 * text when it is a single uncompressed text frame (unmasked when the client sent it).
 */
function wsFrames(onFrame: (raw: Buffer, text: string | null) => void) {
  let buf = Buffer.alloc(0);
  let upgraded = false;
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    // CFNetwork keeps the connection of POST /pair alive and upgrades it later, so plain HTTP may come first.
    while (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.subarray(0, end).toString("latin1");
      const size = end + 4 + Number(head.match(/^content-length:\s*(\d+)/im)?.[1] ?? 0);
      if (buf.length < size) return;
      onFrame(Buffer.from(buf.subarray(0, size)), null);
      buf = buf.subarray(size);
      upgraded = /^HTTP\/1\.1 101/.test(head) || (/^GET /.test(head) && /^upgrade:\s*websocket/im.test(head));
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = buf[1]! & 0x80 ? Buffer.from(buf.subarray(off, off + 4)) : null;
      if (mask) off += 4;
      if (buf.length < off + len) return;
      const raw = Buffer.from(buf.subarray(0, off + len));
      buf = buf.subarray(off + len);
      let text: string | null = null;
      if ((raw[0]! & 0xcf) === 0x81) {
        const body = Buffer.from(raw.subarray(off));
        if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
        text = body.toString("utf8");
      }
      onFrame(raw, text);
    }
  };
}

const parsed = (text: string | null): Frame | null => {
  try {
    return text === null ? null : (JSON.parse(text) as Frame);
  } catch {
    return null;
  }
};

type Tap = { lose(f: Frame): boolean; seen(dir: "in" | "out" | "lost", f: Frame): void };

/**
 * A TCP relay in front of the bridge. The phone and the app reach the bridge through it, so the runner can cut them off
 * the way a network does: `close` ends every connection and refuses new ones; `half-open` passes nothing either way
 * and closes nothing, so neither side hears a close, as when a phone loses signal or is suspended. With a tap, the
 * app's connection is read frame by frame, so one frame can be lost on its way to the app.
 */
class Relay {
  private server: Server | null = null;
  private live = new Set<{ down: Socket; up: Socket; dead: boolean }>();
  private silenced = new Set<{ down: Socket; up: Socket; dead: boolean }>();
  private cut: Drop | null = null;
  port = 0;
  tap: Tap | null = null;

  constructor(private bridgePort: number) {}

  async start() {
    this.server = createServer((down) => {
      if (this.cut === "close") return void down.destroy();
      const p = { down, up: tcp(this.bridgePort, "127.0.0.1"), dead: false };
      this.live.add(p);
      const end = () => {
        if (p.dead) return;
        this.live.delete(p);
        p.down.destroy();
        p.up.destroy();
      };
      for (const s of [p.down, p.up]) s.on("close", end).on("error", end);
      if (this.cut === "half-open") return this.silence(p);
      if (this.tap) return this.read(p, this.tap);
      p.down.pipe(p.up);
      p.up.pipe(p.down);
    });
    await new Promise<void>((ok) => this.server!.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as { port: number }).port;
  }

  drop(how: Drop) {
    this.cut = how;
    for (const p of this.live) how === "close" ? (p.down.destroy(), p.up.destroy()) : this.silence(p);
  }

  restore() {
    this.cut = null;
  }

  /** The app's connection (its upgrade comes from CFNetwork; the runner's phone is Bun) is read frame by frame; others pass as they are. */
  private read(p: { down: Socket; up: Socket; dead: boolean }, tap: Tap) {
    let app: boolean | null = null;
    const toApp = wsFrames((raw, text) => {
      const f = parsed(text);
      if (f && tap.lose(f)) return tap.seen("lost", f);
      if (f) tap.seen("in", f);
      p.down.write(raw);
    });
    const fromApp = wsFrames((_, text) => {
      const f = parsed(text);
      if (f) tap.seen("out", f);
    });
    p.down.on("data", (chunk: Buffer) => {
      if (!this.live.has(p)) return;
      app ??= /^user-agent:.*cfnetwork/im.test(chunk.toString("latin1"));
      p.up.write(chunk);
      if (app) fromApp(chunk);
    });
    p.up.on("data", (chunk: Buffer) => {
      if (!this.live.has(p)) return;
      if (app) toApp(chunk);
      else p.down.write(chunk);
    });
  }

  private silence(p: { down: Socket; up: Socket; dead: boolean }) {
    p.dead = true;
    this.live.delete(p);
    this.silenced.add(p);
    p.down.unpipe(p.up);
    p.up.unpipe(p.down);
    // Read and discard, so each kernel keeps acknowledging and no side sees an error or a close.
    for (const s of [p.down, p.up]) s.on("data", () => {}).resume();
  }

  close() {
    for (const p of [...this.live, ...this.silenced]) (p.down.destroy(), p.up.destroy());
    this.server?.close();
  }
}

/** The phone: one socket like the app's, a reducer over the scenario's own sessions, and the record of both. */
class Phone {
  c: Awaited<ReturnType<typeof connect>> | null = null;
  threads = new Map<string, Thread>();
  rows = new Map<string, Row>();
  names = new Map<string, string>();
  ownProjects = new Set<string>();
  demo: Project | null = null;
  decided = new Set<string>();
  /** Threads the user left: not watched until they return, so the bridge can count news as unread. */
  away = new Set<string>();
  onReply: ((sid: string, type: string) => void) | null = null;
  lastList: Row[] = [];
  /** The stream position the app keeps across reconnects: the bridge's epoch and the last broadcast seq. */
  cursor: { epoch: string; seq: number } | null = null;
  /** What the user sent while the phone was offline; the app sends it after the next hello. */
  outbox: Frame[] = [];
  /** Seconds the user takes to allow a card. */
  holdS = 0;
  private frameNo = 0;

  constructor(
    private run: Run,
    private ev: Ev,
    private out: string,
    private attended: boolean,
    private relay: Relay,
  ) {}

  private record(dir: "in" | "out" | "held", name: string, f: Frame) {
    const at = this.ev.now();
    appendFileSync(join(this.out, "timeline.jsonl"), JSON.stringify({ at, dir, name, frame: f }) + "\n");
    if (name !== "list" || dir !== "in") appendFileSync(join(this.out, "threads.txt"), `+${(at / 1000).toFixed(1)}s ${dir === "in" ? "<<" : dir === "out" ? ">>" : ">> (held offline)"} ${name} ${dir === "in" ? frameLine(f, true) : JSON.stringify(f)}\n`);
  }

  send(m: Frame) {
    const sid = m.sessionId as string | undefined;
    const name = sid && this.names.has(sid) ? this.names.get(sid)! : m.type === "session_create" ? String(m.ref) : null;
    if (!this.c) {
      if (m.type !== "session_send") throw new Error(`the phone is offline; cannot send ${m.type}`);
      this.outbox.push(m);
      if (name) this.record("held", name, m);
      return;
    }
    if (name) this.record("out", name, m);
    this.c.send(m);
  }

  private thread(sid: string) {
    let t = this.threads.get(sid);
    if (!t) this.threads.set(sid, (t = { items: new Map(), seen: new Map(), controls: null, epoch: null, rev: 0 }));
    return t;
  }

  private snap(sid: string) {
    const t = this.thread(sid);
    this.ev.history.push({ at: this.ev.now(), frame: this.frameNo, name: this.names.get(sid)!, row: this.rows.get(sid) ?? null, controls: t.controls, items: [...t.items.values()] });
  }

  private apply(f: Frame) {
    this.frameNo++;
    if (f.type === "hello") {
      if (!(f.resumed === true && f.epoch === this.cursor?.epoch)) this.cursor = { epoch: f.epoch as string, seq: f.seq as number };
      return;
    }
    if (typeof f.seq === "number" && this.cursor) this.cursor.seq = f.seq;
    if (f.type === "sessions" || f.type === "session_rows") {
      if (f.type === "sessions") for (const p of f.projects as Project[]) if (ownProject(this.run, p)) (this.ownProjects.add(p.id), p.name === "demo" && (this.demo = p));
      const mine = (f.rows as Row[]).filter((r) => this.ownProjects.has(r.projectId));
      if (f.type === "sessions") this.lastList = mine;
      const touched = new Set<string>();
      for (const r of mine) {
        if (!this.names.has(r.id)) continue;
        this.rows.set(r.id, r);
        touched.add(r.id);
      }
      if (mine.length || f.type === "sessions") this.record("in", "list", { ...f, rows: mine, projects: ((f.projects as Project[]) ?? []).filter((p) => this.ownProjects.has(p.id)) });
      for (const sid of touched) {
        this.ev.frameTimes.push({ at: this.ev.now(), name: this.names.get(sid)!, type: f.type });
        this.snap(sid);
      }
      return;
    }
    if (f.type === "session_created") {
      this.names.set(f.sessionId as string, String(f.ref));
      this.ev.ids[String(f.ref)] = f.sessionId as string;
      this.record("in", String(f.ref), f);
      return;
    }
    const sid = f.sessionId as string | undefined;
    if (!sid || !this.names.has(sid)) {
      if (f.type === "error") this.record("in", "error", f);
      return;
    }
    const name = this.names.get(sid)!;
    this.record("in", name, f);
    this.ev.frameTimes.push({ at: this.ev.now(), name, type: f.type });
    const t = this.thread(sid);
    if (f.type === "session") {
      t.items = new Map();
      t.seen = new Map();
      for (const i of f.items as Item[]) land(t, i);
      t.controls = f.controls as Controls;
      t.epoch = f.epoch as string;
      t.rev = f.rev as number;
    } else if (f.type === "session_items") {
      for (const i of f.items as Item[]) land(t, i);
      for (const id of f.removed as string[]) t.items.delete(id);
      if (f.controls) t.controls = f.controls as Controls;
      t.rev = f.rev as number;
    } else return;
    this.onReply?.(sid, f.type);
    this.snap(sid);
    // The user taps Allow once on every card the scenario's sessions raise, after holdS; each tap is in the timeline.
    for (const i of t.items.values())
      if (i.kind === "permission" && i.card && i.card.answer === null && !this.decided.has(i.card.id)) {
        const cardId = i.card.id;
        this.decided.add(cardId);
        const tap = () => this.c && this.send({ type: "session_decide", sessionId: sid, cardId, choice: "once" });
        if (this.holdS > 0) setTimeout(tap, this.holdS * 1000);
        else tap();
      }
  }

  /**
   * Connects through the relay as the app does: with resume, from the stream position it holds. Then the Sessions list,
   * `listed` (the list is in, no thread watched yet), each thread it had open, and what the user sent offline.
   */
  async open(resume: boolean, listed?: () => void) {
    const c = await connect(this.run, { port: this.relay.port, resume: resume && this.cursor ? { epoch: this.cursor.epoch, after: this.cursor.seq } : null });
    this.c = c;
    // Frames that came with the hello (a replay) arrived before this handler; the reducer takes them first.
    const early = c.frames.slice();
    const inner = c.ws.onmessage;
    c.ws.onmessage = (e) => {
      inner?.call(c.ws, e);
      this.apply(JSON.parse(String(e.data)) as Frame);
    };
    for (const f of early) this.apply(f);
    // With the simulator, the app is the phone the user looks at; this socket only watches, so it must not hold back pushes.
    if (!this.attended) c.send({ type: "presence", attended: false });
    const at = c.frames.length;
    c.send({ type: "watch_sessions" });
    await until(() => c.frames.slice(at).some((f) => f.type === "sessions"), "the sessions frame", 60);
    if (!this.demo) throw new Error("the run's demo project is not listed");
    listed?.();
    for (const [sid] of this.names) if (!this.away.has(sid)) this.watch(sid, resume);
    for (const m of this.outbox.splice(0)) this.send(m);
    const hello = early.find((f) => f.type === "hello")!;
    return { resumed: hello.resumed === true, replayed: early.filter((f) => typeof f.seq === "number").length };
  }

  watch(sid: string, resume: boolean) {
    const t = this.thread(sid);
    this.away.delete(sid);
    this.send({ type: "watch_session", sessionId: sid, after: resume && t.epoch ? { epoch: t.epoch, rev: t.rev } : null });
  }

  /** The app drops its socket: a clean close, or, after a half-open cut, a socket it gives up on without a word. */
  drop() {
    const c = this.c;
    this.c = null;
    if (!c) return;
    c.ws.onmessage = null;
    c.close();
  }

  async request(m: Frame, type: string, timeoutS = 10): Promise<Frame> {
    const c = this.c ?? die("offline");
    const at = c.frames.length;
    c.send(m);
    return until(() => c.frames.slice(at).find((f) => f.type === type), type, timeoutS);
  }
}

const die = (s: string): never => {
  throw new Error(s);
};

async function until<T>(find: () => T | undefined | null | false, what: string, seconds: number): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const v = find();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > deadline) throw new PreconditionFailed(`timed out after ${seconds}s waiting for ${what}`);
    await Bun.sleep(250);
  }
}

function sh(argv: string[], logFile?: string) {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: process.env });
  const out = p.stdout.toString() + p.stderr.toString();
  if (logFile) appendFileSync(logFile, out);
  return { ok: p.exitCode === 0, out, signal: p.signalCode };
}

const PROBE_SRC = join(import.meta.dir, "list-probe");

/**
 * Builds the list probe (list-probe/, an XCUITest that only reads the app's accessibility tree) once per source
 * digest into $CLAUDIOBOT_VERIFY_DIR/list-probe/<digest>, for any simulator. Concurrent runs wait on the first.
 */
async function buildListProbe(): Promise<string> {
  const files = ["project.yml", "Host/App.swift", "UITests/ListProbe.swift"];
  const digest = new Bun.CryptoHasher("sha256").update(files.map((f) => readFileSync(join(PROBE_SRC, f), "utf8")).join("\0")).digest("hex").slice(0, 16);
  const dir = join(BASE, "list-probe", digest);
  const done = join(dir, "built");
  if (!existsSync(done) && !existsSync(`${dir}.lock`)) {
    mkdirSync(`${dir}.lock`, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const gen = sh(["xcodegen", "generate", "--quiet", "--spec", join(PROBE_SRC, "project.yml"), "--project", dir], join(dir, "build.log"));
    const built = gen.ok && sh(["xcodebuild", "-project", join(dir, "ListProbe.xcodeproj"), "-scheme", "UITests", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", join(dir, "dd"), "build-for-testing"], join(dir, "build.log")).ok;
    if (built) writeFileSync(done, digest);
    sh(["rmdir", `${dir}.lock`]);
    if (!built) throw new Error(`the list probe did not build; see ${join(dir, "build.log")}`);
  }
  await until(() => existsSync(done) || !existsSync(`${dir}.lock`), "the list probe build", 600);
  if (!existsSync(done)) throw new Error(`the list probe did not build; see ${join(dir, "build.log")}`);
  return dir;
}

type Outcome = "judged" | "precondition-failed" | "error";
/** simctl ui settings for a leased device during a run: Dynamic Type and appearance. Reset to large and light at the end. */
type Ui = { contentSize?: string; appearance?: string };

async function runScenario(sc: Scenario, sim: boolean, pairWaitS: number, ui: Ui): Promise<Outcome> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const out = resolve(flag("out") ?? join(BASE, "scenarios", sc.id, `${stamp}${sim ? "-sim" : ""}`));
  mkdirSync(join(out, "screenshots"), { recursive: true });
  log(`scenario ${sc.id} "${sc.title}" lane ${sim ? "simulator" : "protocol"}; evidence ${out}`);
  const report: Record<string, unknown> = { scenario: sc.id, title: sc.title, lane: sim ? "simulator" : "protocol", evidence: out, startedAt: new Date().toISOString() };
  const shots: Record<string, string> = {};
  const skipped: string[] = [];
  const t0 = Date.now();
  let run: Run | null = null;
  let lease: pool.Lease | null = null;
  let held: ReturnType<typeof pool.holdForProcess> | null = null;
  let outcome: Outcome = "judged";
  let failure: string | null = null;
  const ev: Ev = {
    now: () => Date.now() - t0,
    marks: {} as Record<string, number>,
    history: [] as Snap[],
    frameTimes: [] as Ev["frameTimes"],
    ids: {} as Record<string, string>,
    resumes: [] as Resume[],
    sim,
    paired: false,
    transcript: (name: string) => {
      const dir = phone?.demo ? join(homedir(), ".claude", "projects", slug(phone.demo.path)) : "";
      const sid = ev.ids[name];
      const parse = (file: string) =>
        existsSync(file)
          ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
              try {
                return [JSON.parse(l)];
              } catch {
                return [];
              }
            })
          : [];
      if (!sid || !dir) return { main: [], subagents: [] };
      const subDir = join(dir, sid, "subagents");
      const subs = existsSync(subDir) ? readdirSync(subDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) => parse(join(subDir, n))) : [];
      return { main: parse(join(dir, `${sid}.jsonl`)), subagents: subs };
    },
    exists: (rel: string) => !!phone?.demo && existsSync(join(phone.demo.path, rel)),
    pushes: () => (run && existsSync(join(run.dir, "pushes.jsonl")) ? readFileSync(join(run.dir, "pushes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    atOf: (iso: string) => Date.parse(iso) - t0,
    procs: (pattern: string) => {
      const root = phone?.demo?.path;
      if (!root) return [];
      const pids = sh(["pgrep", "-f", pattern]).out.split("\n").filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
      return pids.flatMap((pid) => {
        const cwd = sh(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "";
        return cwd === root || cwd.startsWith(`${root}/`) ? [`${pid} ${sh(["ps", "-p", String(pid), "-o", "command="]).out.trim()}`] : [];
      });
    },
    samples: {},
    app: [],
    list: [],
  };
  const probe: { run: { proc: ReturnType<typeof Bun.spawn>; file: string } | null } = { run: null };
  let phone: Phone | null = null;
  let relay: Relay | null = null;
  let losing: ((f: Frame) => boolean) | null = null;
  let app: pool.Build | null = null;
  const markNow = (m: string) => {
    ev.marks[m] = ev.now();
    log(`mark ${m} at +${(ev.marks[m]! / 1000).toFixed(1)}s`);
  };

  try {
    if (sc.needsSimulator && !sim) throw new PreconditionFailed(`${sc.id} needs the simulator: run it with --sim`);
    app = sim ? await pool.buildApp() : null;
    if (sim) {
      lease = await pool.acquire(`scenario ${sc.id} pid ${process.pid}`);
      const l = lease;
      // simctl ui settings survive a shutdown, so every way out (end, signal, crash) puts them back before release.
      held = pool.holdForProcess(l, undefined, () => {
        if (!ui.contentSize && !ui.appearance) return;
        pool.simctl(l, "ui", "content_size", "large");
        pool.simctl(l, "ui", "appearance", "light");
        log(`ui reset on ${l.device}: content_size ${pool.simctl(l, "ui", "content_size").out}, appearance ${pool.simctl(l, "ui", "appearance").out}`);
      });
      report.device = lease.device;
      pool.boot(lease);
      if (ui.contentSize) pool.simctl(lease, "ui", "content_size", ui.contentSize);
      if (ui.appearance) pool.simctl(lease, "ui", "appearance", ui.appearance);
      if (ui.contentSize || ui.appearance) report.ui = ui;
    }
    const launched = sh(["bun", CONTROL, "launch", "--model", "haiku"], join(out, "launch.log"));
    const started = launched.out.match(/STARTED run=(\S+)/)?.[1];
    if (started) live = { id: started, out };
    // Ctrl-C reaches launch too; the runner's own handler would only run after this scenario is judged.
    if (launched.signal === "SIGINT" || launched.signal === "SIGTERM") {
      log(`interrupted during launch (${launched.signal})`);
      process.exit(launched.signal === "SIGINT" ? 130 : 143);
    }
    const runId = launched.out.match(/READY run=(\S+)/)?.[1];
    if (!launched.ok || !runId) throw new Error(`launch failed; see ${join(out, "launch.log")}`);
    run = JSON.parse(readFileSync(join(BASE, "runs", runId, "run.json"), "utf8")) as Run;
    report.run = runId;
    report.build = run.rev;
    relay = new Relay(run.port);
    if (sim && sc.tapApp)
      relay.tap = {
        lose: (f) => losing?.(f) ?? false,
        seen(dir, f) {
          const sid = f.sessionId as string | undefined;
          if (!sid || f.type === "session_delta" || !Object.values(ev.ids).includes(sid)) return;
          const at = ev.now();
          ev.app.push({ at, dir, frame: f });
          appendFileSync(join(out, "timeline.jsonl"), JSON.stringify({ at, dir: `app-${dir}`, name: "app", frame: f }) + "\n");
        },
      };
    await relay.start();
    log(`bridge run ${runId} on :${run.port}; the phone${sim ? " and the app" : ""} reach it through the relay on :${relay.port}`);
    phone = new Phone(run, ev, out, !sim, relay);
    phone.holdS = sc.holdCardsS ?? 0;
    await phone.open(false);

    if (sim && lease && app) {
      report.app = { stamp: app.stamp, bundle: pool.installAndLaunch(lease, app) };
      await Bun.sleep(3000);
      const before = ((await phone.request({ type: "devices" }, "devices")).devices as unknown[]).length;
      const offer = await phone.request({ type: "pair_code" }, "pair_code");
      const link = `claudiobot://pair?url=${encodeURIComponent(`ws://127.0.0.1:${relay.port}/ws`)}&code=${offer.code}`;
      pool.simctl(lease, "openurl", link);
      await Bun.sleep(3000);
      shots["pair-link"] = pool.screenshot(lease, join(out, "screenshots", "pair-link.png"));
      log(`waiting up to ${pairWaitS}s for ${lease.device} to pair (-pairingAutoConfirm confirms the link)`);
      const deadline = Date.now() + pairWaitS * 1000;
      while (Date.now() < deadline && !ev.paired) {
        ev.paired = ((await phone.request({ type: "devices" }, "devices")).devices as unknown[]).length > before;
        if (!ev.paired) await Bun.sleep(2000);
      }
      log(ev.paired ? "the app paired with the run's bridge" : "the app did not pair; simulator items will show the unpaired app");
      await Bun.sleep(2000);
      shots.paired = pool.screenshot(lease, join(out, "screenshots", "after-pairing.png"));
    }

    for (const a of sc.setup) await perform(a);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    outcome = e instanceof PreconditionFailed ? "precondition-failed" : "error";
    log(`${outcome}: ${failure}`);
    if (!(e instanceof PreconditionFailed)) console.error(e);
  }
  const watched = probe.run;
  if (watched) {
    watched.proc.kill("SIGTERM");
    await watched.proc.exited;
    if (lease) pool.simctl(lease, "terminate", "dev.claudiobot.listprobe.UITests.xctrunner");
    const lines = existsSync(watched.file) ? readFileSync(watched.file, "utf8").split("\n").filter(Boolean) : [];
    ev.list = lines.flatMap((l) => {
      try {
        const x = JSON.parse(l) as { t: number; rows: string[]; more: string[] };
        return [{ at: x.t - t0, rows: x.rows, more: x.more }];
      } catch {
        return [];
      }
    });
    log(`list probe stopped: ${ev.list.length} samples`);
  }

  async function perform(a: Action) {
    const p = phone!;
    switch (a.do) {
      case "create": {
        p.send({ type: "session_create", ref: a.name, projectId: p.demo!.id, model: "haiku", mode: a.mode ?? "default", isolate: "none", text: a.prompt });
        const sid = await until(() => ev.ids[a.name], `session_created for ${a.name}`, 30);
        p.watch(sid, false);
        return;
      }
      case "send":
        p.send({ type: "session_send", sessionId: ev.ids[a.name]!, text: a.text, clientId: `runner-${crypto.randomUUID()}`, interrupt: a.interrupt ?? false });
        if (a.mark) markNow(a.mark);
        return;
      case "until":
        try {
          await until(() => a.test(ev), a.what, a.timeoutS);
          markNow(a.mark);
        } catch (e) {
          if (!a.optional) throw e;
          log(`optional mark ${a.mark} not reached: ${(e as Error).message}`);
        }
        return;
      case "mark":
        return markNow(a.mark);
      case "sleep":
        return Bun.sleep(a.s * 1000);
      case "stop":
        p.send({ type: "session_stop", sessionId: ev.ids[a.name]! });
        return markNow(a.mark);
      case "leave":
        p.send({ type: "unwatch_session", sessionId: ev.ids[a.name]! });
        p.away.add(ev.ids[a.name]!);
        return;
      case "return":
        return p.watch(ev.ids[a.name]!, true);
      case "reconnect": {
        const how = a.how ?? "close";
        relay!.drop(how);
        // A closed socket is noticed at once; a half-open one looks alive, so a send goes into it and is lost.
        if (how === "close") p.drop();
        markNow(`${a.mark}-dropped`);
        if (a.send) p.send({ type: "session_send", sessionId: ev.ids[a.send.name]!, text: a.send.text, clientId: `runner-${crypto.randomUUID()}`, interrupt: false });
        if (a.until) await until(() => a.until!.test(ev), a.until.what, a.until.timeoutS);
        await Bun.sleep(a.afterS * 1000);
        relay!.restore();
        p.drop();
        const replies = new Map<string, string>();
        const stream = await p.open(true, () => (p.onReply = (sid, type) => replies.has(sid) || replies.set(sid, type)));
        log(`reconnected after a ${how} drop: hello resumed ${stream.resumed}, ${stream.replayed} frames replayed`);
        await until(() => replies.size === p.names.size - p.away.size, "a resume reply for every watched thread", 30);
        p.onReply = null;
        await Bun.sleep(1500);
        markNow(a.mark);
        if (a.compare === false) return;
        for (const [sid, name] of p.names) {
          if (p.away.has(sid)) continue;
          const fresh = await connect(run!);
          const at = fresh.frames.length;
          fresh.send({ type: "watch_session", sessionId: sid, after: null });
          const snap = await until(() => fresh.frames.slice(at).find((f) => f.type === "session" && f.sessionId === sid), `a fresh snapshot of ${name}`, 30);
          fresh.close();
          const t = p.threads.get(sid)!;
          ev.resumes.push({ mark: a.mark, how, ...stream, reply: replies.get(sid)!, items: [...t.items.values()], fresh: snap.items as Item[], resumedControls: t.controls, rows: p.lastList });
          log(`${name} resumed with ${replies.get(sid)}: ${t.items.size} items; a fresh open has ${(snap.items as Item[]).length}`);
        }
        return;
      }
      case "screenshot":
        if (!lease) return void skipped.push(`screenshot ${a.shot}`);
        shots[a.shot] = pool.screenshot(lease, join(out, "screenshots", `${a.shot}.png`));
        log(`screenshot ${a.shot}`);
        return;
      case "open-thread": {
        const sid = ev.ids[a.name]!;
        if (!lease) return void (p.away.has(sid) && p.watch(sid, true));
        pool.simctl(lease, "openurl", `claudiobot://session/${sid}`);
        return Bun.sleep(3000);
      }
      case "show-list":
        if (!lease || !app) return;
        // The app has no link to the list; relaunched with -sidebarMode sessions it opens there and unwatches the thread.
        pool.installAndLaunch(lease, app);
        return Bun.sleep(4000);
      case "app":
        if (lease) pool.simctl(lease, "launch", a.to === "background" ? "com.apple.Preferences" : pool.BUNDLE);
        else if (a.to === "background") relay!.drop("half-open");
        else {
          relay!.restore();
          p.drop();
          await p.open(true, () => markNow(`${a.mark}-list`));
        }
        return markNow(a.mark);
      case "ps":
        ev.samples[a.as] = ev.procs(a.pattern);
        log(`ps ${a.as}: ${ev.samples[a.as]!.join(" | ") || "none"}`);
        return;
      case "kill-claude": {
        const sid = ev.ids[a.name]!;
        const found = sh(["pgrep", "-P", String(run!.bridgePid), "-f", sid]).out.split("\n").filter(Boolean).map(Number);
        const lines = found.map((pid) => `${pid} ${sh(["ps", "-p", String(pid), "-o", "command="]).out.trim()}`).filter((l) => /(^|\/)claude$/.test(l.split(" ")[1] ?? ""));
        if (!lines.length) throw new PreconditionFailed(`no Claude Code process names session ${sid}`);
        for (const l of lines) process.kill(Number(l.split(" ")[0]), "SIGKILL");
        ev.samples["kill-claude"] = lines;
        log(`SIGKILL ${lines.join(" | ").slice(0, 200)}`);
        return markNow(a.mark);
      }
      case "lose-frame": {
        if (!relay?.tap) throw new PreconditionFailed("lose-frame needs --sim and a scenario that taps the app's socket");
        const sid = ev.ids[a.name]!;
        let gone = false;
        losing = (f) => !gone && f.sessionId === sid && a.test(f) && (gone = true);
        await until(() => gone, a.what, a.timeoutS);
        losing = null;
        return markNow(a.mark);
      }
      case "watch-list": {
        if (!lease || !p.demo) return void skipped.push("watch-list");
        const dir = await buildListProbe();
        const file = join(out, "app-list.jsonl");
        probe.run = {
          file,
          proc: Bun.spawn(
            ["xcodebuild", "-project", join(dir, "ListProbe.xcodeproj"), "-scheme", "UITests", "-destination", `platform=iOS Simulator,id=${lease.udid}`, "-derivedDataPath", join(dir, "dd"), "test-without-building", "-only-testing:UITests/ListProbe/testWatch"],
            { env: { ...process.env, TEST_RUNNER_OUT: file, TEST_RUNNER_PREFIX: p.demo.name, TEST_RUNNER_SECONDS: "900" }, stdout: Bun.file(join(out, "list-probe.log")), stderr: "pipe" },
          ),
        };
        await until(() => existsSync(file) && readFileSync(file, "utf8").includes("\n"), "the list probe's first sample", 120);
        log("list probe reading the app's Sessions list");
        return;
      }
      case "restart-bridge": {
        p.drop();
        const r = sh(["bun", CONTROL, "restart", "--run", run!.id], join(out, "restart.log"));
        if (!r.ok) throw new Error(`bridge restart failed; see ${join(out, "restart.log")}`);
        run = JSON.parse(readFileSync(join(run!.dir, "run.json"), "utf8")) as Run;
        await p.open(true);
        return markNow(a.mark);
      }
    }
  }

  // Judge, then keep what the cleanup deletes.
  if (outcome !== "error") Object.assign(ev.marks, safeMarks(() => sc.derive?.(ev) ?? {}));
  const pre = failure && outcome === "error" ? [] : sc.pre.map((p) => ({ what: p.what, ...safe(() => p.check(ev)) }));
  if (outcome === "judged" && pre.some((p) => !p.ok)) outcome = "precondition-failed";
  const rubric = sc.rubric.map((r) => {
    if (outcome !== "judged") return { id: r.id, lane: r.lane, tell: r.tell, verdict: "not-judged", why: "the precondition failed" };
    if (r.lane === "simulator" && !sim) return { id: r.id, lane: r.lane, tell: r.tell, verdict: "skipped", why: "simulator item; protocol lane" };
    if (r.check) {
      const v = safe(() => r.check!(ev));
      return { id: r.id, lane: r.lane, tell: r.tell, verdict: v.ok ? "pass" : v.why.startsWith("not judged") ? "not-judged" : "fail", why: v.why };
    }
    const have = (r.shots ?? []).filter((s) => shots[s]);
    return {
      id: r.id,
      lane: r.lane,
      tell: r.tell,
      verdict: !sim ? "skipped" : have.length ? "review" : "not-judged",
      why: !sim ? "simulator item; protocol lane" : have.length ? `judge from ${have.map((s) => `screenshots/${s}.png`).join(", ")}${ev.paired ? "" : " (the app was not paired)"}` : "no screenshot taken",
    };
  });
  Object.assign(report, {
    outcome,
    failure,
    durationS: Math.round(ev.now() / 1000),
    spentUsd: run ? Number(spent(run).toFixed(4)) : 0,
    paired: ev.paired,
    sessions: ev.ids,
    marks: Object.fromEntries(Object.entries(ev.marks).map(([k, v]) => [k, Math.round(v / 100) / 10])),
    preconditions: pre,
    rubric,
    skipped,
    processes: ev.samples,
    screenshots: Object.fromEntries(Object.entries(shots).map(([k, v]) => [k, v.replace(`${out}/`, "")])),
  });
  if (phone?.demo) {
    const dir = join(homedir(), ".claude", "projects", slug(phone.demo.path));
    if (existsSync(dir)) cpSync(dir, join(out, "transcripts"), { recursive: true });
  }
  phone?.drop();
  relay?.close();
  report.bridgeEvidence = cleanupBridge()?.match(/evidence kept at (\S+?):/)?.[1] ?? null;
  held?.release("scenario done");
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), reportMarkdown(sc, report));
  console.log(readFileSync(join(out, "report.md"), "utf8"));
  return outcome;
}

function safeMarks(f: () => Record<string, number>) {
  try {
    return f();
  } catch (e) {
    log(`derive failed: ${(e as Error).message}`);
    return {};
  }
}

function safe(f: () => { ok: boolean; why: string }) {
  try {
    return f();
  } catch (e) {
    return { ok: false, why: `check threw: ${(e as Error).message}` };
  }
}

function reportMarkdown(sc: Scenario, r: Record<string, unknown>) {
  const pre = r.preconditions as { what: string; ok: boolean; why: string }[];
  const rubric = r.rubric as { id: string; lane: string; tell: string; verdict: string; why: string }[];
  const count = (v: string) => rubric.filter((x) => x.verdict === v).length;
  return [
    `# ${sc.id} ${sc.title}`,
    "",
    `outcome **${r.outcome}**${r.failure ? ` (${r.failure})` : ""}; lane ${r.lane}${r.device ? ` on ${r.device}` : ""}${r.app ? ` app ${(r.app as { stamp: string }).stamp}` : ""}; run ${r.run ?? "-"} build ${String(r.build ?? "").slice(0, 10)}; ${r.durationS} s; $${r.spentUsd}`,
    `rubric: ${count("pass")} pass, ${count("fail")} fail, ${count("review")} review, ${count("not-judged")} not judged, ${count("skipped")} skipped`,
    "",
    "## Preconditions",
    ...pre.map((p) => `- ${p.ok ? "ok" : "FAILED"}: ${p.what} (${p.why})`),
    "",
    "## Rubric",
    "| id | lane | tells | verdict | why |",
    "| --- | --- | --- | --- | --- |",
    ...rubric.map((x) => `| ${x.id} | ${x.lane} | ${x.tell} | ${x.verdict} | ${x.why.replace(/\|/g, "/")} |`),
    "",
    `marks (s): ${JSON.stringify(r.marks)}`,
    "",
    ...Object.entries(r.processes as Record<string, string[]>).map(([k, v]) => `processes ${k}: ${v.join(" | ") || "none"}`),
    "",
  ].join("\n");
}

/** The rubric document for an area, generated from the registry so the doc and the checks never drift. */
function doc(area: string) {
  const lines = [
    `# ${area[0]!.toUpperCase()}${area.slice(1)} scenarios`,
    "",
    `Generated by \`.claude/skills/verify-claudio-bot/bin/scenario.ts doc ${area}\` from \`bin/scenarios.ts\`; edit the registry, then regenerate. Each scenario answers, for one situation, whether the user can tell **what** is running, **how many**, **how long**, its **state** (done, failed, stuck) and how to **stop** it.`,
    "",
    "Lanes: a `protocol` item is judged mechanically from the frames the phone receives (and the run's transcripts, files and pushes as independent views); a `simulator` item is judged by a person or agent from the named screenshots, taken with `--sim`. Every session turn runs on haiku; each permission card the scenario raises is answered Allow once, as the user would, and the timeline records the tap. A scenario whose preconditions fail is reported failed and its rubric is not judged; it never falls back to an easier path.",
    "",
  ];
  for (const sc of SCENARIOS.filter((s) => s.area === area)) {
    lines.push(`## ${sc.id} ${sc.title}`, "", `Needs the simulator: ${sc.needsSimulator ? "yes" : "no (simulator items run with `--sim`)"}.`, "", "**User journey.**", "", ...sc.journey.map((j, i) => `${i + 1}. ${j}`), "", "**Setup.**", "");
    for (const a of sc.setup) lines.push(`- ${describe(a)}`);
    lines.push("", "**Preconditions** (any failure fails the scenario):", "", ...sc.pre.map((p) => `- ${p.what}`), "", "**Rubric.**", "", "| id | tells | lane | the user can tell | pass | fail |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of sc.rubric) lines.push(`| ${r.id} | ${r.tell} | ${r.lane}${r.lane === "simulator" ? ` (${r.check ? "list probe" : (r.shots ?? []).join(", ")})` : ""} | ${r.text} | ${r.pass} | ${r.fail} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function describe(a: Action): string {
  switch (a.do) {
    case "create":
      return `New session \`${a.name}\` in demo (haiku, mode ${a.mode ?? "default"}): "${a.prompt.replace(/\n/g, " ")}"`;
    case "send":
      return `Send in \`${a.name}\`${a.interrupt ? " with Stop and send (interrupt)" : ""}: "${a.text.replace(/\n/g, " ")}"${a.mark ? `; mark \`${a.mark}\`` : ""}.`;
    case "until":
      return `Wait up to ${a.timeoutS} s for ${a.what}; mark \`${a.mark}\`${a.optional ? " (optional)" : ""}.`;
    case "stop":
      return `Press Stop on \`${a.name}\` (session_stop); mark \`${a.mark}\`.`;
    case "sleep":
      return `Wait ${a.s} s.`;
    case "mark":
      return `Mark \`${a.mark}\`.`;
    case "leave":
      return `Leave \`${a.name}\`'s thread for the list (unwatch_session; the bridge counts it as a visit, and a watched thread is never unread).`;
    case "return":
      return `Reopen \`${a.name}\`'s thread from the position the phone held (watch_session with after).`;
    case "reconnect":
      return `The network drops the phone${a.how === "half-open" ? " half-open (nothing passes, no close on either side)" : " (the socket closes)"}${a.send ? `; the user sends in \`${a.send.name}\` meanwhile: "${a.send.text.replace(/\n/g, " ")}"` : ""}${a.until ? `; wait for ${a.until.what}` : ""}; wait ${a.afterS} s, reconnect with the stream position (epoch, after) and resume each thread from its last position${a.compare === false ? "" : "; compare each with a fresh open"}. Mark \`${a.mark}\`.`;
    case "screenshot":
      return `Screenshot \`${a.shot}\` (simulator lane).`;
    case "open-thread":
      return `Open \`${a.name}\`'s thread: in the app by claudiobot://session/<id> (simulator lane), or watch it again if the phone had left it (protocol lane).`;
    case "show-list":
      return "The app goes back to the Sessions list (simulator lane: relaunched on the list).";
    case "app":
      return `Send the app to the ${a.to}${a.to === "background" ? " (simulator: Settings over it; protocol: the socket goes half-open)" : " (simulator: launch it again; protocol: reconnect and resume, mark `" + a.mark + "-list` when the list arrives)"}; mark \`${a.mark}\`.`;
    case "ps":
      return `Sample the Mac's processes matching \`${a.pattern}\` in the seed project as \`${a.as}\`.`;
    case "kill-claude":
      return `SIGKILL the Claude Code process of \`${a.name}\`; mark \`${a.mark}\`.`;
    case "restart-bridge":
      return `Restart the bridge on the same port and home; the phone reconnects. Mark \`${a.mark}\`.`;
    case "lose-frame":
      return `The relay loses ${a.what} on its way to the app (simulator lane), within ${a.timeoutS} s. Mark \`${a.mark}\`.`;
    case "watch-list":
      return "The list probe (an XCUITest that only reads the accessibility tree) reads the app's Sessions list about once a second until the setup ends (simulator lane).";
  }
}

async function main() {
  switch (cmd) {
    case "list":
      for (const s of SCENARIOS) console.log(`${s.id} ${s.area} ${s.needsSimulator ? "sim " : "proto"} ${s.title} (${s.rubric.length} rubric items)`);
      return 0;
    case "doc":
      console.log(doc(args[0] ?? "sessions"));
      return 0;
    case "run": {
      const sim = flag("sim", true) === "true";
      const pairWaitS = Number(flag("pair-wait") ?? 120);
      const ui: Ui = { contentSize: flag("content-size"), appearance: flag("appearance") };
      if ((ui.contentSize || ui.appearance) && !sim) die("--content-size and --appearance need --sim");
      const ids = (args[0] ?? die("usage: run <id>[,<id>…] [--sim] [--pair-wait s] [--content-size size] [--appearance dark|light] [--out dir]")).split(",");
      const scs = ids.map((id) => SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase()) ?? die(`no scenario ${id}`));
      const outcomes: Outcome[] = [];
      for (const sc of scs) outcomes.push(await runScenario(sc, sim, pairWaitS, ui));
      return outcomes.includes("error") ? 1 : outcomes.includes("precondition-failed") ? 2 : 0;
    }
    case "pool":
      if (args[0] === "ensure") pool.ensurePool();
      for (const d of pool.poolStatus()) console.log(`${d.name} ${d.udid ?? "-"} ${d.state} ${d.runtime ?? ""}`);
      return 0;
    case "lease": {
      const sub = args.shift();
      if (sub === "status") {
        for (const l of pool.leaseStatus())
          console.log(`${l.name} ${l.state} ${l.owner ? `leased by "${l.owner.label}" pid ${l.owner.pid} since ${l.owner.acquiredAt}, heartbeat ${l.heartbeatAgeS}s ago${l.stale ? " STALE" : ""}` : "free"}`);
        return 0;
      }
      if (sub === "acquire") {
        const label = flag("label") ?? `cli pid ${process.ppid}`;
        const bootIt = flag("boot", true) === "true";
        const lease = await pool.acquire(label, Number(flag("wait") ?? 3600));
        if (bootIt) pool.boot(lease);
        console.log(`LEASED device=${lease.device} udid=${lease.udid} token=${lease.owner.token}`);
        console.log(`keep it: scenario.ts lease heartbeat ${lease.device} --token ${lease.owner.token} (at least every ${pool.STALE_MS / 60_000} min)`);
        return 0;
      }
      const device = args[0] ?? die(`usage: lease ${sub} <device> --token <token>`);
      const token = flag("token") ?? die("--token is required");
      const lease = pool.held(device, token) ?? die(`${device} is not leased with that token`);
      if (sub === "heartbeat") return pool.heartbeat(lease) ? (console.log(`heartbeat ${device}`), 0) : 1;
      if (sub === "boot") return pool.boot(lease), 0;
      if (sub === "release") return pool.release(lease), 0;
      return die(`unknown lease command ${sub}`);
    }
    case "sim-build": {
      const b = await pool.buildApp();
      console.log(`${b.app} stamp ${b.stamp}`);
      return 0;
    }
    case "sim-job": {
      // A dummy simulator job: lease, boot, screenshot, hold, release. Proves the pool's limits under contention.
      const label = flag("label") ?? `job ${process.pid}`;
      const hold = Number(flag("hold") ?? 60);
      const lease = await pool.acquire(label);
      const h = pool.holdForProcess(lease);
      pool.boot(lease);
      const dir = join(BASE, "sim-jobs");
      mkdirSync(dir, { recursive: true });
      log(`${label} screenshot ${pool.screenshot(lease, join(dir, `${label.replace(/\W+/g, "-")}.png`))}`);
      await Bun.sleep(hold * 1000);
      h.release(`${label} done`);
      return 0;
    }
    default:
      console.log(`scenario.ts list | doc <area> | run <id>[,<id>…] [--sim] [--pair-wait s] [--content-size size] [--appearance dark|light] [--out dir]
  pool ensure|status | lease acquire [--label L] [--wait s] [--boot] | lease heartbeat|boot|release <device> --token T | lease status
  sim-build | sim-job [--label L] [--hold s]
See ../runner.md (docs/ux-program/runner.md).`);
      return 0;
  }
}

process.exit(
  await main().catch((e: Error) => {
    console.error(`error: ${e.message}`);
    return 1;
  }),
);
