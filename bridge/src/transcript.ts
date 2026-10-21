import { getSessionInfo, getSessionMessages, listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { PERMISSION_MODES, type AskQuestion, type ItemId, type PermissionMode, type SessionId, type SessionItem, type SessionPr, type ToolStep } from "./protocol";
import { directHeader } from "./prompts";
import { maskProse, maskSecrets } from "./text";

// The only reader of Claude Code's transcripts (~/.claude/projects/<folder>/<id>.jsonl). Heads come from the SDK's
// listSessions plus a small head and tail read; a thread is every line of the file put in the SDK's chain order;
// appended lines are read as they come. project() turns entries into thread items with ids that history and the live
// tail agree on. Unknown or malformed lines are skipped, never thrown.

/** What a list row needs from one transcript, rebuilt only when its size or mtime changed. */
export type Head = {
  id: SessionId;
  file: string;
  size: number;
  mtimeMs: number;
  cwd: string;
  createdAt: number;
  lastAt: number;
  /** The custom title, else Claude Code's own summary or the first prompt, as the SDK picks it. */
  title: string;
  branch: string | null;
  /** The entrypoint of the session's first entry ("cli", "claude-desktop", "sdk-ts", …) and of its last. */
  firstEntry: string | null;
  lastEntry: string | null;
  pr: SessionPr | null;
  mode: PermissionMode | null;
  model: string | null;
  /** Whose entry ends the conversation: a prompt the user sent, or the assistant's turn (a tool result counts as its). */
  lastRole: "user" | "assistant" | null;
};

/** One line of the conversation chain. Lines of other types (titles, snapshots, queue operations) are not entries. */
export type Entry = {
  uuid: string;
  parent: string | null;
  /** Set on a compact_boundary, whose parent is null: the entry it continues from. */
  logicalParent: string | null;
  at: string;
  type: "user" | "assistant" | "system" | "attachment";
  subtype: string | null;
  message: { id?: string; model?: string; content?: unknown } | null;
  /** The content block's index in its API message, which a live stream's content_block index matches. */
  blockIndex: number | null;
  meta: boolean;
  compactSummary: boolean;
  sidechain: boolean;
  apiError: boolean;
  toolResult: unknown;
  thinkingMs: number | null;
};

/** How a transcript's chain stands: the uuids on it and the newest. A line that does not continue it is a fork. */
export type Chain = { uuids: Set<string>; leaf: string | null };

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 64 * 1024;
/** An append larger than this is read from its last TAIL_BYTES only: facts are taken from the newest lines. */
const APPEND_SCAN_MAX = 1024 * 1024;
export const OUTPUT_TAIL = 2048;
export const FULL_OUTPUT_MAX = 64 * 1024;
const THINKING_MAX = 400;

const ENTRY_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "system", "attachment"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function toEntry(o: Record<string, unknown>): Entry | null {
  const uuid = str(o.uuid);
  const type = str(o.type);
  if (uuid === null || type === null || !ENTRY_TYPES.has(type)) return null;
  return {
    uuid,
    parent: str(o.parentUuid),
    logicalParent: str(o.logicalParentUuid),
    at: str(o.timestamp) ?? "",
    type: type as Entry["type"],
    subtype: str(o.subtype),
    message: isRecord(o.message) ? (o.message as Entry["message"]) : null,
    blockIndex: typeof o.apiBlockIndex === "number" ? o.apiBlockIndex : null,
    meta: o.isMeta === true,
    compactSummary: o.isCompactSummary === true,
    sidechain: o.isSidechain === true,
    apiError: o.isApiErrorMessage === true,
    toolResult: o.toolUseResult,
    thinkingMs: typeof o.thinkingDurationMs === "number" ? o.thinkingDurationMs : null,
  };
}

export function parseEntry(line: string): Entry | null {
  const o = line.trim() === "" ? null : parseJson(line);
  return o === null ? null : toEntry(o);
}

function readRange(file: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/** The complete lines of a byte range; a partial first line (when `cut`) and a partial last line are left out. */
function linesOf(text: string, cut: boolean): string[] {
  const lines = text.split("\n");
  lines.pop();
  if (cut) lines.shift();
  return lines;
}

type Facts = Pick<Head, "firstEntry" | "lastEntry" | "pr" | "mode" | "model" | "lastRole"> & { cwd: string | null };
const noFacts = (): Facts => ({ firstEntry: null, lastEntry: null, pr: null, mode: null, model: null, lastRole: null, cwd: null });

const isMode = (v: unknown): v is PermissionMode => typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);

function isToolResult(message: unknown): boolean {
  const content = isRecord(message) ? message.content : null;
  return Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result");
}

/** Folds the facts of these lines, oldest first, onto what is known: a later line wins. */
function scan(lines: readonly string[], into: Facts): Facts {
  const f = { ...into };
  for (const line of lines) {
    // Most lines name none of these, and the big ones (tool results, request blobs) are skipped unparsed.
    if (!/"(type|entrypoint)":/.test(line)) continue;
    const o = parseJson(line);
    if (o === null) continue;
    const entry = str(o.entrypoint);
    if (entry !== null) {
      f.firstEntry ??= entry;
      f.lastEntry = entry;
    }
    f.cwd ??= str(o.cwd);
    switch (o.type) {
      case "pr-link":
        if (typeof o.prNumber === "number" && typeof o.prUrl === "string") f.pr = { number: o.prNumber, url: o.prUrl, state: null };
        break;
      case "permission-mode":
        if (isMode(o.permissionMode)) f.mode = o.permissionMode;
        break;
      case "user":
        if (o.isSidechain === true || o.isMeta === true) break;
        if (isMode(o.permissionMode)) f.mode = o.permissionMode;
        f.lastRole = isToolResult(o.message) ? "assistant" : "user";
        break;
      case "assistant": {
        if (o.isSidechain === true) break;
        const model = isRecord(o.message) ? str(o.message.model) : null;
        if (model !== null && model !== "<synthetic>") f.model = model;
        f.lastRole = "assistant";
        break;
      }
    }
  }
  return f;
}

/**
 * The facts a row needs that listSessions does not give: entrypoints, PR, mode, model, last role. A transcript only
 * grows, so when `prior` covers a shorter prefix only the appended bytes are read.
 */
export function sniff(file: string, size: number, prior: (Facts & { size: number }) | null): Facts & { size: number } {
  /** Where the read ends: past its last complete line, so a line still being written is read whole next time. */
  const through = (from: number, text: string) => from + Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
  if (prior !== null && size >= prior.size && size - prior.size <= APPEND_SCAN_MAX) {
    const text = readRange(file, prior.size, size);
    return { ...scan(linesOf(text, false), prior), size: through(prior.size, text) };
  }
  const headText = readRange(file, 0, Math.min(size, HEAD_BYTES));
  const head = scan(linesOf(headText, false), prior ?? noFacts());
  if (size <= HEAD_BYTES) return { ...head, size: through(0, headText) };
  const from = Math.max(HEAD_BYTES, size - TAIL_BYTES);
  const tailText = readRange(file, from, size);
  return { ...scan(linesOf(tailText, from > HEAD_BYTES), head), size: through(from, tailText) };
}

function headOf(info: SDKSessionInfo, file: { path: string; size: number; mtimeMs: number }, facts: Facts): Head | null {
  const cwd = info.cwd ?? facts.cwd;
  if (cwd === null) return null;
  return {
    id: info.sessionId as SessionId,
    file: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    cwd,
    createdAt: info.createdAt ?? file.mtimeMs,
    lastAt: Math.max(info.lastModified, file.mtimeMs),
    title: (info.customTitle ?? info.summary).trim() || "Untitled session",
    // "HEAD": a detached checkout, or a folder outside git.
    branch: info.gitBranch && info.gitBranch !== "HEAD" ? info.gitBranch : null,
    firstEntry: facts.firstEntry,
    lastEntry: facts.lastEntry,
    pr: facts.pr,
    mode: facts.mode,
    model: facts.model,
    lastRole: facts.lastRole,
  };
}

/** A transcript on disk: ~/.claude/projects/<folder>/<uuid>.jsonl. */
export type TranscriptFile = { id: SessionId; path: string; size: number; mtimeMs: number };

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function listFiles(projectsDir: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  let folders: string[];
  try {
    folders = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(join(projectsDir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!UUID_FILE.test(name)) continue;
      const file = statOf(join(projectsDir, folder, name));
      if (file) out.push(file);
    }
  }
  return out;
}

/** A session's transcript file name: <uuid>.jsonl. Subagent files and others are not sessions. */
export const isTranscriptName = (name: string) => UUID_FILE.test(name);

export function statOf(path: string): TranscriptFile | null {
  try {
    const s = statSync(path);
    return s.isFile() ? { id: basename(path, ".jsonl") as SessionId, path, size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Claude Code's folder for a cwd: every character but a letter or digit becomes "-". */
export const folderOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Whether Claude Code keeps a transcript for the id: in the cwd's own folder, else in any (a long cwd gets a hashed
 * folder name). Stats only.
 */
export function transcriptExists(projectsDir: string, id: string, cwd: string): boolean {
  const name = `${id}.jsonl`;
  if (statOf(join(projectsDir, folderOf(cwd), name))) return true;
  let folders: string[];
  try {
    folders = readdirSync(projectsDir);
  } catch {
    return false;
  }
  return folders.some((f) => statOf(join(projectsDir, f, name)) !== null);
}

export type SdkReaders = {
  listSessions: typeof listSessions;
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
};
export const sdkReaders: SdkReaders = { listSessions, getSessionInfo, getSessionMessages };

type Cached = { head: Head; facts: Facts & { size: number } };

/**
 * The heads of every transcript, cached by (size, mtime) in memory. scan() lists them all through one listSessions
 * call; refresh() rebuilds the named ones. A transcript the SDK does not list (sidechain-only, no prompt yet) has no head.
 */
export function createHeads(opts: { projectsDir: string; sdk?: SdkReaders; seed?: readonly Head[]; exclude?: (cwd: string) => boolean }) {
  const sdk = opts.sdk ?? sdkReaders;
  const cache = new Map<string, Cached>();
  for (const head of opts.seed ?? []) if (!opts.exclude?.(head.cwd)) cache.set(head.file, { head, facts: { ...head, cwd: head.cwd, size: head.size } });

  const fresh = (c: Cached | undefined, f: TranscriptFile) => c !== undefined && c.head.size === f.size && c.head.mtimeMs === f.mtimeMs;

  /** Files with no head (a bot's, one the SDK does not list), at the size and mtime they had, so they are not read again unchanged. */
  const headless = new Map<string, { size: number; mtimeMs: number }>();
  const skip = (f: TranscriptFile) => {
    const h = headless.get(f.path);
    return h !== undefined && h.size === f.size && h.mtimeMs === f.mtimeMs;
  };
  const noHead = (f: TranscriptFile) => {
    cache.delete(f.path);
    headless.set(f.path, { size: f.size, mtimeMs: f.mtimeMs });
    return null;
  };

  function build(info: SDKSessionInfo, f: TranscriptFile): Head | null {
    const prior = cache.get(f.path);
    let facts: Facts & { size: number };
    try {
      facts = sniff(f.path, f.size, prior?.facts ?? null);
    } catch {
      // A read that failed says nothing about the session: what was known stands.
      return prior?.head ?? null;
    }
    const found = headOf(info, f, facts);
    if (!found || opts.exclude?.(found.cwd)) return noHead(f);
    headless.delete(f.path);
    cache.set(f.path, { head: found, facts });
    return found;
  }

  return {
    async scan(): Promise<Head[]> {
      const files = listFiles(opts.projectsDir);
      const stale = files.filter((f) => !fresh(cache.get(f.path), f) && !skip(f));
      const infos = stale.length === 0 ? [] : await sdk.listSessions();
      const byId = new Map(infos.map((i) => [i.sessionId, i]));
      const live = new Set(files.map((f) => f.path));
      for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
      for (const path of headless.keys()) if (!live.has(path)) headless.delete(path);
      const heads: Head[] = [];
      for (const f of files) {
        const c = cache.get(f.path);
        if (fresh(c, f)) heads.push(c!.head);
        else if (!skip(f)) {
          const info = byId.get(f.id);
          const head = info ? build(info, f) : noHead(f);
          if (head) heads.push(head);
        }
      }
      return heads;
    },
    /** The head of one transcript now: the cached one while unchanged, null once it is gone or unlisted. */
    async refresh(path: string): Promise<Head | null> {
      const f = statOf(path);
      if (!f) {
        cache.delete(path);
        return null;
      }
      const c = cache.get(path);
      if (fresh(c, f)) return c!.head;
      if (skip(f)) return null;
      // Without a dir the SDK finds the file by its id in every project folder, whatever folder name a cwd got.
      let failed = false;
      const info = await sdk.getSessionInfo(f.id).catch(() => void (failed = true));
      // A failed read says nothing about the session: what was known stands.
      if (failed) return c?.head ?? null;
      return info ? build(info, f) : noHead(f);
    },
    cached: (): Head[] => [...cache.values()].map((c) => c.head),
  };
}

export type Heads = ReturnType<typeof createHeads>;

/** A thread read whole: its entries in chain order, and how far the file was read (through its last complete line). */
export type Thread = { entries: Entry[]; chain: Chain; size: number; mtimeMs: number };

/**
 * Every entry of the conversation, in the order the SDK's getSessionMessages puts them (it follows parentUuid from the
 * newest leaf, through compactions, with parallel tool results). The lines themselves come from the file, read once up
 * to `size`, because the SDK's messages leave out what items need (block index, tool result, flags). When the SDK
 * finds nothing, the file's own order stands in.
 */
export async function readThread(id: SessionId, path: string, cwd: string, sdk: SdkReaders = sdkReaders): Promise<Thread> {
  const f = statOf(path);
  if (!f) throw new Error("This session's transcript is gone.");
  const byUuid = new Map<string, Entry>();
  const order: string[] = [];
  const text = readRange(path, 0, f.size);
  // Read up to the last complete line: a line Claude Code is still writing is followed from its start.
  const read = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
  for (const line of linesOf(text, false)) {
    const e = parseEntry(line);
    if (!e || e.sidechain) continue;
    if (!byUuid.has(e.uuid)) order.push(e.uuid);
    byUuid.set(e.uuid, e);
  }
  const listed = await sdk.getSessionMessages(id, { dir: cwd, includeSystemMessages: true }).catch(() => []);
  const chosen = listed.length > 0 ? listed.map((m) => m.uuid) : order;
  const entries = chosen.flatMap((u) => byUuid.get(u) ?? []);
  return { entries, chain: { uuids: new Set(entries.map((e) => e.uuid)), leaf: entries.at(-1)?.uuid ?? null }, size: read, mtimeMs: f.mtimeMs };
}

/** Entries appended since `offset`. A partial last line stays for the next call. */
export function follow(path: string, offset: number): { entries: Entry[]; offset: number; size: number } {
  const f = statOf(path);
  if (!f) throw new Error("This session's transcript is gone.");
  if (f.size <= offset) return { entries: [], offset, size: f.size };
  const text = readRange(path, offset, f.size);
  const end = text.lastIndexOf("\n");
  if (end === -1) return { entries: [], offset, size: f.size };
  const entries = text
    .slice(0, end)
    .split("\n")
    .flatMap((line) => parseEntry(line) ?? []);
  return { entries, offset: offset + Buffer.byteLength(text.slice(0, end + 1)), size: f.size };
}

/**
 * Appends what continues the chain. A line whose parent is the leaf continues it, and so does a tool result whose
 * parent is on the chain (parallel calls answer their own tool_use). Anything else, a rewind or a second writer on a
 * stale leaf, is a fork: the caller reads the thread again.
 */
export function extend(chain: Chain, entries: readonly Entry[]): { appended: Entry[]; forked: boolean } {
  const appended: Entry[] = [];
  for (const e of entries) {
    if (e.sidechain || chain.uuids.has(e.uuid)) continue;
    const linear =
      e.parent === chain.leaf ||
      (e.parent === null && e.subtype === "compact_boundary") ||
      (e.parent !== null && chain.uuids.has(e.parent) && e.type === "user" && isToolResult(e.message));
    if (!linear) return { appended, forked: true };
    chain.uuids.add(e.uuid);
    chain.leaf = e.uuid;
    appended.push(e);
  }
  return { appended, forked: false };
}

/**
 * The full output of one tool call, its last FULL_OUTPUT_MAX characters, or null when the transcript has none: what
 * the call returned, never Claude Code's launch acknowledgement or hand-back frame. A background task's is the result
 * its last notification carries.
 */
export function toolOutput(path: string, toolUseId: string): string | null {
  const f = statOf(path);
  if (!f) return null;
  let tool = "";
  let task: string | null = null;
  let output: string | null = null;
  for (const line of linesOf(readRange(path, 0, f.size), false)) {
    if (!line.includes(toolUseId) && !(task !== null && line.includes(task))) continue;
    const e = parseEntry(line);
    if (!e || e.sidechain) continue;
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isRecord(b)) continue;
        if (b.type === "tool_use" && b.id === toolUseId) tool = str(b.name) ?? "";
        if (b.type !== "tool_result" || b.tool_use_id !== toolUseId) continue;
        const outcome = classifyResult(tool, resultText(b.content), e.toolResult, b.is_error === true);
        if (outcome.kind === "launched") task = outcome.task;
        output = outcome.kind === "ok" || outcome.kind === "error" ? outcome.output : null;
      }
    }
    for (const note of parseNotes(promptText(content))) if (note.toolUseId === toolUseId || (task !== null && note.taskId === task)) output = note.result;
  }
  return output === null ? null : maskSecrets(output.slice(-FULL_OUTPUT_MAX));
}

/** How much history a thread's first frame carries: whichever limit comes first, counted back from the newest. */
export const PAGE = { turns: 10, items: 120, bytes: 512 * 1024 } as const;

/**
 * The page that ends right before the item `before` (null: at the newest), oldest first, and where the next older
 * page would end (null at the start). null when `before` is no longer among the items.
 */
export function pageOf(items: readonly SessionItem[], before: ItemId | null, limits: { turns: number; items: number; bytes: number } = PAGE): { items: SessionItem[]; before: ItemId | null } | null {
  const end = before === null ? items.length : items.findIndex((i) => i.id === before);
  if (end === -1) return null;
  let start = end;
  let turns = 0;
  let bytes = 0;
  while (start > 0) {
    const item = items[start - 1]!;
    const size = JSON.stringify(item).length;
    if (end - start >= limits.items || (start < end && bytes + size > limits.bytes)) break;
    if (item.kind === "user" && ++turns > limits.turns) break;
    bytes += size;
    start--;
  }
  return { items: items.slice(start, end), before: start > 0 ? items[start]!.id : null };
}

/** What a projection needs about the session: whose words a prompt may carry. */
export type ProjectContext = { cwd: string; userName: string; agent: boolean };

/** The items a continued projection may still change, and what it counts. */
export type ProjectionTail = {
  open: Map<ItemId, SessionItem>;
  /** A tool_use id to the item that shows it, until its result lands; for good when it runs in the background. */
  tools: Map<string, ItemId>;
  /** Claude Code's task id to the tool_use id of the step that launched it. */
  tasks: Map<string, string>;
  /** The model's description of each open Agent or Bash call, by tool_use id: a task summary quotes it. */
  descriptions: Map<string, string>;
  /** Steps a bare reject just denied, by tool_use id: an interrupt as the next entry makes them stopped. */
  rejected: Map<string, ItemId>;
  /** The work item tool calls join until a text block or a prompt closes it. */
  work: ItemId | null;
  /** The turn's todo item, which each TodoWrite of the turn replaces. */
  todo: ItemId | null;
  /** Blocks seen per API message, for entries written without their block index. */
  blocks: Map<string, number>;
};

export const emptyTail = (): ProjectionTail => ({ open: new Map(), tools: new Map(), tasks: new Map(), descriptions: new Map(), rejected: new Map(), work: null, todo: null, blocks: new Map() });

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : isRecord(c) && c.type === "image" ? "[Image]" : "")).join("\n");
}

const lineCount = (s: unknown) => (typeof s === "string" && s !== "" ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

function patchCounts(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const l of hunk.lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

const FILE_TOOLS: Record<string, string> = { Read: "Read", Edit: "Edit", MultiEdit: "Edit", Write: "Write", NotebookEdit: "Edit" };

function host(u: string): string {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
}

const capped = (line: string, max: number) => (line.length > max ? `${line.slice(0, max - 1)}…` : line);
const firstLine = (s: string, max = 80) => capped(s.trim().split("\n")[0] ?? "", max);
/** Cut from the middle, so two long labels that differ at the end still differ. */
const middleCut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.ceil((max - 1) / 2))}…${s.slice(s.length - Math.floor((max - 1) / 2))}`);

const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const AGENT_LABEL_MAX = 120;
const words = (s: string) => s.replace(/\s+/g, " ").trim();
/** A Bash description that only repeats the command, or its first line, is the command, not the model's own words. */
const repeatsCommand = (description: string, command: string | null) => command !== null && [command, command.trim().split("\n")[0]!].some((c) => words(c) === words(description));
const backgroundLabel = (label: string) => (/\bin (?:the )?background\b/i.test(label) ? label : `Run in background: ${label.replace(/^Run /, "")}`);

/** What a Bash step shows it runs: the command's first 3 lines, each capped, secrets masked. */
const commandDetail = (command: string) =>
  maskSecrets(command.trim())
    .split("\n")
    .slice(0, 3)
    .map((l) => capped(l, 200))
    .join("\n");

/**
 * The call in words: "Edit src/app.ts", "Run bun test", the model's own description of a command. Words the model
 * wrote are masked as prose, commands and paths as secrets. `target` names the background task a control tool points at.
 */
export function stepLabel(tool: string, input: Record<string, unknown>, cwd: string, target: (taskId: string | null) => string): string {
  const path = str(input.file_path) ?? str(input.notebook_path);
  const shown = (p: string) => (p.startsWith(cwd + "/") ? relative(cwd, p) : p);
  const description = str(input.description);
  if (FILE_TOOLS[tool] && path) return maskSecrets(`${FILE_TOOLS[tool]} ${shown(path)}`);
  switch (tool) {
    case "Bash": {
      const command = str(input.command);
      const label = description && !repeatsCommand(description, command) ? firstLine(maskProse(description)) : firstLine(maskSecrets(`Run ${command ?? "a command"}`));
      return input.run_in_background === true ? backgroundLabel(label) : label;
    }
    case "Agent":
    case "Task":
      return `Agent: ${middleCut(maskProse(firstLine(description ?? "a helper", Infinity)), AGENT_LABEL_MAX - "Agent: ".length)}`;
    case "BashOutput":
      return `Check ${target(str(input.bash_id))}`;
    case "TaskOutput":
      return `Check ${target(str(input.task_id))}`;
    case "KillShell":
      return `Stop ${target(str(input.shell_id))}`;
    case "TaskStop":
      return `Stop ${target(str(input.task_id) ?? str(input.shell_id))}`;
    case "Monitor":
      return "Watch background output";
    case "ScheduleWakeup":
      return "Schedule a wake-up";
    case "Grep":
      return `Search for ${firstLine(maskSecrets(str(input.pattern) ?? "text"), 60)}`;
    case "Glob":
      return `Find ${firstLine(maskSecrets(str(input.pattern) ?? "files"), 60)}`;
    case "WebFetch":
      return maskSecrets(`Read ${host(str(input.url) ?? "a web page")}`);
    case "WebSearch":
      return `Search the web for ${firstLine(maskSecrets(str(input.query) ?? ""), 60)}`;
    case "Skill":
      return maskSecrets(`Skill ${str(input.skill) ?? ""}`.trim());
  }
  if (tool.startsWith("mcp__")) {
    const [, server, ...name] = tool.split("__");
    return maskSecrets(`${server}: ${name.join("__")}`);
  }
  return maskSecrets(tool);
}

function inputDiff(tool: string, input: Record<string, unknown>, cwd: string): ToolStep["diff"] {
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (path === null) return null;
  const shown = path.startsWith(cwd + "/") ? relative(cwd, path) : path;
  switch (tool) {
    case "Edit":
      return { path: shown, added: lineCount(input.new_string), removed: lineCount(input.old_string) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
      return { path: shown, added: edits.reduce((n, e) => n + lineCount(e.new_string), 0), removed: edits.reduce((n, e) => n + lineCount(e.old_string), 0) };
    }
    case "Write":
      return { path: shown, added: lineCount(input.content), removed: 0 };
    default:
      return null;
  }
}

function resultDiff(step: ToolStep, toolResult: unknown): ToolStep["diff"] {
  if (step.diff === null || !isRecord(toolResult)) return step.diff;
  if (toolResult.type === "create" && typeof toolResult.content === "string") return { ...step.diff, added: lineCount(toolResult.content), removed: 0 };
  const counts = patchCounts(toolResult.structuredPatch);
  return counts ? { ...step.diff, ...counts } : step.diff;
}

type Usage = NonNullable<ToolStep["usage"]>;

/** What one source (a tool result, a task notification) says about a step. */
type Outcome =
  /** An async Agent's or a background Bash's acknowledgement: the step runs on as `task`. */
  | { kind: "launched"; task: string }
  | { kind: "ok"; output: string | null; usage?: Usage; detail?: string }
  | { kind: "error"; output: string | null; cause: string }
  /** reject: Claude Code's bare "doesn't want to proceed", which an interrupt right after makes a stop. */
  | { kind: "denied"; cause: string; reject: boolean }
  | { kind: "stopped"; cause: string }
  /** The task stopped for now with work of its own still running. */
  | { kind: "interim"; output: string | null };

const CAUSE_MAX = 200;
const STOPPED_BY_YOU = "Stopped by you";
const REJECTED = /^The user doesn't want to proceed with this tool use\b/;
/** The bridge's own denials when the user pressed Stop. */
const STOPPED = /^[^\n]+ (pressed Stop\. This call did not run|stopped the session\. It did not run\.)/;
const DENIED = /^(Permission to use|<tool_use_error>Blocked|.*\bIt did not run\b)/s;
const ASYNC_AGENT = /^Async agent launched successfully\./;
const AGENT_ID = /^agentId: ([\w-]+)/m;
const BACKGROUND_COMMAND = /^Command running in background with ID: ([\w-]+)/;
const HAND_BACK = /^\[Subagent hand-back\][^\n]*\n/;
/** The usage block that ends a hand-back or a notification; the report or result before it may quote one. */
const USAGE_BLOCK = /\n?<usage>((?:(?!<usage>)[\s\S])*)<\/usage>\s*$/;
const ERROR_TAGS = /<\/?tool_use_error>/g;

/** A number the text gives as "key: N" (a hand-back's usage) or as <key>N</key> (a notification's). */
const counted = (s: string, key: string) => {
  const m = s.match(new RegExp(`${key}: (\\d+)|<${key}>(\\d+)</${key}>`));
  return m ? Number(m[1] ?? m[2]) : null;
};

/** An Agent's report without Claude Code's hand-back frame, agentId line and usage block, and its tool count and time. */
function handBack(text: string, toolResult: unknown): { output: string | null; usage?: Usage; detail?: string } {
  const r = isRecord(toolResult) ? toolResult : {};
  const blocks = Array.isArray(r.content) ? r.content.flatMap((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [])) : [];
  let report = blocks.join("\n");
  if (blocks.length === 0) {
    const body = text
      .replace(HAND_BACK, "")
      .replace(USAGE_BLOCK, "")
      .replace(/(^|\n)agentId: [^\n]*$/, "");
    // The harness indents every line of a framed report by two spaces.
    report = HAND_BACK.test(text) ? body.replace(/^ {2}/gm, "") : body;
  }
  const usageText = text.match(USAGE_BLOCK)?.[1] ?? "";
  const tools = typeof r.totalToolUseCount === "number" ? r.totalToolUseCount : counted(usageText, "tool_uses");
  const ms = typeof r.totalDurationMs === "number" ? r.totalDurationMs : counted(usageText, "duration_ms");
  const agentType = str(r.agentType);
  return { output: report.trim() || null, ...(tools !== null && ms !== null && { usage: { tools, ms } }), ...(agentType && { detail: agentType }) };
}

/** A failure in one line: "Exit code 1: ls: late.txt: No such file or directory". */
function failureCause(text: string): string {
  const lines = text
    .replace(ERROR_TAGS, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const exit = lines.find((l) => /^Exit code -?\d+$/.test(l));
  const other = lines.find((l) => l !== exit);
  return capped([exit, other].filter((l) => l !== undefined).join(": "), CAUSE_MAX);
}

/** What a tool_result block (with its entry's toolUseResult) says about the call that made it. */
function classifyResult(tool: string, text: string, toolResult: unknown, isError: boolean): Outcome {
  if (isError) {
    if (REJECTED.test(text) || toolResult === "User rejected tool use") return { kind: "denied", cause: "Denied by you", reject: true };
    if (STOPPED.test(text.replace(ERROR_TAGS, ""))) return { kind: "stopped", cause: STOPPED_BY_YOU };
    if (DENIED.test(text)) return { kind: "denied", cause: firstLine(maskSecrets(text.replace(ERROR_TAGS, "")), CAUSE_MAX), reject: false };
    return { kind: "error", output: text === "" ? null : text, cause: maskSecrets(failureCause(text)) };
  }
  const r = isRecord(toolResult) ? toolResult : {};
  const task =
    (r.status === "async_launched" ? str(r.agentId) : null) ??
    str(r.backgroundTaskId) ??
    (ASYNC_AGENT.test(text) ? (text.match(AGENT_ID)?.[1] ?? null) : null) ??
    text.match(BACKGROUND_COMMAND)?.[1] ??
    null;
  if (task !== null) return { kind: "launched", task };
  if (AGENT_TOOLS.has(tool)) return { kind: "ok", ...handBack(text, toolResult) };
  return { kind: "ok", output: text === "" ? null : text };
}

/** One <task-notification> block: Claude Code's word that a background task stopped. */
type TaskNote = { taskId: string | null; toolUseId: string | null; status: string; summary: string; note: string; result: string | null; usage?: Usage };

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function parseNotes(text: string): TaskNote[] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, body]) => {
    const tag = (name: string) => {
      const m = body!.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return m ? unescapeXml(m[1]!.trim()) : null;
    };
    const usage = body!.match(USAGE_BLOCK)?.[1] ?? "";
    const tools = counted(usage, "tool_uses");
    const ms = counted(usage, "duration_ms");
    return {
      taskId: tag("task-id"),
      toolUseId: tag("tool-use-id"),
      status: tag("status") ?? "",
      summary: tag("summary") ?? "",
      note: tag("note") ?? "",
      result: tag("result"),
      ...(tools !== null && ms !== null && { usage: { tools, ms } }),
    };
  });
}

/** `Agent "<description>" failed: <error>`, `Background command "<description or command>" completed (exit code 0)`. */
const SUMMARY = /^([A-Z][\w ]* ")([\s\S]*?)(" (?:finished|completed|failed|was|is|stopped)\b[\s\S]*)$/;

/**
 * Claude Code quotes a task's description in its summary, and a background command's is the raw command when the model
 * gave none. The quote is masked as prose only when it is the model's own description, whole; what follows it is error text.
 */
export function maskSummary(summary: string, description: string | null): string {
  const m = summary.match(SUMMARY);
  if (!m) return maskSecrets(summary);
  return m[1]! + (description !== null && words(m[2]!) === words(description) ? maskProse(m[2]!) : maskSecrets(m[2]!)) + maskSecrets(m[3]!);
}



function noteOutcome(note: TaskNote, summary: string): Outcome {
  switch (note.status) {
    case "completed": {
      if (/may be interim/.test(note.note) || /is waiting on its own background work/.test(note.summary)) return { kind: "interim", output: note.result };
      const exit = note.summary.match(/\(exit code (-?\d+)\)/)?.[1];
      if (exit !== undefined && exit !== "0") return { kind: "error", output: note.result, cause: `Exit code ${exit}` };
      return { kind: "ok", output: note.result, ...(note.usage && { usage: note.usage }) };
    }
    case "failed":
      return { kind: "error", output: note.result, cause: capped(summary, CAUSE_MAX) };
    case "killed":
    case "stopped":
      return { kind: "stopped", cause: /stopped by user/i.test(note.summary) ? STOPPED_BY_YOU : capped(summary, CAUSE_MAX) };
    default:
      return { kind: "interim", output: note.result };
  }
}

const ERROR_HEAD = 512;
/** An error's output keeps its head too, so the exit status at the top of a long output is never cut. */
const shownOutput = (output: string | null, kind: "ok" | "error") => {
  if (output === null || output === "") return null;
  if (kind === "ok" || output.length <= OUTPUT_TAIL) return maskSecrets(output.slice(-OUTPUT_TAIL));
  return maskSecrets(`${output.slice(0, ERROR_HEAD)}\n…\n${output.slice(-(OUTPUT_TAIL - ERROR_HEAD))}`);
};

/** The one reducer both sources settle a step through. `at` is when the source was written. */
function settleStep(step: ToolStep, outcome: Outcome, at: string): ToolStep {
  const { endedAt: _e, cause: _c, ...base } = step;
  const ended = at === "" ? {} : { endedAt: at };
  switch (outcome.kind) {
    case "launched":
      return { ...base, state: "running", output: null, background: true, label: step.tool === "Bash" && !step.background ? backgroundLabel(step.label) : step.label };
    case "interim":
      return { ...base, state: "running", output: shownOutput(outcome.output, "ok") };
    case "ok":
      return {
        ...base,
        state: "ok",
        output: shownOutput(outcome.output, "ok"),
        ...ended,
        ...(outcome.usage && { usage: outcome.usage }),
        ...(outcome.detail && step.detail === undefined && { detail: outcome.detail }),
      };
    case "error":
      return { ...base, state: "error", output: shownOutput(outcome.output, "error"), ...ended, ...(outcome.cause && { cause: outcome.cause }) };
    case "denied":
      return { ...base, state: "denied", output: null, ...ended, cause: outcome.cause };
    case "stopped":
      return { ...base, state: "stopped", ...ended, cause: outcome.cause };
  }
}

function questionsOf(input: Record<string, unknown>): AskQuestion[] {
  const qs = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
  return qs.map((q) => ({
    question: str(q.question) ?? "",
    header: str(q.header) ?? "",
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options.filter(isRecord) : []).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) ?? "" })),
  }));
}

/** Answers by question: the tool's structured result, else the `"question"="answer"` pairs of its text. */
function answersOf(toolResult: unknown, text: string): Record<string, string> {
  if (isRecord(toolResult) && isRecord(toolResult.answers)) {
    return Object.fromEntries(Object.entries(toolResult.answers).flatMap(([q, a]) => (typeof a === "string" ? [[q, a]] : [])));
  }
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/"([^"]+)"="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const COMMAND = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const BASH_INPUT = /^<bash-input>([\s\S]*)<\/bash-input>$/;
/** Prompts Claude Code writes itself: command output, caveats, task and system notices. */
const MACHINE = /^(<local-command-(stdout|stderr|caveat)>|<bash-(stdout|stderr)>|<task-notification>|<system-reminder>|Caveat: )/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : isRecord(b) && b.type === "image" ? "[Image]" : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/** A header line the bridge puts on what it hands an agent: the user's direct-message header, or a notice. */
const BRACKETED = /^\[[^\n]*\]$/;

/**
 * Who wrote a prompt, and its words without the bridge's framing. In an agent's session, the bot writes the prompts,
 * the user's direct messages carry a "[<user> …]" header, and a prompt of bracketed lines only is the bridge's.
 */
function speakerOf(text: string, ctx: ProjectContext): { from: "user" | "bot" | "system"; text: string } {
  if (!ctx.agent) return { from: "user", text };
  const lines = text.split("\n");
  let i = 0;
  let direct = false;
  while (i < lines.length && BRACKETED.test(lines[i]!.trim())) {
    if (lines[i]!.trim() === directHeader(ctx.userName)) direct = true;
    i++;
  }
  const rest = lines.slice(i).join("\n").trim();
  if (rest === "") return { from: direct ? "user" : "system", text: direct ? "" : text.trim() };
  return { from: direct ? "user" : "bot", text: rest };
}

/** Pure: entries in chain order → the items they make or change, in first-change order, and the tail to continue from. */
export function project(entries: readonly Entry[], ctx: ProjectContext, prior: ProjectionTail = emptyTail()): { items: SessionItem[]; tail: ProjectionTail } {
  const tail: ProjectionTail = {
    open: new Map(prior.open),
    tools: new Map(prior.tools),
    tasks: new Map(prior.tasks),
    descriptions: new Map(prior.descriptions),
    rejected: new Map(prior.rejected),
    work: prior.work,
    todo: prior.todo,
    blocks: new Map(prior.blocks),
  };
  const changed = new Map<ItemId, SessionItem>();
  const put = (item: SessionItem, keep: boolean) => {
    changed.set(item.id, item);
    if (keep) tail.open.set(item.id, item);
    else tail.open.delete(item.id);
  };
  const closeWork = () => {
    const id = tail.work;
    tail.work = null;
    const work = id === null ? undefined : tail.open.get(id);
    if (work?.kind === "work" && !work.steps.some((s) => s.state === "running")) tail.open.delete(work.id);
  };
  const updateStep = (itemId: ItemId, toolId: string, change: (s: ToolStep) => ToolStep) => {
    const item = tail.open.get(itemId);
    if (item?.kind !== "work") return;
    const steps = item.steps.map((s) => (s.id === toolId ? change(s) : s));
    put({ ...item, steps }, tail.work === item.id || steps.some((s) => s.state === "running"));
    if (steps.some((s) => s.id === toolId && s.state === "running")) return;
    tail.tools.delete(toolId);
    tail.descriptions.delete(toolId);
    for (const [task, tool] of tail.tasks) if (tool === toolId) tail.tasks.delete(task);
  };
  /** "background command: sleep 75", "agent: sleeper one": the task a control tool points at, as its step shows it. */
  const target = (taskId: string | null) => {
    const toolId = taskId === null ? undefined : tail.tasks.get(taskId);
    const itemId = toolId === undefined ? undefined : tail.tools.get(toolId);
    const item = itemId === undefined ? undefined : tail.open.get(itemId);
    const step = item?.kind === "work" ? item.steps.find((s) => s.id === toolId) : undefined;
    if (step?.tool === "Bash" && step.detail !== undefined) return `background command: ${firstLine(step.detail)}`;
    if (step && AGENT_TOOLS.has(step.tool)) return `agent: ${step.label.replace(/^Agent: /, "")}`;
    return "a background task";
  };

  for (const e of entries) {
    if (e.sidechain) continue;
    if (e.type === "system") {
      if (e.subtype === "compact_boundary") {
        closeWork();
        put({ kind: "compaction", id: e.uuid as ItemId, at: e.at }, false);
      }
      continue;
    }
    if (e.type === "attachment" || e.meta || e.compactSummary) continue;
    const content = e.message?.content;
    const results = e.type === "user" && Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result");
    // Parallel calls' results come one entry each, so only an entry that is not a result ends the wait for an interrupt.
    const rejected = tail.rejected;
    if (!results) tail.rejected = new Map();

    if (e.type === "assistant") {
      const mid = e.message?.id ?? e.uuid;
      const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
      if (e.apiError) {
        closeWork();
        put({ kind: "notice", id: e.uuid as ItemId, at: e.at, text: promptText(content) || "Claude Code reported an error.", tone: "error" }, false);
        continue;
      }
      blocks.forEach((b, i) => {
        const seen = tail.blocks.get(mid) ?? 0;
        const index = e.blockIndex !== null ? e.blockIndex + i : seen;
        tail.blocks.set(mid, Math.max(seen, index + 1));
        const id = `${mid}:${index}` as ItemId;
        if (b.type === "text") {
          const text = str(b.text)?.trim() ?? "";
          if (text === "" || text === "(no content)") return;
          closeWork();
          put({ kind: "assistant", id, at: e.at, text }, false);
        } else if (b.type === "thinking") {
          const text = str(b.thinking)?.trim() ?? "";
          if (text === "") return;
          closeWork();
          put({ kind: "thinking", id, at: e.at, text: text.length > THINKING_MAX ? `${text.slice(0, THINKING_MAX - 1)}…` : text, ms: e.thinkingMs }, false);
        } else if (b.type === "tool_use") useTool(b, e.at);
      });
      continue;
    }

    // A user entry: tool results settle calls, a task notification settles background work, anything else is a prompt.
    if (results && Array.isArray(content)) {
      for (const b of content) if (isRecord(b) && b.type === "tool_result") settle(b, e);
      continue;
    }
    const raw = promptText(content).trim();
    if (raw.startsWith("<task-notification>")) {
      parseNotes(raw).forEach((note, i) => noted(note, i === 0 ? e.uuid : `${e.uuid}:${i}`, e.at));
      continue;
    }
    if (raw === "" || MACHINE.test(raw)) continue;
    const interrupted = INTERRUPTED.test(raw);
    if (interrupted) for (const [toolId, itemId] of rejected) updateStep(itemId, toolId, (s) => settleStep(s, { kind: "stopped", cause: STOPPED_BY_YOU }, s.endedAt ?? e.at));
    closeWork();
    tail.todo = null;
    if (interrupted) {
      put({ kind: "notice", id: e.uuid as ItemId, at: e.at, text: "Interrupted", tone: "info" }, false);
      continue;
    }
    const command = raw.match(COMMAND);
    const bash = raw.match(BASH_INPUT);
    const words = command ? `${command[1]!.trim()} ${raw.match(COMMAND_ARGS)?.[1]?.trim() ?? ""}`.trim() : bash ? `! ${bash[1]!.trim()}` : raw;
    const said = speakerOf(words, ctx);
    put({ kind: "user", id: e.uuid as ItemId, at: e.at, text: said.text, from: said.from, queued: false }, false);
  }

  function useTool(b: Record<string, unknown>, at: string) {
    const toolId = str(b.id);
    const name = str(b.name) ?? "tool";
    const input = isRecord(b.input) ? b.input : {};
    if (toolId === null) return;
    const id = toolId as ItemId;
    if (name === "TodoWrite") {
      closeWork();
      const todos = (Array.isArray(input.todos) ? input.todos.filter(isRecord) : []).map((t) => ({
        text: str(t.content) ?? "",
        state: t.status === "completed" ? ("done" as const) : t.status === "in_progress" ? ("in_progress" as const) : ("pending" as const),
      }));
      const into = tail.todo ?? id;
      tail.todo = into;
      put({ kind: "todo", id: into, at, todos }, true);
      return;
    }
    if (name === "ExitPlanMode") {
      closeWork();
      tail.tools.set(toolId, id);
      put({ kind: "plan", id, at, text: str(input.plan) ?? "", state: "proposed", cardId: null }, true);
      return;
    }
    if (name === "AskUserQuestion") {
      closeWork();
      tail.tools.set(toolId, id);
      put({ kind: "ask", id, at, questions: questionsOf(input), answers: null, cardId: null }, true);
      return;
    }
    const command = name === "Bash" ? str(input.command) : null;
    const detail = command !== null ? commandDetail(command) : AGENT_TOOLS.has(name) ? str(input.subagent_type) : null;
    const step: ToolStep = {
      id: toolId,
      tool: name,
      label: stepLabel(name, input, ctx.cwd, target),
      state: "running",
      diff: inputDiff(name, input, ctx.cwd),
      output: null,
      ...(detail && { detail }),
      ...(at !== "" && { startedAt: at }),
      ...(input.run_in_background === true && { background: true as const }),
    };
    const current = tail.work === null ? undefined : tail.open.get(tail.work);
    const work: SessionItem = current?.kind === "work" ? { ...current, steps: [...current.steps, step] } : { kind: "work", id, at, steps: [step] };
    tail.work = work.id;
    tail.tools.set(toolId, work.id);
    const description = str(input.description);
    if (description !== null && !repeatsCommand(description, command) && (name === "Bash" || AGENT_TOOLS.has(name))) tail.descriptions.set(toolId, description);
    put(work, true);
  }

  function settle(b: Record<string, unknown>, e: Entry) {
    const toolId = str(b.tool_use_id);
    const itemId = toolId === null ? undefined : tail.tools.get(toolId);
    const item = itemId === undefined ? undefined : tail.open.get(itemId);
    if (toolId === null || !item) return;
    const text = resultText(b.content);
    const failed = b.is_error === true;
    switch (item.kind) {
      case "work": {
        const step = item.steps.find((s) => s.id === toolId);
        if (!step) return;
        const outcome = classifyResult(step.tool, text, e.toolResult, failed);
        if (outcome.kind === "launched") tail.tasks.set(outcome.task, toolId);
        if (outcome.kind === "denied" && outcome.reject) tail.rejected.set(toolId, item.id);
        updateStep(item.id, toolId, (s) => ({ ...settleStep(s, outcome, e.at), diff: outcome.kind === "ok" ? resultDiff(s, e.toolResult) : s.diff }));
        return;
      }
      case "ask":
        tail.tools.delete(toolId);
        put({ ...item, answers: failed ? "dismissed" : answersOf(e.toolResult, text), cardId: null }, false);
        return;
      case "plan":
        tail.tools.delete(toolId);
        put({ ...item, state: failed ? "rejected" : "approved", cardId: null }, false);
        return;
      default:
        return;
    }
  }

  /** A task notification settles the step that launched the task, and shows Claude Code's summary as a notice. */
  function noted(note: TaskNote, id: string, at: string) {
    const toolId = [note.toolUseId, note.taskId === null ? undefined : tail.tasks.get(note.taskId)].find((t): t is string => typeof t === "string" && tail.tools.has(t));
    const item = toolId === undefined ? undefined : tail.open.get(tail.tools.get(toolId)!);
    const description = toolId === undefined ? null : (tail.descriptions.get(toolId) ?? null);
    const summary = maskSummary(note.summary, description);
    const outcome = noteOutcome(note, summary);
    if (toolId !== undefined && item) updateStep(item.id, toolId, (s) => settleStep(s, outcome, at));
    closeWork();
    put({ kind: "notice", id: id as ItemId, at, text: summary, tone: outcome.kind === "error" ? "error" : "info", reason: "task" }, false);
  }

  return { items: [...changed.values()], tail };
}
