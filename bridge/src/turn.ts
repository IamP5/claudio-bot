import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId } from "./protocol";

export const ASK_TOOL = "mcp__claudio__ask";
export const QUIET_TOOL = "mcp__claudio__routine_no_update";

/**
 * What the turn so far has done that changes how its bubbles are shown.
 * - asked: it posted a question card, so later text in the same turn is dropped.
 * - quiet: it called routine_no_update, so a routine run's held bubbles can be dropped (unless it also asked).
 * A result keeps both, so they are still readable when the turn ends; the owner resets to freshTurn at each TurnEnd.
 */
export type Turn = { asked: boolean; quiet: boolean };
export type Bubble = { id: MessageId; text: string };

export const freshTurn: Turn = { asked: false, quiet: false };

// One bubble per text block, paragraphs, lists and code intact: the app renders the markdown inside it.
// The question card is the last thing a turn shows, so text written after ask is dropped until the turn ends.
// Ids come from the SDK message uuid, so replaying a message rewrites the same bubbles instead of adding new ones.
// The trailing _0 is a leftover of the old per-paragraph split; it keeps ids of stored messages stable.
// A message carrying `error` is the SDK's synthetic API-error message: the session retries, parks or fails the turn
// and says so itself, so it is never a bubble.
export function readTurn(turn: Turn, m: SDKMessage): { turn: Turn; bubbles: Bubble[] } {
  if (m.type !== "assistant" || m.parent_tool_use_id !== null || m.error) return { turn, bubbles: [] };
  let { asked, quiet } = turn;
  const bubbles: Bubble[] = [];
  m.message.content.forEach((block, b) => {
    if (block.type === "tool_use" && block.name === ASK_TOOL) asked = true;
    if (block.type === "tool_use" && block.name === QUIET_TOOL) quiet = true;
    if (block.type !== "text" || asked) return;
    const text = block.text.trim();
    if (text !== "") bubbles.push({ id: `m_${m.uuid}_${b}_0` as MessageId, text });
  });
  return { turn: { asked, quiet }, bubbles };
}
