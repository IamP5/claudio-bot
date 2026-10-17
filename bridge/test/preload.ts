import { afterEach, mock } from "bun:test";
import * as sdk from "@anthropic-ai/claude-agent-sdk";

// No test may reach the real claude CLI or start a cloud agent. A test that needs a claude sets its own fake and
// restores this one.
const STAND_IN = "/usr/bin/false";
const configured = process.env.CLAUDIOBOT_CLAUDE;
if (configured !== undefined && configured !== STAND_IN) {
  throw new Error(`CLAUDIOBOT_CLAUDE=${configured} would let tests run a real claude. Unset it or set it to ${STAND_IN} for bun test.`);
}
process.env.CLAUDIOBOT_CLAUDE = STAND_IN;

// A session not handed a query falls back to the SDK's. The session turns that throw into a start-failure note, so the
// test that did it is failed here rather than left to pass on whatever the note changed.
const REACHED = "A test reached the Claude Agent SDK's query. Pass the session a fake query.";
let reached = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...sdk,
  query: () => {
    reached = true;
    throw new Error(REACHED);
  },
}));
afterEach(() => {
  if (!reached) return;
  reached = false;
  throw new Error(REACHED);
});
