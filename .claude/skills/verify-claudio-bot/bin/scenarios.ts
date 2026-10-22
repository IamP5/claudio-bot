// The scenario registry: each scenario is data (setup actions, preconditions, rubric items) read by scenario.ts.
// A precondition is what the scenario must produce to be judged at all; a rubric item is what the user must be able
// to tell. A failed precondition fails the scenario; a failed rubric item is a finding.
import type { Frame, Row } from "./control-claudio";

export type Step = { id: string; tool: string; label: string; state: string; output: string | null; [k: string]: unknown };
export type Item = { kind: string; id: string; at: string; text?: string; steps?: Step[]; card?: { id: string; answer: unknown; label: string; detail: string }; tone?: string; [k: string]: unknown };
export type Controls = { canSend: boolean; reason: string | null; working: boolean; queued: number; [k: string]: unknown };
/**
 * One change to one of the scenario's sessions, as the phone's reducer saw it. at: ms since the scenario started.
 * frame: the number of the frame that caused it, shared by every session one list frame touched.
 */
export type Snap = { at: number; frame: number; name: string; row: Row | null; controls: Controls | null; items: Item[] };
export type TranscriptLine = { type?: string; timestamp?: string; message?: { content?: unknown }; [k: string]: unknown };
/** One reconnect. resumed: hello.resumed, the bridge replayed the stream after the phone's position; replayed: how many frames. */
export type Resume = { mark: string; how: Drop; resumed: boolean; replayed: number; reply: string; items: Item[]; fresh: Item[]; resumedControls: Controls | null; rows: Row[] };
/** How the network loses the phone: a closed socket the app notices, or a half-open one where nothing passes and no close arrives. */
export type Drop = "close" | "half-open";

export type Push = { at: string; title: string | null; click: string | null; priority?: string | null; status?: number; body: string };

/** What a scenario run captured, live while it runs and complete when the rubric is judged. */
export type Ev = {
  now(): number;
  marks: Record<string, number>;
  history: Snap[];
  frameTimes: { at: number; name: string; type: string }[];
  ids: Record<string, string>;
  resumes: Resume[];
  sim: boolean;
  paired: boolean;
  transcript(name: string): { main: TranscriptLine[]; subagents: TranscriptLine[] };
  exists(rel: string): boolean;
  /** What the push sink received; status is what it answered (500 while it was made to fail). */
  pushes(): Push[];
  /** --away (or a scenario that says so): the phone said from the start that nobody looks at it, so pushes go out. */
  away: boolean;
  /** session_alert frames about the scenario's sessions, as the phone received them. */
  alerts: { at: number; name: string; frame: Frame }[];
  /** The push state, from each hello and push_state frame. */
  pushStates: { at: number; via: "hello" | "push_state"; push: { state: string; error?: string; at?: string } }[];
  /** Elapsed ms of the scenario at a wall-clock ISO time. */
  atOf(iso: string): number;
  /** Processes on the Mac whose command line matches `pattern` and whose working directory is the seed project: "pid command". */
  procs(pattern: string): string[];
  /** Process samples the scenario took (action ps), by label; written to the report. */
  samples: Record<string, string[]>;
  /** With --sim and tapApp: the frames about the scenario's sessions on the app's own socket, as the relay saw them. */
  app: { at: number; dir: "in" | "out" | "lost"; frame: Frame }[];
  /**
   * With --sim and watch-list: the app's Sessions list as it drew it, sampled by the list probe. rows: the spoken
   * labels of the seed project's header and rows, top to bottom; more: its "Show N more" fold when on screen.
   */
  list: { at: number; rows: string[]; more: string[] }[];
};

export type Action =
  | { do: "create"; name: string; prompt: string; mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" }
  /** The user sends in the thread. interrupt: "Stop and send". While the phone is offline the message waits for the next hello, as in the app. */
  | { do: "send"; name: string; text: string; interrupt?: boolean; mark?: string }
  | { do: "until"; mark: string; what: string; timeoutS: number; test: (ev: Ev) => boolean; optional?: boolean }
  /** task: stop only the running task whose label holds this text. turnOnly: "Stop the turn only". */
  | { do: "stop"; name: string; mark: string; task?: string; turnOnly?: boolean }
  /** Freezes (SIGSTOP) or resumes (SIGCONT) the session's own Claude Code process, as a hung or busy Mac would. */
  | { do: "signal-claude"; name: string; signal: "SIGSTOP" | "SIGCONT"; mark: string }
  | { do: "sleep"; s: number }
  | { do: "mark"; mark: string }
  /** Unwatches the thread, as the app does when the user goes back to the list; the bridge counts it as a visit. */
  | { do: "leave"; name: string }
  /** Watches the thread again from the position the phone held, as the app does when the user reopens it. */
  | { do: "return"; name: string }
  /**
   * The network drops the phone (and, with --sim, the app): `how` close or half-open. send: a message the user sends
   * while it is down. Waits, reconnects with the app's stream position (epoch, after), resumes every thread, and
   * unless compare is false, compares each with a fresh open.
   */
  | { do: "reconnect"; afterS: number; mark: string; how?: Drop; send?: { name: string; text: string }; compare?: boolean; until?: { what: string; timeoutS: number; test: (ev: Ev) => boolean } }
  | { do: "screenshot"; shot: string }
  /** The user opens the thread: the app by its link with --sim; on the protocol lane the phone watches it again if it had left. */
  | { do: "open-thread"; name: string }
  /** With --sim, the app goes back to the Sessions list (it is relaunched on the list). Nothing on the protocol lane, where leave does it. */
  | { do: "show-list" }
  /** With --sim, Settings over the app and back. On the protocol lane the phone is suspended: its socket goes half-open, then it reconnects. */
  | { do: "app"; to: "background" | "foreground"; mark: string }
  /** Samples the Mac's processes matching `pattern` in the seed project into the report under `as`. */
  | { do: "ps"; pattern: string; as: string }
  /** SIGKILLs the Claude Code process that runs the session, as a crash would. */
  | { do: "kill-claude"; name: string; mark: string }
  /** Restarts the bridge on the same port and home; the phone reconnects as the app does. */
  | { do: "restart-bridge"; mark: string }
  /** With --sim and tapApp, the next frame for the session that passes test is lost on its way to the app, as a flaky link or an unreadable frame loses it. */
  | { do: "lose-frame"; name: string; mark: string; what: string; timeoutS: number; test: (f: Frame) => boolean }
  /** With --sim, the list probe reads the app's Sessions list as it draws it until the setup ends, into ev.list. */
  | { do: "watch-list" }
  /** The push sink answers 500 from now on (fail), or 200 again. */
  | { do: "sink"; fail: boolean };

export type Tell = "what" | "how-many" | "how-long" | "state" | "stop";
export type Verdict = { ok: boolean; why: string };
export type RubricItem = {
  id: string;
  tell: Tell;
  lane: "protocol" | "simulator";
  text: string;
  pass: string;
  fail: string;
  /** Mechanical judgment. A simulator item without one is judged by a person or agent from its screenshots. */
  check?: (ev: Ev) => Verdict;
  shots?: string[];
};
export type Precondition = { what: string; check: (ev: Ev) => Verdict };
export type Scenario = {
  id: string;
  area: "sessions";
  title: string;
  needsSimulator: boolean;
  journey: string[];
  setup: Action[];
  pre: Precondition[];
  rubric: RubricItem[];
  /** Marks read from the evidence after the run (transcript times), merged in before the rubric is judged. */
  derive?: (ev: Ev) => Record<string, number>;
  /** Seconds the user takes to tap Allow once on each card; 0 (the default) taps at once. */
  holdCardsS?: number;
  /** With --sim, the relay reads the app's own socket frame by frame, so lose-frame can lose one on its way to the app. */
  tapApp?: boolean;
  /** The phone says from the start that nobody looks at it, as --away does. */
  away?: boolean;
  /** The bridge runs with no push URL. */
  pushOff?: boolean;
  /** Seconds a session card waits before it expires; its reminder is at half. */
  cardTtlS?: number;
};

// ---- reading the evidence

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const stepsOf = (s: Snap) => s.items.flatMap((i) => (i.kind === "work" ? (i.steps ?? []) : []));
const snaps = (ev: Ev, name: string, from = 0, to = Infinity) => ev.history.filter((s) => s.name === name && s.at >= from && s.at <= to);
const last = (ev: Ev, name: string, at = Infinity) => snaps(ev, name, 0, at).at(-1);
/** Every state that was on screen during [from, to]: the one carried in from before `from`, then each change. */
const during = (ev: Ev, name: string, from: number, to: number) => [last(ev, name, from), ...snaps(ev, name, from + 1, to)].filter((s): s is Snap => s !== undefined);
const mark = (ev: Ev, m: string) => ev.marks[m];
const span = (ev: Ev, from: string, to: string): [number, number] | null => {
  const a = mark(ev, from);
  const b = mark(ev, to);
  return a === undefined || b === undefined ? null : [a, b];
};
const needMarks = (ev: Ev, ...ms: string[]): Verdict | null => {
  const missing = ms.filter((m) => mark(ev, m) === undefined);
  return missing.length ? { ok: false, why: `not judged: mark ${missing.join(", ")} never reached` } : null;
};
const rowStatus = (s: Snap | undefined) => s?.row?.status ?? "none";
const isWorking = (s: Snap) => s.controls?.working === true || ["working", "awaiting_approval", "awaiting_input"].includes(rowStatus(s));
const statuses = (xs: Snap[]) => [...new Set(xs.map((s) => `${rowStatus(s)}/${s.controls?.working ? "working" : "not-working"}`))].join(", ") || "none";

/** The most steps matching `pick` that were in state running at one moment. */
function maxRunning(ev: Ev, name: string, pick: (s: Step) => boolean) {
  let best = 0;
  for (const s of snaps(ev, name)) best = Math.max(best, stepsOf(s).filter((x) => pick(x) && x.state === "running").length);
  return best;
}

type Use = { id: string; name: string; input: Record<string, unknown>; at: string };
type Result = { id: string; isError: boolean; text: string; at: string };
function blocks(lines: TranscriptLine[]) {
  const uses: Use[] = [];
  const results: Result[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const content = l.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      const key = `${b.type}:${String(b.id ?? b.tool_use_id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (b.type === "tool_use") uses.push({ id: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, at: l.timestamp ?? "" });
      if (b.type === "tool_result")
        results.push({ id: String(b.tool_use_id), isError: b.is_error === true, text: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""), at: l.timestamp ?? "" });
    }
  }
  return { uses, results };
}
/** An assistant line that ends a run: text and no tool call. */
const isFinal = (l: TranscriptLine) => {
  const c = l.message?.content;
  return l.type === "assistant" && Array.isArray(c) && c.some((b) => (b as { type?: string }).type === "text") && !c.some((b) => (b as { type?: string }).type === "tool_use");
};
/**
 * Each subagent's run in scenario ms, keyed by agentId: from its first line to its final result (done), or to its
 * last line so far while it has none. A line written before a blocked tool call is not the end.
 */
function subagentSpans(ev: Ev, name: string) {
  const lines = new Map<string, TranscriptLine[]>();
  for (const l of ev.transcript(name).subagents) {
    const id = String(l.agentId ?? "");
    if (id && l.timestamp) lines.set(id, [...(lines.get(id) ?? []), l]);
  }
  const spans = new Map<string, { from: number; to: number; done: boolean }>();
  for (const [id, ls] of lines) {
    const ats = ls.map((l) => ev.atOf(l.timestamp!));
    const assistant = ls.filter((l) => l.type === "assistant").at(-1);
    const done = assistant !== undefined && isFinal(assistant);
    spans.set(id, { from: Math.min(...ats), to: done ? ev.atOf(assistant.timestamp!) : Math.max(...ats), done });
  }
  return spans;
}
/** The Agent call's tool_use id for each agentId, read from the call's result ("agentId: …"). */
const agentOfCall = (ev: Ev, name: string) =>
  new Map(blocks(ev.transcript(name).main).results.flatMap((r) => {
    const id = r.text.match(/agentId: (\w+)/)?.[1];
    return id ? [[r.id, id] as const] : [];
  }));

const bgBash = (lines: TranscriptLine[]) => blocks(lines).uses.filter((u) => u.name === "Bash" && u.input.run_in_background === true);

const ok = (why: string): Verdict => ({ ok: true, why });
const no = (why: string): Verdict => ({ ok: false, why });

// ---- rubric items several scenarios share

/** how-long: the wire gives each running step its own start, so elapsed time survives reopening the thread. */
const startTime = (id: string, name: string, pick: (s: Step) => boolean, what: string, from?: string, to?: string): RubricItem => ({
  id,
  tell: "how-long",
  lane: "protocol",
  text: `While ${what} runs, the phone can show how long it has been running, also after reopening the thread.`,
  pass: "Every running step carries a start time (a step field), or is the first step of its work item, whose `at` is its start.",
  fail: "A running step has no start time on the wire, so elapsed time can only be counted from when the phone happened to see it.",
  check: (ev) => {
    const w = from && to ? span(ev, from, to) : ([0, Infinity] as [number, number]);
    if (!w) return needMarks(ev, from!, to!)!;
    const running = during(ev, name, w[0], w[1]).flatMap((s) => s.items.flatMap((i) => (i.kind === "work" ? (i.steps ?? []).map((st, k) => ({ st, k, item: i })) : []))).filter((x) => pick(x.st) && x.st.state === "running");
    if (!running.length) return no(`no step of ${what} ever reads running${from ? ` at ${from}` : ""}, so nothing on the wire says how long it has run`);
    const fields = (st: Step) => Object.keys(st).filter((k) => /start|since|began|elapsed/i.test(k));
    const own = running.filter((x) => fields(x.st).length > 0);
    if (own.length === running.length) return ok(`steps carry ${fields(running[0]!.st).join(",")}`);
    const firstOnly = running.every((x) => fields(x.st).length > 0 || x.k === 0);
    return firstOnly
      ? ok(`no step field; each running step is the first of its work item, so item.at is its start (step keys: ${Object.keys(running[0]!.st).join(",")})`)
      : no(`steps have no start field (keys: ${Object.keys(running[0]!.st).join(",")}); ${running.filter((x) => x.k > 0).length} running step(s) are not their item's first, so item.at is not their start`);
  },
});

/** stop: while the work runs, the composer offers Stop (controls.working true). */
const stopOffered = (id: string, name: string, from: string, to: string, what: string): RubricItem => ({
  id,
  tell: "stop",
  lane: "protocol",
  text: `While ${what} runs, the thread offers Stop.`,
  pass: `controls.working is true in every thread state between marks ${from} and ${to}.`,
  fail: "Some state in that window has controls.working false, so the app shows no Stop for work that is still running.",
  check: (ev) => {
    const w = span(ev, from, to);
    if (!w) return needMarks(ev, from, to)!;
    const xs = during(ev, name, w[0], w[1]).filter((s) => s.controls);
    const bad = xs.filter((s) => !s.controls!.working);
    if (!xs.length) return no(`not judged: no controls between ${from} and ${to}`);
    return bad.length ? no(`${bad.length}/${xs.length} states had working=false, first at +${Math.max(0, Math.round((bad[0]!.at - w[0]) / 1000))}s`) : ok(`${xs.length} states, all working=true`);
  },
});

/** state: the work is visibly still running in a window after the turn ended (background work). */
const stillRunning = (id: string, name: string, at: string, where: "list" | "thread", what: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: `After the turn ends and while ${what} still runs, the ${where} says something is still running.`,
  pass:
    where === "list"
      ? `At mark ${at} (the user is on the list), the row reads working or another busy status.`
      : `At mark ${at} (the user just reopened the thread), the thread shows a running step or controls.working true.`,
  fail: "The session looks finished (idle row, no running step) while its background work still runs.",
  check: (ev) => {
    const t = mark(ev, at);
    if (t === undefined) return needMarks(ev, at)!;
    const s = last(ev, name, t);
    if (where === "list") return s?.row && s.row.status !== "idle" ? ok(`row ${s.row.status}`) : no(`row ${rowStatus(s)}`);
    if (!s) return no("no state seen");
    const running = stepsOf(s).filter((x) => x.state === "running");
    return running.length || isWorking(s)
      ? ok(`mid-window: row ${rowStatus(s)}, working=${s.controls?.working}, running steps: ${running.map((x) => x.label).join("; ") || "none"}`)
      : no(`mid-window: row ${rowStatus(s)}, working=${s.controls?.working}, no running step`);
  },
});

/** state: once the background work is done, the thread shows it within 60 s. */
const finishShows = (id: string, name: string, doneMark: string, what: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: `When ${what} finishes, the thread shows that it finished.`,
  pass: `Within 60 s of mark ${doneMark}, a new item or a step state change appears in the thread.`,
  fail: "Nothing in the thread changes when the work finishes.",
  check: (ev) => {
    const at = mark(ev, doneMark);
    if (at === undefined) return needMarks(ev, doneMark)!;
    const before = last(ev, name, at);
    const ids = new Set((before?.items ?? []).map((i) => `${i.id}:${JSON.stringify(i.steps?.map((s) => s.state) ?? [])}`));
    const after = snaps(ev, name, at, at + 60_000).flatMap((s) => s.items).filter((i) => !ids.has(`${i.id}:${JSON.stringify(i.steps?.map((s) => s.state) ?? [])}`));
    return after.length ? ok(`new or changed: ${[...new Set(after.map((i) => `${i.kind}:${i.id}`))].slice(0, 4).join(", ")}`) : no("no item appeared or changed within 60 s");
  },
});

const unreadAfter = (id: string, name: string, at: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: "Once the work finished while the user was away from the thread, the list marks the session as having news.",
  pass: `At mark ${at}, with the phone away from the thread since the turn ended, the row is unread.`,
  fail: "The row is not unread, so the list gives no sign that something finished.",
  check: (ev) => {
    const t = mark(ev, at);
    if (t === undefined) return needMarks(ev, at)!;
    const s = last(ev, name, t);
    return s?.row?.unread ? ok("row unread=true") : no(`row unread=${s?.row?.unread}, status ${rowStatus(s)}`);
  },
});

const review = (id: string, tell: Tell, text: string, pass: string, fail: string, shots: string[]): RubricItem => ({ id, tell, lane: "simulator", text, pass, fail, shots });

/**
 * The app's list as the probe read it, as the run's sessions: each sample's rows of `names`, top to bottom, with the
 * status their spoken label ("<project>, <title>, <status>, …") carries. A row is known by any title it ever had, so
 * a title rewrite is the same row. The project header and other sessions are left out. Never returns a title.
 */
export function appList(ev: Ev, names: string[]) {
  const byTitle = new Map<string, string>();
  for (const s of ev.history) if (names.includes(s.name) && s.row?.title) byTitle.set(s.row.title, s.name);
  const titles = [...byTitle.keys()].sort((a, b) => b.length - a.length);
  return ev.list
    .map((x) => {
      const rows: { name: string; status: "needs-you" | "working" | "other" }[] = [];
      for (const label of x.rows) {
        const rest = label.slice(label.indexOf(", ") + 2);
        const title = titles.find((t) => rest === t || rest.startsWith(`${t}, `));
        const name = title && byTitle.get(title);
        if (!name || rows.some((r) => r.name === name)) continue;
        const words = rest.slice(title.length);
        rows.push({ name, status: /, needs you(,|$)/.test(words) ? "needs-you" : /, working\b/.test(words) ? "working" : "other" });
      }
      return { at: x.at, rows, more: x.more };
    })
    .filter((x) => x.rows.length);
}

/** Claude Code's own texts: a background launch ack, the subagent hand-back wrapper, the rejection boilerplate. */
const ACK = /Async agent launched|Command running in background|Subagent hand-back|doesn't want to proceed/;
const noAckOutput = (id: string, names: string[]): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: "A step's output is what the work produced, never Claude Code's launch acknowledgement, hand-back wrapper or rejection boilerplate.",
  pass: `No step output in any state matches ${ACK.source}.`,
  fail: "A step shows one of those texts as its output, so a launch or a refusal reads like a result.",
  check: (ev) => {
    const hits = new Map<string, string>();
    for (const n of names) for (const s of snaps(ev, n)) for (const x of stepsOf(s)) if (ACK.test(x.output ?? "")) hits.set(x.id, `${x.label}: "${x.output!.match(ACK)![0]}"`);
    return hits.size ? no([...hits.values()].join("; ")) : ok(`no step output matches`);
  },
});

/** The notice items a session showed from `from` on. A notice is written by the bridge; assistant prose never counts. */
const notices = (ev: Ev, name: string, from = 0) => [...new Map(snaps(ev, name, from).flatMap((s) => s.items).filter((i) => i.kind === "notice").map((i) => [i.id, i])).values()];

const created = (name: string): Precondition => ({ what: `session ${name} was created`, check: (ev) => (ev.ids[name] ? ok(ev.ids[name]!) : no("no session_created")) });
const fileMade = (rel: string): Precondition => ({ what: `${rel} exists in the seed project`, check: (ev) => (ev.exists(rel) ? ok("present") : no("missing")) });
/** The session rests: nothing it runs, foreground or background, still reads working. */
const atRest = (name: string) => (ev: Ev) => mark(ev, `${name}-started`) !== undefined && !isWorking(last(ev, name) ?? ({ controls: null, row: null } as Snap));
/** The main transcript's last exchange is Claude Code's final reply of a turn. */
const endsTurn = (lines: TranscriptLine[]) => {
  const l = lines.findLast((x) => x.type === "user" || x.type === "assistant");
  return l !== undefined && finalReply(l);
};
/**
 * The turn that started background work ended, while that work may still run: the transcript has the turn's final
 * reply, and controls.turn says no turn runs (a bridge without session_tasks says so only through working).
 */
const turnEnded = (name: string) => (ev: Ev) => {
  const s = last(ev, name);
  if (mark(ev, `${name}-started`) === undefined || !s || !endsTurn(ev.transcript(name).main)) return false;
  return Array.isArray(s.controls?.tasks) ? s.controls?.turn == null : !isWorking(s);
};

const finalReply = (l: TranscriptLine) => l.type === "assistant" && (l.message as { stop_reason?: unknown } | undefined)?.stop_reason === "end_turn";
/** Working with no task listed: only a turn can be running, and Claude Code writes its turns to the transcript. */
const taskless = (s: Snap) => s.controls?.working === true && Array.isArray(s.controls.tasks) && s.controls.tasks.length === 0;

/** After a turn's final reply, until Claude Code writes again, the session reads working only while a task runs. */
const noPhantomWork = (id: string, name: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: "After a turn's final reply, the session does not read working while nothing runs.",
  pass: "After each final reply in the main transcript, until its next line, no stretch longer than 5 s reads controls.working true with no task listed.",
  fail: "The session reads working, with Stop, for more than 5 s while no task runs and Claude Code writes nothing.",
  check: (ev) => {
    const lines = ev.transcript(name).main.filter((l) => (l.type === "user" || l.type === "assistant") && l.timestamp);
    let worst = { ms: 0, at: 0 };
    lines.forEach((l, i) => {
      if (!finalReply(l)) return;
      const from = ev.atOf(l.timestamp!);
      const to = i + 1 < lines.length ? ev.atOf(lines[i + 1]!.timestamp!) : ev.now();
      const xs = during(ev, name, from, to).filter((x) => x.controls);
      for (let j = 0; j < xs.length; j++) {
        if (!taskless(xs[j]!)) continue;
        let k = j;
        while (k + 1 < xs.length && taskless(xs[k + 1]!)) k++;
        const start = Math.max(xs[j]!.at, from);
        const stop = k + 1 < xs.length ? xs[k + 1]!.at : to;
        if (stop - start > worst.ms) worst = { ms: stop - start, at: start };
        j = k;
      }
    });
    const s = (ms: number) => Math.round(ms / 100) / 10;
    return worst.ms <= 5_000 ? ok(`longest taskless working stretch after a reply: ${s(worst.ms)} s`) : no(`working with no task for ${s(worst.ms)} s from +${s(worst.at)} s`);
  },
});

/** Once the session's work has ended, it rests, so the busy row and Stop go away. */
const comesToRest = (id: string, name: string, from: string, what: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: `Once its work is over (${what}), the session comes to rest.`,
  pass: `Within 60 s of mark ${from}, a state reads not working: the row not busy and controls.working false.`,
  fail: "The session still reads working 60 s after its work ended, so the busy row and Stop never go away.",
  check: (ev) => {
    const at = mark(ev, from);
    if (at === undefined) return needMarks(ev, from)!;
    const rest = snaps(ev, name, at).find((s) => !isWorking(s));
    if (!rest) return no(`still working at the end of the run, ${Math.round((ev.now() - at) / 1000)} s later`);
    const s = Math.round((rest.at - at) / 1000);
    return rest.at - at <= 60_000 ? ok(`at rest ${s} s later`) : no(`at rest only ${s} s later`);
  },
});
const replied = (s: Snap | undefined) => !!s?.items.some((i) => i.kind === "assistant");
const started = (name: string): Action => ({ do: "until", mark: `${name}-started`, what: `${name}'s turn to start`, timeoutS: 90, test: (ev) => snaps(ev, name).some((s) => isWorking(s) || replied(s)) });

/** The user leaves the thread once the turn ended, looks at the list, reopens the thread, leaves again until it finished. */
const awayAndBack = (name: string, doneFile: string, finishIsOutcome = false): Action[] => [
  { do: "leave", name },
  { do: "sleep", s: 12 },
  { do: "mark", mark: "list-mid" },
  { do: "return", name },
  { do: "open-thread", name },
  { do: "sleep", s: 3 },
  { do: "mark", mark: "mid-background" },
  { do: "screenshot", shot: "background-running" },
  { do: "show-list" },
  { do: "leave", name },
  { do: "until", mark: "bg-done", what: `${doneFile} to appear`, timeoutS: 150, test: (ev) => ev.exists(doneFile), optional: finishIsOutcome },
  { do: "sleep", s: 20 },
  { do: "mark", mark: "list-after" },
  { do: "return", name },
  { do: "open-thread", name },
  { do: "sleep", s: 3 },
  { do: "mark", mark: "returned" },
  { do: "screenshot", shot: "after" },
];

/** A turn of the session began after `from` and has ended since. */
const turnRan = (ev: Ev, name: string, from: string) => {
  const at = mark(ev, from);
  if (at === undefined) return false;
  const ss = snaps(ev, name, at);
  return ss.some((s) => s.controls?.turn != null) && ss.at(-1)?.controls?.turn == null;
};

/** The bridge's words for a session that came to rest, as its push says them. */
const FINISHED = /^A Claude Code session finished$/;
const ENDED = /^A Claude Code session (finished|stopped with an error)$/;
/** A push about cards: its count, 1 when it names one card. */
const cardCount = (p: Push) => {
  const m = p.body.match(/^A Claude Code session (needs (your approval|(\d+) approvals)|has (a question|(\d+) questions) for you|has a plan for you to review|needs you: (\d+) requests)$/);
  return m ? Number(m[3] ?? m[5] ?? m[6] ?? 1) : null;
};
const awayOnly = (ev: Ev): Verdict | null => (ev.away ? null : { ok: false, why: "not judged: the phone was attended, so the bridge held every push (run with --away)" });

const BG = (cmd: string) =>
  `Use the Bash tool with run_in_background set to true to run exactly this command: ${cmd}\nDo not wait for it, do not check on it, do not run anything else. Reply with one line: started.`;

// ---- the scenarios

const fanOut = (id: "S1" | "S1b", background: boolean): Scenario => {
  const n = id.toLowerCase();
  return {
    id,
    area: "sessions",
    title: background ? "Three parallel subagents in the background (Claude Code's default)" : "Three parallel subagents the session waits for",
    needsSimulator: false,
    journey: [
      "The user starts a session from the phone that fans out three subagents at once.",
      "They watch the thread while the three run: which three, that all three run, for how long, and that Stop is there.",
      "They see each one finish and the session come to rest.",
    ],
    setup: [
      {
        do: "create",
        name: n,
        prompt:
          `Launch exactly 3 subagents in parallel, all in one message, with the Agent tool: subagent_type general-purpose, model haiku, run_in_background ${background}. Their descriptions are "sleeper one", "sleeper two" and "sleeper three". Each one\'s prompt is: "Run exactly this Bash command in the foreground: perl -e \'sleep 30\' . Then reply with the single word done." When all three have returned, reply with one line: all done.`,
      },
      started(n),
      { do: "open-thread", name: n },
      { do: "until", mark: "agents-launched", what: "3 Agent calls in the transcript", timeoutS: 120, test: (ev) => blocks(ev.transcript(n).main).uses.filter((u) => AGENT_TOOLS.has(u.name)).length >= 3 },
      { do: "sleep", s: 12 },
      { do: "mark", mark: "mid-run" },
      { do: "screenshot", shot: "running" },
      {
        do: "until",
        mark: "agents-finished",
        what: "each subagent's final result in its own transcript",
        timeoutS: 240,
        test: (ev) => {
          const spans = [...subagentSpans(ev, n).values()];
          return spans.length >= 3 && spans.every((s) => s.done);
        },
      },
      // The parent promises "all done" when it launches them, so only a line that is exactly the reply counts.
      { do: "until", mark: "all-done", what: 'the "all done" reply', timeoutS: 180, test: (ev) => !!last(ev, n)?.items.some((i) => i.kind === "assistant" && /^\W*all done\W*$/im.test(i.text ?? "")) },
      { do: "until", mark: `${n}-ended`, what: "the turn to end", timeoutS: 120, test: atRest(n) },
      { do: "screenshot", shot: "done" },
    ],
    pre: [
      created(n),
      {
        what: `the 3 Agent calls ran with run_in_background ${background}`,
        check: (ev) => {
          const calls = blocks(ev.transcript(n).main).uses.filter((u) => AGENT_TOOLS.has(u.name));
          const right = calls.filter((u) => (u.input.run_in_background === true) === background);
          return calls.length >= 3 && right.length === calls.length ? ok(`${calls.length} calls`) : no(`${right.length}/${calls.length} calls with run_in_background ${background}`);
        },
      },
      {
        what: "3 subagents ran at the same time (their own transcripts overlap)",
        check: (ev) => {
          const spans = [...subagentSpans(ev, n).values()];
          const overlap = Math.min(...spans.map((x) => x.to)) - Math.max(...spans.map((x) => x.from));
          return spans.length >= 3 && overlap > 5000 ? ok(`${spans.length} subagents, all running together for ${Math.round(overlap / 1000)} s`) : no(`${spans.length} subagents, overlap ${Math.round(overlap / 1000)} s`);
        },
      },
    ],
    derive: (ev): Record<string, number> => {
      const spans = [...subagentSpans(ev, n).values()];
      return spans.length ? { "agents-from": Math.min(...spans.map((x) => x.from)), "agents-to": Math.max(...spans.map((x) => x.to)) } : {};
    },
    rubric: [
      {
        id: `${id}.1`,
        tell: "what",
        lane: "protocol",
        text: "Each subagent appears as its own step that names its job.",
        pass: "At least 3 Agent/Task steps, with distinct labels that carry the description.",
        fail: "Fewer than 3 subagent steps, or labels that do not tell them apart.",
        check: (ev) => {
          const steps = new Map(snaps(ev, n).flatMap(stepsOf).filter((s) => AGENT_TOOLS.has(s.tool)).map((s) => [s.id, s.label]));
          const labels = new Set(steps.values());
          return steps.size >= 3 && labels.size >= 3 ? ok([...labels].join(" | ")) : no(`${steps.size} steps, labels: ${[...labels].join(" | ") || "none"}`);
        },
      },
      {
        id: `${id}.2`,
        tell: "how-many",
        lane: "protocol",
        text: "The phone can tell that three subagents run at the same time.",
        pass: "At one moment, 3 subagent steps are in state running.",
        fail: "The most running at once is under 3 (they look sequential, or their state is not live).",
        check: (ev) => {
          const most = maxRunning(ev, n, (s) => AGENT_TOOLS.has(s.tool));
          return most >= 3 ? ok(`max ${most} running at once`) : no(`max ${most} running at once`);
        },
      },
      {
        id: `${id}.3`,
        tell: "state",
        lane: "protocol",
        text: "While the subagents run, the Sessions list shows the session as working.",
        pass: "row.status is working in every state between agents-from and agents-to (the subagents' own transcripts).",
        fail: "The row reads idle (or another rest state) while subagents still run.",
        check: (ev) => {
          const w = span(ev, "agents-from", "agents-to");
          if (!w) return needMarks(ev, "agents-from", "agents-to")!;
          const xs = during(ev, n, w[0], w[1]).filter((s) => s.row);
          const bad = xs.filter((s) => s.row!.status !== "working");
          const idle = bad.reduce((n, s, i) => n + ((xs[xs.indexOf(s) + 1]?.at ?? w[1]) - Math.max(s.at, w[0])), 0);
          return bad.length ? no(`row ${statuses(bad)} for about ${Math.round(idle / 1000)} of the ${Math.round((w[1] - w[0]) / 1000)} s the subagents ran`) : ok(`row working in all ${xs.length} states`);
        },
      },
      {
        id: `${id}.4`,
        tell: "state",
        lane: "protocol",
        text: "Each subagent's step reads done when that subagent finishes, not before, and none stays running after.",
        pass: "Each Agent step first reads ok no earlier than 2 s before its subagent's final result (the last line of its transcript when that is plain text), and reads ok at the end.",
        fail: "A step reads ok while its subagent still runs (or stays running after it ended).",
        check: (ev) => {
          const spans = subagentSpans(ev, n);
          const calls = agentOfCall(ev, n);
          const early: string[] = [];
          const ids = [...new Set(snaps(ev, n).flatMap(stepsOf).filter((x) => AGENT_TOOLS.has(x.tool)).map((x) => x.id))];
          for (const id of ids) {
            const span = spans.get(calls.get(id) ?? "");
            const firstOk = snaps(ev, n).find((s) => stepsOf(s).some((x) => x.id === id && x.state === "ok"))?.at;
            const label = stepsOf(last(ev, n)!).find((x) => x.id === id)?.label ?? id;
            if (firstOk === undefined) continue;
            if (!span) early.push(`${label} read ok, and no subagent transcript matches its call, so its end is unknown`);
            else if (!span.done) early.push(`${label} read ok at +${Math.round(firstOk / 1000)} s; its subagent never wrote a final result`);
            else if (firstOk < span.to - 2000) early.push(`${label} read ok ${Math.round((span.to - firstOk) / 1000)} s before its subagent ended`);
          }
          const notOk = stepsOf(last(ev, n)!).filter((x) => AGENT_TOOLS.has(x.tool) && x.state !== "ok");
          if (!ids.length) return no("no subagent steps");
          return early.length || notOk.length ? no([...early, ...notOk.map((x) => `${x.label} ends ${x.state}`)].join("; ")) : ok(`${ids.length} steps read ok when their subagents ended`);
        },
      },
      startTime(`${id}.5`, n, (s) => AGENT_TOOLS.has(s.tool), "a subagent"),
      {
        id: `${id}.6`,
        tell: "what",
        lane: "protocol",
        text: "The user can see what a running subagent is doing inside, not only that it runs.",
        pass: "A child row (parentId = the session) is listed, a running subagent step carries progress output, or controls.tasks has an agent task with progress.",
        fail: "A running subagent is an opaque line: no child row, no output and no task progress until it returns.",
        check: (ev) => {
          const id = ev.ids[n];
          const child = ev.history.some((s) => s.row?.parentId === id);
          const progress = snaps(ev, n).flatMap(stepsOf).some((x) => AGENT_TOOLS.has(x.tool) && x.state === "running" && (x.output ?? "") !== "" && !ACK.test(x.output ?? ""));
          const tasks = snaps(ev, n).some((s) => ((s.controls?.tasks as { kind?: string; progress?: unknown }[] | undefined) ?? []).some((t) => t.kind === "agent" && t.progress));
          return child || progress || tasks ? ok(`child row: ${child}, progress output: ${progress}, task progress: ${tasks}`) : no("no child row, no output and no task progress while running");
        },
      },
      stopOffered(`${id}.7`, n, "agents-from", "agents-to", "the subagents"),
      review(`${id}.8`, "how-many", "Mid-run, the thread shows three labeled subagent rows, each visibly running, and a Stop button.", "All three rows, a running indicator on each, Stop visible.", "Rows missing or merged, no running indicator, or no Stop.", ["running"]),
      review(`${id}.9`, "state", "After the turn, the thread shows all three done and the session at rest.", "Three done rows, no spinner, composer ready.", "A spinner or running state remains.", ["done"]),
      noAckOutput(`${id}.10`, [n]),
      coalescedCards(`${id}.11`, n),
    ],
  };
};

/** The session's cards, by when each opened, grouped into bursts that opened within 2 s of the burst's first card. */
const cardBursts = (ev: Ev, name: string) => {
  const opened = [...new Map(snaps(ev, name).flatMap((s) => s.items).filter((i) => i.kind === "permission" && i.card).map((i) => [i.card!.id, ev.atOf(i.at)])).values()].sort((a, b) => a - b);
  const bursts: number[][] = [];
  for (const t of opened) {
    const b = bursts.at(-1);
    if (b && t - b[0]! <= 2_000) b.push(t);
    else bursts.push([t]);
  }
  return bursts;
};

/** With the phone away, cards that open together send one push that counts them (run 2, F-SES-149). */
const coalescedCards = (id: string, name: string): RubricItem => ({
  id,
  tell: "how-many",
  lane: "protocol",
  text: "With the phone away, approvals that open together arrive as one push that counts them, not one buzz each.",
  pass: "With --away, every burst of cards that opened within 2 s gets exactly one card push, which counts the burst's cards; it names no command.",
  fail: "A burst sends a push per card, a count that does not match, or no push at all.",
  check: (ev) => {
    const away = awayOnly(ev);
    if (away) return away;
    const sid = ev.ids[name] ?? "-";
    const pushes = ev.pushes().filter((p) => cardCount(p) !== null && (p.click ?? "").includes(sid));
    const bursts = cardBursts(ev, name);
    if (!bursts.length) return no("no cards opened");
    const bad: string[] = [];
    for (const b of bursts) {
      const mine = pushes.filter((p) => ev.atOf(p.at) >= b[0]! - 500 && ev.atOf(p.at) <= b[0]! + 15_000);
      if (mine.length !== 1 || cardCount(mine[0]!) !== b.length) bad.push(`${b.length} cards at +${Math.round(b[0]! / 1000)} s: ${mine.map((p) => p.body).join(" | ") || "no push"}`);
    }
    const leaky = pushes.filter((p) => /perl|sleep/.test(p.body));
    if (leaky.length) bad.push(`content in ${leaky[0]!.body}`);
    return bad.length ? no(bad.join("; ")) : ok(`${bursts.map((b) => b.length).join(", ")} card(s): ${pushes.map((p) => p.body).join(" | ")}`);
  },
});

const S2: Scenario = {
  id: "S2",
  area: "sessions",
  title: "A long background Bash command",
  needsSimulator: false,
  journey: [
    "The user asks a session to start a long command in the background; the turn ends right away.",
    "They leave the thread. The command keeps running on the Mac for about 75 s.",
    "They want to tell, from the list and the thread, that it still runs, for how long, how to stop it, and when it finished.",
  ],
  setup: [
    { do: "create", name: "s2", prompt: BG("sleep 75 && echo bg-done > bg.txt") },
    started("s2"),
    { do: "until", mark: "s2-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s2") },
    ...awayAndBack("s2", "bg.txt"),
    // S2.4 judges the 60 s after bg-done; the second part must not add items to that window.
    { do: "until", mark: "finish-window-over", what: "the 60 s after bg-done to pass", timeoutS: 120, test: (ev) => ev.now() > (mark(ev, "bg-done") ?? Infinity) + 61_000 },
    {
      do: "send",
      name: "s2",
      text: "Use the Bash tool with run_in_background set to true to run exactly this command: sleep 45 && echo bg-done > bg2.txt\nThen, without waiting for it, use the Bash tool in the foreground (not in the background) to run exactly: perl -e 'sleep 40'\nThen reply with one line: waited.",
    },
    { do: "until", mark: "fg-running", what: "the foreground perl sleep 40 to run on the Mac", timeoutS: 150, test: (ev) => ev.procs("sleep 40").length > 0 },
    { do: "sleep", s: 3 },
    { do: "ps", pattern: "sleep 45", as: "bg2-before-stop-and-send" },
    { do: "send", name: "s2", text: "Reply with one word: ok.", interrupt: true, mark: "stop-and-send" },
    { do: "until", mark: "bg2-done", what: "bg2.txt to appear", timeoutS: 90, optional: true, test: (ev) => ev.exists("bg2.txt") },
    { do: "until", mark: "s2-rest", what: "the session to rest", timeoutS: 90, optional: true, test: atRest("s2") },
  ],
  pre: [
    created("s2"),
    { what: "the transcript runs Bash with run_in_background", check: (ev) => (bgBash(ev.transcript("s2").main).length ? ok(String(bgBash(ev.transcript("s2").main)[0]!.input.command)) : no("no background Bash call")) },
    fileMade("bg.txt"),
  ],
  rubric: [
    {
      id: "S2.1",
      tell: "what",
      lane: "protocol",
      text: "The background command shows as a step that names what it runs.",
      pass: 'A Bash step whose label or detail carries the command itself ("sleep 75 && …"), not only the model\'s description of it.',
      fail: "No step for it, or a label and detail that do not show the command.",
      check: (ev) => {
        const s = snaps(ev, "s2").flatMap(stepsOf).find((x) => x.tool === "Bash");
        const said = s && [s.label, String(s.detail ?? "")].find((t) => /sleep 75 &&/.test(t));
        return said ? ok(said) : no(s ? `label "${s.label}", detail ${JSON.stringify(s.detail ?? null)}` : "no Bash step");
      },
    },
    stillRunning("S2.2a", "s2", "list-mid", "list", "the background command"),
    stillRunning("S2.2b", "s2", "mid-background", "thread", "the background command"),
    startTime("S2.3", "s2", (s) => s.tool === "Bash", "the background command", "mid-background", "mid-background"),
    finishShows("S2.4", "s2", "bg-done", "the background command"),
    unreadAfter("S2.5", "s2", "list-after"),
    stopOffered("S2.6", "s2", "mid-background", "mid-background", "the background command"),
    review("S2.7", "state", "Mid-background, the thread shows the command still running, with elapsed time and a Stop.", "Running indicator, elapsed time, Stop.", "The thread looks finished.", ["background-running"]),
    review("S2.8", "state", "After it finished, the thread shows the result.", "A done state or the wake turn's reply.", "Still shows running, or nothing changed.", ["after"]),
    {
      id: "S2.9",
      tell: "stop",
      lane: "protocol",
      text: '"Stop and send" stops the turn, not the background command the session started earlier.',
      pass: "A second background command (sleep 45, then bg2.txt) seen running before a send with interrupt still writes bg2.txt.",
      fail: "bg2.txt never appears: Stop and send killed the background command with the turn.",
      check: (ev) => {
        const at = mark(ev, "stop-and-send");
        if (at === undefined) return needMarks(ev, "stop-and-send")!;
        if (!ev.samples["bg2-before-stop-and-send"]?.length) return no("not judged: the background sleep 45 was not running when the user pressed Stop and send");
        const done = mark(ev, "bg2-done");
        return done !== undefined ? ok(`bg2.txt appeared ${Math.round((done - at) / 1000)} s after Stop and send`) : no("bg2.txt never appeared within 90 s of Stop and send");
      },
    },
    noAckOutput("S2.10", ["s2"]),
    comesToRest("S2.11", "s2", "bg-done", "the background command and the turn it woke"),
    noPhantomWork("S2.12", "s2"),
  ],
};

const S3: Scenario = {
  id: "S3",
  area: "sessions",
  title: "Background work finishes while the app is in the background",
  needsSimulator: false,
  journey: [
    "The user starts a background command from the phone, watches the thread, then leaves the app.",
    "The command finishes on the Mac while the app is in the background.",
    "They learn it finished without opening the app, and on return the thread shows the result.",
  ],
  setup: [
    { do: "create", name: "s3", prompt: BG("sleep 60 && echo bg-done > bg3.txt") },
    started("s3"),
    { do: "until", mark: "s3-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s3") },
    // With --sim the app is the phone: this socket stops watching and the app opens the thread instead.
    { do: "leave", name: "s3" },
    { do: "open-thread", name: "s3" },
    { do: "sleep", s: 4 },
    { do: "screenshot", shot: "thread-before" },
    { do: "app", to: "background", mark: "backgrounded" },
    { do: "until", mark: "bg-done", what: "bg3.txt to appear", timeoutS: 150, test: (ev) => ev.exists("bg3.txt") },
    { do: "sleep", s: 20 },
    { do: "mark", mark: "list-after" },
    { do: "screenshot", shot: "while-away" },
    { do: "app", to: "foreground", mark: "foregrounded" },
    { do: "sleep", s: 5 },
    { do: "screenshot", shot: "thread-after" },
    { do: "return", name: "s3" },
    { do: "sleep", s: 3 },
    { do: "until", mark: "s3-rest", what: "the session to rest", timeoutS: 90, optional: true, test: atRest("s3") },
  ],
  pre: [
    { what: "with --sim, the app on the leased simulator paired with the run's bridge", check: (ev) => (!ev.sim ? ok("protocol lane: the runner is the phone") : ev.paired ? ok("paired") : no("not paired within --pair-wait (see runner.md)")) },
    created("s3"),
    { what: "the transcript runs Bash with run_in_background", check: (ev) => (bgBash(ev.transcript("s3").main).length ? ok("yes") : no("no background Bash call")) },
    fileMade("bg3.txt"),
    { what: "the app went to the background before the command finished", check: (ev) => (mark(ev, "backgrounded")! < (mark(ev, "bg-done") ?? 0) ? ok("yes") : no("no")) },
  ],
  rubric: [
    {
      id: "S3.1",
      tell: "state",
      lane: "protocol",
      text: "A push tells the user the background work finished, and only once it did.",
      pass: "After bg-done, a push says a session finished, without the command or any other content; no push said finished while the command still ran.",
      fail: "No finished push after the work finished, one before it, or one that carries content.",
      check: (ev) => {
        const at = mark(ev, "bg-done");
        if (at === undefined) return needMarks(ev, "bg-done")!;
        const done = ev.pushes().filter((x) => FINISHED.test(x.body));
        const early = done.filter((x) => ev.atOf(x.at) < at - 2000);
        const after = done.filter((x) => ev.atOf(x.at) >= at - 2000);
        const leaky = ev.pushes().filter((x) => /sleep|bg3|bg-done|started/.test(`${x.title} ${x.body}`));
        if (early.length) return no(`a finished push ${Math.round((at - ev.atOf(early[0]!.at)) / 1000)} s before the command ended`);
        if (leaky.length) return no(`a push carries content: ${leaky[0]!.body}`);
        return after.length ? ok(after.map((x) => `${x.title ?? ""} ${x.body}`.trim()).join(" | ")) : no(`no finished push after bg-done (${ev.pushes().map((x) => x.body).join(" | ") || "no pushes"})`);
      },
    },
    {
      id: "S3.2",
      tell: "what",
      lane: "protocol",
      text: "Tapping that push opens the session.",
      pass: "The finished push's link is claudiobot://session/<the session id>.",
      fail: "No finished push, or a link elsewhere.",
      check: (ev) => {
        const p = ev.pushes().find((x) => FINISHED.test(x.body));
        return !p ? no("no finished push") : p.click === `claudiobot://session/${ev.ids.s3}` ? ok(p.click!) : no(`links to ${p.click}`);
      },
    },
    {
      ...unreadAfter("S3.3", "s3", "list-after"),
      pass: "With --sim, at mark list-after (the app in the background), the row is unread. On the protocol lane, where the suspended phone hears nothing, the first list it gets on its return (mark foregrounded-list) has the row unread.",
      check: (ev) => unreadAfter("S3.3", "s3", ev.sim ? "list-after" : "foregrounded-list").check!(ev),
    },
    finishShows("S3.4", "s3", "bg-done", "the background command"),
    review("S3.5", "state", "Before leaving, the thread shows the command running in the background.", "Running indicator with what runs.", "Looks finished.", ["thread-before"]),
    review("S3.6", "state", "While the app is away (Settings in front), a notification says the work finished.", "Notification banner or badge.", "Nothing.", ["while-away"]),
    review("S3.7", "state", "Back in the app, the thread shows the result, with no stale running indicator.", "Done state and the reply.", "Still running, or stale.", ["thread-after"]),
    noAckOutput("S3.8", ["s3"]),
    comesToRest("S3.9", "s3", "bg-done", "the background command and the turn it woke"),
  ],
};

const S4: Scenario = {
  id: "S4",
  area: "sessions",
  title: "A subagent fails, and the user stops one from the phone",
  needsSimulator: false,
  journey: [
    "The user's session starts two subagents: one fails at once, one runs a long command.",
    "They see which one failed and why.",
    "They press Stop while the other still runs, and see it stop: no step left spinning, the session at rest.",
  ],
  setup: [
    {
      do: "create",
      name: "s4",
      prompt:
        'In one message, launch 2 subagents in parallel with the Agent tool, both with run_in_background false. The first: subagent_type "no-such-agent-type", description "broken helper", prompt "Say hi." The second: subagent_type general-purpose, model haiku, description "long sleeper", prompt "Run exactly this Bash command in the foreground: perl -e \'sleep 45\' && echo late > late.txt . Then reply done." Use exactly these values even if one looks wrong. Then reply with one line saying what happened.',
    },
    started("s4"),
    { do: "open-thread", name: "s4" },
    // The tool call alone is not enough: it can sit behind its approval card. The command must run on the Mac.
    { do: "until", mark: "sleeper-running", what: "the sleeper's perl sleep 45 to run on the Mac", timeoutS: 150, test: (ev) => ev.procs("sleep 45").length > 0 },
    { do: "sleep", s: 8 },
    { do: "screenshot", shot: "running" },
    { do: "ps", pattern: "sleep 45", as: "before-stop" },
    { do: "stop", name: "s4", mark: "stopped" },
    { do: "until", mark: "s4-rest", what: "the session to rest after Stop", timeoutS: 60, optional: true, test: (ev) => !isWorking(last(ev, "s4")!) },
    { do: "sleep", s: 5 },
    { do: "ps", pattern: "sleep 45", as: "after-stop" },
    { do: "screenshot", shot: "stopped" },
    { do: "sleep", s: 45 },
    { do: "mark", mark: "late-window-over" },
  ],
  pre: [
    created("s4"),
    {
      what: "the transcript has a subagent call that failed",
      check: (ev) => {
        const { uses, results } = blocks(ev.transcript("s4").main);
        const failed = results.filter((r) => r.isError && uses.some((u) => u.id === r.id && AGENT_TOOLS.has(u.name)));
        return failed.length ? ok(failed[0]!.text.slice(0, 120)) : no("no failed Agent call");
      },
    },
    { what: "the sleeper's command ran on the Mac right before Stop (process sample before-stop)", check: (ev) => (ev.samples["before-stop"]?.length ? ok(ev.samples["before-stop"]!.join(" | ").slice(0, 160)) : no("no sleep 45 process in the seed project")) },
  ],
  rubric: [
    {
      id: "S4.1",
      tell: "state",
      lane: "protocol",
      text: "The failed subagent shows as failed, not done.",
      pass: "Its step is in state error.",
      fail: "Its step reads ok or stays running.",
      check: (ev) => {
        const s = snaps(ev, "s4").flatMap(stepsOf).filter((x) => AGENT_TOOLS.has(x.tool) && /broken/i.test(x.label)).at(-1);
        return s?.state === "error" ? ok(`${s.label}: error`) : no(s ? `${s.label}: ${s.state}` : "no step for the broken helper");
      },
    },
    {
      id: "S4.2",
      tell: "what",
      lane: "protocol",
      text: "The user can read why it failed.",
      pass: "The failed step carries output that names the cause.",
      fail: "No output on the failed step.",
      check: (ev) => {
        const s = snaps(ev, "s4").flatMap(stepsOf).filter((x) => AGENT_TOOLS.has(x.tool) && x.state === "error").at(-1);
        return s?.output ? ok(s.output.slice(0, 120)) : no("no output on an error step");
      },
    },
    {
      id: "S4.3",
      tell: "stop",
      lane: "protocol",
      text: "After Stop, nothing is left looking like it runs.",
      pass: "Within 30 s of Stop, no step is in state running.",
      fail: "A step still reads running 30 s after Stop.",
      check: (ev) => {
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const s = last(ev, "s4", at + 30_000);
        const running = s ? stepsOf(s).filter((x) => x.state === "running") : [];
        return running.length ? no(`still running: ${running.map((x) => `${x.label}`).join("; ")}`) : ok(`steps: ${s ? stepsOf(s).map((x) => `${x.label.slice(0, 30)}=${x.state}`).join("; ") : "none"}`);
      },
    },
    {
      id: "S4.4",
      tell: "stop",
      lane: "protocol",
      text: "After Stop, the session comes to rest.",
      pass: "Row not working and controls.working false within 30 s of Stop.",
      fail: "Still working 30 s after Stop.",
      check: (ev) => {
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const s = last(ev, "s4", at + 30_000);
        return s && !isWorking(s) ? ok(`row ${rowStatus(s)}, working ${s.controls?.working}`) : no(`row ${rowStatus(s)}, working ${s?.controls?.working}`);
      },
    },
    {
      id: "S4.5",
      tell: "stop",
      lane: "protocol",
      text: "The thread says the user stopped it, in the bridge's own words.",
      pass: 'After Stop, a notice from the bridge says so: its reason is "stop" and its text starts "Stopped by you". Claude Code\'s own "Interrupted" line and assistant prose do not count.',
      fail: "No bridge notice says it was stopped.",
      check: (ev) => {
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const it = notices(ev, "s4", at).find((i) => i.reason === "stop" && (i.text ?? "").startsWith("Stopped by you") && ev.atOf(i.at) >= at);
        const other = notices(ev, "s4", at).map((i) => `"${(i.text ?? "").slice(0, 60)}" reason ${String(i.reason ?? "-")}`);
        return it ? ok(`notice: ${(it.text ?? "").slice(0, 80)}`) : no(other.length ? `no stop notice; notices: ${other.join("; ")}` : "no notice after Stop");
      },
    },
    {
      id: "S4.6",
      tell: "stop",
      lane: "protocol",
      text: "Stop really stops the subagent's work on the Mac.",
      pass: "The sleeper's sleep 45 process ran before Stop (sample before-stop), is gone 5 s after the session rests (sample after-stop), and late.txt never appears, checked 50 s after Stop.",
      fail: "The process is still there after Stop, or late.txt appeared.",
      check: (ev) => {
        if (mark(ev, "late-window-over") === undefined) return needMarks(ev, "late-window-over")!;
        const before = ev.samples["before-stop"] ?? [];
        const after = ev.samples["after-stop"] ?? [];
        if (!before.length) return no("not judged: the sleeper's command was not seen running before Stop");
        if (after.length) return no(`still running after Stop: ${after.join(" | ").slice(0, 160)}`);
        return ev.exists("late.txt") ? no("late.txt exists") : ok(`ran as ${before.join(" | ").slice(0, 100)}; gone after Stop; late.txt absent`);
      },
    },
    review("S4.7", "state", "Mid-run, the failed subagent reads failed and the other running.", "Two distinct states.", "Same look for both.", ["running"]),
    review("S4.8", "stop", "After Stop, the thread reads stopped, no spinner.", "Stopped state.", "Spinner left.", ["stopped"]),
    {
      id: "S4.9",
      tell: "state",
      lane: "protocol",
      text: "The failed subagent reads failed as soon as Claude Code records the failure.",
      pass: "Its step first reads error within 2 s of the failed tool_result line in the transcript.",
      fail: "The step reads error later than 2 s after the transcript has the failure, or never.",
      check: (ev) => {
        const { uses, results } = blocks(ev.transcript("s4").main);
        const r = results.find((x) => x.isError && uses.some((u) => u.id === x.id && AGENT_TOOLS.has(u.name)));
        if (!r) return no("not judged: no failed Agent call in the transcript");
        const written = ev.atOf(r.at);
        const seen = snaps(ev, "s4").find((s) => stepsOf(s).some((x) => x.id === r.id && x.state === "error"))?.at;
        if (seen === undefined) return no("the failed Agent step never read error");
        const lag = seen - written;
        return lag <= 2000 ? ok(`error on the wire ${(lag / 1000).toFixed(1)} s after the transcript line`) : no(`error on the wire ${(lag / 1000).toFixed(1)} s after the transcript line`);
      },
    },
    noAckOutput("S4.10", ["s4"]),
    {
      id: "S4.11",
      tell: "state",
      lane: "protocol",
      text: "After the user stops the session, no push claims it finished or failed.",
      pass: "With --away, no push after mark stopped says the session finished or stopped with an error.",
      fail: "A finished or failed push follows the user's own Stop.",
      check: (ev) => {
        const away = awayOnly(ev);
        if (away) return away;
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const after = ev.pushes().filter((p) => ENDED.test(p.body) && ev.atOf(p.at) >= at);
        if (after.length) return no(`"${after[0]!.body}" ${Math.round((ev.atOf(after[0]!.at) - at) / 1000)} s after Stop`);
        // A run where nothing pushed at all cannot tell a held push from a broken one.
        if (!ev.pushes().length) return no("no push went out in the whole run, so the silence after Stop proves nothing");
        return ok(`${ev.pushes().map((p) => p.body).join(" | ")}; none an ending after Stop`);
      },
    },
  ],
};

const S5: Scenario = {
  id: "S5",
  area: "sessions",
  title: "A silent two-minute tool call",
  needsSimulator: false,
  journey: [
    "The user's session runs one command that prints nothing for two minutes.",
    "They watch the thread and must tell it is still alive, not stuck: what runs, for how long, and how to stop it.",
  ],
  holdCardsS: 10,
  setup: [
    { do: "create", name: "s5", prompt: "Run exactly this Bash command in the foreground (not in the background), with timeout 200000: perl -e 'sleep 120' && echo slept > slept.txt\nThen reply with one line: slept." },
    started("s5"),
    { do: "open-thread", name: "s5" },
    // The user takes 10 s to allow the card, so the call runs only once the process is there.
    { do: "until", mark: "call-running", what: "the perl sleep 120 to run on the Mac", timeoutS: 150, test: (ev) => ev.procs("sleep 120").length > 0 },
    { do: "sleep", s: 30 },
    { do: "screenshot", shot: "at-30s" },
    { do: "sleep", s: 60 },
    { do: "screenshot", shot: "at-90s" },
    { do: "until", mark: "call-done", what: "the sleep step to end", timeoutS: 120, test: (ev) => snaps(ev, "s5").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "ok")) },
    { do: "until", mark: "s5-ended", what: "the turn to end", timeoutS: 60, test: atRest("s5") },
  ],
  pre: [
    created("s5"),
    {
      what: "the transcript holds one foreground Bash call that took at least 110 s",
      check: (ev) => {
        const { uses, results } = blocks(ev.transcript("s5").main);
        const u = uses.find((x) => x.name === "Bash" && String(x.input.command).includes("sleep 120") && x.input.run_in_background !== true);
        const r = u && results.find((x) => x.id === u.id);
        const s = u && r ? (Date.parse(r.at) - Date.parse(u.at)) / 1000 : 0;
        return s >= 110 ? ok(`${Math.round(s)} s`) : no(u ? `took ${Math.round(s)} s` : "no foreground sleep 120");
      },
    },
    fileMade("slept.txt"),
  ],
  rubric: [
    {
      id: "S5.1",
      tell: "what",
      lane: "protocol",
      text: "While it runs, the thread names the command.",
      pass: "The running Bash step's label or detail carries the command itself (\"perl -e 'sleep 120' …\"), not only the model's description of it.",
      fail: "No label or detail, a generic one, or only a description such as \"Sleep 120 seconds\".",
      check: (ev) => {
        const s = snaps(ev, "s5").flatMap(stepsOf).find((x) => x.tool === "Bash" && x.state === "running");
        const said = s && [s.label, String(s.detail ?? "")].find((t) => /perl -e/.test(t));
        return said ? ok(said) : no(s ? `label "${s.label}", detail ${JSON.stringify(s.detail ?? null)}` : "never running");
      },
    },
    {
      id: "S5.2",
      tell: "state",
      lane: "protocol",
      text: "For the whole two minutes the session reads working and the step running.",
      pass: "Every state from call-running to call-done has a running step and a working row.",
      fail: "Some state in the window reads idle or shows no running step.",
      check: (ev) => {
        const w = span(ev, "call-running", "call-done");
        if (!w) return needMarks(ev, "call-running", "call-done")!;
        // The call-done mark lands a poll after the step finishes; the window ends at the first state it no longer runs.
        const end = snaps(ev, "s5", w[0]).find((s) => !stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running"))?.at ?? w[1];
        const xs = during(ev, "s5", w[0], end - 1);
        const bad = xs.filter((s) => !(stepsOf(s).some((x) => x.state === "running") && s.row?.status === "working"));
        return bad.length ? no(`${bad.length}/${xs.length} states: ${statuses(bad)}`) : ok(`${xs.length} states, all running and working`);
      },
    },
    startTime("S5.3", "s5", (s) => s.tool === "Bash", "the command"),
    {
      id: "S5.4",
      tell: "state",
      lane: "protocol",
      text: "The phone can tell a long silent call from a stuck one: something reaches it at least every 30 s.",
      pass: "During the call, the longest gap between frames about this session is at most 30 s.",
      fail: "A gap longer than 30 s: the phone sees nothing and cannot tell alive from stuck (unless it shows its own elapsed clock).",
      check: (ev) => {
        const w = span(ev, "call-running", "call-done");
        if (!w) return needMarks(ev, "call-running", "call-done")!;
        const ts = [w[0], ...ev.frameTimes.filter((f) => f.name === "s5" && f.at > w[0] && f.at < w[1]).map((f) => f.at), w[1]];
        const gap = Math.max(...ts.slice(1).map((t, i) => t - ts[i]!));
        return gap <= 30_000 ? ok(`longest gap ${Math.round(gap / 1000)} s`) : no(`longest gap ${Math.round(gap / 1000)} s over a ${Math.round((w[1] - w[0]) / 1000)} s call`);
      },
    },
    stopOffered("S5.5", "s5", "call-running", "call-done", "the command"),
    {
      id: "S5.6",
      tell: "state",
      lane: "protocol",
      text: "When it ends, the step reads done and the reply follows.",
      pass: "The Bash step ends ok and an assistant item follows.",
      fail: "The step or the reply is missing.",
      check: (ev) => {
        const s = last(ev, "s5");
        const done = s && stepsOf(s).some((x) => x.tool === "Bash" && x.state === "ok");
        const reply = s?.items.some((i) => i.kind === "assistant");
        return done && reply ? ok("step ok, reply present") : no(`step ok: ${!!done}, reply: ${!!reply}`);
      },
    },
    review("S5.7", "how-long", "At 30 s and 90 s the thread looks alive: a running indicator and an elapsed time that moves.", "Elapsed time differs between the two shots.", "Identical frozen screens.", ["at-30s", "at-90s"]),
    {
      id: "S5.8",
      tell: "state",
      lane: "protocol",
      text: "While the command waits on its approval card, the thread says it waits, not that it runs.",
      pass: "In every state with the Bash card open (the user takes 10 s to allow), the Bash step is on the wire in state waiting.",
      fail: "A state with the card open shows the step running, or shows no step.",
      check: (ev) => {
        const open = snaps(ev, "s5").filter((s) => s.items.some((i) => i.kind === "permission" && i.card?.answer === null));
        if (!open.length) return no("not judged: no state had the card open");
        const bad = open.filter((s) => !stepsOf(s).some((x) => x.tool === "Bash" && x.state === "waiting"));
        const seen = [...new Set(bad.map((s) => stepsOf(s).filter((x) => x.tool === "Bash").map((x) => x.state).join(",") || "no step"))].join(" / ");
        return bad.length ? no(`${bad.length}/${open.length} states with the card open: Bash step ${seen}`) : ok(`${open.length} states, the step waiting in each`);
      },
    },
    noAckOutput("S5.9", ["s5"]),
  ],
};

const S6: Scenario = {
  id: "S6",
  area: "sessions",
  title: "Reconnect in the middle of a run, then a crash and a bridge restart",
  needsSimulator: false,
  journey: [
    "The user watches a command run; the phone loses its connection for 15 s and comes back while it still runs.",
    "It drops again, half-open this time (no close reaches either side), and comes back only after the turn ended.",
    "Each time, the thread must show the truth at once: still running, then done, with no duplicates, in the same order as a fresh open.",
    "Offline once more, the user sends a message; it goes out when the phone is back, and its command runs.",
    "Claude Code crashes mid-command, then the Mac's bridge restarts. The thread and the row must say the run failed, and keep saying it.",
  ],
  setup: [
    { do: "create", name: "s6", prompt: "Run exactly this Bash command in the foreground (not in the background): perl -e 'sleep 40' && echo hi > s6.txt\nThen reply with one line: done." },
    started("s6"),
    { do: "open-thread", name: "s6" },
    { do: "until", mark: "call-running", what: "the sleep step to run", timeoutS: 120, test: (ev) => snaps(ev, "s6").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running")) },
    { do: "sleep", s: 3 },
    { do: "reconnect", afterS: 15, mark: "resume-1" },
    { do: "screenshot", shot: "after-resume-1" },
    { do: "reconnect", how: "half-open", afterS: 15, mark: "resume-2", until: { what: "s6.txt and the end of the turn while offline", timeoutS: 120, test: (ev) => ev.exists("s6.txt") } },
    { do: "until", mark: "s6-ended", what: "the turn to end", timeoutS: 60, test: atRest("s6") },
    { do: "screenshot", shot: "after-resume-2" },
    {
      do: "reconnect",
      afterS: 3,
      mark: "resume-3",
      compare: false,
      send: { name: "s6", text: "Run exactly this Bash command in the foreground (not in the background): perl -e 'sleep 90'\nThen reply with one line: done." },
    },
    { do: "until", mark: "second-running", what: "the perl sleep 90 sent while offline to run on the Mac", timeoutS: 150, test: (ev) => ev.procs("sleep 90").length > 0 },
    { do: "sleep", s: 3 },
    { do: "kill-claude", name: "s6", mark: "killed" },
    { do: "until", mark: "s6-rest-after-kill", what: "the session to rest after the crash", timeoutS: 30, optional: true, test: (ev) => !isWorking(last(ev, "s6")!) },
    { do: "sleep", s: 5 },
    { do: "mark", mark: "after-kill" },
    { do: "screenshot", shot: "after-kill" },
    { do: "restart-bridge", mark: "restarted" },
    { do: "sleep", s: 8 },
    { do: "mark", mark: "after-restart" },
    { do: "screenshot", shot: "after-restart" },
  ],
  pre: [
    created("s6"),
    fileMade("s6.txt"),
    { what: "both compared reconnects happened", check: (ev) => (ev.resumes.length === 2 ? ok(ev.resumes.map((r) => `${r.mark} ${r.how}: ${r.reply}`).join(", ")) : no(`${ev.resumes.length} reconnects`)) },
    { what: "each reconnect resumed the stream from the phone's position, as the app's does (hello resumed)", check: (ev) => (ev.resumes.every((r) => r.resumed) ? ok(ev.resumes.map((r) => `${r.mark}: ${r.replayed} frames replayed`).join(", ")) : no(ev.resumes.map((r) => `${r.mark}: resumed ${r.resumed}`).join(", "))) },
    { what: "Claude Code was killed while the command sent offline ran", check: (ev) => (ev.samples["kill-claude"]?.length ? ok(ev.samples["kill-claude"]!.join(" | ").slice(0, 160)) : no("no Claude Code process was killed")) },
    { what: "the bridge restarted", check: (ev) => (mark(ev, "after-restart") !== undefined ? ok("yes") : no("no")) },
  ],
  rubric: [
    {
      id: "S6.1",
      tell: "state",
      lane: "protocol",
      text: "Reconnecting while the command runs shows it still running.",
      pass: "After resume-1 the resumed thread has the Bash step running and controls.working true.",
      fail: "The resumed thread reads done or idle while the command runs.",
      check: (ev) => {
        const r = ev.resumes.find((x) => x.mark === "resume-1");
        if (!r) return no("no resume-1");
        const running = r.items.flatMap((i) => i.steps ?? []).some((s) => s.tool === "Bash" && s.state === "running");
        return running && r.resumedControls?.working ? ok(`${r.reply}; step running, working`) : no(`${r.reply}; step running ${running}, working ${r.resumedControls?.working}`);
      },
    },
    {
      id: "S6.2",
      tell: "state",
      lane: "protocol",
      text: "Reconnecting after the turn ended shows it done, without reopening the thread.",
      pass: "After resume-2 the resumed thread has the step ok, an assistant reply, and controls.working false.",
      fail: "The resumed thread still reads running, or lacks the reply.",
      check: (ev) => {
        const r = ev.resumes.find((x) => x.mark === "resume-2");
        if (!r) return no("no resume-2");
        const done = r.items.flatMap((i) => i.steps ?? []).some((s) => s.tool === "Bash" && s.state === "ok");
        const reply = r.items.some((i) => i.kind === "assistant");
        return done && reply && r.resumedControls?.working === false ? ok(`${r.reply}; done, reply, at rest`) : no(`${r.reply}; done ${done}, reply ${reply}, working ${r.resumedControls?.working}`);
      },
    },
    {
      id: "S6.3",
      tell: "what",
      lane: "protocol",
      text: "The resumed thread equals a fresh open: no duplicates, nothing missing, same contents, same order.",
      pass: "For both resumes, the resumed items equal a fresh snapshot's item for item, as JSON, in order.",
      fail: "The resumed view differs from a fresh open in an item, a field or the order.",
      check: (ev) => {
        const tag = (i: Item | undefined) => (i ? `${i.kind}:${i.id}` : "nothing");
        const diffs = ev.resumes.flatMap((r) => {
          const n = Math.max(r.items.length, r.fresh.length);
          const k = Array.from({ length: n }, (_, i) => i).find((i) => JSON.stringify(r.items[i]) !== JSON.stringify(r.fresh[i]));
          if (k === undefined) return [];
          const same = tag(r.items[k]) === tag(r.fresh[k]);
          const field = same ? Object.keys({ ...r.items[k], ...r.fresh[k] }).filter((f) => JSON.stringify(r.items[k]![f]) !== JSON.stringify(r.fresh[k]![f])) : [];
          return [`${r.mark}: item ${k + 1} is ${tag(r.items[k])} resumed but ${tag(r.fresh[k])} fresh${field.length ? ` (differs in ${field.join(", ")})` : ""}; resumed ${r.items.map(tag).join(",")} vs fresh ${r.fresh.map(tag).join(",")}`];
        });
        return ev.resumes.length && !diffs.length ? ok(`${ev.resumes.length} resumes equal a fresh open, in order`) : no(diffs.join("; ") || "no resumes");
      },
    },
    {
      id: "S6.4",
      tell: "state",
      lane: "protocol",
      text: "After each reconnect, the Sessions list shows the row's current state.",
      pass: "The list frame after resume-1 shows working, after resume-2 idle.",
      fail: "The list row lags behind the thread.",
      check: (ev) => {
        const st = ev.resumes.map((r) => r.rows.find((x) => x.id === ev.ids.s6)?.status ?? "missing");
        return st[0] === "working" && st[1] === "idle" ? ok(st.join(" then ")) : no(st.join(" then "));
      },
    },
    startTime("S6.5", "s6", (s) => s.tool === "Bash", "the command"),
    review("S6.6", "state", "Right after each reconnect, the thread on screen matches the truth.", "Running after resume-1, done after resume-2.", "Stale state.", ["after-resume-1", "after-resume-2"]),
    {
      id: "S6.7",
      tell: "state",
      lane: "protocol",
      text: "When Claude Code dies mid-command, nothing keeps reading running, and the row says the run failed and why.",
      pass: "At mark after-kill (5 s after the session rests), no step reads running, the row reads failed, and row.outcome carries the cause.",
      fail: "A step still reads running, the row is not failed, or the row gives no cause.",
      check: (ev) => {
        const at = mark(ev, "after-kill");
        if (at === undefined) return needMarks(ev, "after-kill")!;
        const s = last(ev, "s6", at);
        if (!s) return no("no state seen");
        const running = stepsOf(s).filter((x) => x.state === "running").map((x) => x.label);
        const outcome = s.row?.outcome as { kind?: string; text?: string } | null | undefined;
        const bad = [running.length ? `still running: ${running.join("; ")}` : "", s.row?.status !== "failed" ? `row ${rowStatus(s)}` : "", outcome?.text ? "" : "the row carries no outcome cause"].filter(Boolean);
        return bad.length ? no(bad.join("; ")) : ok(`no running step; row failed: ${outcome!.text}`);
      },
    },
    {
      id: "S6.8",
      tell: "state",
      lane: "protocol",
      text: "The failure outlives a bridge restart: the row and the thread still say the run failed.",
      pass: "At mark after-restart, the row reads failed (or its outcome is failed or lost) and the thread still holds a notice that says the run failed or that the bridge restarted.",
      fail: "After the restart the row reads idle, or the thread lost the notice.",
      check: (ev) => {
        const at = mark(ev, "after-restart");
        if (at === undefined) return needMarks(ev, "after-restart")!;
        const s = last(ev, "s6", at);
        if (!s) return no("no state seen");
        const outcome = s.row?.outcome as { kind?: string } | null | undefined;
        const rowFailed = s.row?.status === "failed" || ["failed", "lost"].includes(outcome?.kind ?? "");
        const notice = s.items.find((i) => i.kind === "notice" && (i.tone === "error" || ["failure", "restart"].includes(String(i.reason))));
        const bad = [rowFailed ? "" : `row ${rowStatus(s)}, outcome ${outcome?.kind ?? "none"}`, notice ? "" : "no failure or restart notice in the thread"].filter(Boolean);
        return bad.length ? no(bad.join("; ")) : ok(`row ${rowStatus(s)}; notice "${(notice!.text ?? "").slice(0, 80)}"`);
      },
    },
    noAckOutput("S6.9", ["s6"]),
  ],
};

const bashDone = (f: Frame) => ((f.items as Item[] | undefined) ?? []).some((i) => (i.steps ?? []).some((x) => x.tool === "Bash" && x.state === "ok"));
/** The frame lost on its way to the app, and what passed after it, in the order the relay saw them (several can share a millisecond). */
const lossAndRewatch = (ev: Ev) => {
  const sid = ev.ids.s6b;
  const at = ev.app.findIndex((x) => x.dir === "lost" && x.frame.sessionId === sid);
  const lost = at === -1 ? undefined : ev.app[at];
  const later = at === -1 ? [] : ev.app.slice(at + 1).filter((x) => x.frame.sessionId === sid);
  const w = later.findIndex((x) => x.dir === "out" && x.frame.type === "watch_session");
  const watch = w === -1 ? undefined : later[w];
  const next = later.find((x) => x.dir === "in" && x.frame.type === "session_items");
  const snap = w === -1 ? undefined : later.slice(w + 1).find((x) => x.dir === "in" && x.frame.type === "session");
  return { lost, next, watch, snap };
};

const S6b: Scenario = {
  id: "S6b",
  area: "sessions",
  title: "A thread frame lost on its way to the app",
  needsSimulator: true,
  tapApp: true,
  journey: [
    "The user watches a command run in the app. The one frame that says it finished never reaches the phone, as a flaky link or a frame the app cannot read would lose it.",
    "The app must see the gap in the thread's revs on the next frame, ask for the thread again, and show the command done, as a fresh open would, with nothing for the user to do.",
  ],
  setup: [
    { do: "create", name: "s6b", prompt: "Run exactly this Bash command in the foreground (not in the background): perl -e 'sleep 12' && echo hi > s6b.txt\nThen reply with one line: done." },
    started("s6b"),
    { do: "open-thread", name: "s6b" },
    { do: "until", mark: "call-running", what: "the sleep step to run", timeoutS: 120, test: (ev) => snaps(ev, "s6b").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running")) },
    { do: "lose-frame", name: "s6b", mark: "lost", what: "the frame that says the command is done", timeoutS: 120, test: (f) => f.type === "session_items" && bashDone(f) },
    { do: "until", mark: "s6b-ended", what: "the turn to end", timeoutS: 90, test: atRest("s6b") },
    { do: "sleep", s: 4 },
    { do: "screenshot", shot: "after-loss" },
  ],
  pre: [
    created("s6b"),
    { what: "the app was paired", check: (ev) => (ev.paired ? ok("yes") : no("no")) },
    { what: "one frame was lost on its way to the app", check: (ev) => (lossAndRewatch(ev).lost ? ok(`session_items rev ${lossAndRewatch(ev).lost!.frame.rev}`) : no("nothing was lost")) },
  ],
  rubric: [
    {
      id: "S6b.1",
      tell: "state",
      lane: "protocol",
      text: "The app notices the lost frame and asks for the thread again, from scratch.",
      pass: "The app sends watch_session for the session with after null within 2 s of the first thread frame that reached it after the loss.",
      fail: "The app never watches the thread again, asks to resume from a position past the loss, or waits longer than 2 s.",
      check: (ev) => {
        const { lost, next, watch } = lossAndRewatch(ev);
        if (!lost) return no("not judged: nothing was lost");
        if (!watch) return no(`the app never watched the thread again${next ? `; rev ${next.frame.rev} reached it` : ""}`);
        if (watch.frame.after !== null) return no(`it asked to resume after ${JSON.stringify(watch.frame.after)}`);
        const lag = watch.at - (next?.at ?? lost.at);
        return lag <= 2000 ? ok(`lost rev ${lost.frame.rev}; rev ${next?.frame.rev} came next; watched again ${(lag / 1000).toFixed(1)} s later, for a snapshot`) : no(`watched again ${(lag / 1000).toFixed(1)} s after the next frame`);
      },
    },
    {
      id: "S6b.2",
      tell: "state",
      lane: "protocol",
      text: "What the lost frame said reaches the app anyway.",
      pass: "After that watch, a snapshot of the session reaches the app with the Bash step ok.",
      fail: "No snapshot reaches the app, or it lacks the finished step.",
      check: (ev) => {
        const { watch, snap } = lossAndRewatch(ev);
        if (!watch) return no("not judged: the app never watched again");
        if (!snap) return no("no snapshot reached the app");
        return bashDone(snap.frame) ? ok(`snapshot rev ${snap.frame.rev} with the command done, ${((snap.at - watch.at) / 1000).toFixed(1)} s after the watch`) : no("the snapshot has no finished Bash step");
      },
    },
    review("S6b.3", "state", "The thread on screen shows the command done and the reply, with nothing left running.", "A done step and the reply.", "A step still running after the turn ended, or no reply.", ["after-loss"]),
  ],
};

const S6c: Scenario = {
  id: "S6c",
  area: "sessions",
  title: "A background command that outlives a bridge restart",
  needsSimulator: false,
  journey: [
    "The user starts a long command in the background; the turn ends at once.",
    "The Mac's bridge restarts while the command runs. Claude Code goes with it, but the command keeps running.",
    "The thread must say the command still runs, never that it stopped, and Stop must end it on the Mac.",
  ],
  setup: [
    { do: "create", name: "s6c", prompt: BG("sleep 420 && echo late > s6c.txt") },
    started("s6c"),
    { do: "until", mark: "s6c-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s6c") },
    { do: "until", mark: "bg-running", what: "the sleep 420 to run on the Mac", timeoutS: 60, test: (ev) => ev.procs("sleep 420").length > 0 },
    { do: "sleep", s: 3 },
    { do: "restart-bridge", mark: "restarted" },
    { do: "sleep", s: 8 },
    { do: "ps", pattern: "sleep 420", as: "after-restart" },
    { do: "mark", mark: "after-restart" },
    { do: "send", name: "s6c", text: "Reply with the single word hi.", mark: "sent" },
    { do: "until", mark: "replied", what: "the turn of the message sent after the restart to end", timeoutS: 120, test: (ev) => turnRan(ev, "s6c", "sent") },
    { do: "sleep", s: 3 },
    { do: "ps", pattern: "sleep 420", as: "after-send" },
    { do: "mark", mark: "after-send" },
    { do: "stop", name: "s6c", mark: "stopped" },
    { do: "until", mark: "s6c-rest", what: "the session to rest after Stop", timeoutS: 30, optional: true, test: atRest("s6c") },
    { do: "sleep", s: 3 },
    { do: "ps", pattern: "sleep 420", as: "after-stop" },
  ],
  pre: [
    created("s6c"),
    { what: "the bridge restarted", check: (ev) => (mark(ev, "after-restart") !== undefined ? ok("yes") : no("no")) },
    { what: "the command outlived the restart (process sample after-restart)", check: (ev) => (ev.samples["after-restart"]?.length ? ok(ev.samples["after-restart"]!.join(" | ").slice(0, 160)) : no("no sleep 420 process after the restart")) },
  ],
  rubric: [
    {
      id: "S6c.1",
      tell: "state",
      lane: "protocol",
      text: "After the restart the thread says the command still runs and Stop ends it, never that it stopped, and its step still runs.",
      pass: 'Between the command starting on the Mac and Stop, no notice says the background work stopped and one says "which still runs on this Mac. Stop ends it"; at mark after-restart the Bash step reads running.',
      fail: "A notice says the background work stopped, none says it still runs, or the step reads anything but running.",
      check: (ev) => {
        const at = mark(ev, "bg-running");
        const until = mark(ev, "stopped");
        const seen = mark(ev, "after-restart");
        if (at === undefined || until === undefined || seen === undefined) return needMarks(ev, "bg-running", "stopped", "after-restart")!;
        const said = notices(ev, "s6c", at)
          .filter((i) => ev.atOf(i.at) >= at && ev.atOf(i.at) <= until)
          .map((i) => i.text ?? "");
        const lie = said.find((t) => /background work stopped/i.test(t));
        const runs = said.find((t) => /which still runs on this Mac\. Stop ends it/.test(t));
        const step = stepsOf(last(ev, "s6c", seen)!).find((x) => x.tool === "Bash");
        if (lie) return no(`said: ${lie.slice(0, 120)}`);
        if (!runs) return no(`no notice says it still runs; notices: ${said.join(" | ").slice(0, 160) || "none"}`);
        return step?.state === "running" ? ok(runs.slice(0, 120)) : no(`the Bash step reads ${step?.state ?? "nothing"} ${step?.cause ?? ""}`);
      },
    },
    {
      id: "S6c.2",
      tell: "stop",
      lane: "protocol",
      text: "After the restart the session reads working with the command as a task, so Stop is offered.",
      pass: "At mark after-restart, controls.working is true and controls.tasks names the command.",
      fail: "The session rests, or no task names the command.",
      check: (ev) => {
        const at = mark(ev, "after-restart");
        if (at === undefined) return needMarks(ev, "after-restart")!;
        const s = last(ev, "s6c", at);
        const task = (s?.controls?.tasks ?? []).find((t) => /sleep 420/.test(String((t as { label?: unknown }).label)));
        return s?.controls?.working === true && task ? ok(`working; task ${String((task as { label?: unknown }).label).slice(0, 60)}`) : no(`working ${s?.controls?.working}; tasks ${(s?.controls?.tasks ?? []).length}`);
      },
    },
    {
      id: "S6c.4",
      tell: "state",
      lane: "protocol",
      text: "A message sent after the restart does not bring back a claim that the command stopped: it still runs and shows so.",
      pass: "The sleep 420 still runs (sample after-send); at mark after-send controls.tasks names it, the Bash step reads running, and no notice since the message says it stopped or did not finish.",
      fail: "The process is gone, no task names it, the step reads stopped, or a notice says it stopped or did not finish.",
      check: (ev) => {
        const sent = mark(ev, "sent");
        const at = mark(ev, "after-send");
        if (sent === undefined || at === undefined) return needMarks(ev, "sent", "after-send")!;
        if (!(ev.samples["after-send"] ?? []).length) return no("not judged: the sleep 420 was not running after the message");
        const s = last(ev, "s6c", at)!;
        const task = (s.controls?.tasks ?? []).some((t) => /sleep 420/.test(String((t as { label?: unknown }).label)));
        const step = stepsOf(s).find((x) => x.tool === "Bash");
        const claim = notices(ev, "s6c", sent).find((i) => ev.atOf(i.at) >= sent && ev.atOf(i.at) <= at && /stopped|didn.t finish|did not finish/i.test(i.text ?? ""));
        const bad = [task ? "" : "no task names it", step?.state === "running" ? "" : `step ${step?.state} ${step?.cause ?? ""}`, claim ? `notice: ${(claim.text ?? "").slice(0, 80)}` : ""].filter(Boolean);
        return bad.length ? no(bad.join("; ")) : ok("still a task, step running, no claim");
      },
    },
    {
      id: "S6c.3",
      tell: "stop",
      lane: "protocol",
      text: "Stop ends the command on the Mac, and the thread says the user stopped it.",
      pass: 'The sleep 420 is gone 3 s after the session rests (sample after-stop), and a notice that starts "Stopped by you" follows Stop.',
      fail: "The process still runs after Stop, or no stop notice.",
      check: (ev) => {
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const after = ev.samples["after-stop"] ?? [];
        const said = notices(ev, "s6c", at).find((i) => i.reason === "stop" && (i.text ?? "").startsWith("Stopped by you") && ev.atOf(i.at) >= at);
        if (after.length) return no(`still running after Stop: ${after.join(" | ").slice(0, 160)}`);
        return said ? ok(`gone after Stop; notice: ${(said.text ?? "").slice(0, 80)}`) : no("gone after Stop, but no stop notice");
      },
    },
  ],
};

/** The bridge's notices that a command it followed ended. */
const endedSaid = (ev: Ev, name: string) => notices(ev, name).filter((i) => /ended\. Claude Code no longer followed/.test(i.text ?? ""));

/** Every Bash step of the session in its latest snapshot at or before `at`. */
const bashSteps = (ev: Ev, name: string, at: number) => stepsOf(last(ev, name, at) ?? ({ items: [] } as unknown as Snap)).filter((x) => x.tool === "Bash");

const S6d: Scenario = {
  id: "S6d",
  area: "sessions",
  title: "Background commands the bridge cannot check after a restart",
  needsSimulator: false,
  journey: [
    "Two long commands run in the background. One sends its output elsewhere at once, the other a little later, so after the bridge restarts it cannot prove either is still the command.",
    "Both end on their own. The thread must never show them running forever: once the bridge cannot tell, the steps say so and stop spinning, and the session rests.",
  ],
  setup: [
    { do: "create", name: "vu1", prompt: BG("exec >/dev/null 2>&1; sleep 51") },
    started("vu1"),
    { do: "until", mark: "vu1-ended", what: "vu1's turn to end", timeoutS: 180, test: turnEnded("vu1") },
    { do: "create", name: "vu2", prompt: BG("sleep 25; exec >/dev/null 2>&1; sleep 52") },
    started("vu2"),
    { do: "until", mark: "vu2-ended", what: "vu2's turn to end", timeoutS: 180, test: turnEnded("vu2") },
    { do: "until", mark: "bg-running", what: "both commands to run on the Mac", timeoutS: 60, test: (ev) => ev.procs("sleep 51").length > 0 && ev.procs("sleep 25").length > 0 },
    { do: "restart-bridge", mark: "restarted" },
    { do: "sleep", s: 8 },
    { do: "mark", mark: "after-restart" },
    { do: "until", mark: "vu1-gone", what: "vu1's command to end", timeoutS: 150, test: (ev) => ev.procs("sleep 51").length === 0 },
    { do: "until", mark: "vu2-gone", what: "vu2's command to end", timeoutS: 150, test: (ev) => ev.procs("sleep 52").length === 0 && ev.procs("sleep 25").length === 0 },
    { do: "until", mark: "all-gone", what: "both commands to end", timeoutS: 150, test: (ev) => ev.procs("sleep 51").length === 0 && ev.procs("sleep 52").length === 0 && ev.procs("sleep 25").length === 0 },
    { do: "sleep", s: 10 },
    { do: "mark", mark: "after-ended" },
    { do: "sleep", s: 30 },
    { do: "mark", mark: "after-ended-40s" },
    { do: "until", mark: "ended-said", what: "the bridge to say each command ended", timeoutS: 240, optional: true, test: (ev) => ["vu1", "vu2"].every((n) => endedSaid(ev, n).length > 0) },
    { do: "sleep", s: 5 },
    { do: "mark", mark: "after-said" },
  ],
  pre: [created("vu1"), created("vu2"), { what: "the bridge restarted", check: (ev) => (mark(ev, "after-restart") !== undefined ? ok("yes") : no("no")) }],
  rubric: [
    {
      id: "S6d.1",
      tell: "state",
      lane: "protocol",
      text: "Once the bridge cannot tell whether a command still runs, its step stops spinning and says so, and the session rests; one it still follows reads running.",
      pass: 'At mark after-restart, vu1\'s Bash step is in state "unsure" with a cause that says the bridge cannot tell, and vu1 is not working; vu2\'s step is running with a task that names it, or already unsure; neither reads stopped.',
      fail: "vu1's step reads anything but unsure, or vu1 reads working; or vu2's step reads stopped, or running with no task.",
      check: (ev) => {
        const at = mark(ev, "after-restart");
        if (at === undefined) return needMarks(ev, "after-restart")!;
        const step = bashSteps(ev, "vu1", at)[0];
        const s = last(ev, "vu1", at);
        if (!step) return no("no Bash step for vu1");
        if (step.state !== "unsure" || !/can.t tell/i.test(step.cause ?? "")) return no(`vu1 step ${step.state} ${step.cause ?? ""}`);
        if (!s || isWorking(s)) return no(`vu1 reads working: row ${rowStatus(s)}, working ${s?.controls?.working}`);
        const step2 = bashSteps(ev, "vu2", at)[0];
        const s2 = last(ev, "vu2", at);
        const task2 = (s2?.controls?.tasks ?? []).some((t) => /sleep 25/.test(String((t as { label?: unknown }).label)));
        const vu2ok = step2?.state === "unsure" || (step2?.state === "running" && task2);
        return vu2ok ? ok(`vu1: ${step.cause}; vu2: ${step2!.state}`) : no(`vu2 step ${step2?.state} ${step2?.cause ?? ""}, task ${task2}`);
      },
    },
    {
      id: "S6d.2",
      tell: "state",
      lane: "protocol",
      text: "After both commands ended, neither thread shows a step running and neither session works, 10 s and 40 s later.",
      pass: "At marks after-ended and after-ended-40s, no Bash step of vu1 or vu2 reads running, and neither reads working.",
      fail: "A step still reads running, or a session reads working.",
      check: (ev) => {
        const marks = [mark(ev, "after-ended"), mark(ev, "after-ended-40s")];
        if (marks.some((m) => m === undefined)) return needMarks(ev, "after-ended", "after-ended-40s")!;
        const bad = marks.flatMap((at) =>
          ["vu1", "vu2"].flatMap((name) => {
            const s = last(ev, name, at!);
            const running = bashSteps(ev, name, at!).filter((x) => x.state === "running");
            return [...(running.length ? [`${name} step running at ${Math.round(at! / 1000)} s`] : []), ...(s && isWorking(s) ? [`${name} working at ${Math.round(at! / 1000)} s`] : [])];
          }),
        );
        return bad.length ? no(bad.join("; ")) : ok("both settled, neither working");
      },
    },
    {
      id: "S6d.3",
      tell: "state",
      lane: "protocol",
      text: "Each command's end is said once, whether the bridge knew its process group or found it only by its command line.",
      pass: 'By mark after-said, vu1 and vu2 each hold exactly one notice that the command "ended", said no earlier than 1 s before the run saw that command\'s process gone, and each Bash step is in state "ended", neither stopped nor unsure.',
      fail: "A thread never says its command ended, says it twice, says it while the process still ran, or its step reads anything but ended.",
      check: (ev) => {
        const at = mark(ev, "after-said");
        if (at === undefined) return no("the bridge never said both commands ended (mark ended-said not reached)");
        const bad = ["vu1", "vu2"].flatMap((n) => {
          const said = endedSaid(ev, n);
          const gone = mark(ev, `${n}-gone`);
          const step = bashSteps(ev, n, at)[0];
          return [
            ...(said.length === 1 ? [] : [`${n}: ${said.length} ended notices`]),
            ...(gone === undefined ? [`${n}: never seen gone`] : said.some((i) => ev.atOf(i.at) < gone - 1000) ? [`${n}: said ended ${((gone - ev.atOf(said[0]!.at)) / 1000).toFixed(1)} s before its process was gone`] : []),
            ...(step?.state === "ended" ? [] : [`${n}: step ${step?.state}`]),
          ];
        });
        return bad.length ? no(bad.join("; ")) : ok("each said ended once, after its process was gone; steps ended");
      },
    },
  ],
};

const S4b: Scenario = {
  id: "S4b",
  area: "sessions",
  title: "Stop one background task while nothing else runs",
  needsSimulator: false,
  journey: [
    "The only thing running is one background command. The user stops just that task.",
    "Claude Code queues a note about the stopped task but starts no turn for it, so the session must come to rest, not read working.",
  ],
  setup: [
    { do: "create", name: "s4b", prompt: BG("sleep 305") },
    started("s4b"),
    { do: "until", mark: "s4b-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s4b") },
    { do: "until", mark: "bg-running", what: "the sleep 305 to run on the Mac", timeoutS: 60, test: (ev) => ev.procs("sleep 305").length > 0 },
    { do: "sleep", s: 2 },
    { do: "stop", name: "s4b", task: "sleep 305", mark: "stopped" },
    ...[2, 5, 10, 15, 20, 25].flatMap((t, i, all): Action[] => [{ do: "sleep", s: t - (all[i - 1] ?? 0) }, { do: "mark", mark: `stop-${t}s` }]),
    { do: "ps", pattern: "sleep 305", as: "after-stop" },
  ],
  pre: [created("s4b")],
  rubric: [
    {
      id: "S4b.1",
      tell: "stop",
      lane: "protocol",
      text: "After stopping the only running task, the session rests, shows no turn that never started, and says only what stopped.",
      pass: 'At marks 2, 5, 10, 15, 20 and 25 s after the stop, controls.working is false, controls.turn is absent and the row is not working; the Bash step reads stopped "Stopped by you"; no notice says the turn was stopped; the sleep 305 is gone.',
      fail: "The session reads working or shows a wake turn at any mark, the step reads otherwise, a notice claims the turn stopped, or the command still runs.",
      check: (ev) => {
        const at = [2, 5, 10, 15, 20, 25].map((t) => mark(ev, `stop-${t}s`));
        const stopped = mark(ev, "stopped");
        if (stopped === undefined || at.some((m) => m === undefined)) return needMarks(ev, "stopped", "stop-25s")!;
        if ((ev.samples["after-stop"] ?? []).length) return no(`still running: ${ev.samples["after-stop"]!.join(" | ").slice(0, 120)}`);
        const bad = at.flatMap((m) => {
          const s = last(ev, "s4b", m!);
          const step = bashSteps(ev, "s4b", m!)[0];
          return [
            ...(s && (isWorking(s) || s.controls?.turn != null) ? [`at ${Math.round((m! - stopped) / 1000)} s: row ${rowStatus(s)}, working ${s.controls?.working}, turn ${JSON.stringify(s.controls?.turn)}`] : []),
            ...(step && !(step.state === "stopped" && step.cause === "Stopped by you") && m! >= stopped + 5000 ? [`step ${step.state} ${step.cause ?? ""}`] : []),
          ];
        });
        const claim = notices(ev, "s4b", stopped).find((i) => /the turn/i.test(i.text ?? "") && i.reason === "stop");
        if (claim) bad.push(`notice: ${claim.text}`);
        return bad.length ? no([...new Set(bad)].join("; ")) : ok("at rest at every mark, step stopped by you, nothing claimed of a turn");
      },
    },
  ],
};

const S4c: Scenario = {
  id: "S4c",
  area: "sessions",
  title: "Stop the turn only while Claude Code is frozen",
  needsSimulator: false,
  journey: [
    "Claude Code is frozen (a hung or busy Mac) when the user sends a prompt and presses Stop the turn only.",
    "Nothing may say the turn stopped while it is frozen. Once it resumes, the prompt must not run, and only then does the thread say the user stopped it.",
  ],
  setup: [
    { do: "create", name: "s4c", prompt: "Reply with the single word ready." },
    started("s4c"),
    { do: "until", mark: "s4c-ready", what: "the first turn to end", timeoutS: 120, test: (ev) => replied(last(ev, "s4c")) && !isWorking(last(ev, "s4c")!) },
    { do: "signal-claude", name: "s4c", signal: "SIGSTOP", mark: "frozen" },
    { do: "send", name: "s4c", text: "Run these three Bash commands one at a time, each in its own tool call: echo s4cone ; echo s4ctwo ; echo s4cthree . Then reply with the single word done.", mark: "sent" },
    { do: "until", mark: "turn-shown", what: "the prompt's turn to show", timeoutS: 30, test: (ev) => last(ev, "s4c")?.controls?.turn != null },
    { do: "sleep", s: 1.5 },
    { do: "stop", name: "s4c", turnOnly: true, mark: "stopped" },
    { do: "sleep", s: 3 },
    { do: "signal-claude", name: "s4c", signal: "SIGCONT", mark: "resumed" },
    { do: "until", mark: "s4c-rest", what: "the session to rest after it resumes", timeoutS: 60, optional: true, test: atRest("s4c") },
    { do: "sleep", s: 8 },
    { do: "mark", mark: "after" },
  ],
  pre: [created("s4c"), { what: "Claude Code was frozen and resumed", check: (ev) => (mark(ev, "resumed") !== undefined ? ok("yes") : no("no")) }],
  rubric: [
    {
      id: "S4c.1",
      tell: "stop",
      lane: "protocol",
      text: "While Claude Code is frozen, nothing says the turn stopped.",
      pass: "No notice with reason stop appears between Stop and the resume.",
      fail: "A stop notice appears while Claude Code is still frozen.",
      check: (ev) => {
        const [a, b] = [mark(ev, "stopped"), mark(ev, "resumed")];
        if (a === undefined || b === undefined) return needMarks(ev, "stopped", "resumed")!;
        const early = notices(ev, "s4c", a).find((i) => i.reason === "stop" && ev.atOf(i.at) < b);
        return early ? no(`said while frozen: ${early.text}`) : ok("nothing said while frozen");
      },
    },
    {
      id: "S4c.2",
      tell: "stop",
      lane: "protocol",
      text: "The stopped prompt does not run once Claude Code resumes, and Claude does not answer it.",
      pass: "The transcript has no Bash call for echo s4cone, s4ctwo or s4cthree, and no assistant text after the prompt.",
      fail: "Claude Code ran any of the prompt's commands, or Claude replied to it.",
      check: (ev) => {
        if (mark(ev, "after") === undefined) return needMarks(ev, "after")!;
        const main = ev.transcript("s4c").main;
        const ran = blocks(main).uses.filter((u) => u.name === "Bash" && /s4c(one|two|three)/.test(String(u.input.command ?? "")));
        const asked = main.findIndex((l) => l.type === "user" && JSON.stringify(l.message?.content ?? "").includes("echo s4cone"));
        const replies = asked === -1 ? [] : main.slice(asked + 1).filter((l) => l.type === "assistant" && Array.isArray(l.message?.content) && (l.message!.content as { type?: string; text?: string }[]).some((b) => b.type === "text" && (b.text ?? "").trim() !== ""));
        if (ran.length) return no(`ran: ${ran.map((u) => String(u.input.command)).join("; ")}`);
        return replies.length ? no(`Claude replied: ${JSON.stringify(replies[0]!.message?.content).slice(0, 100)}`) : ok("no command ran and no reply");
      },
    },
    {
      id: "S4c.3",
      tell: "stop",
      lane: "protocol",
      text: "Once the turn ended, the thread says the user stopped it, in the bridge's own words.",
      pass: 'After the resume, a notice with reason "stop" starts "Stopped by you".',
      fail: "No such notice.",
      check: (ev) => {
        const b = mark(ev, "resumed");
        if (b === undefined) return needMarks(ev, "resumed")!;
        const it = notices(ev, "s4c", b).find((i) => i.reason === "stop" && (i.text ?? "").startsWith("Stopped by you") && ev.atOf(i.at) >= b);
        return it ? ok(it.text ?? "") : no("no bridge stop notice after the resume");
      },
    },
  ],
};

const SLEEPERS = 4;
const QUICK = 8;
const s7names = [...Array.from({ length: SLEEPERS }, (_, i) => `s7-sleep-${i + 1}`), ...Array.from({ length: QUICK }, (_, i) => `s7-quick-${i + 1}`)];
const S7: Scenario = {
  id: "S7",
  area: "sessions",
  title: "Twelve sessions at once",
  needsSimulator: false,
  journey: [
    "The user has 12 phone sessions in one project: 4 running a minute-long command, 8 finished.",
    "From the list they must tell how many run, which ones, and tell the sessions apart.",
  ],
  setup: [
    { do: "watch-list" },
    ...s7names.map(
      (name, i): Action => ({
        do: "create",
        name,
        prompt: i < SLEEPERS ? `Task ${name}: run exactly this Bash command in the foreground (not in the background): perl -e 'sleep 60' . Then reply with one line: done.` : `Task ${name}: reply with the single word ok.`,
      }),
    ),
    {
      do: "until",
      mark: "mixed",
      what: "the 4 sleepers running and the 8 others idle",
      timeoutS: 150,
      test: (ev) =>
        s7names.every((n, i) => {
          const s = last(ev, n);
          return s && (i < SLEEPERS ? stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running") : replied(s) && !isWorking(s));
        }),
    },
    { do: "screenshot", shot: "mixed" },
    { do: "until", mark: "s7-ended", what: "every session at rest", timeoutS: 180, test: (ev) => s7names.every((n) => !isWorking(last(ev, n)!)) },
  ],
  pre: [{ what: "all 12 sessions were created", check: (ev) => (s7names.every((n) => ev.ids[n]) ? ok("12 created") : no(`${s7names.filter((n) => ev.ids[n]).length} created`)) }, { what: "the mixed state was reached", check: (ev) => (mark(ev, "mixed") !== undefined ? ok("yes") : no("no")) }],
  rubric: [
    {
      id: "S7.1",
      tell: "how-many",
      lane: "protocol",
      text: "The list holds all 12 sessions under the project.",
      pass: "At mark mixed, 12 rows of the run's sessions are listed.",
      fail: "Rows are missing.",
      check: (ev) => {
        const at = mark(ev, "mixed");
        if (at === undefined) return needMarks(ev, "mixed")!;
        const n = s7names.filter((x) => last(ev, x, at)?.row).length;
        return n === 12 ? ok("12 rows") : no(`${n} rows`);
      },
    },
    {
      id: "S7.2",
      tell: "how-many",
      lane: "protocol",
      text: "The rows say which sessions run, so the phone can count them.",
      pass: "At mark mixed, the 4 sleepers' rows read working and the 8 others idle.",
      fail: "A row's status disagrees with its thread.",
      check: (ev) => {
        const at = mark(ev, "mixed");
        if (at === undefined) return needMarks(ev, "mixed")!;
        const bad = s7names.filter((n, i) => (last(ev, n, at)?.row?.status === "working") !== i < SLEEPERS);
        return bad.length ? no(`wrong: ${bad.map((n) => `${n}=${last(ev, n, at)?.row?.status}`).join(", ")}`) : ok("4 working, 8 idle");
      },
    },
    {
      id: "S7.3",
      tell: "what",
      lane: "protocol",
      text: "The user can tell the 12 sessions apart by their titles.",
      pass: "12 distinct row titles.",
      fail: "Titles repeat.",
      check: (ev) => {
        const titles = new Set(s7names.map((n) => last(ev, n)?.row?.title ?? ""));
        return titles.size === 12 ? ok("12 distinct titles") : no(`${titles.size} distinct titles`);
      },
    },
    {
      id: "S7.4",
      tell: "state",
      lane: "protocol",
      text: "Every session comes to rest, none stuck working.",
      pass: "At the end, every row reads idle.",
      fail: "A row still reads working.",
      check: (ev) => {
        const bad = s7names.filter((n) => last(ev, n)?.row?.status !== "idle");
        return bad.length ? no(`not idle: ${bad.join(", ")}`) : ok("12 idle");
      },
    },
    review("S7.5", "how-many", "The Sessions list shows at a glance which 4 run and how many.", "Working rows stand out; a count is visible or obvious.", "Running rows look like the rest.", ["mixed"]),
    {
      id: "S7.6",
      tell: "state",
      lane: "protocol",
      text: "A row stops reading Working as soon as its thread is at rest.",
      pass: "Each time a thread's controls.working turns false, its row leaves working within 1.5 s.",
      fail: "A row keeps reading working for more than 1.5 s after its thread came to rest.",
      check: (ev) => {
        const lags: { name: string; ms: number }[] = [];
        for (const n of s7names) {
          const xs = snaps(ev, n);
          xs.forEach((s, i) => {
            if (i === 0 || s.controls?.working !== false || xs[i - 1]!.controls?.working !== true) return;
            const left = xs.slice(i).find((x) => x.row && x.row.status !== "working");
            lags.push({ name: n, ms: left ? left.at - s.at : Infinity });
          });
        }
        if (!lags.length) return no("not judged: no thread came to rest while watched");
        const slow = lags.filter((l) => l.ms > 1500);
        const worst = Math.max(...lags.map((l) => l.ms));
        return slow.length ? no(`${slow.length}/${lags.length} rows lagged: ${slow.map((l) => `${l.name} ${Number.isFinite(l.ms) ? `${(l.ms / 1000).toFixed(1)} s` : "never"}`).join(", ")}`) : ok(`${lags.length} rest transitions, worst ${(worst / 1000).toFixed(1)} s`);
      },
    },
    {
      id: "S7.7",
      tell: "how-many",
      lane: "simulator",
      text: "The list keeps its order while the user reads it: rows move only when their status changes.",
      pass: "In the app's own list, read by the list probe from creation to rest, a row whose spoken status (needs you, working, or neither) held between two samples never changes its place among the other rows whose status held. Not judged unless the probe saw at least two of the run's rows at once and at least one status change among them.",
      fail: "A row moves past another while neither changed status (a title rewrite, a transcript write, a ticking age reordered the list).",
      check: (ev) => {
        if (!ev.list.length) return no("not judged: the list probe did not run (see the run's log)");
        const xs = appList(ev, s7names);
        if (xs.length < 10) return no(`not judged: ${xs.length} probe samples showed the run's rows`);
        let reorders = 0;
        let changes = 0;
        const bad: string[] = [];
        for (let i = 1; i < xs.length; i++) {
          const [a, b] = [xs[i - 1]!, xs[i]!];
          const both = a.rows.filter((r) => b.rows.some((x) => x.name === r.name)).map((r) => r.name);
          const changed = new Set(both.filter((n) => a.rows.find((r) => r.name === n)!.status !== b.rows.find((r) => r.name === n)!.status));
          changes += changed.size;
          const order = (s: typeof a, keep: (n: string) => boolean) => s.rows.map((r) => r.name).filter((n) => both.includes(n) && keep(n)).join();
          if (order(a, () => true) === order(b, () => true)) continue;
          reorders++;
          if (order(a, (n) => !changed.has(n)) !== order(b, (n) => !changed.has(n))) bad.push(`+${(b.at / 1000).toFixed(1)}s`);
        }
        const most = Math.max(...xs.map((x) => x.rows.length));
        const seen = `${xs.length} samples, up to ${most} of the run's rows on screen, ${changes} status changes, ${reorders} reorders`;
        if (!bad.length && (most < 2 || !changes)) return no(`not judged: nothing could have moved (${seen})`);
        return bad.length ? no(`${bad.length} reorders moved a row whose status held, at ${bad.slice(0, 6).join(", ")}; ${seen}`) : ok(`no row whose status held moved; ${seen}`);
      },
    },
    noAckOutput("S7.8", s7names),
    {
      id: "S7.9",
      tell: "how-many",
      lane: "simulator",
      text: "No fold hides a running session: Show more never holds a row that works or needs the user.",
      pass: "Between marks mixed and s7-ended, whenever the app draws the project's Show more, every sleeper the bridge reports working (now and 1.5 s before) is among the rows above it.",
      fail: "A sleeper that works is folded under Show more.",
      check: (ev) => {
        const range = span(ev, "mixed", "s7-ended");
        if (!range) return needMarks(ev, "mixed", "s7-ended")!;
        if (!ev.list.length) return no("not judged: the list probe did not run (see the run's log)");
        const busy = (n: string, at: number) => ["working", "awaiting_approval", "awaiting_input"].includes(last(ev, n, at)?.row?.status ?? "");
        const xs = appList(ev, s7names).filter((x) => x.at >= range[0] && x.at <= range[1] && x.more.length);
        if (!xs.length) return no("not judged: the probe never saw the project's Show more on screen between mixed and s7-ended, so what it folds cannot be read");
        const bad = xs.flatMap((x) => {
          const hidden = s7names.slice(0, SLEEPERS).filter((n) => busy(n, x.at) && busy(n, x.at - 1500) && !x.rows.some((r) => r.name === n));
          return hidden.length ? [`+${(x.at / 1000).toFixed(1)}s ${hidden.join(", ")}`] : [];
        });
        return bad.length ? no(`${bad.length} of ${xs.length} samples with the fold on screen hid a working sleeper: ${bad.slice(0, 4).join("; ")}`) : ok(`${xs.length} samples with the fold on screen, every working sleeper above it`);
      },
    },
  ],
};

const S8: Scenario = {
  id: "S8",
  area: "sessions",
  title: "A subagent starts a background task and returns",
  needsSimulator: false,
  journey: [
    "The user's session starts a subagent; the subagent starts a background command and returns at once.",
    "The session's turn ends while that command still runs on the Mac.",
    "They must tell that something still runs, what started it, and when it finished.",
  ],
  setup: [
    {
      do: "create",
      name: "s8",
      prompt:
        'Launch one subagent with the Agent tool: subagent_type general-purpose, model haiku, run_in_background true, description "starter". Its prompt: "Use the Bash tool with run_in_background set to true to run exactly: sleep 60 && echo nested-done > nested.txt . Do not wait for it. Reply with one line: started." After the subagent returns, reply with one line: subagent returned. Do not wait for the background command and do not check on it.',
    },
    started("s8"),
    { do: "until", mark: "s8-ended", what: "the parent turn to end", timeoutS: 180, test: turnEnded("s8") },
    ...awayAndBack("s8", "nested.txt", true),
    { do: "until", mark: "s8-rest", what: "the session to rest", timeoutS: 90, optional: true, test: atRest("s8") },
  ],
  pre: [
    created("s8"),
    { what: "the subagent ran Bash with run_in_background", check: (ev) => (bgBash(ev.transcript("s8").subagents).length ? ok("yes") : no("no background Bash in a subagent transcript")) },
    {
      what: "the parent turn ended while that command still had at least 40 s to run",
      check: (ev) => {
        const started = bgBash(ev.transcript("s8").subagents)[0];
        const ended = mark(ev, "s8-ended");
        if (!started || ended === undefined) return no("no background command or no turn end");
        const left = 60 - (ended - ev.atOf(started.at)) / 1000;
        return left >= 40 ? ok(`${Math.round(left)} s left when the turn ended`) : no(`${Math.round(left)} s left`);
      },
    },
  ],
  rubric: [
    stillRunning("S8.1a", "s8", "list-mid", "list", "the subagent's background command"),
    stillRunning("S8.1b", "s8", "mid-background", "thread", "the subagent's background command"),
    {
      id: "S8.2",
      tell: "what",
      lane: "protocol",
      text: "What the user sees names the background command or the subagent that started it, while it runs.",
      pass: 'Mid-background, a running step or notice mentions "sleep 60", "nested" or "starter".',
      fail: "Nothing names it.",
      check: (ev) => {
        const at = mark(ev, "mid-background");
        if (at === undefined) return needMarks(ev, "mid-background")!;
        const s = last(ev, "s8", at);
        const hit = s?.items.flatMap((i) => [...(i.steps ?? []).filter((x) => x.state === "running").map((x) => x.label), i.kind === "notice" ? (i.text ?? "") : ""]).find((t) => /sleep 60|nested|starter/i.test(t));
        return hit ? ok(hit) : no("no running step or notice names it");
      },
    },
    {
      id: "S8.3",
      tell: "state",
      lane: "protocol",
      text: "The user learns how the subagent's background command ended: it finished, or it was stopped.",
      pass: "nested.txt appeared and the thread changed within 60 s of it; or, if it never appeared, a notice says the background work stopped. Assistant prose does not count.",
      fail: "The command never finished (nested.txt missing) and no notice told the user, or it finished and the thread did not change.",
      check: (ev) => {
        const done = mark(ev, "bg-done");
        if (done !== undefined) return finishShows("S8.3", "s8", "bg-done", "it").check!(ev);
        const told = notices(ev, "s8", mark(ev, "s8-ended") ?? 0).find((i) => /stopp|killed|background|nested/i.test(i.text ?? ""));
        return told ? ok(`never finished; the thread says: notice "${(told.text ?? "").slice(0, 80)}"`) : no("nested.txt never appeared (the command did not finish) and no notice says it stopped");
      },
    },
    unreadAfter("S8.4", "s8", "list-after"),
    stopOffered("S8.5", "s8", "mid-background", "mid-background", "the subagent's background command"),
    review("S8.6", "state", "Mid-background, the thread shows that something still runs and what.", "A running indicator with the command or the subagent.", "Looks finished.", ["background-running"]),
    {
      id: "S8.7",
      tell: "what",
      lane: "protocol",
      text: "When Claude Code kills the subagent's background command, the thread names the command and the subagent that started it.",
      pass: 'If nested.txt never appeared, a notice after the parent turn names the command ("sleep 60" or "nested") and its owner ("starter").',
      fail: "The command was killed and no notice names both it and its owner.",
      check: (ev) => {
        if (mark(ev, "bg-done") !== undefined) return no("not judged: the command was not killed (nested.txt appeared)");
        const all = notices(ev, "s8", mark(ev, "s8-ended") ?? 0);
        const hit = all.find((i) => /sleep 60|nested/i.test(i.text ?? "") && /starter/i.test(i.text ?? ""));
        return hit ? ok(`notice "${(hit.text ?? "").slice(0, 100)}"`) : no(all.length ? `no notice names both; notices: ${all.map((i) => `"${(i.text ?? "").slice(0, 60)}"`).join("; ")}` : "no notice after the parent turn");
      },
    },
    noAckOutput("S8.8", ["s8"]),
    comesToRest("S8.9", "s8", "bg-done", "the background command and the turn it woke"),
    noPhantomWork("S8.10", "s8"),
  ],
};

const S8fg: Scenario = {
  id: "S8fg",
  area: "sessions",
  title: "A subagent the session waits for starts a background task and returns",
  needsSimulator: false,
  journey: [
    "The user's session starts a subagent and waits for it; the subagent starts a background command and returns at once.",
    "Claude Code stops that command when the subagent returns, and the turn ends.",
    "They must learn that the command was stopped, what it was and what started it, and see the session at rest.",
  ],
  setup: [
    {
      do: "create",
      name: "s8",
      prompt:
        'Launch one subagent with the Agent tool: subagent_type general-purpose, model haiku, run_in_background false, description "starter". Its prompt: "Use the Bash tool with run_in_background set to true to run exactly: sleep 60 && echo nested-done > nested.txt . Do not wait for it. Reply with one line: started." After the subagent returns, reply with one line: subagent returned. Do not wait for the background command and do not check on it.',
    },
    started("s8"),
    { do: "until", mark: "s8-ended", what: "the session to rest", timeoutS: 180, test: atRest("s8") },
    { do: "until", mark: "late-window-over", what: "the 60 s the command would have run to pass", timeoutS: 90, test: (ev) => ev.now() > (mark(ev, "s8-started") ?? Infinity) + 75_000 },
  ],
  pre: [
    created("s8"),
    { what: "the subagent ran Bash with run_in_background", check: (ev) => (bgBash(ev.transcript("s8").subagents).length ? ok("yes") : no("no background Bash in a subagent transcript")) },
    { what: "Claude Code stopped the command: nested.txt never appeared", check: (ev) => (ev.exists("nested.txt") ? no("nested.txt appeared, so the command was not stopped") : ok("absent")) },
  ],
  rubric: [
    {
      id: "S8fg.1",
      tell: "what",
      lane: "protocol",
      text: "When Claude Code stops the subagent's background command, the thread names the command and the subagent that started it.",
      pass: 'A notice names the command ("sleep 60" or "nested") and its owner ("starter").',
      fail: "No notice names both, so the command vanished without a word. Assistant prose does not count.",
      check: (ev) => {
        const all = notices(ev, "s8");
        const hit = all.find((i) => /sleep 60|nested/i.test(i.text ?? "") && /starter/i.test(i.text ?? ""));
        return hit ? ok(`notice "${(hit.text ?? "").slice(0, 100)}"`) : no(all.length ? `no notice names both; notices: ${all.map((i) => `"${(i.text ?? "").slice(0, 60)}"`).join("; ")}` : "no notice");
      },
    },
    {
      id: "S8fg.2",
      tell: "stop",
      lane: "protocol",
      text: "Once the turn's final reply is written, nothing runs, so the session rests at once and Stop goes away.",
      pass: "A state reads not working within 5 s of the main transcript's final reply.",
      fail: "The session reads working, with Stop, for more than 5 s after the reply while nothing runs.",
      check: (ev) => {
        const reply = ev.transcript("s8").main.findLast(finalReply);
        if (!reply?.timestamp) return no("not judged: no final reply in the transcript");
        const at = ev.atOf(reply.timestamp);
        const rest = during(ev, "s8", at, Infinity).find((s) => !isWorking(s));
        if (!rest) return no("still working at the end of the run");
        const s = Math.max(0, Math.round((rest.at - at) / 100) / 10);
        return rest.at - at <= 5_000 ? ok(`at rest ${s} s after the reply`) : no(`at rest only ${s} s after the reply`);
      },
    },
    noAckOutput("S8fg.3", ["s8"]),
  ],
};

const S3b: Scenario = {
  id: "S3b",
  area: "sessions",
  title: "Background work finishes while the user is elsewhere in the app",
  needsSimulator: false,
  journey: [
    "The user starts a background command from the phone, then goes back to the Sessions list with the app still open.",
    "The command finishes on the Mac while the list is on screen.",
    "A notification on the phone says the session finished; nothing is pushed from outside, since the app is open.",
  ],
  setup: [
    { do: "create", name: "s3b", prompt: BG("sleep 20 && echo bg-done > bg3b.txt") },
    started("s3b"),
    { do: "until", mark: "s3b-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s3b") },
    { do: "leave", name: "s3b" },
    { do: "open-thread", name: "s3b" },
    { do: "sleep", s: 3 },
    { do: "show-list" },
    { do: "until", mark: "bg-done", what: "bg3b.txt to appear", timeoutS: 90, test: (ev) => ev.exists("bg3b.txt") },
    { do: "until", mark: "alerted", what: "a session_alert that s3b finished", timeoutS: 60, test: (ev) => ev.alerts.some((a) => a.name === "s3b" && a.frame.reason === "finished") },
    { do: "screenshot", shot: "alert" },
    { do: "sleep", s: 20 },
    { do: "mark", mark: "window-over" },
  ],
  pre: [
    { what: "with --sim, the app on the leased simulator paired with the run's bridge", check: (ev) => (!ev.sim ? ok("protocol lane: the runner is the phone") : ev.paired ? ok("paired") : no("not paired within --pair-wait (see runner.md)")) },
    created("s3b"),
    fileMade("bg3b.txt"),
  ],
  rubric: [
    {
      id: "S3b.1",
      tell: "state",
      lane: "protocol",
      text: "While the app is open on another screen, it is told the session finished, so it can show a notification.",
      pass: "After bg-done, the phone gets a session_alert for s3b with reason finished and the session's title.",
      fail: "No session_alert, so an open app on another screen gives no sign that the work finished.",
      check: (ev) => {
        const at = mark(ev, "bg-done");
        if (at === undefined) return needMarks(ev, "bg-done")!;
        const a = ev.alerts.find((x) => x.name === "s3b" && x.frame.reason === "finished" && x.at >= at - 2000);
        return a ? ok(`+${Math.round((a.at - at) / 1000)} s after bg-done: "${a.frame.title}"`) : no(`no finished alert (${ev.alerts.map((x) => x.frame.reason).join(", ") || "none"})`);
      },
    },
    {
      id: "S3b.2",
      tell: "state",
      lane: "protocol",
      text: "While the app is open, nothing is pushed from outside on top of it.",
      pass: "pushes.jsonl has no push about s3b, through 20 s after the alert.",
      fail: "A remote push also went out, so the user gets the news twice.",
      check: (ev) => {
        const p = ev.pushes().filter((x) => (x.click ?? "").includes(ev.ids.s3b ?? "-"));
        return p.length ? no(p.map((x) => x.body).join(" | ")) : ok("no push for s3b");
      },
    },
    review("S3b.3", "state", "With the Sessions list on screen, a notification says the session finished.", "A banner that names the session and says it finished.", "No banner.", ["alert"]),
  ],
};

const WAITED = "echo waited > waited.txt";
const cardOf = (ev: Ev, name: string) => snaps(ev, name).flatMap((s) => s.items).find((i) => i.kind === "permission" && i.card);
const cardIs = (name: string, answer: unknown) => (ev: Ev) => last(ev, name)?.items.some((i) => i.kind === "permission" && i.card?.answer === answer) === true;

const S9: Scenario = {
  id: "S9",
  area: "sessions",
  title: "A card waits while the user is away: push, failing push server, reminder, expiry",
  needsSimulator: false,
  away: true,
  cardTtlS: 60,
  holdCardsS: 600,
  journey: [
    "The user is away from the phone when a session asks for approval; the push server is down at that moment.",
    "The push server comes back. Half the card's time later the user is reminded.",
    "Nobody answers, so the card expires, and the thread says what was refused.",
  ],
  setup: [
    { do: "sink", fail: true },
    { do: "create", name: "s9", prompt: `Use the Bash tool to run exactly this command: ${WAITED}\nThen reply with one line: done.` },
    { do: "until", mark: "card-open", what: "s9's permission card to open", timeoutS: 120, test: cardIs("s9", null) },
    { do: "until", mark: "failing", what: "the push state to read failing", timeoutS: 40, test: (ev) => ev.pushStates.some((p) => p.push.state === "failing") },
    { do: "sink", fail: false },
    { do: "until", mark: "reminded", what: "a reminder push", timeoutS: 60, test: (ev) => ev.pushes().some((p) => /still waiting/.test(p.body) && p.status === 200) },
    { do: "until", mark: "recovered", what: "the push state to read on again", timeoutS: 15, test: (ev) => ev.pushStates.at(-1)?.push.state === "on" },
    { do: "until", mark: "expired", what: "the card to expire", timeoutS: 60, test: cardIs("s9", "expired") },
    { do: "sleep", s: 3 },
  ],
  pre: [created("s9"), { what: "a permission card opened", check: (ev) => (cardOf(ev, "s9") ? ok(cardOf(ev, "s9")!.card!.label) : no("no card")) }],
  rubric: [
    {
      id: "S9.1",
      tell: "state",
      lane: "protocol",
      text: "When the push server fails, the phone is told that alerts are failing, and why.",
      pass: "After the card push was tried three times and answered 500 each time, a push_state frame reads failing with \"The push server answered 500\".",
      fail: "No failing state, the wrong cause, or fewer than three tries.",
      check: (ev) => {
        // The bot's greeting turn pushes too; only the card push's tries count.
        const tries = ev.pushes().filter((p) => p.status === 500 && cardCount(p) !== null);
        const failing = ev.pushStates.find((p) => p.push.state === "failing");
        if (!failing) return no(`no failing state; ${tries.length} failed tries`);
        if (failing.push.error !== "The push server answered 500") return no(`error "${failing.push.error}"`);
        return tries.length === 3 ? ok(`${tries.length} tries, then failing at +${Math.round(failing.at / 1000)} s`) : no(`${tries.length} failed tries`);
      },
    },
    {
      id: "S9.2",
      tell: "what",
      lane: "protocol",
      text: "The card's push says what waits, at high priority, and opens the session at that card.",
      pass: 'The card push reads "A Claude Code session needs your approval", priority high, link claudiobot://session/<id>?card=<the card id>.',
      fail: "Another text, priority or link.",
      check: (ev) => {
        const card = cardOf(ev, "s9")?.card;
        const p = ev.pushes().find((x) => cardCount(x) !== null);
        if (!card || !p) return no(`card ${card?.id ?? "none"}, push ${p?.body ?? "none"}`);
        const want = `claudiobot://session/${ev.ids.s9}?card=${card.id}`;
        return p.body === "A Claude Code session needs your approval" && p.priority === "high" && p.click === want ? ok(`${p.body}, ${p.priority}, ${p.click}`) : no(`${p.body}, ${p.priority}, ${p.click} (want ${want})`);
      },
    },
    {
      id: "S9.3",
      tell: "state",
      lane: "protocol",
      text: "A card nobody answers reminds the user once, at half its time.",
      pass: "One reminder push, 30 s (half the 60 s card time) after the card opened, give or take 3 s, linking to the card.",
      fail: "No reminder, more than one, or one at another time.",
      check: (ev) => {
        const card = cardOf(ev, "s9");
        const r = ev.pushes().filter((p) => /still waiting/.test(p.body));
        if (!card || r.length !== 1) return no(`${r.length} reminders`);
        const after = (ev.atOf(r[0]!.at) - ev.atOf(card.at)) / 1000;
        return Math.abs(after - 30) <= 3 && (r[0]!.click ?? "").endsWith(`?card=${card.card!.id}`) ? ok(`"${r[0]!.body}" ${after.toFixed(1)} s after the card opened`) : no(`${after.toFixed(1)} s after the card, link ${r[0]!.click}`);
      },
    },
    {
      id: "S9.4",
      tell: "state",
      lane: "protocol",
      text: "Once a push gets through again, the phone hears that alerts work.",
      pass: "After the failing state, a push_state frame reads on within 2 s of the first push the sink answered 200, and not before it.",
      fail: "The state stays failing after a push got through, or reads on before any did.",
      check: (ev) => {
        const failing = ev.pushStates.findIndex((p) => p.push.state === "failing");
        if (failing < 0) return no("never failing");
        const since = ev.pushStates[failing]!.at;
        const through = ev.pushes().find((p) => p.status === 200 && ev.atOf(p.at) >= since);
        const on = ev.pushStates.slice(failing + 1).find((p) => p.push.state === "on");
        if (!through || !on) return no(`${ev.pushStates.map((p) => p.push.state).join(" → ")}; first good push ${through?.body ?? "none"}`);
        const lag = on.at - ev.atOf(through.at);
        return lag >= -500 && lag <= 2_000 ? ok(`on ${(lag / 1000).toFixed(1)} s after "${through.body}" got through`) : no(`on ${(lag / 1000).toFixed(1)} s after the first good push`);
      },
    },
    {
      id: "S9.5",
      tell: "state",
      lane: "protocol",
      text: "When the card expires, the thread says what was refused, and that the user did not say no.",
      pass: 'The card reads expired and a notice (reason approval) names the command and says "You did not say no."',
      fail: "No notice, or one that does not say what was refused.",
      check: (ev) => {
        const n = notices(ev, "s9").find((i) => i.reason === "approval");
        if (!cardIs("s9", "expired")(ev)) return no("the card never read expired");
        return n && /echo waited/.test(n.text ?? "") && /You did not say no\./.test(n.text ?? "") ? ok(n.text!) : no(n?.text ?? "no approval notice");
      },
    },
    {
      id: "S9.6",
      tell: "what",
      lane: "protocol",
      text: "No push carries the command or anything else from the session.",
      pass: "No push title, body or link contains the command.",
      fail: "A push carries content.",
      check: (ev) => {
        const leaky = ev.pushes().filter((p) => /echo|waited/.test(`${p.title} ${p.body} ${p.click}`));
        return leaky.length ? no(leaky[0]!.body) : ok(ev.pushes().map((p) => p.body).join(" | "));
      },
    },
  ],
};

const S9b: Scenario = {
  id: "S9b",
  area: "sessions",
  title: "Push is off: the phone can tell, and the app still hears what finished",
  needsSimulator: false,
  pushOff: true,
  journey: [
    "The Mac has no push URL set, so nothing can reach the phone when the app is closed.",
    "The user can tell this from the app, and while the app is open it still hears that a session finished.",
  ],
  setup: [
    { do: "create", name: "s9b", prompt: BG("sleep 10 && echo bg-done > off.txt") },
    started("s9b"),
    { do: "until", mark: "s9b-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s9b") },
    { do: "leave", name: "s9b" },
    { do: "until", mark: "bg-done", what: "off.txt to appear", timeoutS: 90, test: (ev) => ev.exists("off.txt") },
    { do: "until", mark: "alerted", what: "a session_alert that s9b finished", timeoutS: 60, test: (ev) => ev.alerts.some((a) => a.name === "s9b" && a.frame.reason === "finished") },
  ],
  pre: [created("s9b"), fileMade("off.txt")],
  rubric: [
    {
      id: "S9b.1",
      tell: "state",
      lane: "protocol",
      text: "The app can tell that alerts when away are off.",
      pass: "hello carries push state off.",
      fail: "No push state, or it reads on.",
      check: (ev) => {
        const h = ev.pushStates.find((p) => p.via === "hello");
        return h?.push.state === "off" ? ok("off") : no(h ? h.push.state : "hello has no push state");
      },
    },
    {
      id: "S9b.2",
      tell: "state",
      lane: "protocol",
      text: "With push off, the open app still hears that the session finished.",
      pass: "A session_alert for s9b with reason finished arrives after bg-done, and the sink got nothing.",
      fail: "No alert, or something was pushed.",
      check: (ev) => {
        const at = mark(ev, "bg-done");
        if (at === undefined) return needMarks(ev, "bg-done")!;
        const a = ev.alerts.find((x) => x.name === "s9b" && x.frame.reason === "finished" && x.at >= at - 2000);
        if (ev.pushes().length) return no(`${ev.pushes().length} pushes reached the sink`);
        return a ? ok(`+${Math.round((a.at - at) / 1000)} s after bg-done`) : no("no finished alert");
      },
    },
  ],
};

export const SCENARIOS: Scenario[] = [fanOut("S1", false), fanOut("S1b", true), S2, S3, S3b, S4, S4b, S4c, S5, S6, S6b, S6c, S6d, S7, S8, S8fg, S9, S9b];
