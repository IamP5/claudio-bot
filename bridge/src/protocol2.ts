import type { CardReply } from "./gate";
import { isSessionFrame, type Message, type PermissionChoice, type ServerMessage } from "./protocol";

// An app that speaks protocol 2 connects without ?protocol=3 and decodes a permission card as nothing, so the
// transport shows it each permission card as a question with these options, and the hub reads an answer to that
// question as a decision. It has no Always or Never, and dismissing the card denies the call. It has no Sessions view
// either, so it gets no session frame.

const PROTOCOL_2_OPTIONS = [
  { label: "Allow once", choice: "once" },
  { label: "Deny", choice: "deny" },
] as const satisfies readonly { label: string; choice: PermissionChoice }[];

type Permission = Extract<Message, { kind: "permission" }>;
type Question = Extract<Message, { kind: "question" }>;

const ANSWERS: Record<NonNullable<Permission["answer"]>, Question["answer"]> = {
  once: 0, always: 0, deny: 1, never: 1, expired: "expired", stopped: "dismissed",
};

function asQuestion(p: Permission): Question {
  const answer = p.answer === null ? null : ANSWERS[p.answer];
  return {
    kind: "question",
    id: p.id,
    at: p.at,
    question: `${p.from ? `${p.from.title}: ` : ""}${p.label}: ${p.detail}`,
    options: PROTOCOL_2_OPTIONS.map((o) => o.label),
    answer,
    expiresAt: p.expiresAt,
  };
}

const downgrade = (m: Message): Message => (m.kind === "permission" ? asQuestion(m) : m);

/**
 * The frame a protocol 2 socket gets in place of `message`: the same frame unless it carries a permission card, and
 * null for a session frame, which it never gets.
 */
export function forProtocol2(message: ServerMessage): ServerMessage | null {
  if (isSessionFrame(message)) return null;
  switch (message.type) {
    case "message":
      return message.message.kind === "permission" ? { ...message, message: asQuestion(message.message) } : message;
    case "conversation":
      return message.messages.some((m) => m.kind === "permission") ? { ...message, messages: message.messages.map(downgrade) } : message;
    default:
      return message;
  }
}

/** What a tap on a card means. On a permission card it comes from a protocol 2 app; null is an option it never showed. */
export function cardReply(card: Message | undefined, tap: { type: "answer"; option: number } | { type: "dismiss" }): CardReply | null {
  if (card?.kind !== "permission") return tap.type === "answer" ? { kind: "option", index: tap.option } : { kind: "dismiss" };
  if (tap.type === "dismiss") return { kind: "permission", choice: "deny" };
  const option = PROTOCOL_2_OPTIONS[tap.option];
  return option ? { kind: "permission", choice: option.choice } : null;
}
