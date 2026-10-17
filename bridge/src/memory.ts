import type { Homes } from "./home";
import type { BotId, Fact, FactId } from "./protocol";
import { refused, type Result } from "./result";

// What a bot remembers goes through the remember tool, never through a file write the gate
// would card: facts about the user into USER.md's ## Facts (shared by every bot, shown in the app's Memory tab), notes
// about the bot's own job into its CLAUDE.md ## Notes. USER.md's facts reach every bot's query as data when it opens.

/** The most of USER.md's facts a query carries, in bytes of the fenced block. */
export const MEMORY_CONTEXT_MAX = 3 * 1024;

export type Memory = {
  /**
   * Appended to a bot's system prompt as its query opens: USER.md's facts, fenced and labelled as data, at most
   * MEMORY_CONTEXT_MAX bytes. "" when there are none. Called from the hub's options(); it must not throw.
   */
  context(): string;
  /** The remember tool. Returns the tool's reply; throws (the tool reports an error) when it refuses the text. */
  remember(botId: BotId, a: { text: string; about: "user" | "self" }): string;
  facts(): Fact[];
  /** factId null adds a fact. */
  setFact(factId: FactId | null, text: string): Result;
  forgetFact(factId: FactId): Result;
};

export type MemoryDeps = {
  homes: Homes;
  /** The bot's name for Fact.by, read when a fact is remembered. */
  botName: (botId: BotId) => string;
  /** The facts changed: the hub broadcasts a memory frame. */
  changed: () => void;
  now: () => Date;
  log: (line: string) => void;
};

export function createMemory(_deps: MemoryDeps): Memory {
  return {
    context: () => "",
    remember() {
      throw new Error("Memory is not available on this bridge yet.");
    },
    facts: () => [],
    setFact: () => refused("Memory is not available on this bridge yet."),
    forgetFact: () => refused("Memory is not available on this bridge yet."),
  };
}
