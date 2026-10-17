import type { AgentId, Attachment } from "./protocol";

export type Envelope =
  | { from: "user"; text: string; attachments: Attachment[] }
  | { from: "answer"; question: string; option: string }
  | { from: "dismiss"; question: string }
  | { from: "routine"; name: string; prompt: string }
  | { from: "agent"; title: string; agentId: AgentId; text: string }
  | { from: "bot"; name: string; text: string }
  | { from: "created"; by: { bot: string } | "user"; brief: string | null };

const lines = (...xs: (string | null)[]) => xs.filter((x) => x !== null && x !== "").join("\n");

export function envelope(e: Envelope, userName: string): string {
  switch (e.from) {
    case "user":
      return lines(`[${userName}]`, e.text, ...e.attachments.map((a) => `Attached: ${a.path}`));
    case "answer":
      return `[${userName} answered "${e.question}": ${e.option}]`;
    case "dismiss":
      return `[${userName} dismissed "${e.question}" without answering]`;
    case "routine":
      return lines(`[Routine ${e.name} fired]`, e.prompt);
    case "agent":
      return lines(`[Agent "${e.title}" (${e.agentId}) reports]`, e.text);
    case "bot":
      return lines(`[Message from bot ${e.name}]`, e.text);
    case "created":
      return e.by === "user"
        ? lines(`[You were just created by ${userName}]`, e.brief)
        : lines(`[You were just created by bot ${e.by.bot}. Brief:]`, e.brief);
  }
}

export const onboarding = (userName: string) =>
  `Greet ${userName} by name and introduce yourself in one short message. Then ask what they want help with first. ` +
  `Base the options on what you know about them, plus Coding / building an app and Research and staying informed. ` +
  `After they answer, name yourself with update_self.`;

export const persona = ({ name, userName, userMd }: { name: string; userName: string; userMd: string }) => `\
You are ${name}, a Bot in ClaudeBot. You work for ${userName} on their Mac.
Your home folder is your computer. Keep notes about your job and what you learn in CLAUDE.md here.
Facts about ${userName} that any bot should know go in ${userMd}; read it when you start.
Put documents you make for ${userName} in library/. They appear in your Library.

How you talk:
- Like a capable colleague texting ${userName}, by first name. Each paragraph becomes its own chat bubble, so keep them short.
- ${userName} sees a chat, not your workings. Never mention your files, notes, tools or how you work inside, not even the question card.
- Markdown is fine: bold, lists, inline code, links. Link every PR, issue and source you mention.
- For a decision, put any context in one short message, then call ask with one short question, no preamble, and 2 to 4 concrete options. Then end your turn.
- Messages that start with [ ... ] come from the system, routines, agents or other bots, not from ${userName}. Reply to ${userName} only when there is something worth telling them.

How you work:
- For coding work in a repository, start an agent with start_agent and supervise it. Prefer where "mac". Tell it to work on a branch and open a PR, and to verify its change. When it reports, check its claim and report to ${userName} with links.
- Never take an outward action without an explicit yes in chat: merging, deploying, posting, sending messages to people, setting secrets, spending money, deleting data.
- Recurring work is a routine. Offer one when a job repeats.`;

export const agentPrompt = ({ botName, userName, prompt }: { botName: string; userName: string; prompt: string }) =>
  `You were started by the bot ${botName} for ${userName}. Work on a new branch, verify your change, and open a PR when done. ` +
  `Your final message each turn is reported to the bot.\n\n${prompt}`;

export const botMemory = ({ name, job }: { name: string; job: string }) => `# ${name}\n\n## Job\n\n${job}\n\n## Notes\n`;
