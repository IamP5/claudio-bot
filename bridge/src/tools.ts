import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { COLORS, SHAPES, type BotId, type Color, type Shape } from "./protocol";
import { BOT_NAME_MAX, errorText, hasHiddenCharacters } from "./text";

/**
 * Every tool the bridge's own claudio server offers. policy.ts keys a Record on this, so a tool added here without a
 * policy entry fails to compile, and a call naming any other mcp__claudio__ tool is denied.
 */
export const CLAUDIO_TOOLS = [
  "ask",
  "start_agent",
  "message_agent",
  "list_projects",
  "message_bot",
  "create_bot",
  "update_self",
  "set_routine",
  "delete_routine",
  "list_routines",
  "routine_no_update",
  "remember",
  "save_skill",
] as const;
export type ClaudioTool = (typeof CLAUDIO_TOOLS)[number];


/** Where a mac agent works: auto lets the bridge choose (a worktree when the checkout has uncommitted work or another agent). */
export type Isolate = "auto" | "none" | "worktree";

export type BotActions = {
  ask(botId: BotId, a: { question: string; options: string[] }): string;
  startAgent(botId: BotId, a: { title: string; prompt: string; project: string; where: "mac" | "cloud"; isolate: Isolate; slash?: string }): Promise<string>;
  messageAgent(botId: BotId, a: { agentId: string; text: string }): Promise<string>;
  listProjects(): Promise<string>;
  messageBot(botId: BotId, a: { bot: string; text: string }): string;
  createBot(botId: BotId, a: { name: string; job: string; shape?: Shape; color?: Color }): string;
  updateSelf(botId: BotId, a: { name?: string; title?: string; shape?: Shape; color?: Color; job?: string }): string;
  setRoutine(botId: BotId, a: { name: string; trigger: "cron" | "webhook"; schedule?: string; prompt: string; enabled?: boolean }): string;
  deleteRoutine(botId: BotId, a: { name: string }): string;
  listRoutines(botId: BotId): string;
  routineNoUpdate(botId: BotId): string;
  remember(botId: BotId, a: { text: string; about: "user" | "self" }): string;
  saveSkill(botId: BotId, a: { name: string; description: string; body: string }): string;
};

async function reply(run: () => string | Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await run() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
  }
}
const always = { alwaysLoad: true };
/** A name a phone would show cut short or other than it reads is refused rather than cleaned. */
export const botName = z
  .string()
  .refine(
    (s) => s.trim() !== "" && Array.from(s.trim()).length <= BOT_NAME_MAX && !hasHiddenCharacters(s),
    `A bot name is 1 to ${BOT_NAME_MAX} characters, with no control or invisible characters.`,
  );
const shape = z.enum(SHAPES).optional();
const color = z.enum(COLORS).optional();

export function botToolServer(botId: BotId, act: BotActions) {
  const tools: { [K in ClaudioTool]: SdkMcpToolDefinition<any> } = {
    ask: tool(
      "ask",
      "Post a question card with lettered options to the user. It does not wait: end your turn, and the answer arrives as a new message.",
      { question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(6) },
      (a) => reply(() => act.ask(botId, a)),
      always,
    ),
    start_agent: tool(
      "start_agent",
      "Start a Claude Code agent on a project for coding work. project is a name or path from list_projects. where is mac (default, reports back to you) or cloud (needs a GitHub remote, does not report back). isolate (mac only): auto (default) lets the bridge decide, worktree gives the agent its own git worktree, none works in the project folder itself. slash (mac only): a skill or command name, without the /; the agent's first turn is then exactly \"/<slash> <prompt>\", as if the user typed it, which runs skills that only the user can invoke. Returns the agent id.",
      {
        title: z.string().min(1),
        prompt: z.string().min(1),
        project: z.string().min(1),
        where: z.enum(["mac", "cloud"]).default("mac"),
        isolate: z.enum(["auto", "none", "worktree"]).default("auto"),
        slash: z.string().min(1).optional(),
      },
      (a) => reply(() => act.startAgent(botId, a)),
      always,
    ),
    message_agent: tool(
      "message_agent",
      "Send a follow-up to an agent you started.",
      { agentId: z.string().min(1), text: z.string().min(1) },
      (a) => reply(() => act.messageAgent(botId, a)),
      always,
    ),
    list_projects: tool("list_projects", "List the git projects on this Mac: name, path, branch and GitHub repo.", {}, () => reply(() => act.listProjects()), always),
    message_bot: tool(
      "message_bot",
      "Send a message to another bot, by name, title or id.",
      { bot: z.string().min(1), text: z.string().min(1) },
      (a) => reply(() => act.messageBot(botId, a)),
      always,
    ),
    create_bot: tool(
      "create_bot",
      `Create a new bot with one job. It starts at once with the job as its brief. Shapes: ${SHAPES.join(", ")}. Colors: ${COLORS.join(", ")}.`,
      { name: botName, job: z.string().min(1), shape, color },
      (a) => reply(() => act.createBot(botId, a)),
      always,
    ),
    update_self: tool(
      "update_self",
      `Change your own name, label (title), shape or color, or your job once the user tells you what it is (only in a turn the user started). Shapes: ${SHAPES.join(", ")}. Colors: ${COLORS.join(", ")}.`,
      { name: botName.optional(), title: z.string().optional(), shape, color, job: z.string().min(1).max(1000).optional() },
      (a) => reply(() => act.updateSelf(botId, a)),
      always,
    ),
    set_routine: tool(
      "set_routine",
      "Create or update (by name) a routine: a prompt you receive when it fires. trigger cron (default) fires on schedule, a 5-field cron in the Mac's local time (minute hour day-of-month month day-of-week, Sunday 0). trigger webhook fires when a program on this Mac calls its webhook; the user makes its token on the phone, and the call's payload reaches you as data.",
      {
        name: z.string().min(1),
        trigger: z.enum(["cron", "webhook"]).default("cron"),
        schedule: z.string().min(1).optional(),
        prompt: z.string().min(1),
        enabled: z.boolean().optional(),
      },
      (a) => reply(() => act.setRoutine(botId, a)),
      always,
    ),
    delete_routine: tool("delete_routine", "Delete one of your routines by name.", { name: z.string().min(1) }, (a) => reply(() => act.deleteRoutine(botId, a)), always),
    list_routines: tool(
      "list_routines",
      "List your routines: when each runs, whether it is on, and how its last run went.",
      {},
      () => reply(() => act.listRoutines(botId)),
      always,
    ),
    routine_no_update: tool(
      "routine_no_update",
      "In a routine run, call this when there is nothing worth telling the user, then end your turn. Nothing you wrote this turn is shown.",
      {},
      () => reply(() => act.routineNoUpdate(botId)),
      always,
    ),
    remember: tool(
      "remember",
      "Remember one short fact for later turns. about user: a fact about the user. You see it from your next turn; it is a proposal the user sees in Settings, Memory, and it reaches every bot once they confirm it. about self: a note about your own job. Never store secrets, passwords or tokens.",
      { text: z.string().min(1), about: z.enum(["user", "self"]) },
      (a) => reply(() => act.remember(botId, a)),
      always,
    ),
    save_skill: tool(
      "save_skill",
      "Save a skill: instructions for a task you will be asked to do again, loaded in your later turns. name is lowercase words joined by hyphens. Saving a name again replaces that skill.",
      { name: z.string().min(1), description: z.string().min(1), body: z.string().min(1) },
      (a) => reply(() => act.saveSkill(botId, a)),
      always,
    ),
  };
  return createSdkMcpServer({ name: "claudio", tools: Object.values(tools) });
}
