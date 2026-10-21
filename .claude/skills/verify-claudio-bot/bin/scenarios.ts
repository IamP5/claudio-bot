// The scenario registry: each scenario is data (setup actions, preconditions, rubric items) read by scenario.ts.
// A precondition is what the scenario must produce to be judged at all; a rubric item is what the user must be able
// to tell. A failed precondition fails the scenario; a failed rubric item is a finding.
import type { Row } from "./control-claudio";

export type Step = { id: string; tool: string; label: string; state: string; output: string | null; [k: string]: unknown };
export type Item = { kind: string; id: string; at: string; text?: string; steps?: Step[]; card?: { id: string; answer: unknown; label: string; detail: string }; tone?: string; [k: string]: unknown };
export type Controls = { canSend: boolean; reason: string | null; working: boolean; queued: number; [k: string]: unknown };
/** One change to one of the scenario's sessions, as the phone's reducer saw it. at: ms since the scenario started. */
export type Snap = { at: number; name: string; row: Row | null; controls: Controls | null; items: Item[] };
export type TranscriptLine = { type?: string; timestamp?: string; message?: { content?: unknown }; [k: string]: unknown };
export type Resume = { mark: string; reply: string; resumed: Item[]; fresh: Item[]; resumedControls: Controls | null; rows: Row[] };

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
  pushes(): { at: string; title: string | null; click: string | null; body: string }[];
  /** Elapsed ms of the scenario at a wall-clock ISO time. */
  atOf(iso: string): number;
};

export type Action =
  | { do: "create"; name: string; prompt: string; mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" }
  | { do: "until"; mark: string; what: string; timeoutS: number; test: (ev: Ev) => boolean; optional?: boolean }
  | { do: "stop"; name: string; mark: string }
  | { do: "sleep"; s: number }
  | { do: "mark"; mark: string }
  /** Unwatches the thread, as the app does when the user goes back to the list; the bridge counts it as a visit. */
  | { do: "leave"; name: string }
  /** Watches the thread again from the position the phone held, as the app does when the user reopens it. */
  | { do: "return"; name: string }
  /** Drops the phone's socket, waits, reconnects, and resumes every thread from the position it held. */
  | { do: "reconnect"; afterS: number; mark: string; until?: { what: string; timeoutS: number; test: (ev: Ev) => boolean } }
  | { do: "screenshot"; shot: string }
  | { do: "open-thread"; name: string }
  | { do: "app"; to: "background" | "foreground"; mark: string };

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
/** Each subagent's run, from the first to the last line of its own transcript, in scenario ms; keyed by agentId. */
function subagentSpans(ev: Ev, name: string) {
  const spans = new Map<string, { from: number; to: number }>();
  for (const l of ev.transcript(name).subagents) {
    const id = String(l.agentId ?? "");
    if (!id || !l.timestamp) continue;
    const at = ev.atOf(l.timestamp);
    const s = spans.get(id) ?? { from: at, to: at };
    spans.set(id, { from: Math.min(s.from, at), to: Math.max(s.to, at) });
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

const created = (name: string): Precondition => ({ what: `session ${name} was created`, check: (ev) => (ev.ids[name] ? ok(ev.ids[name]!) : no("no session_created")) });
const fileMade = (rel: string): Precondition => ({ what: `${rel} exists in the seed project`, check: (ev) => (ev.exists(rel) ? ok("present") : no("missing")) });
const turnEnded = (name: string) => (ev: Ev) => mark(ev, `${name}-started`) !== undefined && !isWorking(last(ev, name) ?? ({ controls: null, row: null } as Snap));
const replied = (s: Snap | undefined) => !!s?.items.some((i) => i.kind === "assistant");
const started = (name: string): Action => ({ do: "until", mark: `${name}-started`, what: `${name}'s turn to start`, timeoutS: 90, test: (ev) => snaps(ev, name).some((s) => isWorking(s) || replied(s)) });

/** The user leaves the thread once the turn ended, looks at the list, reopens the thread, leaves again until it finished. */
const awayAndBack = (name: string, doneFile: string): Action[] => [
  { do: "leave", name },
  { do: "sleep", s: 12 },
  { do: "mark", mark: "list-mid" },
  { do: "return", name },
  { do: "sleep", s: 3 },
  { do: "mark", mark: "mid-background" },
  { do: "screenshot", shot: "background-running" },
  { do: "leave", name },
  { do: "until", mark: "bg-done", what: `${doneFile} to appear`, timeoutS: 150, test: (ev) => ev.exists(doneFile) },
  { do: "sleep", s: 20 },
  { do: "mark", mark: "list-after" },
  { do: "return", name },
  { do: "sleep", s: 3 },
  { do: "mark", mark: "returned" },
  { do: "screenshot", shot: "after" },
];

const BG = (cmd: string) =>
  `Use the Bash tool with run_in_background set to true to run exactly this command: ${cmd}\nDo not wait for it, do not check on it, do not run anything else. Reply with one line: started.`;

// ---- the scenarios

const S1: Scenario = {
  id: "S1",
  area: "sessions",
  title: "Three parallel subagents",
  needsSimulator: false,
  journey: [
    "The user starts a session from the phone that fans out three subagents at once.",
    "They watch the thread while the three run: which three, that all three run, for how long, and that Stop is there.",
    "They see each one finish and the session come to rest.",
  ],
  setup: [
    {
      do: "create",
      name: "s1",
      prompt:
        'Launch exactly 3 subagents in parallel, all in one message, with the Agent tool: subagent_type general-purpose, model haiku. Their descriptions are "sleeper one", "sleeper two" and "sleeper three". Each one\'s prompt is: "Run exactly this Bash command in the foreground: perl -e \'sleep 30\' . Then reply with the single word done." When all three have returned, reply with one line: all done.',
    },
    started("s1"),
    { do: "until", mark: "agents-launched", what: "3 Agent calls in the transcript", timeoutS: 120, test: (ev) => blocks(ev.transcript("s1").main).uses.filter((u) => AGENT_TOOLS.has(u.name)).length >= 3 },
    { do: "sleep", s: 12 },
    { do: "mark", mark: "mid-run" },
    { do: "screenshot", shot: "running" },
    { do: "until", mark: "all-done", what: 'the "all done" reply', timeoutS: 240, test: (ev) => !!last(ev, "s1")?.items.some((i) => i.kind === "assistant" && /all done/i.test(i.text ?? "")) },
    { do: "until", mark: "s1-ended", what: "the turn to end", timeoutS: 120, test: turnEnded("s1") },
    { do: "screenshot", shot: "done" },
  ],
  pre: [
    created("s1"),
    {
      what: "3 subagents ran at the same time (their own transcripts overlap)",
      check: (ev) => {
        const spans = [...subagentSpans(ev, "s1").values()];
        const overlap = Math.min(...spans.map((x) => x.to)) - Math.max(...spans.map((x) => x.from));
        return spans.length >= 3 && overlap > 5000 ? ok(`${spans.length} subagents, all running together for ${Math.round(overlap / 1000)} s`) : no(`${spans.length} subagents, overlap ${Math.round(overlap / 1000)} s`);
      },
    },
  ],
  derive: (ev): Record<string, number> => {
    const spans = [...subagentSpans(ev, "s1").values()];
    return spans.length ? { "agents-from": Math.min(...spans.map((x) => x.from)), "agents-to": Math.max(...spans.map((x) => x.to)) } : {};
  },
  rubric: [
    {
      id: "S1.1",
      tell: "what",
      lane: "protocol",
      text: "Each subagent appears as its own step that names its job.",
      pass: "At least 3 Agent/Task steps, with distinct labels that carry the description.",
      fail: "Fewer than 3 subagent steps, or labels that do not tell them apart.",
      check: (ev) => {
        const steps = new Map(snaps(ev, "s1").flatMap(stepsOf).filter((s) => AGENT_TOOLS.has(s.tool)).map((s) => [s.id, s.label]));
        const labels = new Set(steps.values());
        return steps.size >= 3 && labels.size >= 3 ? ok([...labels].join(" | ")) : no(`${steps.size} steps, labels: ${[...labels].join(" | ") || "none"}`);
      },
    },
    {
      id: "S1.2",
      tell: "how-many",
      lane: "protocol",
      text: "The phone can tell that three subagents run at the same time.",
      pass: "At one moment, 3 subagent steps are in state running.",
      fail: "The most running at once is under 3 (they look sequential, or their state is not live).",
      check: (ev) => {
        const n = maxRunning(ev, "s1", (s) => AGENT_TOOLS.has(s.tool));
        return n >= 3 ? ok(`max ${n} running at once`) : no(`max ${n} running at once`);
      },
    },
    {
      id: "S1.3",
      tell: "state",
      lane: "protocol",
      text: "While the subagents run, the Sessions list shows the session as working.",
      pass: "row.status is working in every state between agents-from and agents-to (the subagents' own transcripts).",
      fail: "The row reads idle (or another rest state) while subagents still run.",
      check: (ev) => {
        const w = span(ev, "agents-from", "agents-to");
        if (!w) return needMarks(ev, "agents-from", "agents-to")!;
        const xs = during(ev, "s1", w[0], w[1]).filter((s) => s.row);
        const bad = xs.filter((s) => s.row!.status !== "working");
        const idle = bad.reduce((n, s, i) => n + ((xs[xs.indexOf(s) + 1]?.at ?? w[1]) - Math.max(s.at, w[0])), 0);
        return bad.length ? no(`row ${statuses(bad)} for about ${Math.round(idle / 1000)} of the ${Math.round((w[1] - w[0]) / 1000)} s the subagents ran`) : ok(`row working in all ${xs.length} states`);
      },
    },
    {
      id: "S1.4",
      tell: "state",
      lane: "protocol",
      text: "Each subagent's step reads done when that subagent finishes, not before, and none stays running after.",
      pass: "Each Agent step first reads ok no earlier than 2 s before its subagent's transcript ends, and reads ok at the end.",
      fail: "A step reads ok while its subagent still runs (or stays running after it ended).",
      check: (ev) => {
        const spans = subagentSpans(ev, "s1");
        const calls = agentOfCall(ev, "s1");
        const early: string[] = [];
        const ids = [...new Set(snaps(ev, "s1").flatMap(stepsOf).filter((x) => AGENT_TOOLS.has(x.tool)).map((x) => x.id))];
        for (const id of ids) {
          const end = spans.get(calls.get(id) ?? "")?.to;
          const firstOk = snaps(ev, "s1").find((s) => stepsOf(s).some((x) => x.id === id && x.state === "ok"))?.at;
          const label = stepsOf(last(ev, "s1")!).find((x) => x.id === id)?.label ?? id;
          if (end !== undefined && firstOk !== undefined && firstOk < end - 2000) early.push(`${label} read ok ${Math.round((end - firstOk) / 1000)} s before its subagent ended`);
        }
        const notOk = stepsOf(last(ev, "s1")!).filter((x) => AGENT_TOOLS.has(x.tool) && x.state !== "ok");
        if (!ids.length) return no("no subagent steps");
        return early.length || notOk.length ? no([...early, ...notOk.map((x) => `${x.label} ends ${x.state}`)].join("; ")) : ok(`${ids.length} steps read ok when their subagents ended`);
      },
    },
    startTime("S1.5", "s1", (s) => AGENT_TOOLS.has(s.tool), "a subagent"),
    {
      id: "S1.6",
      tell: "what",
      lane: "protocol",
      text: "The user can see what a running subagent is doing inside, not only that it runs.",
      pass: "A child row (parentId = the session) is listed, or a running subagent step carries progress output.",
      fail: "A running subagent is an opaque line: no child row and no output until it returns.",
      check: (ev) => {
        const id = ev.ids.s1;
        const child = ev.history.some((s) => s.row?.parentId === id);
        const progress = snaps(ev, "s1").flatMap(stepsOf).some((x) => AGENT_TOOLS.has(x.tool) && x.state === "running" && (x.output ?? "") !== "");
        return child || progress ? ok(`child row: ${child}, progress output: ${progress}`) : no("no child row, no output while running");
      },
    },
    stopOffered("S1.7", "s1", "agents-from", "agents-to", "the subagents"),
    review("S1.8", "how-many", "Mid-run, the thread shows three labeled subagent rows, each visibly running, and a Stop button.", "All three rows, a running indicator on each, Stop visible.", "Rows missing or merged, no running indicator, or no Stop.", ["running"]),
    review("S1.9", "state", "After the turn, the thread shows all three done and the session at rest.", "Three done rows, no spinner, composer ready.", "A spinner or running state remains.", ["done"]),
  ],
};

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
      pass: 'A Bash step whose label carries the command ("Run sleep 75 …").',
      fail: "No step for it, or a label that does not say what runs.",
      check: (ev) => {
        const s = snaps(ev, "s2").flatMap(stepsOf).find((x) => x.tool === "Bash");
        return s && /sleep 75|bg/i.test(s.label) ? ok(s.label) : no(s ? s.label : "no Bash step");
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
  ],
};

const S3: Scenario = {
  id: "S3",
  area: "sessions",
  title: "Background work finishes while the app is in the background",
  needsSimulator: true,
  journey: [
    "The user starts a background command from the phone, watches the thread, then leaves the app.",
    "The command finishes on the Mac while the app is in the background.",
    "They learn it finished without opening the app, and on return the thread shows the result.",
  ],
  setup: [
    { do: "create", name: "s3", prompt: BG("sleep 60 && echo bg-done > bg3.txt") },
    started("s3"),
    { do: "until", mark: "s3-ended", what: "the turn that starts the command to end", timeoutS: 180, test: turnEnded("s3") },
    { do: "leave", name: "s3" },
    { do: "open-thread", name: "s3" },
    { do: "sleep", s: 4 },
    { do: "screenshot", shot: "thread-before" },
    { do: "app", to: "background", mark: "backgrounded" },
    { do: "until", mark: "bg-done", what: "bg3.txt to appear", timeoutS: 150, test: (ev) => ev.exists("bg3.txt") },
    { do: "sleep", s: 20 },
    { do: "mark", mark: "list-after" },
    { do: "screenshot", shot: "home-screen" },
    { do: "app", to: "foreground", mark: "foregrounded" },
    { do: "sleep", s: 5 },
    { do: "screenshot", shot: "thread-after" },
    { do: "return", name: "s3" },
    { do: "sleep", s: 3 },
  ],
  pre: [
    { what: "the app on the leased simulator paired with the run's bridge", check: (ev) => (ev.paired ? ok("paired") : no("not paired: tap Pair on the confirmation (see runner.md)")) },
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
      text: "A push tells the user the background work finished.",
      pass: "pushes.jsonl has a push sent after bg-done.",
      fail: "No push after the work finished.",
      check: (ev) => {
        const at = mark(ev, "bg-done");
        if (at === undefined) return needMarks(ev, "bg-done")!;
        const p = ev.pushes().filter((x) => ev.atOf(x.at) >= at - 2000);
        return p.length ? ok(p.map((x) => `${x.title ?? ""} ${x.body}`.trim()).join(" | ")) : no(`no push after bg-done (${ev.pushes().length} pushes in the run)`);
      },
    },
    {
      id: "S3.2",
      tell: "what",
      lane: "protocol",
      text: "Tapping that push opens the session.",
      pass: "The push's link is claudiobot://session/<the session id>.",
      fail: "No push, or a link elsewhere.",
      check: (ev) => {
        const p = ev.pushes().find((x) => (x.click ?? "").includes(ev.ids.s3 ?? "-"));
        return p ? ok(p.click!) : no("no push links to the session");
      },
    },
    unreadAfter("S3.3", "s3", "list-after"),
    finishShows("S3.4", "s3", "bg-done", "the background command"),
    review("S3.5", "state", "Before leaving, the thread shows the command running in the background.", "Running indicator with what runs.", "Looks finished.", ["thread-before"]),
    review("S3.6", "state", "On the home screen, a notification or badge says the work finished.", "Notification banner or badge.", "Nothing.", ["home-screen"]),
    review("S3.7", "state", "Back in the app, the thread shows the result, with no stale running indicator.", "Done state and the reply.", "Still running, or stale.", ["thread-after"]),
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
        'In one message, launch 2 subagents in parallel with the Agent tool. The first: subagent_type "no-such-agent-type", description "broken helper", prompt "Say hi." The second: subagent_type general-purpose, model haiku, description "long sleeper", prompt "Run exactly this Bash command in the foreground: perl -e \'sleep 45\' && echo late > late.txt . Then reply done." Use exactly these values even if one looks wrong. Then reply with one line saying what happened.',
    },
    started("s4"),
    { do: "until", mark: "sleeper-running", what: "the sleeper's Bash call to start", timeoutS: 150, test: (ev) => blocks(ev.transcript("s4").subagents).uses.some((u) => u.name === "Bash" && String(u.input.command).includes("sleep 45") && u.input.run_in_background !== true) },
    { do: "sleep", s: 8 },
    { do: "screenshot", shot: "running" },
    { do: "stop", name: "s4", mark: "stopped" },
    { do: "until", mark: "s4-rest", what: "the session to rest after Stop", timeoutS: 60, optional: true, test: (ev) => !isWorking(last(ev, "s4")!) },
    { do: "sleep", s: 5 },
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
    { what: "the sleeper ran its command before Stop", check: (ev) => (mark(ev, "sleeper-running") !== undefined ? ok("yes") : no("no")) },
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
      text: "The thread says the user stopped it.",
      pass: "After Stop, a notice or an interruption line appears.",
      fail: "Nothing in the thread says it was stopped.",
      check: (ev) => {
        const at = mark(ev, "stopped");
        if (at === undefined) return needMarks(ev, "stopped")!;
        const it = snaps(ev, "s4", at).flatMap((s) => s.items).find((i) => i.kind === "notice" || /interrupt|stopp/i.test(i.text ?? ""));
        return it ? ok(`${it.kind}: ${(it.text ?? "").slice(0, 80)}`) : no("no notice or interruption");
      },
    },
    {
      id: "S4.6",
      tell: "stop",
      lane: "protocol",
      text: "Stop really stops the subagent's work on the Mac.",
      pass: "late.txt never appears (the sleeper's command was killed), checked 50 s after Stop.",
      fail: "late.txt appeared: the subagent's command kept running after Stop.",
      check: (ev) => (mark(ev, "late-window-over") === undefined ? needMarks(ev, "late-window-over")! : ev.exists("late.txt") ? no("late.txt exists") : ok("late.txt absent")),
    },
    review("S4.7", "state", "Mid-run, the failed subagent reads failed and the other running.", "Two distinct states.", "Same look for both.", ["running"]),
    review("S4.8", "stop", "After Stop, the thread reads stopped, no spinner.", "Stopped state.", "Spinner left.", ["stopped"]),
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
  setup: [
    { do: "create", name: "s5", prompt: "Run exactly this Bash command in the foreground (not in the background), with timeout 200000: perl -e 'sleep 120' && echo slept > slept.txt\nThen reply with one line: slept." },
    started("s5"),
    { do: "until", mark: "call-running", what: "the sleep step to run", timeoutS: 120, test: (ev) => snaps(ev, "s5").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running")) },
    { do: "sleep", s: 30 },
    { do: "screenshot", shot: "at-30s" },
    { do: "sleep", s: 60 },
    { do: "screenshot", shot: "at-90s" },
    { do: "until", mark: "call-done", what: "the sleep step to end", timeoutS: 120, test: (ev) => snaps(ev, "s5").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "ok")) },
    { do: "until", mark: "s5-ended", what: "the turn to end", timeoutS: 60, test: turnEnded("s5") },
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
      pass: "The running Bash step's label carries the command.",
      fail: "No label, or a generic one.",
      check: (ev) => {
        const s = snaps(ev, "s5").flatMap(stepsOf).find((x) => x.tool === "Bash" && x.state === "running");
        return s && /sleep|perl|120/i.test(s.label) ? ok(s.label) : no(s?.label ?? "never running");
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
        const xs = snaps(ev, "s5", w[0], w[1] - 1);
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
  ],
};

const S6: Scenario = {
  id: "S6",
  area: "sessions",
  title: "Reconnect in the middle of a run",
  needsSimulator: false,
  journey: [
    "The user watches a command run; the phone loses its connection for 15 s and comes back while it still runs.",
    "It drops again and comes back only after the turn ended.",
    "Each time, the thread must show the truth at once: still running, then done, with no duplicates.",
  ],
  setup: [
    { do: "create", name: "s6", prompt: "Run exactly this Bash command in the foreground (not in the background): perl -e 'sleep 40' && echo hi > s6.txt\nThen reply with one line: done." },
    started("s6"),
    { do: "until", mark: "call-running", what: "the sleep step to run", timeoutS: 120, test: (ev) => snaps(ev, "s6").some((s) => stepsOf(s).some((x) => x.tool === "Bash" && x.state === "running")) },
    { do: "sleep", s: 3 },
    { do: "reconnect", afterS: 15, mark: "resume-1" },
    { do: "screenshot", shot: "after-resume-1" },
    { do: "reconnect", afterS: 15, mark: "resume-2", until: { what: "s6.txt and the end of the turn while offline", timeoutS: 120, test: (ev) => ev.exists("s6.txt") } },
    { do: "until", mark: "s6-ended", what: "the turn to end", timeoutS: 60, test: turnEnded("s6") },
    { do: "screenshot", shot: "after-resume-2" },
  ],
  pre: [created("s6"), fileMade("s6.txt"), { what: "both reconnects happened", check: (ev) => (ev.resumes.length === 2 ? ok(ev.resumes.map((r) => r.reply).join(", ")) : no(`${ev.resumes.length} reconnects`)) }],
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
        const running = r.resumed.flatMap((i) => i.steps ?? []).some((s) => s.tool === "Bash" && s.state === "running");
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
        const done = r.resumed.flatMap((i) => i.steps ?? []).some((s) => s.tool === "Bash" && s.state === "ok");
        const reply = r.resumed.some((i) => i.kind === "assistant");
        return done && reply && r.resumedControls?.working === false ? ok(`${r.reply}; done, reply, at rest`) : no(`${r.reply}; done ${done}, reply ${reply}, working ${r.resumedControls?.working}`);
      },
    },
    {
      id: "S6.3",
      tell: "what",
      lane: "protocol",
      text: "The resumed thread equals a fresh open: no duplicates, nothing missing, same step states.",
      pass: "For both resumes, the item ids and step states equal a fresh snapshot's.",
      fail: "The resumed view differs from a fresh open.",
      check: (ev) => {
        const key = (xs: Item[]) => xs.map((i) => `${i.kind}:${i.id}:${(i.steps ?? []).map((s) => s.state).join("")}`).sort().join("|");
        const bad = ev.resumes.filter((r) => key(r.resumed) !== key(r.fresh));
        return ev.resumes.length && !bad.length ? ok(`${ev.resumes.length} resumes match a fresh open`) : no(bad.map((r) => `${r.mark}: resumed ${r.resumed.length} items vs fresh ${r.fresh.length}`).join("; ") || "no resumes");
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
    review("S7.5", "how-many", "The Sessions list shows at a glance which 4 run and how many (needs a tap to the Sessions sidebar first).", "Working rows stand out; a count is visible or obvious.", "Running rows look like the rest.", ["mixed"]),
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
        'Launch one subagent with the Agent tool: subagent_type general-purpose, model haiku, description "starter". Its prompt: "Use the Bash tool with run_in_background set to true to run exactly: sleep 60 && echo nested-done > nested.txt . Do not wait for it. Reply with one line: started." After the subagent returns, reply with one line: subagent returned. Do not wait for the background command and do not check on it.',
    },
    started("s8"),
    { do: "until", mark: "s8-ended", what: "the parent turn to end", timeoutS: 180, test: turnEnded("s8") },
    ...awayAndBack("s8", "nested.txt"),
  ],
  pre: [
    created("s8"),
    { what: "the subagent ran Bash with run_in_background", check: (ev) => (bgBash(ev.transcript("s8").subagents).length ? ok("yes") : no("no background Bash in a subagent transcript")) },
    fileMade("nested.txt"),
    { what: "the parent turn ended before nested.txt appeared", check: (ev) => ((mark(ev, "s8-ended") ?? Infinity) < (mark(ev, "bg-done") ?? 0) ? ok("yes") : no("no")) },
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
    finishShows("S8.3", "s8", "bg-done", "the subagent's background command"),
    unreadAfter("S8.4", "s8", "list-after"),
    stopOffered("S8.5", "s8", "mid-background", "mid-background", "the subagent's background command"),
    review("S8.6", "state", "Mid-background, the thread shows that something still runs and what.", "A running indicator with the command or the subagent.", "Looks finished.", ["background-running"]),
  ],
};

export const SCENARIOS: Scenario[] = [S1, S2, S3, S4, S5, S6, S7, S8];
