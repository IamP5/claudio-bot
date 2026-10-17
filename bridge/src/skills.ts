import type { Homes } from "./home";
import type { BotId, Skill } from "./protocol";
import { refused, type Result } from "./result";

// A bot's skills live in its own home as .claude/skills/<name>/SKILL.md, the project skill path
// probe2 proved loads under settingSources ["user","project"] with the bot home as cwd. save_skill writes there through
// the bridge (a direct Write to .claude/skills stays a self-escalation card), then the bot's query reopens so the next
// turn sees it.

export type Skills = {
  /** The save_skill tool. Returns the tool's reply; throws when it refuses the name or body. */
  save(botId: BotId, a: { name: string; description: string; body: string }): string;
  list(botId: BotId): Skill[];
  remove(botId: BotId, name: string): Result;
};

export type SkillsDeps = {
  homes: Homes;
  /** The bot's live query closes at its next chance, so its next turn loads the changed skills. */
  reopen: (botId: BotId) => void;
  now: () => Date;
};

export function createSkills(_deps: SkillsDeps): Skills {
  return {
    save() {
      throw new Error("Skills are not available on this bridge yet.");
    },
    list: () => [],
    remove: () => refused("Skills are not available on this bridge yet."),
  };
}
