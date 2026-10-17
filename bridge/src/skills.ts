import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Homes } from "./home";
import type { BotId, Skill } from "./protocol";
import { refused, type Result } from "./result";
import { hasHiddenCharacters, maskSecrets } from "./text";

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

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 200;
export const SKILL_BODY_MAX = 20 * 1024;
export const SKILLS_MAX = 30;

const nameError = (name: string): string | null =>
  name.length <= SKILL_NAME_MAX && SKILL_NAME.test(name) ? null : `A skill name is lowercase letters and digits joined by single hyphens, at most ${SKILL_NAME_MAX} characters.`;

function contentError(description: string, body: string): string | null {
  if (!description.trim()) return "A skill needs a description.";
  if (/[\r\n]/.test(description)) return "A skill's description is one line.";
  if (description.length > SKILL_DESCRIPTION_MAX) return `A skill's description is at most ${SKILL_DESCRIPTION_MAX} characters.`;
  if (!body.trim()) return "A skill needs a body.";
  if (Buffer.byteLength(body) > SKILL_BODY_MAX) return `A skill's body is at most ${SKILL_BODY_MAX / 1024} KB.`;
  if (hasHiddenCharacters(description) || hasHiddenCharacters(body.replace(/\r?\n|\t/g, ""))) return "A skill cannot contain hidden characters.";
  if (maskSecrets(description) !== description || maskSecrets(body) !== body) return "A skill cannot contain secrets, passwords or tokens.";
  return null;
}

// A JSON string is a valid YAML double-quoted scalar, so any one-line description survives the frontmatter parse.
const skillFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.endsWith("\n") ? body : `${body}\n`}`;

/** The description from a SKILL.md frontmatter, quoted or plain, so a hand-edited file still lists. */
export function descriptionOf(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line = front?.split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  if (!line) return "";
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value.startsWith("'") && value.endsWith("'") && value.length > 1 ? value.slice(1, -1).replace(/''/g, "'") : value;
}

const isRealDir = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isRealFile = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const absent = (path: string) => lstatSync(path, { throwIfNoEntry: false }) === undefined;

export function createSkills(deps: SkillsDeps): Skills {
  /** The bot's skills folder, or null when it, or .claude above it, is anything but a plain folder in the bot's home. */
  function folder(botId: BotId, create: boolean): string | null {
    const home = deps.homes.homeOf(botId);
    if (!isRealDir(home)) return null;
    const dir = join(home, ".claude", "skills");
    for (const d of [join(home, ".claude"), dir]) {
      if (create && absent(d)) mkdirSync(d, { mode: 0o700 });
      if (!isRealDir(d)) return null;
    }
    return realpathSync(dir) === join(realpathSync(home), ".claude", "skills") ? dir : null;
  }

  function names(dir: string): string[] {
    return readdirSync(dir).filter((n) => SKILL_NAME.test(n) && isRealDir(join(dir, n)) && isRealFile(join(dir, n, "SKILL.md")));
  }

  return {
    save(botId, a) {
      const problem = nameError(a.name) ?? contentError(a.description, a.body);
      if (problem) throw new Error(problem);
      const dir = folder(botId, true);
      if (!dir) throw new Error("This bot's skills folder is not a plain folder in its home, so the skill was not saved.");
      const own = join(dir, a.name);
      const replacing = !absent(own);
      if (replacing && !isRealDir(own)) throw new Error(`The skill ${a.name} is not a plain folder, so it was not replaced.`);
      if (!replacing && names(dir).length >= SKILLS_MAX) throw new Error(`This bot already has ${SKILLS_MAX} skills. Ask the user to delete one first.`);
      if (!replacing) mkdirSync(own, { mode: 0o700 });
      const tmp = join(own, `.SKILL.md.${randomBytes(6).toString("hex")}.tmp`);
      writeFileSync(tmp, skillFile(a.name, a.description, a.body), { mode: 0o600, flag: "wx" });
      renameSync(tmp, join(own, "SKILL.md"));
      deps.reopen(botId);
      return replacing
        ? `Replaced the skill ${a.name}. The new version loads in your next turn.`
        : `Saved the skill ${a.name}. It loads in your next turn; the user can see and delete it in your profile.`;
    },

    list(botId) {
      const dir = folder(botId, false);
      if (!dir) return [];
      return names(dir)
        .map((name) => {
          const file = join(dir, name, "SKILL.md");
          return { name, description: descriptionOf(readFileSync(file, "utf8")), updatedAt: lstatSync(file).mtime.toISOString() };
        })
        .sort((x, y) => x.name.localeCompare(y.name));
    },

    remove(botId, name) {
      const problem = nameError(name);
      if (problem) return refused(problem);
      const dir = folder(botId, false);
      if (!dir || !names(dir).includes(name)) return refused(`This bot has no skill named ${name}.`);
      rmSync(join(dir, name), { recursive: true });
      deps.reopen(botId);
      return { ok: true };
    },
  };
}
