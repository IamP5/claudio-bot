import type { Avatar, BotId, Mention, MessageId } from "./protocol";
import { clip, maskSecrets } from "./text";
import type { GroupRecord, World } from "./world";

// The rules of a group chat, pure. A group is a chat of the user and its member bots; each member answers in it from
// its own session, so the hub routes a group's sends to members and their replies back. Nothing here runs a turn.

/** How many bots a group holds. parse.ts refuses a create_group or a members patch outside it. */
export const GROUP_SIZE = { min: 2, max: 8 } as const;

/** The newest messages a member's turn shows of the group, and the most text they may take. */
export const TRANSCRIPT_MESSAGES = 20;
export const TRANSCRIPT_CHARS = 6_000;
const LINE_CHARS = 800;

/** null when every id is a bot of this bridge; otherwise why the list cannot be a group's members. */
export function membersError(world: World, ids: readonly BotId[]): string | null {
  if (ids.some((id) => world.groups.has(id))) return "A group cannot be a member of another group.";
  if (ids.some((id) => !world.bots.has(id))) return "One of those bots no longer exists.";
  return null;
}

export function newGroup(fields: { id: BotId; name: string; members: BotId[]; avatar: Avatar; at: string }): GroupRecord {
  return {
    id: fields.id,
    name: fields.name,
    title: null,
    avatar: fields.avatar,
    pinned: false,
    hidden: false,
    createdAt: fields.at,
    messages: [],
    unread: 0,
    muted: false,
    members: fields.members,
  };
}

/** Who a user's message in the group goes to: the members it mentions, or every member when it mentions none. */
export function targetsOf(group: GroupRecord, mentions: readonly Mention[]): BotId[] {
  const named = group.members.filter((id) => mentions.some((m) => m.kind === "bot" && m.id === id));
  return named.length > 0 ? named : [...group.members];
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The bots a member's reply @mentions, in the order it names them: "@" then a bot's exact name, ignoring case, at the
 * start of a word and not running on into one. The longest name wins, so "@Ana Lee" is Ana Lee, not Ana.
 */
export function mentionedIn(text: string, bots: readonly { id: BotId; name: string }[]): BotId[] {
  const lower = text.toLowerCase();
  const names = bots.map((b) => ({ id: b.id, name: b.name.toLowerCase() })).sort((a, b) => b.name.length - a.name.length);
  const found: BotId[] = [];
  for (let at = lower.indexOf("@"); at !== -1; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && WORD.test(lower[at - 1]!)) continue;
    const hit = names.find((b) => lower.startsWith(b.name, at + 1) && !WORD.test(lower[at + 1 + b.name.length] ?? ""));
    if (hit && !found.includes(hit.id)) found.push(hit.id);
  }
  return found;
}

/**
 * The group's recent conversation as a member's turn reads it, oldest first: "name: text" per user or member message,
 * the user named userName, secrets masked, each line cut to LINE_CHARS, at most TRANSCRIPT_MESSAGES lines and
 * TRANSCRIPT_CHARS characters. Notes are left out, and so are the messages in `skip` (the one the turn is about).
 */
export function transcript(group: GroupRecord, nameOf: (id: BotId) => string, userName: string, skip: ReadonlySet<MessageId>): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = group.messages.length - 1; i >= 0 && lines.length < TRANSCRIPT_MESSAGES; i--) {
    const m = group.messages[i]!;
    if (skip.has(m.id) || (m.kind !== "user" && m.kind !== "bot")) continue;
    const who = m.kind === "user" ? userName : m.from === undefined ? "a bot" : nameOf(m.from);
    const line = `${who}: ${clip(maskSecrets(m.text).replace(/\s+/g, " ").trim(), LINE_CHARS)}`;
    if (size + line.length > TRANSCRIPT_CHARS) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The group's activity line while members work on it: "engineer is typing…". null when none does. The app shows it
 * as the group's typing row and under the group in the list; it names only turns for this group.
 */
export function typingLine(names: readonly string[]): string | null {
  switch (names.length) {
    case 0:
      return null;
    case 1:
      return `${names[0]} is typing…`;
    case 2:
      return `${names[0]} and ${names[1]} are typing…`;
    default:
      return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing…`;
  }
}
