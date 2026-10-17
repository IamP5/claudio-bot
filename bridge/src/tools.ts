import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { COLORS, SHAPES, type BotId, type Color, type Shape } from "./protocol";

export type BotActions = {
  ask(botId: BotId, a: { question: string; options: string[] }): string;
  startAgent(botId: BotId, a: { title: string; prompt: string; project: string; where: "mac" | "cloud" }): Promise<string>;
  messageAgent(botId: BotId, a: { agentId: string; text: string }): Promise<string>;
  listProjects(): Promise<string>;
  messageBot(botId: BotId, a: { bot: string; text: string }): string;
  createBot(botId: BotId, a: { name: string; job: string; shape?: Shape; color?: Color }): string;
  updateSelf(botId: BotId, a: { name?: string; title?: string; shape?: Shape; color?: Color }): string;
  setRoutine(botId: BotId, a: { name: string; schedule: string; prompt: string; enabled?: boolean }): string;
  deleteRoutine(botId: BotId, a: { name: string }): string;
  routineNoUpdate(botId: BotId): string;
};

async function reply(run: () => string | Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await run() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}
const always = { alwaysLoad: true };
/** Push titles and every phone's bot list show the name, so a long one or one with control or bidi characters is refused. */
export const BOT_NAME_MAX = 40;
const UNSAFE_NAME = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
export const botName = z
  .string()
  .refine(
    (s) => s.trim() !== "" && Array.from(s.trim()).length <= BOT_NAME_MAX && !UNSAFE_NAME.test(s),
    `A bot name is 1 to ${BOT_NAME_MAX} characters, with no control characters.`,
  );
const shape = z.enum(SHAPES).optional();
const color = z.enum(COLORS).optional();

export function botToolServer(botId: BotId, act: BotActions) {
  return createSdkMcpServer({
    name: "claudio",
    tools: [
      tool(
        "ask",
        "Post a question card with lettered options to the user. It does not wait: end your turn, and the answer arrives as a new message.",
        { question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(6) },
        (a) => reply(() => act.ask(botId, a)),
        always,
      ),
      tool(
        "start_agent",
        "Start a Claude Code agent on a project for coding work. project is a name or path from list_projects. where is mac (default, reports back to you) or cloud (needs a GitHub remote, does not report back). Returns the agent id.",
        { title: z.string().min(1), prompt: z.string().min(1), project: z.string().min(1), where: z.enum(["mac", "cloud"]).default("mac") },
        (a) => reply(() => act.startAgent(botId, a)),
        always,
      ),
      tool(
        "message_agent",
        "Send a follow-up to an agent you started.",
        { agentId: z.string().min(1), text: z.string().min(1) },
        (a) => reply(() => act.messageAgent(botId, a)),
        always,
      ),
      tool("list_projects", "List the git projects on this Mac: name, path, branch and GitHub repo.", {}, () => reply(() => act.listProjects()), always),
      tool(
        "message_bot",
        "Send a message to another bot, by name or id.",
        { bot: z.string().min(1), text: z.string().min(1) },
        (a) => reply(() => act.messageBot(botId, a)),
        always,
      ),
      tool(
        "create_bot",
        `Create a new bot with one job. It starts at once with the job as its brief. Shapes: ${SHAPES.join(", ")}. Colors: ${COLORS.join(", ")}.`,
        { name: botName, job: z.string().min(1), shape, color },
        (a) => reply(() => act.createBot(botId, a)),
        always,
      ),
      tool(
        "update_self",
        `Change your own name, label (title), shape or color. Shapes: ${SHAPES.join(", ")}. Colors: ${COLORS.join(", ")}.`,
        { name: botName.optional(), title: z.string().optional(), shape, color },
        (a) => reply(() => act.updateSelf(botId, a)),
        always,
      ),
      tool(
        "set_routine",
        "Create or update (by name) a routine: a prompt you receive on a schedule. schedule is a 5-field cron in the Mac's local time (minute hour day-of-month month day-of-week, Sunday 0).",
        { name: z.string().min(1), schedule: z.string().min(1), prompt: z.string().min(1), enabled: z.boolean().optional() },
        (a) => reply(() => act.setRoutine(botId, a)),
        always,
      ),
      tool("delete_routine", "Delete one of your routines by name.", { name: z.string().min(1) }, (a) => reply(() => act.deleteRoutine(botId, a)), always),
      tool(
        "routine_no_update",
        "In a routine run, call this when there is nothing worth telling the user, then end your turn. Nothing you wrote this turn is shown.",
        {},
        () => reply(() => act.routineNoUpdate(botId)),
        always,
      ),
    ],
  });
}
