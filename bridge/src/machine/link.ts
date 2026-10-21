import { randomBytes } from "node:crypto";
import { signWith, verifyWith } from "./identity";
import type { HomeFrame, MachineFrame, MachineId, ProfileView, Seq } from "./wire";

// The link's handshake, as pure steps over its state. The home speaks first with a nonce; the machine proves its key
// over that nonce and the home's id, and sends a nonce of its own; the home proves its key over that and the
// machine's id. Each side checks the other against the key it pinned at enrollment. Until both proofs pass, nothing
// but the handshake crosses, and any other frame closes the link.

export type LinkState =
  | { kind: "connecting" }
  /** This side sent its nonce and waits for the proof over it. */
  | { kind: "challenged"; nonce: string }
  | { kind: "live"; peer: MachineId }
  | { kind: "closed"; reason: string };

export const newNonce = () => randomBytes(32).toString("hex");

/**
 * What a side signs: who signs, the other side's nonce, then the other side's id, so a proof is good for one link to
 * one peer, and a machine's proof never passes for the home's.
 */
const PROOF = { machine: "claudiobot-link machine-proof v1\n", home: "claudiobot-link home-proof v1\n" } as const;
const proofOf = (by: keyof typeof PROOF, nonce: string, peer: MachineId) => Buffer.concat([Buffer.from(PROOF[by]), Buffer.from(nonce, "hex"), Buffer.from(peer)]);

type Hello = Extract<MachineFrame, { t: "hello" }>;
type Live<F, T> = Extract<F, { t: T }>;

export type HomeStep =
  | { kind: "close"; reason: string }
  /** ackedSeq: where the machine's replay starts. */
  | { kind: "welcome"; state: Extract<LinkState, { kind: "live" }>; send: HomeFrame; hello: Hello; ackedSeq: Seq }
  | { kind: "frame"; peer: MachineId; frame: Live<MachineFrame, "event" | "applied" | "reply" | "signal"> };

export type MachineStep =
  | { kind: "close"; reason: string }
  | { kind: "hello"; state: Extract<LinkState, { kind: "challenged" }>; send: MachineFrame }
  | { kind: "live"; state: Extract<LinkState, { kind: "live" }>; ackedSeq: Seq }
  | { kind: "frame"; frame: Live<HomeFrame, "intent" | "ack" | "ask"> };

export function homeOpens(nonce = newNonce()): { state: LinkState; send: HomeFrame } {
  return { state: { kind: "challenged", nonce }, send: { t: "challenge", nonce } };
}

export function homeHears(
  state: LinkState,
  frame: MachineFrame,
  home: { machineId: MachineId; privateKey: string },
  /** The machine's pinned key and the newest seq the home saved from it; null: not enrolled. */
  pinned: (id: MachineId) => { publicKey: string; ackedSeq: Seq } | null,
): HomeStep {
  switch (state.kind) {
    case "challenged": {
      if (frame.t !== "hello") return { kind: "close", reason: `expected hello, got ${frame.t}` };
      const known = pinned(frame.machineId);
      if (known === null) return { kind: "close", reason: `machine ${frame.machineId} is not enrolled` };
      if (!verifyWith(known.publicKey, proofOf("machine", state.nonce, home.machineId), frame.sig)) return { kind: "close", reason: `machine ${frame.machineId} did not prove its enrolled key` };
      // A machine whose outbox is behind what the home saved lost its journal: it starts over from its first event.
      const ackedSeq = frame.lastSeq < known.ackedSeq ? 0 : known.ackedSeq;
      return {
        kind: "welcome",
        state: { kind: "live", peer: frame.machineId },
        send: { t: "welcome", sig: signWith(home.privateKey, proofOf("home", frame.nonce, frame.machineId)), ackedSeq },
        hello: frame,
        ackedSeq,
      };
    }
    case "live":
      if (frame.t === "event" || frame.t === "applied" || frame.t === "reply" || frame.t === "signal") return { kind: "frame", peer: state.peer, frame };
      return { kind: "close", reason: `unexpected ${frame.t} on a live link` };
    case "connecting":
    case "closed":
      return { kind: "close", reason: `unexpected ${frame.t} before the challenge` };
  }
}

export function machineHears(
  state: LinkState,
  frame: HomeFrame,
  me: { machineId: MachineId; privateKey: string; home: { machineId: MachineId; publicKey: string } },
  hello: () => { profile: ProfileView; lastSeq: Seq },
  nonce = newNonce(),
): MachineStep {
  switch (state.kind) {
    case "connecting": {
      if (frame.t !== "challenge") return { kind: "close", reason: `expected a challenge, got ${frame.t}` };
      const { profile, lastSeq } = hello();
      return {
        kind: "hello",
        state: { kind: "challenged", nonce },
        send: { t: "hello", machineId: me.machineId, sig: signWith(me.privateKey, proofOf("machine", frame.nonce, me.home.machineId)), nonce, profile, lastSeq },
      };
    }
    case "challenged":
      if (frame.t !== "welcome") return { kind: "close", reason: `expected welcome, got ${frame.t}` };
      if (!verifyWith(me.home.publicKey, proofOf("home", state.nonce, me.machineId), frame.sig)) return { kind: "close", reason: "the home did not prove its enrolled key" };
      return { kind: "live", state: { kind: "live", peer: me.home.machineId }, ackedSeq: frame.ackedSeq };
    case "live":
      if (frame.t === "intent" || frame.t === "ack" || frame.t === "ask") return { kind: "frame", frame };
      return { kind: "close", reason: `unexpected ${frame.t} on a live link` };
    case "closed":
      return { kind: "close", reason: `unexpected ${frame.t} after close` };
  }
}
