import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Decision,
  Item,
  ItemId,
  PermissionMode,
  Question,
  ServerMessage,
  Target,
  TaskId,
  TaskStatus,
  TaskSummary,
} from "./protocol";
import { approvalDetail, toolSummary, truncate } from "./summary";

export type TaskState = {
  summary: TaskSummary;
  // Map keeps insertion order, which is transcript order.
  items: Map<ItemId, Item>;
  cwd: string;
  // Local: the Agent SDK session id. Cloud: the session_... id from claude.ai.
  sessionId: string | null;
};

export type TaskEvent =
  | { type: "sdk"; message: SDKMessage; at: string }
  | { type: "user_sent"; itemId: ItemId; text: string; at: string }
  | { type: "approval_requested"; itemId: ItemId; tool: string; input: Record<string, unknown>; at: string }
  | { type: "approval_decided"; itemId: ItemId; decision: Decision; at: string }
  | { type: "question_asked"; itemId: ItemId; questions: Question[]; at: string }
  | { type: "question_answered"; itemId: ItemId; answers: Record<string, string>; at: string }
  | { type: "stopped"; at: string; notice?: { itemId: ItemId; text: string } }
  | { type: "crashed"; itemId: ItemId; error: string; at: string }
  | { type: "cloud_created"; itemId: ItemId; sessionId: string; url: string; title: string; at: string }
  | { type: "cloud_followup"; itemId: ItemId; at: string }
  | { type: "cloud_failed"; itemId: ItemId; error: string; at: string };

type Signal =
  | "input_pending"
  | "input_resolved"
  | "user_sent"
  | "result_ok"
  | "result_error"
  | "cloud_ready"
  | "cloud_failed"
  | "stop"
  | "crash";

const transitions: Record<TaskStatus, Partial<Record<Signal, TaskStatus>>> = {
  running: {
    input_pending: "needs_input",
    user_sent: "running",
    result_ok: "idle",
    result_error: "failed",
    cloud_ready: "idle",
    cloud_failed: "failed",
    stop: "stopped",
    crash: "failed",
  },
  needs_input: {
    input_resolved: "running",
    user_sent: "needs_input",
    result_ok: "idle",
    result_error: "failed",
    stop: "stopped",
    crash: "failed",
  },
  // An idle process dying is harmless: the next send resumes the session in a fresh one.
  idle: { user_sent: "running", stop: "stopped" },
  failed: {},
  stopped: {},
};

export const acceptsFollowUp = (status: TaskStatus) => transitions[status].user_sent !== undefined;
export const isLive = (status: TaskStatus) => status === "running" || status === "needs_input";

const TOOL_OUTPUT_MAX = 4000;

export function createTask(params: {
  id: TaskId;
  prompt: string;
  target: Target;
  projectName: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  at: string;
}): TaskState {
  return {
    summary: {
      id: params.id,
      title: truncate(params.prompt.trim().split("\n")[0] ?? "", 60),
      target: params.target,
      projectName: params.projectName,
      model: params.model,
      permissionMode: params.permissionMode,
      status: "running",
      createdAt: params.at,
      updatedAt: params.at,
      preview: "",
      costUsd: 0,
      cloudUrl: null,
    },
    items: new Map(),
    cwd: params.cwd,
    sessionId: null,
  };
}

type Effect = {
  items: Item[];
  signal: Signal | null;
  summary?: Partial<Pick<TaskSummary, "preview" | "costUsd" | "cloudUrl">>;
  sessionId?: string;
};

const none: Effect = { items: [], signal: null };

function interpretSdk(state: TaskState, message: SDKMessage, at: string): Effect {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? { ...none, sessionId: message.session_id } : none;
    case "assistant": {
      // Subagent traffic would interleave with the main transcript; approvals still surface via canUseTool.
      if (message.parent_tool_use_id !== null) return none;
      const items: Item[] = [];
      let preview: string | undefined;
      message.message.content.forEach((block, i) => {
        if (block.type === "text" && block.text.trim() !== "") {
          items.push({ kind: "assistant", id: `${message.uuid}:${i}` as ItemId, text: block.text, at });
          preview = truncate(block.text.replace(/\s+/g, " ").trim(), 120);
        } else if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          items.push({
            kind: "tool",
            id: block.id as ItemId,
            name: block.name,
            summary: toolSummary(block.name, input, state.cwd),
            state: "running",
            output: null,
            at,
          });
        }
      });
      return { items, signal: null, summary: preview === undefined ? undefined : { preview } };
    }
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return none;
      const items: Item[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const existing = state.items.get(block.tool_use_id as ItemId);
        if (existing?.kind !== "tool") continue;
        items.push({
          ...existing,
          state: block.is_error ? "error" : "ok",
          output: truncate(toolResultText(block.content), TOOL_OUTPUT_MAX),
        });
      }
      return { items, signal: null };
    }
    case "result": {
      const ok = message.subtype === "success" && !message.is_error;
      const text = message.subtype === "success" ? message.result : message.errors.join("\n");
      // More queued sends mean another turn follows immediately, so the task is still running.
      const moreQueued = (message.queued_turn_count ?? 0) > 0;
      return {
        items: [
          {
            kind: "result",
            id: `result:${message.uuid}` as ItemId,
            ok,
            text,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
            at,
          },
        ],
        signal: moreQueued ? null : ok ? "result_ok" : "result_error",
        // total_cost_usd is cumulative for the session, so it replaces rather than adds.
        summary: { costUsd: message.total_cost_usd },
      };
    }
    default:
      return none;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

const notice = (id: ItemId, text: string, url: string | null, at: string): Item => ({ kind: "notice", id, text, url, at });

function interpret(state: TaskState, event: TaskEvent): Effect {
  switch (event.type) {
    case "sdk":
      return interpretSdk(state, event.message, event.at);
    case "user_sent":
      return { items: [{ kind: "user", id: event.itemId, text: event.text, at: event.at }], signal: "user_sent" };
    case "approval_requested":
      return {
        items: [
          {
            kind: "approval",
            id: event.itemId,
            tool: event.tool,
            summary: toolSummary(event.tool, event.input, state.cwd),
            detail: approvalDetail(event.tool, event.input, state.cwd),
            state: "pending",
            at: event.at,
          },
        ],
        signal: "input_pending",
      };
    case "approval_decided": {
      const item = state.items.get(event.itemId);
      if (item?.kind !== "approval" || item.state !== "pending") return none;
      return { items: [{ ...item, state: event.decision === "deny" ? "denied" : "allowed" }], signal: "input_resolved" };
    }
    case "question_asked":
      return {
        items: [{ kind: "question", id: event.itemId, questions: event.questions, answers: null, at: event.at }],
        signal: "input_pending",
      };
    case "question_answered": {
      const item = state.items.get(event.itemId);
      if (item?.kind !== "question" || item.answers !== null) return none;
      return { items: [{ ...item, answers: event.answers }], signal: "input_resolved" };
    }
    case "stopped": {
      const denied: Item[] = [];
      for (const item of state.items.values()) {
        if (item.kind === "approval" && item.state === "pending") denied.push({ ...item, state: "denied" });
      }
      const extra = event.notice ? [notice(event.notice.itemId, event.notice.text, null, event.at)] : [];
      return { items: [...denied, ...extra], signal: "stop" };
    }
    case "crashed":
      return { items: [notice(event.itemId, event.error, null, event.at)], signal: "crash" };
    case "cloud_created":
      return {
        items: [notice(event.itemId, `Cloud session created: ${event.title}`, event.url, event.at)],
        signal: "cloud_ready",
        summary: { cloudUrl: event.url, preview: "Running in Claude Code cloud" },
        sessionId: event.sessionId,
      };
    case "cloud_followup":
      return {
        items: [notice(event.itemId, "Follow-up sent to cloud session", state.summary.cloudUrl, event.at)],
        signal: "cloud_ready",
      };
    case "cloud_failed":
      return { items: [notice(event.itemId, event.error, null, event.at)], signal: "cloud_failed" };
  }
}

function pendingInputs(items: Map<ItemId, Item>): number {
  let n = 0;
  for (const item of items.values()) {
    if ((item.kind === "approval" && item.state === "pending") || (item.kind === "question" && item.answers === null)) n++;
  }
  return n;
}

function nextStatus(status: TaskStatus, signal: Signal | null, items: Map<ItemId, Item>): TaskStatus {
  if (signal === null) return status;
  const resolved: Signal =
    signal === "input_pending" || signal === "input_resolved"
      ? pendingInputs(items) > 0
        ? "input_pending"
        : "input_resolved"
      : signal;
  return transitions[status][resolved] ?? status;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function apply(state: TaskState, event: TaskEvent): { state: TaskState; emitted: ServerMessage[] } {
  const effect = interpret(state, event);
  const changed = effect.items.filter((item) => !sameJson(state.items.get(item.id), item));

  const items = changed.length === 0 ? state.items : new Map(state.items);
  for (const item of changed) items.set(item.id, item);

  const status = nextStatus(state.summary.status, effect.signal, items);
  const fields = { ...state.summary, ...effect.summary, status };
  const summaryChanged = !sameJson(fields, state.summary);
  const sessionId = effect.sessionId ?? state.sessionId;

  if (changed.length === 0 && !summaryChanged) {
    return { state: sessionId === state.sessionId ? state : { ...state, sessionId }, emitted: [] };
  }

  const summary = { ...fields, updatedAt: event.at };
  const taskId = summary.id;
  return {
    state: { ...state, summary, items, sessionId },
    emitted: [...changed.map((item): ServerMessage => ({ type: "item", taskId, item })), { type: "task", task: summary }],
  };
}

export type StoredTask = { summary: TaskSummary; items: Item[]; cwd: string; sessionId: string | null };

export const toStored = (s: TaskState): StoredTask => ({ ...s, items: [...s.items.values()] });
export const fromStored = (s: StoredTask): TaskState => ({ ...s, items: new Map(s.items.map((i) => [i.id, i])) });
