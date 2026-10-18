import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Line, Prompted } from "../scripts/record-transcript";
import { FakeQuery } from "./hub-kit";

// Real Claude Code sessions recorded by scripts/record-transcript.ts, read back for tests. Reading a file never runs claude.

export type Transcript = {
  meta: Record<string, unknown>;
  /** The user messages the recording sent, in order. */
  outbound: SDKUserMessage[];
  /** What arrived before the first send (segments[0]), and after each send until the next (segments[i] after outbound[i-1]). */
  segments: SDKMessage[][];
  /** Every canUseTool call, with the answer the recording gave. */
  prompts: Prompted[];
};

export function replay(scenario: string): Transcript {
  const text = readFileSync(join(import.meta.dir, "transcripts", `${scenario}.ndjson`), "utf8");
  const t: Transcript = { meta: {}, outbound: [], segments: [[]], prompts: [] };
  for (const line of text.trim().split("\n").map((l) => JSON.parse(l) as Line)) {
    if ("meta" in line) t.meta = line.meta;
    else if (line.dir === "out") {
      t.outbound.push(line.message);
      t.segments.push([]);
    } else if (line.dir === "in") t.segments.at(-1)!.push(line.message);
    else t.prompts.push(line.call);
  }
  return t;
}

const textOf = (m: SDKUserMessage) => (typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));

/**
 * A query for createSession that plays a recording back on hub-kit's FakeQuery. Each user message the session sends
 * must match the next recorded one; the frames recorded after it are then emitted, with the recorded uuid swapped for
 * the one the session sent wherever Claude Code echoed it. done() throws if anything recorded was left unplayed.
 */
export function player(t: Transcript) {
  const uuids = new Map<string, string>();
  const failures: string[] = [];
  let sends = 0;
  let emitted = 0;
  let consumed = 0;
  let live: FakeQuery | null = null;

  const swap = (u: string) => uuids.get(u) ?? u;
  function rewrite(m: SDKMessage): SDKMessage {
    const r: Record<string, unknown> = { ...m };
    if (typeof r.user_message_uuid === "string") r.user_message_uuid = swap(r.user_message_uuid);
    if (Array.isArray(r.user_message_uuids)) r.user_message_uuids = (r.user_message_uuids as string[]).map(swap);
    if (typeof r.command_uuid === "string") r.command_uuid = swap(r.command_uuid);
    return r as unknown as SDKMessage;
  }
  function play(q: FakeQuery, segment: SDKMessage[]) {
    emitted += segment.length;
    q.emit(...segment.map(rewrite));
  }

  async function* tap(prompt: AsyncIterable<SDKUserMessage>): AsyncGenerator<SDKUserMessage> {
    for await (const m of prompt) {
      const recorded = t.outbound[sends];
      if (!recorded) failures.push(`the session sent a message the recording does not have: ${textOf(m)}`);
      else if (textOf(recorded) !== textOf(m)) failures.push(`send ${sends + 1} differs from the recording: ${textOf(m)}`);
      else {
        uuids.set(recorded.uuid!, m.uuid!);
        sends++;
        if (live) play(live, t.segments[sends]!);
      }
      yield m;
    }
  }

  const run = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    if (live) failures.push("the session opened a second query; the recording has one");
    const q = new FakeQuery(tap(prompt), options);
    const iterate = q[Symbol.asyncIterator].bind(q);
    q[Symbol.asyncIterator] = async function* () {
      for await (const m of iterate()) {
        consumed++;
        yield m;
      }
    };
    live = q;
    play(q, t.segments[0]!);
    return q;
  }) as unknown as typeof query;

  return {
    query: run,
    /** The query the session opened, once it has. */
    q: () => live,
    /** Throws unless every recorded send happened and every recorded frame reached the session. */
    done() {
      if (failures.length > 0) throw new Error(failures.join("\n"));
      if (sends < t.outbound.length) throw new Error(`${t.outbound.length - sends} recorded sends never happened`);
      const total = t.segments.reduce((n, s) => n + s.length, 0);
      if (consumed < total) throw new Error(`${total - consumed} recorded frames were never consumed (${emitted - consumed} emitted and unread)`);
    },
  };
}
