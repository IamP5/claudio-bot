import type { CardReply } from "./gate";
import type { Message, PermissionChoice, ServerMessage } from "./protocol";

// An app that speaks protocol 2 connects without ?protocol=3 and decodes a permission card as nothing, so the
// transport shows it each permission card as a question with these options, and the hub reads an answer to that
// question as a decision. It has no Always or Never, and dismissing the card denies the call.

const PROTOCOL_2_OPTIONS = [
  { label: "Allow once", choice: "once" },
  { label: "Deny", choice: "deny" },
] as const satisfies readonly { label: string; choice: PermissionChoice }[];

type Permission = Extract<Message, { kind: "permission" }>;
type Question = Extract<Message, { kind: "question" }>;

function asQuestion(p: Permission): Question {
  const answer = p.answer === null || p.answer === "expired" ? p.answer : p.answer === "once" || p.answer === "always" ? 0 : 1;
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

/** The frame a protocol 2 socket gets in place of `message`: the same frame unless it carries a permission card. */
export function forProtocol2(message: ServerMessage): ServerMessage {
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
