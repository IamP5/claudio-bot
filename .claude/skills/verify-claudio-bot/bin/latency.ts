#!/usr/bin/env bun
/**
 * How late the phone learns what Claude Code already wrote, read from scenario evidence folders (timeline.jsonl,
 * transcripts/, report.json). Prints one JSON line per folder; times are ms.
 *
 *   bun latency.ts <evidence dir>...
 *
 * create→row: a session_created ack to the first list frame with its row.
 * step: a main-thread tool_use line to the first thread frame with its step.
 * failed: an Agent tool_result is_error line to the first frame where its step reads error.
 * user: a prompt line to the first frame with its item; gaps: the phone's own message left the thread before its
 *   transcript copy arrived (count, and how long the thread had neither).
 * rest→row: a thread's controls.working turning false to its row leaving working.
 * lastAt: the final idle row's lastAt minus the last prompt, reply or tool result (negative: the row reads older than the conversation; positive: a later write moved it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Frame = Record<string, unknown> & { type: string };
type Line = { at: number; dir: "in" | "out" | "held"; name: string; frame: Frame };
type Item = { id: string; kind: string; text?: string; steps?: { id: string; state: string }[] };
type Entry = { type?: string; uuid?: string; timestamp?: string; isSidechain?: boolean; isMeta?: boolean; message?: { role?: string; content?: unknown } };

/** never: how many never arrived. */
function stats(all: number[]) {
  const xs = all.filter(Number.isFinite).sort((a, b) => a - b);
  const never = all.length - xs.length;
  return { n: all.length, ...(xs.length && { median: xs[Math.floor((xs.length - 1) / 2)], max: xs.at(-1) }), ...(never && { never }) };
}

function measure(dir: string) {
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { scenario: string; startedAt: string; sessions: Record<string, string> };
  const t0 = Date.parse(report.startedAt);
  const lines = readFileSync(join(dir, "timeline.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
  const incoming = lines.filter((l) => l.dir === "in");
  const items = (f: Frame) => ((f.type === "session" || f.type === "session_items" ? f.items : []) as Item[]) ?? [];
  const firstIn = (test: (f: Frame) => boolean, after = -Infinity) => incoming.find((l) => l.at >= after && test(l.frame))?.at;

  const createRow: number[] = [];
  for (const l of incoming.filter((x) => x.frame.type === "session_created")) {
    const sid = l.frame.sessionId as string;
    const seen = firstIn((f) => (f.type === "sessions" || f.type === "session_rows") && (f.rows as { id: string }[]).some((r) => r.id === sid), l.at);
    createRow.push(seen === undefined ? Infinity : seen - l.at);
  }

  const step: number[] = [];
  const failed: number[] = [];
  const user: number[] = [];
  const lastAt: number[] = [];
  const tdir = join(dir, "transcripts");
  for (const sid of Object.values(report.sessions)) {
    const file = join(tdir, `${sid}.jsonl`);
    if (!existsSync(file)) continue;
    const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l) as Entry];
      } catch {
        return [];
      }
    }).filter((e) => !e.isSidechain && !e.isMeta && e.timestamp);
    const mine = (f: Frame) => f.sessionId === sid;
    const agents = new Set<string>();
    for (const e of entries) {
      const at = Date.parse(e.timestamp!) - t0;
      const content = Array.isArray(e.message?.content) ? (e.message!.content as Record<string, unknown>[]) : [];
      if (e.type === "assistant")
        for (const b of content.filter((x) => x.type === "tool_use")) {
          if (b.name === "Agent" || b.name === "Task") agents.add(b.id as string);
          const seen = firstIn((f) => mine(f) && items(f).some((i) => i.steps?.some((s) => s.id === b.id)));
          if (seen !== undefined) step.push(seen - at);
        }
      if (e.type === "user") {
        const stop = /interrupted|pressed Stop|stopped the session|doesn't want to proceed/i;
        for (const b of content.filter((x) => x.type === "tool_result" && x.is_error === true && agents.has(x.tool_use_id as string) && !stop.test(JSON.stringify(x.content)))) {
          const seen = firstIn((f) => mine(f) && items(f).some((i) => i.steps?.some((s) => s.id === b.tool_use_id && s.state === "error")));
          failed.push(seen === undefined ? Infinity : seen - at);
        }
        if (typeof e.message?.content === "string" && !e.message.content.startsWith("<")) {
          const seen = firstIn((f) => mine(f) && items(f).some((i) => i.id === e.uuid));
          if (seen !== undefined) user.push(seen - at);
        }
      }
    }
    const replied = entries.filter((e) => e.type === "assistant" || e.type === "user").map((e) => Date.parse(e.timestamp!));
    const rows = incoming.flatMap((l) => (l.frame.type === "sessions" || l.frame.type === "session_rows" ? (l.frame.rows as { id: string; status: string; lastAt: string }[]).filter((r) => r.id === sid) : []));
    const end = rows.at(-1);
    if (end && end.status === "idle" && replied.length) lastAt.push(Date.parse(end.lastAt) - Math.max(...replied));
  }

  const gaps: number[] = [];
  const shown = new Map<string, Map<string, Item>>();
  for (const l of incoming) {
    const f = l.frame;
    const sid = f.sessionId as string | undefined;
    if (!sid || (f.type !== "session" && f.type !== "session_items")) continue;
    const t = f.type === "session" ? new Map<string, Item>() : (shown.get(sid) ?? new Map<string, Item>());
    const gone = ((f.removed as string[] | undefined) ?? []).map((id) => t.get(id)).filter((i): i is Item => i?.kind === "user");
    for (const id of (f.removed as string[] | undefined) ?? []) t.delete(id);
    for (const i of items(f)) t.set(i.id, i);
    shown.set(sid, t);
    for (const g of gone) {
      if ([...t.values()].some((i) => i.kind === "user" && i.text?.trim() === g.text?.trim())) continue;
      const back = firstIn((x) => x.sessionId === sid && items(x).some((i) => i.kind === "user" && i.text?.trim() === g.text?.trim()), l.at);
      gaps.push(back === undefined ? Infinity : back - l.at);
    }
  }

  const rest: number[] = [];
  for (const sid of Object.values(report.sessions)) {
    let working: boolean | null = null;
    let row: string | null = null;
    let since: number | null = null;
    for (const l of incoming) {
      const f = l.frame;
      if ((f.type === "session" || f.type === "session_items") && f.sessionId === sid && f.controls) {
        const w = (f.controls as { working: boolean }).working;
        if (working === true && !w && row === "working") since = l.at;
        working = w;
      }
      if (f.type === "sessions" || f.type === "session_rows")
        for (const r of (f.rows as { id: string; status: string }[]).filter((x) => x.id === sid)) {
          row = r.status;
          if (since !== null && r.status !== "working") (rest.push(l.at - since), (since = null));
        }
    }
    if (since !== null) rest.push(Infinity);
  }

  return { scenario: report.scenario, dir, "create→row": stats(createRow), step: stats(step), failed: stats(failed), user: stats(user), gaps: stats(gaps), "rest→row": stats(rest), lastAt: stats(lastAt) };
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: latency.ts <scenario evidence dir>...");
  process.exit(2);
}
for (const d of dirs) console.log(JSON.stringify(existsSync(join(d, "report.json")) ? measure(d) : { dir: d, error: "no report.json", has: existsSync(d) ? readdirSync(d) : [] }));
