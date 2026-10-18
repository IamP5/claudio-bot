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

// Tests build throwaway repos with git. An inherited GIT_DIR or GIT_WORK_TREE (git rebase --exec sets them) would aim
// those commands at the checkout running the tests and rewrite its branches and config. Deleting them here is not
// enough: the processes tests spawn still inherit them, so refuse to run instead.
const inherited = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"].filter((k) => process.env[k] !== undefined);
if (inherited.length > 0) {
  throw new Error(`${inherited.join(", ")} would aim the tests' git at another repo. Unset ${inherited.length > 1 ? "them" : "it"} for bun test.`);
}

// Sessions take their query from their owner, and only main.ts hands them the SDK's. Any test that still reaches it
// is failed here: the session would turn the throw into a start-failure note the test might pass on.
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
