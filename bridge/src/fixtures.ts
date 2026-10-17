import type { Agent, Bot, ClientMessage, Peer, Routine, ServerMessage } from "./protocol";

// The wire form of T: branded ids are plain strings, so fixtures type-check without casts.
type Wire<T> = T extends string & { readonly __brand: string } ? string : T extends (infer U)[] ? Wire<U>[] : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

const at = "2026-10-16T12:00:00.000Z";
const routine: Wire<Routine> = {
  id: "r1", name: "tech-news-digest", schedule: "57 7 * * 1-5", describe: "Weekdays at 7:57 AM",
  prompt: "Post today's tech digest.", enabled: true, lastRunAt: at,
};
const bot: Wire<Bot> = {
  id: "b1", name: "engineer", title: null, avatar: { shape: "hexagon", color: "orange" },
  pinned: false, hidden: false, status: "idle", unread: 2,
  question: "Want me to merge any of these now?", preview: "Want me to merge any of these now?",
  lastAt: at, createdAt: at, routines: [routine],
};
const agentPeer: Wire<Peer> = { kind: "agent", id: "a1", title: "Set up verification skill" };
const agent: Wire<Agent> = {
  id: "a1", botId: "b1", title: "Set up verification skill", where: "mac", projectName: "solta-o-som",
  status: "waiting", url: null, createdAt: at, updatedAt: at,
};

export const server = [
  { type: "hello", machine: "MacBook", userName: "Bruno", bots: [bot] },
  { type: "bot", bot: { ...bot, id: "b2", name: "tech news", title: "Morning digest", avatar: { shape: "pentagon", color: "teal" }, status: "working", unread: 0, question: null, pinned: true } },
  { type: "bot_removed", botId: "b2" },
  { type: "created", ref: "c1", botId: "b3" },
  {
    type: "conversation", botId: "b1", messages: [
      { kind: "user", id: "m1", at, text: "Merge the stack when green", attachments: [{ name: "plan.png", mime: "image/png", path: "inbox/plan.png" }] },
      { kind: "bot", id: "m2", at, text: "On it. **#19** can merge on its own." },
      { kind: "exchange", id: "m3", at, peer: agentPeer, sent: 1, received: 3 },
      { kind: "note", id: "m4", at, text: "Created routines {0} and {1}", refs: [{ kind: "routine", id: "r1", name: "tech-news-digest" }, { kind: "routine", id: "r2", name: "healthcheck" }] },
      { kind: "exchange", id: "m5", at, peer: { kind: "bot", id: "b2", name: "tech news", avatar: { shape: "pentagon", color: "teal" } }, sent: 1, received: 0 },
      { kind: "question", id: "m6", at, question: "Want me to merge any of these now?", options: ["Merge only #19", "Merge #18 and #19", "Keep holding everything"], answer: null },
    ],
  },
  { type: "message", botId: "b1", message: { kind: "question", id: "m6", at, question: "Want me to merge any of these now?", options: ["Merge only #19", "Merge #18 and #19", "Keep holding everything"], answer: 1 } },
  { type: "message", botId: "b1", message: { kind: "question", id: "m7", at, question: "Add the secret?", options: ["Yes", "Not yet"], answer: "dismissed" } },
  {
    type: "details", botId: "b1",
    library: [{ path: "comment-prune-plan.md", size: 2048, modifiedAt: at }],
    links: [{ url: "https://github.com/me/app/pull/19", host: "github.com", at }],
    agents: [agent, { ...agent, id: "a2", where: "cloud", status: "in_cloud", url: "https://claude.ai/code/session_01" }],
  },
  {
    type: "agent", agent, messages: [
      { id: "am1", at, from: "bot", text: "Create the verification skill and open a PR." },
      { id: "am2", at, from: "agent", text: "PR #19 is open. 27 tests pass." },
    ],
  },
  { type: "file", botId: "b1", path: "comment-prune-plan.md", mime: "text/markdown", content: "# Plan\n", data: null },
  { type: "file", botId: "b1", path: "chart.png", mime: "image/png", data: "iVBORw0KGgo=", content: null },
  { type: "error", message: "Unknown bot" },
] satisfies Wire<ServerMessage>[];

export const client = [
  { type: "create_bot", ref: "c1" },
  { type: "open", botId: "b1" },
  { type: "send", botId: "b1", text: "Also add tests", uploads: [{ name: "shot.png", mime: "image/png", data: "iVBORw0KGgo=" }] },
  { type: "answer", botId: "b1", messageId: "m6", option: 1 },
  { type: "dismiss", botId: "b1", messageId: "m7" },
  { type: "update_bot", botId: "b1", patch: { name: "eng", title: "Ships PRs", avatar: { shape: "star6", color: "blue" }, pinned: true, hidden: false } },
  { type: "mark_unread", botId: "b1" },
  { type: "delete_bot", botId: "b1" },
  { type: "set_routine", botId: "b1", routineId: "r1", enabled: false },
  { type: "details", botId: "b1" },
  { type: "agent", agentId: "a1" },
  { type: "file", botId: "b1", path: "comment-prune-plan.md" },
] satisfies Wire<ClientMessage>[];

export const fixturesJson = () => JSON.stringify({ server, client }, null, 2) + "\n";
export const fixturesPath = new URL("../../fixtures/protocol.json", import.meta.url);

if (import.meta.main) await Bun.write(fixturesPath, fixturesJson());
