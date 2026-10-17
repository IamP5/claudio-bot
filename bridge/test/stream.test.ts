import { expect, test } from "bun:test";
import type { BotId, ServerMessage } from "../src/protocol";
import { createStream } from "../src/stream";

const removed = (n: number): ServerMessage => ({ type: "bot_removed", botId: `b_${n}` as BotId });
const seqOf = (frame: string) => (JSON.parse(frame) as { seq: number }).seq;

test("every appended frame carries the next seq and the message itself", () => {
  const stream = createStream();
  const frames = [1, 2, 3].map((n) => stream.append(removed(n)));
  expect(frames.map((f) => JSON.parse(f))).toEqual([
    { type: "bot_removed", botId: "b_1", seq: 1 },
    { type: "bot_removed", botId: "b_2", seq: 2 },
    { type: "bot_removed", botId: "b_3", seq: 3 },
  ]);
  expect(stream.seq).toBe(3);
});

test("the epoch is never empty and differs per start", () => {
  const a = createStream();
  const b = createStream();
  expect(a.epoch).not.toBe("");
  expect(a.epoch).not.toBe(b.epoch);
});

test("position reports the epoch and the last seq", () => {
  const stream = createStream();
  stream.append(removed(1));
  expect(stream.position(true)).toEqual({ epoch: stream.epoch, seq: 1, resumed: true });
  expect(stream.position(false)).toEqual({ epoch: stream.epoch, seq: 1, resumed: false });
});

test("since covers exactly the frames after the client's last seq", () => {
  const stream = createStream();
  for (const n of [1, 2, 3, 4]) stream.append(removed(n));
  const cases: [after: number, seqs: number[] | null][] = [
    [0, [1, 2, 3, 4]],
    [2, [3, 4]],
    [4, []],
    [5, null],
    [-1, null],
    [1.5, null],
  ];
  for (const [after, seqs] of cases) expect([after, stream.since(stream.epoch, after)?.map(seqOf) ?? null]).toEqual([after, seqs]);
});

test("a different epoch never resumes, so a restarted bridge sends a fresh hello", () => {
  const before = createStream();
  before.append(removed(1));
  const after = createStream();
  after.append(removed(1));
  expect(after.since(before.epoch, 0)).toBeNull();
  expect(after.since("", 0)).toBeNull();
});

test("the ring evicts the oldest frames past its frame count", () => {
  const stream = createStream({ frames: 3, bytes: 1 << 20 });
  for (const n of [1, 2, 3, 4, 5]) stream.append(removed(n));
  expect(stream.since(stream.epoch, 1)).toBeNull();
  expect(stream.since(stream.epoch, 2)?.map(seqOf)).toEqual([3, 4, 5]);
});

test("the ring evicts the oldest frames past its byte budget", () => {
  const size = Buffer.byteLength(createStream().append(removed(1)));
  const stream = createStream({ frames: 100, bytes: size * 2 });
  for (const n of [1, 2, 3, 4]) stream.append(removed(n));
  expect(stream.since(stream.epoch, 1)).toBeNull();
  expect(stream.since(stream.epoch, 2)?.map(seqOf)).toEqual([3, 4]);
});

test("a frame bigger than the whole budget leaves nothing to replay but the seq still advances", () => {
  const stream = createStream({ frames: 100, bytes: 10 });
  stream.append(removed(1));
  expect(stream.seq).toBe(1);
  expect(stream.since(stream.epoch, 0)).toBeNull();
  expect(stream.since(stream.epoch, 1)).toEqual([]);
});
