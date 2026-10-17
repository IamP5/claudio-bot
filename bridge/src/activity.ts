import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Signal } from "./protocol";
import type { Actor } from "./world";

// The activity line under a bot ("Reading hub.ts", "Running tests"): read from the live query's
// messages, throttled, redacted with text.ts, sent as an unsequenced signal to live sockets only. Never stored,
// replayed or pushed.

/** The line one SDK message shows, or null when it changes nothing. Pure. */
export function activityOf(_m: SDKMessage): string | null {
  return null;
}

export type Activity = {
  /** Every SDK message of a bot's or mac agent's live query. Must not throw: it runs inside the session's onMessage. */
  observe(actor: Actor, m: SDKMessage): void;
  /** The actor's turn ended or it went away: its line clears. */
  clear(actor: Actor): void;
};

export function createActivity(_deps: { signal: (s: Signal) => void; now: () => Date }): Activity {
  return { observe() {}, clear() {} };
}
