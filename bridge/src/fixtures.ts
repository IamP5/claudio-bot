import type { Agent, Bot, Broadcast, ClientMessage, Message, Peer, Routine, ServerMessage } from "./protocol";

// The wire form of T: branded ids are plain strings, so fixtures type-check without casts.
type Wire<T> = T extends string & { readonly __brand: string } ? string : T extends (infer U)[] ? Wire<U>[] : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

const at = "2026-10-16T12:00:00.000Z";
const later = "2026-10-16T14:00:00.000Z";
const tomorrow = "2026-10-17T11:57:00.000Z";
const routine: Wire<Routine> = {
  id: "r1", name: "morning-digest", schedule: "57 7 * * 1-5", describe: "Weekdays at 7:57 AM",
  prompt: "Post today's tech digest.", enabled: true, lastRunAt: at,
  trigger: "cron", nextRunAt: tomorrow,
  runs: [
    { id: "run4", at, status: "ok", late: false, manual: true, note: null },
    { id: "run3", at: "2026-10-15T11:57:00.000Z", status: "quiet", late: true, manual: false, note: null },
    { id: "run2", at: "2026-10-14T11:57:00.000Z", status: "failed", late: false, manual: false, note: "Overloaded" },
    { id: "run1", at: "2026-10-13T11:57:00.000Z", status: "skipped", late: false, manual: false, note: "Missed while the Mac was asleep" },
  ],
};
const bot: Wire<Bot> = {
  id: "b1", name: "engineer", title: null, avatar: { shape: "hexagon", color: "orange" },
  pinned: false, hidden: false, status: "idle", unread: 2,
  question: "Want me to merge any of these now?", preview: "Want me to merge any of these now?",
  lastAt: at, createdAt: at, routines: [routine], dailyCapUsd: null,
};
const question = (answer: Wire<Extract<Message, { kind: "question" }>>["answer"]) => ({
  kind: "question" as const, id: "m6", at, question: "Want me to merge any of these now?",
  options: ["Merge only #142", "Merge #139 and #142", "Keep holding everything"], answer, expiresAt: "2026-10-17T12:00:00.000Z",
});
const permission = {
  kind: "permission" as const, id: "m8", at: later, from: null, tool: "Bash", label: "Push to the default branch",
  detail: "git push origin main", always: "git push to main or master from engineer", answer: null, expiresAt: "2026-10-16T16:00:00.000Z",
};
const agentPeer: Wire<Peer> = { kind: "agent", id: "a1", title: "Set up verification skill" };
const agent: Wire<Agent> = {
  id: "a1", botId: "b1", title: "Set up verification skill", where: "mac", projectName: "web",
  status: "waiting", url: null, createdAt: at, updatedAt: at,
};

export const server = [
  { type: "hello", protocol: 3, epoch: "e_7f3a", seq: 41, resumed: false, machine: "MacBook", userName: "Alex", bots: [bot] },
  { type: "bot", seq: 42, bot: { ...bot, id: "b2", name: "news digest", title: "Morning digest", avatar: { shape: "pentagon", color: "teal" }, status: "working", unread: 0, question: null, pinned: true, dailyCapUsd: 5 } },
  { type: "bot_removed", botId: "b2" },
  { type: "created", ref: "c1", botId: "b3" },
  {
    type: "conversation", botId: "b1", messages: [
      { kind: "user", id: "m1", at, text: "Merge the stack when green", attachments: [{ name: "plan.png", mime: "image/png", path: "inbox/plan.png" }] },
      { kind: "bot", id: "m2", at, text: "On it. **#142** can merge on its own." },
      { kind: "exchange", id: "m3", at, peer: agentPeer, sent: 1, received: 3 },
      { kind: "note", id: "m4", at, text: "Created routines {0} and {1}", refs: [{ kind: "routine", id: "r1", name: "morning-digest" }, { kind: "routine", id: "r2", name: "healthcheck" }] },
      { kind: "exchange", id: "m5", at, peer: { kind: "bot", id: "b2", name: "news digest", avatar: { shape: "pentagon", color: "teal" } }, sent: 1, received: 0 },
      question(null),
    ],
  },
  { type: "message", seq: 44, botId: "b1", message: question(1) },
  { type: "message", botId: "b1", message: { kind: "question", id: "m7", at, question: "Add the secret?", options: ["Yes", "Not yet"], answer: "dismissed", expiresAt: null } },
  {
    type: "details", botId: "b1",
    library: [{ path: "merge-plan.md", size: 2048, modifiedAt: at }],
    links: [{ url: "https://github.com/acme/web/pull/142", host: "github.com", at }],
    agents: [agent, { ...agent, id: "a2", where: "cloud", status: "in_cloud", url: "https://claude.ai/code/session_abc" }],
  },
  {
    type: "agent", agent, messages: [
      { id: "am1", at, from: "bot", text: "Create the verification skill and open a PR." },
      { id: "am2", at, from: "agent", text: "PR #142 is open. 27 tests pass." },
    ],
  },
  { type: "file", botId: "b1", path: "merge-plan.md", mime: "text/markdown", content: "# Plan\n", data: null },
  { type: "file", botId: "b1", path: "chart.png", mime: "image/png", data: "iVBORw0KGgo=", content: null },
  { type: "error", message: "Unknown bot" },
  { type: "message", seq: 45, botId: "b1", message: permission },
  { type: "message", seq: 46, botId: "b1", message: { ...permission, id: "m9", from: agentPeer, tool: "mcp__github__merge_pull_request", label: "Merge a pull request", detail: 'mcp__github__merge_pull_request {"repo":"acme/web","number":142}', always: "merging pull requests from engineer", answer: "once" } },
  { type: "message", seq: 47, botId: "b1", message: { ...question("expired"), id: "m10" } },
  { type: "bot", seq: 48, bot: { ...bot, status: "awaiting_approval", question: "Push to the default branch: git push origin main" } },
  { type: "bot", seq: 49, bot: { ...bot, status: "parked" } },
  { type: "agent", seq: 50, agent: { ...agent, status: "awaiting_approval" }, messages: [] },
  { type: "devices", devices: [
    { id: "d1", name: "Alex's iPhone", createdAt: at, lastSeenAt: later, legacy: false, current: true },
    { id: "d0", name: "Paired before protocol 3", createdAt: at, lastSeenAt: null, legacy: true, current: false },
  ] },
  { type: "pair_code", code: "K7QD-M2XP", expiresAt: "2026-10-16T12:10:00.000Z" },
] satisfies (Wire<ServerMessage> | Wire<Broadcast>)[];

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
  { type: "file", botId: "b1", path: "merge-plan.md" },
  { type: "decide", botId: "b1", messageId: "m8", choice: "once" },
  { type: "stop", botId: "b1" },
  { type: "stop_agent", agentId: "a1" },
  { type: "run_routine", botId: "b1", routineId: "r1" },
  { type: "update_bot", botId: "b1", patch: { dailyCapUsd: 5 } },
  { type: "devices" },
  { type: "revoke_device", deviceId: "d0" },
  { type: "pair_code" },
] satisfies Wire<ClientMessage>[];

// Compile-time coverage: every server type, client type and message kind has a fixture, so the Swift mirror is pinned
// for all of them. A missing one fails tsc with its name.
type Kinds<F> = F extends { message: { kind: infer K } } ? K : F extends { messages: (infer M)[] } ? (M extends { kind: infer K } ? K : never) : never;
type Covered<All, Seen> = [Exclude<All, Seen>] extends [never] ? true : Exclude<All, Seen>;
const everyServerType: Covered<ServerMessage["type"], (typeof server)[number]["type"]> = true;
const everyClientType: Covered<ClientMessage["type"], (typeof client)[number]["type"]> = true;
const everyMessageKind: Covered<Message["kind"], Kinds<(typeof server)[number]>> = true;

export const fixturesJson = () => JSON.stringify({ server, client }, null, 2) + "\n";
export const fixturesPath = new URL("../../fixtures/protocol.json", import.meta.url);

if (import.meta.main) await Bun.write(fixturesPath, fixturesJson());
