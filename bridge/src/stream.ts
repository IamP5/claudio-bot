import type { Broadcast, ServerMessage, StreamPosition } from "./protocol";

// The resumable broadcast: a seq on every published frame, an epoch per bridge start, and a bounded replay ring.
// Memory only, so a restart means a fresh hello. Every frame is a full upsert, so replaying one twice is harmless.

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
  const epoch = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
  let seq = 0;
  // Seqs are contiguous, so the ring holds frames (seq - ring.length, seq].
  const ring: { frame: string; bytes: number }[] = [];
  let bytes = 0;

  return {
    epoch,
    get seq() {
      return seq;
    },
    append(message) {
      seq += 1;
      const frame = JSON.stringify({ ...message, seq } satisfies Broadcast);
      const size = Buffer.byteLength(frame);
      ring.push({ frame, bytes: size });
      bytes += size;
      while (ring.length > 0 && (ring.length > limits.frames || bytes > limits.bytes)) bytes -= ring.shift()!.bytes;
      return frame;
    },
    since(asked, after) {
      if (asked !== epoch || !Number.isInteger(after) || after < 0 || after > seq) return null;
      const missing = seq - after;
      if (missing > ring.length) return null;
      return ring.slice(ring.length - missing).map((e) => e.frame);
    },
    position: (resumed) => ({ epoch, seq, resumed }),
  };
}
