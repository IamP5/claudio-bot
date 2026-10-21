#!/usr/bin/env bun
// Runs a named UX scenario (scenarios.ts) against a throwaway bridge launched by control-claudio, records what the
// phone would see, and judges the scenario's rubric. With --sim it also leases a pool simulator (pool.ts), installs the
// app, pairs it with the run's bridge when someone taps Pair, and takes the scenario's screenshots.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BASE, connect, frameLine, ownProject, slug, spent, type Frame, type Project, type Row, type Run } from "./control-claudio";
import * as pool from "./pool";
import { SCENARIOS, type Action, type Controls, type Ev, type Item, type Resume, type Scenario, type Snap } from "./scenarios";

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

type Thread = { items: Map<string, Item>; controls: Controls | null; epoch: string | null; rev: number };

/** The phone: one socket like the app's, a reducer over the scenario's own sessions, and the record of both. */
class Phone {
  c: Awaited<ReturnType<typeof connect>> | null = null;
  threads = new Map<string, Thread>();
  rows = new Map<string, Row>();
  names = new Map<string, string>();
  ownProjects = new Set<string>();
  demo: Project | null = null;
  decided = new Set<string>();
  onReply: ((sid: string, type: string) => void) | null = null;
  lastList: Row[] = [];

  constructor(
    private run: Run,
    private ev: Ev,
    private out: string,
    private attended: boolean,
  ) {}

  private record(dir: "in" | "out", name: string, f: Frame) {
    const at = this.ev.now();
    appendFileSync(join(this.out, "timeline.jsonl"), JSON.stringify({ at, dir, name, frame: f }) + "\n");
    if (name !== "list" || dir === "out") appendFileSync(join(this.out, "threads.txt"), `+${(at / 1000).toFixed(1)}s ${dir === "out" ? ">>" : "<<"} ${name} ${dir === "out" ? JSON.stringify(f) : frameLine(f, true)}\n`);
  }

  send(m: Frame) {
    if (!this.c) throw new Error(`the phone is offline; cannot send ${m.type}`);
    const sid = m.sessionId as string | undefined;
    if (sid && this.names.has(sid)) this.record("out", this.names.get(sid)!, m);
    if (m.type === "session_create") this.record("out", String(m.ref), m);
    this.c.send(m);
  }

  private thread(sid: string) {
    let t = this.threads.get(sid);
    if (!t) this.threads.set(sid, (t = { items: new Map(), controls: null, epoch: null, rev: 0 }));
    return t;
  }

  private snap(sid: string) {
    const t = this.thread(sid);
    this.ev.history.push({ at: this.ev.now(), name: this.names.get(sid)!, row: this.rows.get(sid) ?? null, controls: t.controls, items: [...t.items.values()] });
  }

  private apply(f: Frame) {
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
      t.items = new Map((f.items as Item[]).map((i) => [i.id, i]));
      t.controls = f.controls as Controls;
      t.epoch = f.epoch as string;
      t.rev = f.rev as number;
    } else if (f.type === "session_items") {
      for (const i of f.items as Item[]) t.items.set(i.id, i);
      for (const id of f.removed as string[]) t.items.delete(id);
      if (f.controls) t.controls = f.controls as Controls;
      t.rev = f.rev as number;
    } else return;
    this.onReply?.(sid, f.type);
    this.snap(sid);
    // The user taps Allow once on every card the scenario's sessions raise; each tap is in the timeline.
    for (const i of t.items.values())
      if (i.kind === "permission" && i.card && i.card.answer === null && !this.decided.has(i.card.id)) {
        this.decided.add(i.card.id);
        this.send({ type: "session_decide", sessionId: sid, cardId: i.card.id, choice: "once" });
      }
  }

  async open(resume: boolean) {
    this.c = await connect(this.run);
    const c = this.c;
    const inner = c.ws.onmessage;
    c.ws.onmessage = (e) => {
      inner?.call(c.ws, e);
      this.apply(JSON.parse(String(e.data)) as Frame);
    };
    // With the simulator, the app is the phone the user looks at; this socket only watches, so it must not hold back pushes.
    if (!this.attended) c.send({ type: "presence", attended: false });
    const at = c.frames.length;
    c.send({ type: "watch_sessions" });
    await until(() => c.frames.slice(at).some((f) => f.type === "sessions"), "the sessions frame", 60);
    if (!this.demo) throw new Error("the run's demo project is not listed");
    for (const [sid] of this.names) {
      const t = this.thread(sid);
      c.send({ type: "watch_session", sessionId: sid, after: resume && t.epoch ? { epoch: t.epoch, rev: t.rev } : null });
    }
  }

  drop() {
    this.c?.close();
    this.c = null;
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
  return { ok: p.exitCode === 0, out };
}

type Outcome = "judged" | "precondition-failed" | "error";

async function runScenario(sc: Scenario, sim: boolean, pairWaitS: number): Promise<Outcome> {
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
  };
  let phone: Phone | null = null;
  const markNow = (m: string) => {
    ev.marks[m] = ev.now();
    log(`mark ${m} at +${(ev.marks[m]! / 1000).toFixed(1)}s`);
  };

  try {
    if (sc.needsSimulator && !sim) throw new PreconditionFailed(`${sc.id} needs the simulator: run it with --sim`);
    const app = sim ? await pool.buildApp() : null;
    if (sim) {
      lease = await pool.acquire(`scenario ${sc.id} pid ${process.pid}`);
      held = pool.holdForProcess(lease);
      report.device = lease.device;
      pool.boot(lease);
    }
    const launched = sh(["bun", CONTROL, "launch", "--model", "haiku"], join(out, "launch.log"));
    const runId = launched.out.match(/READY run=(\S+)/)?.[1];
    if (!launched.ok || !runId) throw new Error(`launch failed; see ${join(out, "launch.log")}`);
    run = JSON.parse(readFileSync(join(BASE, "runs", runId, "run.json"), "utf8")) as Run;
    report.run = runId;
    report.build = run.rev;
    log(`bridge run ${runId} on :${run.port}`);
    phone = new Phone(run, ev, out, !sim);
    await phone.open(false);

    if (sim && lease && app) {
      pool.installAndLaunch(lease, app);
      await Bun.sleep(3000);
      const before = ((await phone.request({ type: "devices" }, "devices")).devices as unknown[]).length;
      const offer = await phone.request({ type: "pair_code" }, "pair_code");
      const link = `claudiobot://pair?url=${encodeURIComponent(`ws://127.0.0.1:${run.port}/ws`)}&code=${offer.code}`;
      pool.simctl(lease, "openurl", link);
      await Bun.sleep(3000);
      shots["pair-confirm"] = pool.screenshot(lease, join(out, "screenshots", "pair-confirm.png"));
      log(`PAIR: tap "Pair" in the confirmation on ${lease.device} (${lease.udid}) within ${pairWaitS}s`);
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

  async function perform(a: Action) {
    const p = phone!;
    switch (a.do) {
      case "create": {
        p.send({ type: "session_create", ref: a.name, projectId: p.demo!.id, model: "haiku", mode: a.mode ?? "default", isolate: "none", text: a.prompt });
        const sid = await until(() => ev.ids[a.name], `session_created for ${a.name}`, 30);
        p.send({ type: "watch_session", sessionId: sid, after: null });
        return;
      }
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
      case "leave": {
        const sid = ev.ids[a.name]!;
        p.send({ type: "unwatch_session", sessionId: sid });
        const t = p.threads.get(sid);
        p.send({ type: "watch_session", sessionId: sid, after: t?.epoch ? { epoch: t.epoch, rev: t.rev } : null });
        return;
      }
      case "reconnect": {
        p.drop();
        markNow(`${a.mark}-dropped`);
        if (a.until) await until(() => a.until!.test(ev), a.until.what, a.until.timeoutS);
        await Bun.sleep(a.afterS * 1000);
        const replies = new Map<string, string>();
        p.onReply = (sid, type) => replies.has(sid) || replies.set(sid, type);
        await p.open(true);
        await until(() => replies.size === p.names.size, "a resume reply for every thread", 30);
        p.onReply = null;
        await Bun.sleep(1500);
        markNow(a.mark);
        for (const [sid, name] of p.names) {
          const fresh = await connect(run!);
          const at = fresh.frames.length;
          fresh.send({ type: "watch_session", sessionId: sid, after: null });
          const snap = await until(() => fresh.frames.slice(at).find((f) => f.type === "session" && f.sessionId === sid), `a fresh snapshot of ${name}`, 30);
          fresh.close();
          const t = p.threads.get(sid)!;
          ev.resumes.push({ mark: a.mark, reply: replies.get(sid)!, resumed: [...t.items.values()], fresh: snap.items as Item[], resumedControls: t.controls, rows: p.lastList });
          log(`${name} resumed with ${replies.get(sid)}: ${t.items.size} items; a fresh open has ${(snap.items as Item[]).length}`);
        }
        return;
      }
      case "screenshot":
        if (!lease) return void skipped.push(`screenshot ${a.shot}`);
        shots[a.shot] = pool.screenshot(lease, join(out, "screenshots", `${a.shot}.png`));
        log(`screenshot ${a.shot}`);
        return;
      case "open-thread":
        if (!lease) return void skipped.push(`open-thread ${a.name}`);
        pool.simctl(lease, "openurl", `claudiobot://session/${ev.ids[a.name]}`);
        return;
      case "app":
        if (!lease) return void skipped.push(`app ${a.to}`);
        if (a.to === "background") pool.simctl(lease, "launch", "com.apple.Preferences");
        else pool.simctl(lease, "launch", pool.BUNDLE);
        return markNow(a.mark);
    }
  }

  // Judge, then keep what the cleanup deletes.
  const pre = failure && outcome === "error" ? [] : sc.pre.map((p) => ({ what: p.what, ...safe(() => p.check(ev)) }));
  if (outcome === "judged" && pre.some((p) => !p.ok)) outcome = "precondition-failed";
  const rubric = sc.rubric.map((r) => {
    if (outcome !== "judged") return { id: r.id, lane: r.lane, tell: r.tell, verdict: "not-judged", why: "the precondition failed" };
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
    screenshots: Object.fromEntries(Object.entries(shots).map(([k, v]) => [k, v.replace(`${out}/`, "")])),
  });
  if (phone?.demo) {
    const dir = join(homedir(), ".claude", "projects", slug(phone.demo.path));
    if (existsSync(dir)) cpSync(dir, join(out, "transcripts"), { recursive: true });
  }
  phone?.drop();
  if (run) {
    const c = sh(["bun", CONTROL, "cleanup", "--run", run.id], join(out, "cleanup.log"));
    report.bridgeEvidence = c.out.match(/evidence kept at (\S+?):/)?.[1] ?? null;
  }
  held?.release("scenario done");
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "report.md"), reportMarkdown(sc, report));
  console.log(readFileSync(join(out, "report.md"), "utf8"));
  return outcome;
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
    `outcome **${r.outcome}**${r.failure ? ` (${r.failure})` : ""}; lane ${r.lane}${r.device ? ` on ${r.device}` : ""}; run ${r.run ?? "-"} build ${String(r.build ?? "").slice(0, 10)}; ${r.durationS} s; $${r.spentUsd}`,
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
    for (const r of sc.rubric) lines.push(`| ${r.id} | ${r.tell} | ${r.lane}${r.lane === "simulator" ? ` (${(r.shots ?? []).join(", ")})` : ""} | ${r.text} | ${r.pass} | ${r.fail} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function describe(a: Action): string {
  switch (a.do) {
    case "create":
      return `New session \`${a.name}\` in demo (haiku, mode ${a.mode ?? "default"}): "${a.prompt.replace(/\n/g, " ")}"`;
    case "until":
      return `Wait up to ${a.timeoutS} s for ${a.what}; mark \`${a.mark}\`${a.optional ? " (optional)" : ""}.`;
    case "stop":
      return `Press Stop on \`${a.name}\` (session_stop); mark \`${a.mark}\`.`;
    case "sleep":
      return `Wait ${a.s} s.`;
    case "mark":
      return `Mark \`${a.mark}\`.`;
    case "leave":
      return `Leave \`${a.name}\`'s thread (unwatch_session, which the bridge counts as a visit).`;
    case "reconnect":
      return `Drop the socket${a.until ? `, wait for ${a.until.what}` : ""}, wait ${a.afterS} s, reconnect and resume each thread from its last position; compare with a fresh open. Mark \`${a.mark}\`.`;
    case "screenshot":
      return `Screenshot \`${a.shot}\` (simulator lane).`;
    case "open-thread":
      return `Open \`${a.name}\`'s thread in the app (claudiobot://session/<id>).`;
    case "app":
      return `Send the app to the ${a.to}${a.to === "background" ? " (launch Settings over it)" : " (launch it again)"}; mark \`${a.mark}\`.`;
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
      const ids = (args[0] ?? die("usage: run <id>[,<id>…] [--sim] [--pair-wait s] [--out dir]")).split(",");
      const scs = ids.map((id) => SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase()) ?? die(`no scenario ${id}`));
      const outcomes: Outcome[] = [];
      for (const sc of scs) outcomes.push(await runScenario(sc, sim, pairWaitS));
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
    case "sim-build":
      console.log(await pool.buildApp());
      return 0;
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
      console.log(`scenario.ts list | doc <area> | run <id>[,<id>…] [--sim] [--pair-wait s] [--out dir]
  pool ensure|status | lease acquire [--label L] [--wait s] [--boot] | lease heartbeat|boot|release <device> --token T | lease status
  sim-build | sim-job [--label L] [--hold s]
See ../runner.md (docs/ux-program/runner.md).`);
      return 0;
  }
}

process.exit(await main());
