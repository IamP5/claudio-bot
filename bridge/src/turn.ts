import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId } from "./protocol";

export const ASK_TOOL = "mcp__claudio__ask";

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

function paragraphs(text: string): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (fence === null && line.trim() === "") {
      if (current.length > 0) chunks.push(current);
      current = [];
      continue;
    }
    current.push(line);
    const marker = FENCE.exec(line)?.[1];
    if (!marker) continue;
    if (fence === null) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// One chat bubble per paragraph. A line ending in ":" stays with what it introduces, and a list stays whole.
export function splitBubbles(text: string): string[] {
  const bubbles: string[] = [];
  let joinNext = false;
  let inList = false;
  for (const chunk of paragraphs(text.trim())) {
    const first = chunk[0]!;
    const item: boolean = LIST_ITEM.test(first) || (inList && /^\s/.test(first));
    const body = chunk.join("\n").trimEnd();
    if (bubbles.length > 0 && (joinNext || (inList && item))) bubbles[bubbles.length - 1] += `\n\n${body}`;
    else bubbles.push(body);
    inList = item;
    joinNext = chunk.at(-1)!.trimEnd().endsWith(":");
  }
  return bubbles;
}

export type Turn = { asked: boolean };
export type Bubble = { id: MessageId; text: string };

export const freshTurn: Turn = { asked: false };

// The question card is the last thing a turn shows, so text written after ask is dropped until the turn's result.
// Ids come from the SDK message uuid, so replaying a message rewrites the same bubbles instead of adding new ones.
export function readTurn(turn: Turn, m: SDKMessage): { turn: Turn; bubbles: Bubble[] } {
  if (m.type === "result") return { turn: freshTurn, bubbles: [] };
  if (m.type !== "assistant" || m.parent_tool_use_id !== null) return { turn, bubbles: [] };
  let asked = turn.asked;
  const bubbles: Bubble[] = [];
  m.message.content.forEach((block, b) => {
    if (block.type === "tool_use" && block.name === ASK_TOOL) asked = true;
    if (block.type !== "text" || asked) return;
    splitBubbles(block.text).forEach((text, p) => bubbles.push({ id: `m_${m.uuid}_${b}_${p}` as MessageId, text }));
  });
  return { turn: { asked }, bubbles };
}
