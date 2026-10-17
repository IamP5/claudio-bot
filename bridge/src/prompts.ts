import type { AgentId, Attachment, Avatar, BotId, PermissionChoice } from "./protocol";
import type { Initiator, Notice, Origin, RunRef } from "./world";

// Everything that reaches a bot or an agent is one envelope. Its initiator is a pure function of the envelope.
export type Envelope =
  | { from: "user"; text: string; attachments: Attachment[] }
  | { from: "answer"; question: string; option: string }
  | { from: "dismiss"; question: string }
  // A permission card was settled. It carries the held call's initiator, so the continuation keeps it: a call a
  // routine asked for is still a routine's call after the tap.
  | { from: "decision"; choice: PermissionChoice; tool: string; detail: string; initiator: Initiator }
  // manual: Run now from the phone. late: fired after its time because the Mac was asleep, inside the grace window.
  | { from: "routine"; name: string; prompt: string; run: RunRef; manual: boolean; late: boolean }
  // hops and origin come from the agent turn that reported (world.hopsOf, world.rootOf), so the lineage carries on.
  | { from: "agent"; title: string; agentId: AgentId; text: string; hops: number; origin: Origin }
  // hops is world.hopsAfter of the sending turn; origin is world.rootOf of it.
  | { from: "bot"; name: string; botId: BotId; hops: number; origin: Origin; text: string }
  | { from: "created"; by: { bot: string; botId: BotId; hops: number; origin: Origin } | "user"; brief: string | null };

export function initiatorOf(e: Envelope): Initiator {
  switch (e.from) {
    case "user":
    case "answer":
    case "dismiss":
      return { kind: "user" };
    case "decision":
      return e.initiator;
    case "routine":
      return { kind: "routine", run: e.run, manual: e.manual };
    case "agent":
      return { kind: "agent", agentId: e.agentId, hops: e.hops, origin: e.origin };
    case "bot":
      return { kind: "bot", botId: e.botId, hops: e.hops, origin: e.origin };
    case "created":
      return e.by === "user" ? { kind: "user" } : { kind: "bot", botId: e.by.botId, hops: e.by.hops, origin: e.by.origin };
  }
}

/** An approval continuation runs before anything else queued, so the grant it relies on is still fresh. */
export const runsAhead = (e: Envelope): boolean => e.from === "decision";

/** Only a routine's own fire settles its run. A continuation keeps the routine's initiator but settles nothing. */
export const settlesOf = (e: Envelope): RunRef | null => (e.from === "routine" ? e.run : null);

/** What a session queues for one envelope. Session.push takes this, and Pending keeps all of it but `ahead`. */
export type SessionInput = { text: string; initiator: Initiator; settles: RunRef | null; ahead: boolean };

export const inputOf = (e: Envelope, userName: string): SessionInput => ({
  text: envelope(e, userName),
  initiator: initiatorOf(e),
  settles: settlesOf(e),
  ahead: runsAhead(e),
});

const lines = (...xs: (string | null)[]) => xs.filter((x) => x !== null && x !== "").join("\n");

const call = (tool: string, detail: string) => `${tool} \`${detail}\``;

export function envelope(e: Envelope, userName: string): string {
  switch (e.from) {
    case "user":
      return lines(`[${userName}]`, e.text, ...e.attachments.map((a) => `Attached: ${a.path}`));
    case "answer":
      return `[${userName} answered "${e.question}": ${e.option}]`;
    case "dismiss":
      return `[${userName} dismissed "${e.question}" without answering]`;
    case "decision":
      switch (e.choice) {
        case "once":
          return `[${userName} allowed once: ${call(e.tool, e.detail)}. Run exactly that call again now.]`;
        case "always":
          return `[${userName} allowed ${call(e.tool, e.detail)} from now on. Run exactly that call again now.]`;
        case "deny":
          return `[${userName} denied: ${call(e.tool, e.detail)}. Do not try it or anything equivalent.]`;
        case "never":
          return `[${userName} said never: ${call(e.tool, e.detail)}. Do not try it or anything equivalent, now or later.]`;
      }
    case "routine":
      return lines(
        `[Routine ${e.name} fired]`,
        e.prompt,
        e.late ? "(It ran late: the Mac was asleep at its time.)" : null,
        e.manual
          ? `(${userName} ran this now from the phone: reply even if nothing changed.)`
          : `If there is nothing worth telling ${userName}, call routine_no_update and end your turn.`,
      );
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

/** Notices go on top of the next envelope, so expiry and Stop reach the actor without spending a turn. */
export const withNotices = (text: string, notices: readonly Notice[]) => lines(...notices.map((n) => n.text), text);

// Notice texts. None of them is a refusal: an unanswered card is not a no.
export const notices = {
  expiredPermission: (userName: string, tool: string, detail: string) =>
    `[Your request to run ${call(tool, detail)} expired unanswered. It did not run. ${userName} did not say no; ask again later if it still matters.]`,
  expiredQuestion: (userName: string, question: string) =>
    `[Your question "${question}" expired unanswered. ${userName} did not say no; do not act on it.]`,
  droppedByStop: (userName: string, envelopeText: string) =>
    `[${userName} pressed Stop, so this never ran: ${envelopeText.split("\n")[0]}]`,
};

export const onboarding = (userName: string) =>
  `Greet ${userName} by name and introduce yourself in one short message. Then ask what they want help with first. ` +
  `Base the options on what you know about them, plus Coding / building an app and Research and staying informed. ` +
  `After they answer, name yourself with update_self.`;

export const persona = ({ name, userName, userMd }: { name: string; userName: string; userMd: string }) => `\
You are ${name}, a Bot in ClaudioBot. You work for ${userName} on their Mac.
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

/** The bot a first run creates. migrate.ts recognizes an untouched one by these and the job. */
export const DEFAULT_BOT = { name: "Claudio Bot", avatar: { shape: "circle", color: "white" } } as const satisfies { name: string; avatar: Avatar };
export const defaultBotJob = (userName: string) => `General assistant. Take real work off ${userName}'s plate.`;
