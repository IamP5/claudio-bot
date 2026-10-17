import type { ServerMessage, StreamPosition } from "./protocol";

// The resumable broadcast: a seq on every published frame, an epoch per bridge start, and a bounded replay ring.
// Memory only, so a restart means a fresh hello. Every frame is a full upsert, so replaying one twice is harmless.
// Owner: U5.

export type Stream = {
  /** Random per start; never "" (that means "no ring" on the wire). */
  readonly epoch: string;
  /** The seq of the last frame appended. */
  readonly seq: number;
  /** Stamps the next seq, keeps the JSON frame in the ring, and returns it for server.publish. */
  append(message: ServerMessage): string;
  /** Frames after `after` when the epoch matches and the ring still holds all of them; null means a fresh hello only. */
  since(epoch: string, after: number): string[] | null;
  /** For the hello. */
  position(resumed: boolean): StreamPosition;
};

export function createStream(limits: { frames: number; bytes: number } = { frames: 2000, bytes: 8 << 20 }): Stream {
  throw new Error("not implemented");
}
