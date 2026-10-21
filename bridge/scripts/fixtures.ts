import type { HomeFrame, MachineFrame, Intent, EventBody } from "../src/machine/wire";
import { FEATURES } from "../src/protocol";
import type {
  AgentView, Bot, Broadcast, ClientMessage, MachineView, Message, Peer, Routine, ServerMessage, SessionControls, SessionItem, SessionProject, SessionRow,
} from "../src/protocol";

// The wire form of T: branded ids are plain strings, so fixtures type-check without casts.
type Wire<T> = T extends string & { readonly __brand: string } ? string : T extends (infer U)[] ? Wire<U>[] : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

const at = "2026-10-16T12:00:00.000Z";
const later = "2026-10-16T14:00:00.000Z";
const tomorrow = "2026-10-17T11:57:00.000Z";
// The home, omarchy, and a machine enrolled into it, the MacBook.
const HOME = "m_0b7e4c1a-2f3d-4e5a-9b6c-7d8e9f0a1b2c";
const MAC = "m_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
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
  id: "b1", kind: "bot", members: [], name: "engineer", title: null, avatar: { shape: "hexagon", color: "orange" },
  pinned: false, hidden: false, status: "idle", unread: 2,
  question: "Want me to merge any of these now?", preview: "Want me to merge any of these now?",
  lastAt: at, createdAt: at, routines: [routine], dailyCapUsd: null, muted: false, agentsOn: null,
  spentTodayUsd: 8.4, capUsd: 10,
};
const hookRoutine: Wire<Routine> = {
  id: "r2", name: "deploy-watch", schedule: "", describe: "When its webhook is called",
  prompt: "Summarize the deploy that just finished.", enabled: true, lastRunAt: null,
  trigger: "webhook", nextRunAt: null, runs: [],
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
const agent: Wire<AgentView> = {
  id: "a1", botId: "b1", title: "Set up verification skill", where: "mac", projectName: "web",
  status: "waiting", url: null, createdAt: at, updatedAt: at, evidence: null, worktree: null,
  spentUsd: 1.2, budgetUsd: 5, machine: HOME,
};

// Sessions: solta-o-som (the GitHub name of ~/Dev/projects/br-soundless) holds an agent's session and one from the
// Claude app; claudio-bot holds a cloud agent's.
const solta: Wire<SessionProject> = {
  id: "3f9a1c7e2b4d6a80", name: "solta-o-som", path: "/Users/alex/Dev/projects/br-soundless", githubRepo: "IamP5/solta-o-som", lastAt: later, canCloud: false,
};
const claudio: Wire<SessionProject> = {
  id: "9c2e5b7a1d3f4e60", name: "claudio-bot", path: "/Users/alex/Dev/projects/claudio-bot", githubRepo: "alex/claudio-bot", lastAt: at, canCloud: false,
};
const agentSession = "6b1f3c2a-8d4e-4f7a-9c1b-2e5d7a9f0c31";
const agentRow: Wire<SessionRow> = {
  id: agentSession, machine: HOME, projectId: solta.id, parentId: null, title: "Smooth the audio fade on iOS Safari", origin: "agent",
  agent: { botId: "b1", agentId: "a3" }, status: "working", holder: "claudio", unread: false,
  branch: "claudio/6b1f3c2a", worktree: true, pr: null, mirror: "pending", hidden: false, url: null, createdAt: at, lastAt: later,
};
const desktopRow: Wire<SessionRow> = {
  id: "b109b727-4c1e-4a8b-9e2f-7d3c5a1b8e40", machine: MAC, projectId: solta.id, parentId: null, title: "Add a volume slider to the player", origin: "desktop",
  agent: null, status: "idle", holder: "desktop", unread: true,
  branch: "feat/volume-slider", worktree: false, pr: { number: 87, url: "https://github.com/IamP5/solta-o-som/pull/87", state: "open" },
  mirror: "imported", hidden: false, url: null, createdAt: "2026-10-15T09:30:00.000Z", lastAt: at,
};
const cloudRow: Wire<SessionRow> = {
  id: "session_01Hq7vXk3mRt9wYpL2nB5cDe", machine: HOME, projectId: claudio.id, parentId: null, title: "Add a changelog", origin: "cloud",
  agent: { botId: "b1", agentId: "a2" }, status: "idle", holder: "none", unread: false,
  branch: "claude/add-changelog", worktree: false, pr: { number: 12, url: "https://github.com/alex/claudio-bot/pull/12", state: "merged" },
  mirror: "none", hidden: false, url: "https://claude.ai/code/session_01Hq7vXk3mRt9wYpL2nB5cDe", createdAt: "2026-10-14T18:00:00.000Z", lastAt: at,
};
const childRow: Wire<SessionRow> = {
  id: "d4e8a1b6-3c2f-4b9e-8a7d-1f6c5e3b2a90", machine: MAC, projectId: solta.id, parentId: desktopRow.id, title: "Check the slider on iPad", origin: "terminal",
  agent: null, status: "awaiting_input", holder: "terminal", unread: false,
  branch: "feat/volume-slider", worktree: false, pr: null, mirror: "none", hidden: false, url: null, createdAt: at, lastAt: later,
};
const controls: Wire<SessionControls> = {
  canSend: true, reason: null, working: true, queued: 1, model: null,
  models: [{ id: "default", label: "Default (recommended)" }, { id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }],
  mode: "acceptEdits", modes: ["default", "acceptEdits", "plan"],
};
const items = [
  { kind: "user", id: "4a7e2c91-5b3d-4e8f-a1c6-9d2b7e5f3a18", at, text: "Make the fade on iOS Safari smooth, then open a PR.", from: "bot", queued: false },
  { kind: "thinking", id: "msg_01XyZ7Lq:0", at, text: "The fade calls linearRampToValueAtTime down to 0, which Safari renders as a click near the end.", ms: 2400 },
  { kind: "assistant", id: "msg_01XyZ7Lq:1", at, text: "The fade is **linear**, so it sounds abrupt near zero. I'll make it exponential." },
  { kind: "work", id: "toolu_01Ab3", at, steps: [
    { id: "toolu_01Ab3", tool: "Read", label: "Read src/audio/fade.ts", state: "ok", diff: null, output: null },
    { id: "toolu_01Ab4", tool: "Edit", label: "Edit src/audio/fade.ts", state: "ok", diff: { path: "src/audio/fade.ts", added: 12, removed: 4 }, output: null },
    { id: "toolu_01Ab5", tool: "Bash", label: "Run bun test", state: "error", diff: null, output: " 13 pass\n 1 fail\n" },
  ] },
  { kind: "todo", id: "toolu_01Ab6", at: later, todos: [
    { text: "Replace the linear ramp", state: "done" },
    { text: "Fix the failing fade test", state: "in_progress" },
    { text: "Open a PR", state: "pending" },
  ] },
] satisfies Wire<SessionItem>[];
const card = {
  kind: "permission" as const, id: "m20", at: later, from: null, tool: "Bash", label: "Bash",
  detail: "rm -rf node_modules && bun install", always: "rm -rf node_modules in solta-o-som, for this session", answer: null, expiresAt: "2026-10-16T16:00:00.000Z",
};
const asked = "Which audio library should the fade use?";
const ask = {
  kind: "ask" as const, id: "toolu_01Ab8", at: later, cardId: "m21", answers: null,
  questions: [{ question: asked, header: "Library", multiSelect: false, options: [
    { label: "Web Audio API", description: "Native, no new dependency" },
    { label: "Howler.js", description: "Handles the Safari quirks for us" },
  ] }],
};

const machines: Wire<MachineView>[] = [
  { id: HOME, name: "omarchy", role: "home", online: true, since: null, platform: "linux", access: { full: true, sandbox: false } },
  { id: MAC, name: "MacBook", role: "machine", online: false, since: at, platform: "darwin", access: { full: false, sandbox: true } },
];

export const server = [
  { type: "hello", protocol: 3, features: [...FEATURES], epoch: "e_7f3a", seq: 41, resumed: false, machine: "omarchy", userName: "Alex", bots: [bot], machines,
    world: { id: "w_2c9d4e1f-7a3b-4c5d-8e6f-0a1b2c3d4e5f", name: "Alex's bots" } },
  { type: "bot", seq: 42, bot: { ...bot, id: "b2", name: "news digest", title: "Morning digest", avatar: { shape: "pentagon", color: "teal" }, status: "working", unread: 0, question: null, pinned: true, dailyCapUsd: 5, spentTodayUsd: 0, capUsd: 5, agentsOn: MAC } },
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
    agents: [agent, { ...agent, id: "a2", where: "cloud", status: "in_cloud", url: "https://claude.ai/code/session_abc", spentUsd: null, budgetUsd: null }],
    routines: [routine, hookRoutine],
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
  { type: "bot", seq: 51, bot: { ...bot, status: "unavailable" } },
  { type: "agent", seq: 52, agent: { ...agent, status: "unavailable" }, messages: [] },
  { type: "devices", devices: [
    { id: "d1", name: "Alex's iPhone", createdAt: at, lastSeenAt: later, legacy: false, current: true },
    { id: "d0", name: "Paired before protocol 3", createdAt: at, lastSeenAt: null, legacy: true, current: false },
  ] },
  { type: "pair_code", code: "K7QD-M2XP", expiresAt: "2026-10-16T12:10:00.000Z", urls: ["ws://mac.tail1234.ts.net:7878/ws", "ws://Mac.local:7878/ws", "ws://192.168.1.20:7878/ws"] },
  { type: "machines", seq: 43, machines: [machines[0]!, { ...machines[1]!, online: true, since: later }] },
  { type: "machine_code", code: "R4TW-9HJC", expiresAt: "2026-10-16T12:10:00.000Z", urls: ["http://omarchy.tail1234.ts.net:7878", "http://192.168.1.30:7878"] },
  { type: "message", seq: 53, botId: "b1", message: { kind: "user", id: "m11", at, text: "Ship it", attachments: [], clientId: "c_9b1e" } },
  { type: "bot", seq: 54, bot: { ...bot, muted: true, spentTodayUsd: 1.25, capUsd: null } },
  {
    type: "agent", seq: 55, messages: [], agent: {
      ...agent, status: "capped", machine: MAC,
      evidence: { at: later, branch: "claudio/verify-skill", head: "4f2a9c1", ahead: 3, changed: 5, insertions: 120, deletions: 14, dirty: false, pr: "https://github.com/acme/web/pull/142" },
      worktree: { path: "/Users/alex/.claudiobot-worktrees/web/a1", branch: "claudio/verify-skill" },
    },
  },
  { type: "activity", botId: "b1", agentId: null, text: "Reading hub.ts", at },
  { type: "activity", botId: "b1", agentId: "a1", text: null, at },
  { type: "memory", seq: 56, facts: [
    { id: "f_1", text: "Prefers short answers", at, by: null, confirmed: true, proposerBotId: null },
    { id: "f_2", text: "Works on acme/web", at, by: "engineer", confirmed: false, proposerBotId: "b1" },
  ] },
  { type: "connectors", botId: "b1", connectors: [
    { name: "github", status: "connected", enabled: true },
    { name: "linear", status: "needs_auth", enabled: true },
    { name: "slack", status: "unchecked", enabled: false },
  ] },
  { type: "skills", botId: "b1", skills: [{ name: "release-notes", description: "Write release notes from merged PRs", updatedAt: at }] },
  { type: "webhook_token", botId: "b1", routineId: "r2", url: "http://127.0.0.1:7879/hook/r2", token: "whk_3s9dK2" },
  { type: "bot", seq: 57, bot: { ...bot, id: "g1", kind: "group", members: ["b1", "b2"], name: "launch crew", avatar: { shape: "flower", color: "purple" }, unread: 1, question: null, preview: "Staging is green." } },
  { type: "message", seq: 58, botId: "g1", message: { kind: "user", id: "m12", at, text: "@engineer is staging green? Check @github", attachments: [], mentions: [{ kind: "bot", id: "b1", name: "engineer" }, { kind: "connector", name: "github" }] } },
  { type: "message", seq: 59, botId: "g1", message: { kind: "bot", id: "m13", at: later, text: "Staging is green.", from: "b1" } },
  { type: "commands", botId: "b1", commands: [
    { name: "release-notes", description: "Write release notes from merged PRs", argumentHint: "", source: "skill" },
    { name: "compact", description: "Summarize the conversation to free up context", argumentHint: "[instructions]", source: "builtin" },
  ] },
  { type: "exchange", botId: "b1", peer: "b2", messages: [
    { id: "x1", at, from: "b1", text: "Put PR #142 in tomorrow's digest." },
    { id: "x2", at: later, from: "b2", text: "Added." },
  ] },
  { type: "usage", usage: { state: "ok", plan: "max", fetchedAt: later, stale: false, windows: [
    { id: "session", kind: "session", label: "Current session", utilization: 0.37, resetsAt: "2026-10-16T16:14:00.000Z", severity: "normal" },
    { id: "weekly", kind: "weekly", label: "Weekly · all models", utilization: 0.82, resetsAt: "2026-10-20T12:00:00.000Z", severity: "warning" },
    { id: "weekly:fable", kind: "weekly_model", label: "Weekly · Fable", utilization: 1, resetsAt: null, severity: "critical" },
  ] } },
  { type: "usage", usage: { state: "unavailable", reason: "api_key", fetchedAt: later } },
  { type: "sessions", projects: [solta, claudio], rows: [agentRow, desktopRow, cloudRow], mirror: "auto" },
  { type: "session_rows", rows: [{ ...agentRow, status: "awaiting_approval", mirror: "imported" }, childRow], removed: ["0d4e7b2a-9f1c-4e3b-b8a6-5c2d1e7f9a04"], projects: [solta] },
  { type: "session", sessionId: agentSession, epoch: "e_7f3a", rev: 42, items, before: "8812331:2b7c9e41", controls, live: { itemId: "msg_01XyZ7Lq:2", text: "Now I'll update" } },
  { type: "session_delta", sessionId: agentSession, itemId: "msg_01XyZ7Lq:2", offset: 15, text: " the fade test." },
  { type: "session_items", sessionId: agentSession, rev: 43, items: [{ kind: "permission", id: "toolu_01Ab7", at: later, card }], removed: [], controls: { ...controls, working: false } },
  {
    type: "session_items", sessionId: agentSession, rev: 45, removed: ["c_4d2a"], controls: null, items: [
      ask,
      { kind: "plan", id: "toolu_01Ab9", at: later, cardId: "m22", state: "proposed", text: "## Plan\n1. Swap the linear ramp for setTargetAtTime\n2. Test on iOS Safari 18 and Firefox" },
    ],
  },
  {
    type: "session_page", sessionId: agentSession, before: null, items: [
      { kind: "notice", id: "n_1", at: "2026-10-16T11:00:00.000Z", text: "Claude Code could not start: the sandbox is unavailable.", tone: "error" },
      { kind: "compaction", id: "c4f1a2e7-3b9d-4c8e-a6f2-1d7b5e9c3a20", at: "2026-10-16T11:30:00.000Z" },
      { ...ask, id: "toolu_01Aa2", at: "2026-10-16T11:40:00.000Z", cardId: null, answers: { [asked]: "Web Audio API" } },
      { kind: "plan", id: "toolu_01Aa3", at: "2026-10-16T11:45:00.000Z", cardId: null, state: "approved", text: "## Plan\n1. Read the fade code" },
    ],
  },
  { type: "session_created", ref: "s1", sessionId: "e3a9c5d1-7b2f-4a6e-9c8d-2f1b4e7a5c63" },
  { type: "session_tool_output", sessionId: agentSession, toolUseId: "toolu_01Ab5", output: "bun test v1.3.0\n\nsrc/audio/fade.test.ts:\n(fail) fades to silence in 40 ms\n\n 13 pass\n 1 fail\n" },
  { type: "session_removed", sessionId: agentSession, movedTo: "f2c8b4a6-1e3d-4f9b-a7c5-6d2e8b1f4a37" },
  { type: "session_removed", sessionId: desktopRow.id, movedTo: null },
] satisfies (Wire<ServerMessage> | Wire<Broadcast>)[];

export const client = [
  { type: "create_bot", ref: "c1" },
  { type: "open", botId: "b1" },
  { type: "send", botId: "b1", text: "Also add tests", uploads: [{ name: "shot.png", mime: "image/png", data: "iVBORw0KGgo=" }] },
  { type: "answer", botId: "b1", messageId: "m6", option: 1 },
  { type: "dismiss", botId: "b1", messageId: "m7" },
  { type: "update_bot", botId: "b1", patch: { name: "eng", title: "Ships PRs", avatar: { shape: "star6", color: "blue" }, pinned: true, hidden: false } },
  { type: "mark_unread", botId: "b1" },
  { type: "delete_bot", botId: "b1", force: true },
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
  { type: "machine_code" },
  { type: "presence", attended: false },
  { type: "send", botId: "b1", text: "Ship it", uploads: [], clientId: "c_9b1e" },
  { type: "update_bot", botId: "b1", patch: { muted: true } },
  { type: "update_bot", botId: "b1", patch: { agentsOn: MAC } },
  { type: "update_bot", botId: "b1", patch: { agentsOn: null } },
  { type: "memory" },
  { type: "set_fact", factId: null, text: "Prefers short answers" },
  { type: "set_fact", factId: "f_2", text: "Works on acme/web and acme/api" },
  { type: "forget_fact", factId: "f_1" },
  { type: "confirm_fact", factId: "f_2" },
  { type: "connectors", botId: "b1" },
  { type: "set_connector", botId: "b1", name: "slack", enabled: false },
  { type: "skills", botId: "b1" },
  { type: "delete_skill", botId: "b1", name: "release-notes" },
  { type: "webhook_token", botId: "b1", routineId: "r2" },
  { type: "remove_worktree", agentId: "a1" },
  { type: "send", botId: "g1", text: "@engineer check @github", uploads: [], mentions: [{ kind: "bot", id: "b1", name: "engineer" }, { kind: "connector", name: "github" }] },
  { type: "commands", botId: "b1" },
  { type: "exchange", botId: "b1", peer: "b2" },
  { type: "create_group", ref: "c2", name: "launch crew", members: ["b1", "b2"] },
  { type: "update_bot", botId: "g1", patch: { members: ["b1", "b2", "b3"] } },
  { type: "refresh_usage" },
  { type: "watch_sessions" },
  { type: "unwatch_sessions" },
  { type: "watch_session", sessionId: agentSession, after: null },
  { type: "watch_session", sessionId: agentSession, after: { epoch: "e_7f3a", rev: 42 } },
  { type: "unwatch_session", sessionId: agentSession },
  { type: "session_page", sessionId: agentSession, before: "8812331:2b7c9e41" },
  { type: "session_send", sessionId: agentSession, text: "Also check it on Firefox", clientId: "c_4d2a", interrupt: false },
  { type: "session_send", sessionId: desktopRow.id, text: "Stop, use the Web Audio API instead", clientId: "c_4d2b", interrupt: true },
  { type: "session_stop", sessionId: agentSession },
  { type: "session_decide", sessionId: agentSession, cardId: "m20", choice: "once" },
  { type: "session_answer", sessionId: agentSession, cardId: "m21", answers: { [asked]: "Howler.js" } },
  { type: "session_answer", sessionId: agentSession, cardId: "m21", answers: null },
  { type: "session_create", ref: "s1", projectId: solta.id, text: "Add a mute button to the player", model: null, mode: "plan", isolate: "worktree" },
  { type: "session_create", ref: "s2", projectId: claudio.id, text: "Why does the bridge log a gap?", model: "opus", mode: null, isolate: "none" },
  { type: "session_create", ref: "s3", projectId: solta.id, text: "Profile the fade on the Mac", model: null, mode: null, isolate: "none", machine: MAC },
  { type: "session_set", sessionId: desktopRow.id, patch: { title: "Volume slider", hidden: true } },
  { type: "session_set", sessionId: agentSession, patch: { model: null, mode: "acceptEdits" } },
  { type: "session_open_desktop", sessionId: agentSession },
  { type: "session_tool", sessionId: agentSession, toolUseId: "toolu_01Ab5" },
  { type: "session_prefs", mirror: "tap" },
] satisfies Wire<ClientMessage>[];

// The home-machine link (src/machine/wire.ts), one frame of each kind and every intent and event inside them. The
// iOS app never reads these.
const machineProfile = {
  name: "omarchy", platform: "linux", homedir: "/home/alex", username: "alex", rootHome: "/root", bridgeHome: "/home/alex/.claudiobot",
  managedMcpPath: "/etc/claude-code/managed-mcp.json",
  private: { bridge: [".claudiobot"], keys: [".ssh"], browser: [".config/google-chrome"], creds: [".netrc"], personal: [] },
  caches: [".npm"], pushReadable: [".ssh/*.pub"], tempDirs: ["/tmp"], sandboxNeeds: [], access: { full: true, sandbox: false },
} as const;
const fromBot = { kind: "bot", botId: "b1", hops: 1, origin: { kind: "routine", run: { routineId: "r1", runId: "run4" }, manual: false } } as const;
const agentCard = { ...permission, id: "m30", from: agentPeer };
// The machine's own record: spend is the ledger's, and the machine is the home's to say, on whichever side shows it.
const { spentUsd, budgetUsd, machine: _, ...bareAgent } = agent;
export const link = [
  { t: "challenge", nonce: "9f".repeat(32) },
  { t: "hello", machineId: MAC, sig: "c2lnbmF0dXJl", nonce: "4e".repeat(32), profile: machineProfile, lastSeq: 12 },
  { t: "welcome", sig: "c2lnbmF0dXJl", ackedSeq: 9 },
  {
    t: "intent",
    intent: {
      kind: "agent.start", intentId: "i_1", agentId: "a1", bot: { id: "b1", name: "engineer", dailyCapUsd: 10, connectorsOff: ["gmail"] },
      title: "Set up verification skill", prompt: "Write the verify skill.", project: { githubRepo: "alex/web", name: "alex/web" },
      where: "mac", isolate: "worktree", budgetUsd: 5, slash: null, initiator: { kind: "user" },
    },
  },
  { t: "intent", intent: { kind: "agent.message", intentId: "i_2", agentId: "a1", text: "Also cover the login page.", initiator: fromBot } },
  { t: "intent", intent: { kind: "agent.direct", intentId: "i_3", agentId: "a1", text: "Use port 4000.", clientId: "c9" } },
  { t: "intent", intent: { kind: "agent.stop", intentId: "i_4", agentId: "a1" } },
  { t: "intent", intent: { kind: "agent.removeWorktree", intentId: "i_5", agentId: "a1" } },
  { t: "intent", intent: { kind: "card.answer", intentId: "i_6", botId: "b1", cardId: "m30", reply: { kind: "permission", choice: "once" }, signed: null } },
  { t: "intent", intent: { kind: "snapshot", intentId: "i_7" } },
  { t: "ack", seq: 10 },
  { t: "event", event: { seq: 10, at, kind: "agent", agent: bareAgent, messages: [{ id: "m40", at, from: "bot", text: "Write the verify skill." }] } },
  { t: "event", event: { seq: 11, at, kind: "report", agentId: "a1", botId: "b1", text: "Done: the skill runs.", by: { kind: "agent", agentId: "a1", hops: 1, origin: { kind: "user" } } } },
  { t: "event", event: { seq: 12, at, kind: "note", agentId: "a1", botId: "b1", text: "Worktree removed." } },
  { t: "event", event: { seq: 13, at, kind: "card", botId: "b1", message: agentCard } },
  {
    t: "event",
    event: {
      seq: 14, at, kind: "usage",
      row: { at, actor: "agent:a1", botId: "b1", sessionId: "s_1", initiator: { kind: "user" }, cumulativeUsd: 0.4, deltaUsd: 0.25, day: "2026-10-16" },
    },
  },
  { t: "event", event: { seq: 15, at, kind: "profile", profile: machineProfile } },
  { t: "event", event: { seq: 16, at, kind: "refused", intentId: "i_1", reason: "No project \"web\". Call list_projects for the names." } },
  { t: "event", event: { seq: 17, at, kind: "snapshot", agents: [], openCards: [{ botId: "b1", message: agentCard }] } },
  { t: "applied", intentId: "i_1", applied: { ok: true, reply: "Started agent a1 on web. It reports back to you when its turn ends." } },
  { t: "applied", intentId: "i_4", applied: { ok: false, reason: "Nothing is running." } },
] satisfies Wire<HomeFrame | MachineFrame>[];

// Compile-time coverage: every server type, client type, message kind and session item kind has a fixture, so the Swift mirror is pinned
// for all of them. A missing one fails tsc with its name.
type Kinds<F> = F extends { message: { kind: infer K } } ? K : F extends { messages: (infer M)[] } ? (M extends { kind: infer K } ? K : never) : never;
type Covered<All, Seen> = [Exclude<All, Seen>] extends [never] ? true : Exclude<All, Seen>;
const everyServerType: Covered<ServerMessage["type"], (typeof server)[number]["type"]> = true;
const everyClientType: Covered<ClientMessage["type"], (typeof client)[number]["type"]> = true;
const everyMessageKind: Covered<Message["kind"], Kinds<(typeof server)[number]>> = true;
type ItemKinds<F> = F extends { items: (infer I)[] } ? (I extends { kind: infer K } ? K : never) : never;
const everySessionItemKind: Covered<SessionItem["kind"], ItemKinds<(typeof server)[number]>> = true;
type Frames = (typeof link)[number];
const everyFrame: Covered<(HomeFrame | MachineFrame)["t"], Frames["t"]> = true;
const everyIntent: Covered<Intent["kind"], Extract<Frames, { t: "intent" }>["intent"]["kind"]> = true;
const everyEvent: Covered<EventBody["kind"], Extract<Frames, { t: "event" }>["event"]["kind"]> = true;
void [everyServerType, everyClientType, everyMessageKind, everySessionItemKind, everyFrame, everyIntent, everyEvent];

export const fixturesJson = () => JSON.stringify({ server, client, link }, null, 2) + "\n";
export const fixturesPath = new URL("../../fixtures/protocol.json", import.meta.url);

if (import.meta.main) await Bun.write(fixturesPath, fixturesJson());
