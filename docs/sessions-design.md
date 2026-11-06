# Sessions: project-bound Claude Code sessions and a Sessions view

Status: design, chosen in an architecture arena (three independent candidates, a cross-judge from another model family, then a base pick with grafts). §8 records the synthesis. Where §8 and the body disagree, §8 wins.

**The shape in one paragraph.** Claude Code's transcript files are the only source of truth for what a session *is*: whether it exists, its cwd, title, branch, PR, who wrote each turn, and every item in its thread. The bridge keeps no session list. It keeps an **overlay** (`World.sessions`) holding only the facts nothing else owns: hidden, last visited, and, for sessions the phone drives, the durable inbox and model/mode. Three read-only inputs join that overlay at one read boundary (`catalog.ts`): the transcript index, the Claude desktop app's store (whether the app lists the session, archived, parent), and Claude Code's live-process registry `~/.claude/sessions/<pid>.json`. That registry was found while grounding this design. It lists every live Claude Code process with its `sessionId`, `entrypoint` and `status: busy|idle`, so the bridge can see who else is writing. Thread items always come from the transcript tail, whoever the writer is. The bridge's own SDK stream adds only transient text deltas and cards. Every session has at most one writer inside the bridge, and that writer is a `session.ts` Session: the mac agent's Session when a bot's agent owns the id, or an "own" Session (new `OwnActor`) when the phone drives it. Both kinds of input, bot follow-ups and phone replies, go into that one durable inbox, so they are serialized and never interleave.

## 1. Usage first

### 1.1 Flows (the spec)

**F1: the bot dispatches into solta-o-som.**
- The bot calls `start_agent {project:"solta-o-som"}`. `findProject` now also matches the GitHub repo name, so this resolves to `~/Dev/projects/br-soundless` (remote `IamP5/solta-o-som`).
- `agents.start` makes the worktree `~/Dev/projects/br-soundless/.claude/worktrees/claudio-<8>` (see §8.2), pre-allocates `S = randomUUID()` and saves it (`persist("now")`). The first query opens with `{sessionId: S, title}`.
- The catalog shows the row at once, built from the AgentRecord. The project comes from the worktree's `.git` → `commondir`, and the label from the remote: **solta-o-som**.
- After the first `done` turn, if the Claude app is running in the background, the bridge runs `open -g "claude://resume?session=S"`, and the app lists the session under solta-o-som.
- The phone shows the row with the bot's avatar badge, a working dot while it runs, then an unread dot.

**F2: open the Sessions tab (300 sessions, 25 projects).** The app sends `watch_sessions`. Serve subscribes the socket to channel `sessions` and replies with one `sessions` frame of about 60 KB, built from the in-memory index (no disk reads). The app shows 5 rows per project, then "Show more". Later changes arrive as `session_rows` diffs, coalesced every 500 ms, only to sockets watching the list.

**F3: open a 37 MB transcript.** One exists here (`b109b727…`). `watch_session {id, after:null}` → `transcript.readPage(file, null)` reads backwards in 256 KB chunks along `parentUuid` from the leaf. It stops at 10 user turns, 120 items or 512 KB and replies `session {epoch, rev, items, before}`. Cost is O(page), not O(file). `session_page {before}` continues backwards from the cursor.

**F4: reconnect mid-stream.** After `hello`, the app re-sends `watch_sessions` (always a fresh snapshot) and `watch_session {id, after:{epoch, rev}}`. The thread's ring (256 upserts or 1 MB) replays `session_items` since `rev`; when the ring no longer covers it, the app gets a fresh snapshot. Either reply carries `live: {itemId, text}`, so deltas resume without a gap. The global replay ring is never used.

**F5: the user replies in an agent's session while the bot also follows up.** `session_send {S}` → `driverOf(S)` finds the AgentRecord → `agents.direct(rec, text)`. That pushes `{initiator: user}` into the **same** inbox that `message_agent` pushes into. Turns run one at a time, in queue order. The gate's attended column applies. Cards show in the bot's chat and inline in the thread. The user's turn is not relayed to the bot. The bot's next report from this agent carries "Alex also messaged this agent directly."

**F6: continue a desktop session from the phone.** The row shows `holder: "desktop"` (a live `claude-desktop` process has the id in `~/.claude/sessions`).
- While that process is busy, the composer is read-only and the thread live-tails the file.
- While it is idle, the phone may send (pending E6). `own.ts` resumes S in the transcript's cwd with native `canUseTool` cards and the user's raw text, so the transcript stays native.
- When the app turns busy while our query is idle, the bridge closes its query. The bridge always yields.

**F7: a new session in a project.** The project header's "+" → `session_create {ref, projectId, text, model, mode, isolate}` → `session_created {ref, sessionId}`. The id is pre-allocated, so the app navigates before Claude Code even starts.

### 1.2 Call sites

```ts
// main.ts / hub.ts wiring: the hub stays orchestration only and delegates every session verb.
const sessions = createSessions({ world, agents, ledger, persist, claude: deps.claude, channel: transport.channel,
  apps: createClaudeApps(), floors: policy.floors, now, log, userName });
// hub.handle(m): case "session_send": case "session_stop": … return sessions.handle(m);

// serve.ts: watching is a transport concern, because it needs the socket. Reply, replay and subscribe happen in one tick.
case "watch_session": for (const f of sessions.watchThread(m.sessionId, m.after)) send(ws, f); ws.subscribe(`s:${m.sessionId}`);

// agents.ts start(): one line of identity, decided before anything runs.
const rec = { …, session: { ...emptySession(newSessionId()) } };   // options(): transcriptExists(id) ? {resume:id} : {sessionId:id, title}
```

## 2. Data structures

### 2.1 Single source per fact

| Fact | Source (only writer) | Read by |
|---|---|---|
| session exists, cwd, createdAt, lastAt (the newest prompt, reply or tool result, never a title or bookkeeping line), title (`custom-title` > `ai-title` > first prompt), branch (last `gitBranch`), PR (`pr-link`), first/last `entrypoint`, last `permissionMode` | the transcript (Claude Code) | `transcript.ts` only |
| who is live on it, busy/idle | `~/.claude/sessions/<pid>.json` (Claude Code), minus the bridge's own child pids | `claudeApps.ts` |
| listed in the desktop app, archived there, `spawnedFrom` parent | desktop store `claude-code-sessions/**/local_*.json`, read only | `claudeApps.ts` |
| bot agent link | `AgentRecord.session.id` (agents.ts / session.ts) | catalog join |
| hidden in ClaudioBot, visitedAt, phone-driven inbox/model/mode, own cards | `World.sessions` (sessions.ts / session.ts / own.ts) | catalog, threads |
| project of a cwd | git: the worktree's `.git` → `commondir`, the remote in `<common>/config` | `projects.ts`, cached in `cache/projects.json` so a removed worktree still groups |
| desktop-mirrored? | derived: the desktop store has `cliSessionId == id` | mirror policy (no flag, so it is idempotent) |
| fresh vs resume for a pre-allocated id | derived: the transcript file exists | `options()` |

Nothing is hand-synced. Status, unread, holder and inDesktop are computed when a row is built.

### 2.2 Persisted (world.ts)

```ts
export type SessionId = string & { readonly __brand: "SessionId" };   // Claude Code's uuid; a cloud row uses its session_01… id
/** A session the user drives from the phone. Never a gate actor: gate.hooks and policy keep taking Actor. */
export type OwnActor = { kind: "own"; sessionId: SessionId };
/** What session.ts and ledger.ts run and meter. Gate code cannot be handed an OwnActor: the types say so. */
export type Driver = Actor | OwnActor;

/** The bridge's facts about one Claude Code session it has shown or driven. Writer: sessions.ts (own: own.ts / session.ts). */
export type SessionRecord = {
  id: SessionId;
  hidden: boolean;              // ClaudioBot's own archive; the desktop app's is its own store, never written
  visitedAt: string | null;     // unread = row.lastAt > visitedAt and the last item is the assistant's
  own: OwnDrive | null;         // present once the phone has sent to it; never on an id an AgentRecord owns
};
export type OwnDrive = {
  cwd: string;                  // fixed at first send from the transcript; never re-derived (one place the query opens)
  created: boolean;             // started from the phone (origin "phone")
  model: string | null;         // null: the transcript's last model, else the user's default
  mode: PermissionMode | null;  // null: the transcript's last permissionMode, else settings.permissions.defaultMode
  readonly session: Owned<SessionState>;   // writer session.ts: durable inbox, lifecycle, no notices/brief/context
  readonly cards: Owned<OwnCard[]>;        // writer own.ts: open ones + newest 20 settled
};
/** A Claude Code ask held for the user. Live-only on the SDK side: at boot every open one becomes "expired". */
export type OwnCard =
  | { kind: "permission"; card: PermissionMessage; toolUseId: string; suggestions: PermissionUpdate[] }
  | { kind: "ask"; card: AskCard; toolUseId: string }
  | { kind: "plan"; card: PlanCard; toolUseId: string; modeBefore: PermissionMode };
// World gains: sessions: Map<SessionId, SessionRecord>; sessionPrefs: Owned<{ mirror: "auto" | "ask" }>
// SessionState gains nothing. ParkReason gains "elsewhere" (another live process is busy on the id; re-checked every 15 s).
```

Encoded one-writer rule: `sessions.driverOf(id)` is the only function that maps an id to a writer. An agent link wins. `own` is refused on an agent-owned id, and at boot an `own` that conflicts with an agent link is dropped with a log line. Nothing else constructs a Session for a SessionId.

### 2.3 Index (catalog.ts, in memory plus a cache file)

```ts
type Head = {                        // one per transcript, rebuilt only when (size, mtimeMs) changed
  id: SessionId; file: string; size: number; mtimeMs: number;
  cwd: string; createdAt: number; lastAt: number;
  title: string; titleSource: "custom" | "ai" | "prompt";
  firstEntry: Entrypoint; lastEntry: Entrypoint;      // "cli" | "claude-desktop" | "sdk-ts" | "sdk-cli" | "sdk-py" | string
  branch: string | null; pr: PrLink | null; mode: PermissionMode | null; model: string | null;
  lastRole: "user" | "assistant" | null; lastError: boolean;
};
// Built from a 32 KB head read and a 64 KB tail read. 336 files is about 32 MB of reads on a cold boot, then incremental.
// Persisted to ~/.claudiobot/cache/sessions-index.json (0600). A cache, never state: deleting it costs one rescan.
// Bot homes (cwd under the bridge home) and isSidechain-only files are skipped: bots live in the Bots view.
// So are sessions whose cwd is under a temp folder (os.tmpdir(), /tmp, /var/folders) and outside the project roots:
// script and test-run leftovers, 102 of 162 projects on the first Mac measured.
```

Access patterns, traced:
- List: `rows()` maps heads, joins the overlay and agents, then sorts. 300 rows take under 5 ms.
- Change: `fs.watch(~/.claude/projects, {recursive:true})` is debounced 300 ms, re-stats the named files, rebuilds their heads and diffs the rows. A stat-only sweep every 60 s backs it up.
- Holder: `fs.watch(~/.claude/sessions)`, plus a re-read every 5 s while any thread is watched. A pid counts when it is alive and its `procStart` matches.
- Desktop store: `fs.watch` on the store dir, re-read on change: 101 small JSON files.

## 3. Wire protocol (feature `"sessions"`)

Everything is additive. A protocol 2 socket, or an app without the feature, never sends `watch_*`, so it never sees these frames. They bypass the global ring. They go on per-socket channels instead (Bun topics `sessions` and `s:<id>`), through the new `Transport.channel(topic, frame)`.

```ts
export type ProjectId = string & { readonly __brand: "ProjectId" };      // sha256(root realpath)[0..16]
export type SessionOrigin = "phone" | "agent" | "desktop" | "terminal" | "sdk" | "cloud";
export type SessionStatus = "idle" | "working" | "awaiting_approval" | "awaiting_input" | "failed" | "parked" | "unavailable";
export type Holder = "none" | "claudio" | "desktop" | "terminal" | "other";
export type SessionProject = { id: ProjectId; name: string; path: string; githubRepo: string | null; lastAt: string | null; canCloud: boolean };
export type SessionRow = {
  id: SessionId; projectId: ProjectId; parentId: SessionId | null;
  title: string; origin: SessionOrigin; agent: { botId: BotId; agentId: AgentId } | null;
  status: SessionStatus; holder: Holder; unread: boolean;
  branch: string | null; worktree: boolean;
  pr: { number: number; url: string; state: "open" | "merged" | "closed" | null } | null;
  inDesktop: boolean; hidden: boolean; url: string | null;   // url: claude.ai for cloud rows
  createdAt: string; lastAt: string;
};
export type ItemId = string & { readonly __brand: "ItemId" };
export type ToolStep = { id: string; tool: string; label: string; state: "running" | "ok" | "error" | "denied";
  diff: { path: string; added: number; removed: number } | null; output: string | null };   // output: last 2 KB
export type SessionItem =
  | { kind: "user"; id: ItemId; at: string; text: string; from: "user" | "bot" | "system"; queued: boolean }
  | { kind: "assistant"; id: ItemId; at: string; text: string }                 // id = `${message.id}:${block}`
  | { kind: "thinking"; id: ItemId; at: string; text: string; ms: number | null } // text ≤ 400 chars
  | { kind: "work"; id: ItemId; at: string; steps: ToolStep[] }                  // one run of tool calls; id = first tool_use id
  | { kind: "todo"; id: ItemId; at: string; todos: { text: string; state: "pending" | "in_progress" | "done" }[] }
  | { kind: "plan"; id: ItemId; at: string; text: string; state: "proposed" | "approved" | "rejected" | "expired" }
  | { kind: "permission"; id: ItemId; at: string; card: PermissionMessage }      // gate cards and own cards alike
  | { kind: "ask"; id: ItemId; at: string; questions: AskQuestion[]; answers: Record<string, string> | "dismissed" | "expired" | null }
  | { kind: "notice"; id: ItemId; at: string; text: string; tone: "info" | "error" }
  | { kind: "compaction"; id: ItemId; at: string };
export type SessionControls = { canSend: boolean; reason: string | null; working: boolean; queued: number;
  model: string | null; models: { id: string; label: string }[]; mode: PermissionMode; modes: PermissionMode[] };
export type ThreadPosition = { epoch: string; rev: number };
export type Cursor = string & { readonly __brand: "Cursor" };   // opaque: byte offset + chain uuid + file size

// Server
| { type: "sessions"; projects: SessionProject[]; rows: SessionRow[]; mirror: "auto" | "ask" }         // reply to watch_sessions
| { type: "session_rows"; rows: SessionRow[]; removed: SessionId[]; projects: SessionProject[] }      // channel "sessions"
| { type: "session"; sessionId: SessionId; epoch: string; rev: number; items: SessionItem[]; before: Cursor | null;
    controls: SessionControls; live: { itemId: ItemId; text: string } | null }                        // reply to watch_session
| { type: "session_items"; sessionId: SessionId; rev: number; items: SessionItem[]; removed: ItemId[]; controls: SessionControls | null } // channel s:<id>
| { type: "session_delta"; sessionId: SessionId; itemId: ItemId; offset: number; text: string }       // channel s:<id>, unsequenced, 60 ms coalesce
| { type: "session_page"; sessionId: SessionId; items: SessionItem[]; before: Cursor | null }
| { type: "session_created"; ref: string; sessionId: SessionId }
| { type: "session_tool"; sessionId: SessionId; toolUseId: string; output: string }                   // ≤ 64 KB, on demand
// Client
| { type: "watch_sessions" } | { type: "unwatch_sessions" }                                           // serve-level
| { type: "watch_session"; sessionId: SessionId; after: ThreadPosition | null } | { type: "unwatch_session"; sessionId: SessionId }
| { type: "session_page"; sessionId: SessionId; before: Cursor }
| { type: "session_send"; sessionId: SessionId; text: string; clientId: string; interrupt: boolean }  // interrupt: "Stop and send"
| { type: "session_stop"; sessionId: SessionId }
| { type: "session_decide"; sessionId: SessionId; cardId: MessageId; choice: PermissionChoice }       // permission and plan items
| { type: "session_answer"; sessionId: SessionId; cardId: MessageId; answers: Record<string, string> | null } // null dismisses
| { type: "session_create"; ref: string; projectId: ProjectId; text: string; model: string | null; mode: PermissionMode | null; isolate: "none" | "worktree" }
| { type: "session_set"; sessionId: SessionId; patch: { title?: string; hidden?: boolean; model?: string | null; mode?: PermissionMode } }
| { type: "session_open_desktop"; sessionId: SessionId }
| { type: "session_tool"; sessionId: SessionId; toolUseId: string }
| { type: "session_prefs"; mirror: "auto" | "ask" }
```

Rules:
- `rev` counts per session within a bridge `epoch`, one per `session_items` frame, with no gaps. A live frame is the next rev or the same one again. Only the reply to a `watch_session` from a position may jump ahead. Anything else means the app lost a frame. It then forgets its position and watches again with `after: null`, at once, for a snapshot. A thread frame the app cannot decode counts the same way, and a `session_rows` frame it cannot decode makes it watch the list again. A snapshot older than a live frame the app already applied since its watch counts as a loss too. A repair with no snapshot back after 5 s is sent once more. After that, a repair whose reply is lost waits for the next ordinary watch, so an unreadable reply never loops. The bridge holds a thread's later frames until its watch reply is on the socket.
- One order for every item, in every view: by `at`, except a `user` item with `queued: true`, which follows everything. Items at the same time keep the order they were first seen in, also when one moves. The bridge sorts snapshots and pages this way (`threads.ts` `ordered()`), and the app inserts each upsert at its place, so live, resumed and fresh views list the same items in the same order. An answered card stays at the time it was raised. A message Claude Code took carries its turn's start time until the transcript's copy replaces it, in the same frame.
- Every frame goes through one serializer (`stream.ts` `wire()`) that turns a lone surrogate into U+FFFD, so no frame is undecodable for that reason.
- `session_items` upserts by `id`, so replaying an upsert is a no-op.
- `session_delta` applies only when `offset` equals the client's current text length. Otherwise the client drops it and waits for the upsert, so a lost delta can only delay text, never corrupt it.
- `session_decide` on a card the gate owns is routed to `gate.answer(botId, cardId)`. The client sends one verb whatever owns the card.
- A rename calls SDK `renameSession`, which writes `custom-title` into the transcript, the source of truth.
- Fixtures: 8 server and 14 client fixtures in `fixtures/protocol.json`, with compile-time coverage through `scripts/fixtures.ts` as today.

### 3.1 Run state (features `session_tasks`, `session_unqueue`, `push_state`)

The Sessions fix plan (`docs/ux-program/fix-plan-sessions.md`, G0) adds what the wire needs to say about background work, step times, run endings, stop targets and push state. `bridge/src/protocol.ts` is the contract; this is the shape at a glance. Every new field is optional, so protocol stays 3: an older app ignores the keys, and a newer app reads an absent key as none. An optional field is either set or absent, never `null`, so each fact has one spelling and the fixtures round-trip on both sides. The bridge lists a feature in `hello.features` only once it serves it, and the app offers a control only behind its feature.

```ts
type StepState = "running" | "waiting" | "ok" | "error" | "denied" | "stopped";
type ToolStep = { /* as before */ state: StepState;
  detail?: string; startedAt?: string; endedAt?: string; background?: true; owner?: string; cause?: string; usage?: { tools: number; ms: number } };
type SessionTask = { id: TaskId; stepId: string | null; kind: "agent" | "command" | "other"; label: string; background: boolean;
  startedAt: string; owner: string | null; progress: { tools: number; last: string | null; at: string } | null; waiting: MessageId | null };
type SessionControls = { /* as before */ turn?: { startedAt: string; wake: boolean }; tasks?: SessionTask[]; heardAt?: string };
type SessionRow = { /* as before */ since?: string; running?: { agents: number; commands: number }; activity?: string;
  outcome?: { kind: "finished" | "failed" | "stopped" | "lost"; text: string; at: string } };
// SessionItem: permission + stepId?, subagent?; notice + reason?: "stop" | "task" | "restart" | "failure" | "approval"
// PermissionMessage.answer + "stopped" (the user stopped what asked) + "closed" (Claude Code exited while it waited)
// Client: session_stop + target?: "all" | "turn" | { task: TaskId }, turnStartedAt?; session_unqueue { sessionId, clientId }
// Server: hello + push?; push_state { push: PushState } (a live signal, like usage); error + about?: ErrorAbout
type PushState = { state: "on" } | { state: "off" } | { state: "failing"; error: string; at: string };
type ErrorAbout = { kind: "stop"; sessionId } | { kind: "set"; sessionId } | { kind: "send"; sessionId; clientId } | { kind: "tool"; sessionId; toolUseId } | { kind: "create"; ref };
```

Rules:
- Steps come from the transcript, so they survive a reopen or a restart. Tasks come from the live SDK stream and exist only while a bridge-driven query runs. The app joins them by `SessionTask.stepId` = `ToolStep.id`.
- With `session_tasks`, `controls.working` means something runs (a turn, a wake turn, or a live task), and Stop follows it. `controls.turn` says whether a turn runs, and queue-versus-send follows it. Without the feature, `working` is the turn alone and `turn` is never sent.
- A failed full-output fetch is an `error` with `about: { kind: "tool" }`. `session_tool_output.output` stays a string, so an older app never meets a `null` there.
- Until a bridge serves `session_tasks`, a `session_stop` aimed at `"turn"` or a task is refused with an error. `session_unqueue` is its own feature: a bridge without it refuses the request. A second withdrawal of the same message says it was already withdrawn, and both errors carry `about: { kind: "send" }`.
- How a run ends is recorded on the session's drive in `state.json` with `persist("now")`, so it outlives a bridge restart: `outcome` and `endedTurn` (the row's ending, until a turn of another envelope starts a new run), `cut` (when work was cut off, kept across sends), `stoppedSteps` (the steps of tasks the user stopped), the bridge's own `notices` (the newest 10) and `kept` (prompts of turns that ended without a reply, shown until the transcript has their words). Notices and kept prompts sit where their time falls in a snapshot. Stop closes the turn's open cards as `"stopped"` at once, and a subagent's once Claude Code takes its task's stop. It posts a `reason: "stop"` notice that names what stopped, what Claude Code refused to stop and what it has not confirmed yet; a late stop is named when the task ends. A stop that stopped nothing is no outcome.
- A transcript step that started before `cut.at` and still reads running reads `cut.state` with `cut.cause` once no turn from before the cut runs: `error` after Claude Code exited, `stopped` after a stop of everything or a bridge restart. Once the session rests (no turn, no task, no other Claude Code busy on it), any step still running reads `stopped`, "It ended without a result". A task the live query still runs keeps its step running.
- A `session_set` that Claude Code refuses changes nothing the controls report, and answers with `error` and `about: { kind: "set" }`.

## 4. Bridge modules

### 4.1 Module map

| File | Status | Owns (one line) |
|---|---|---|
| `transcript.ts` | new | the only reader of a Claude Code transcript: head/tail facts, backward pages, forward tail, projection to items. Pure except for byte reads |
| `claudeApps.ts` | new | other Claude surfaces on this Mac: the live-process registry, the desktop store (read only), app running/frontmost, the resume deep link |
| `catalog.ts` | new | the index: scan, cache, watch, join overlay + agents + apps, build rows, publish diffs |
| `threads.ts` | new | per-session watching: snapshot, pages, upsert ring, delta coalescing, overlay items (cards, queued, notices) merged into the transcript items |
| `own.ts` | new | drivers for sessions the phone drives: a `session.ts` Session with OwnActor, inline approvals (permission, AskUserQuestion, ExitPlanMode), model and mode controls |
| `sessions.ts` | new | the facade the hub and serve call: `handle`, `watchList`, `watchThread`, `driverOf` (the one-writer rule), mirror policy, boot resume |
| `projects.ts` | changed | `projectOf(cwd)` (worktree → main checkout via `.git`/`commondir`, remote label); `findProject` by path, folder or GitHub repo name |
| `session.ts` | changed | `actor: Driver`; spec `forgotten: "restart" \| "fail"`, `idleMs`, `held(): Hold \| null` (park "elsewhere"), `controls()` (`setModel`, `setPermissionMode`, `supportedModels`); the first attempt's uuid is `Pending.id` when that is a uuid; `includePartialMessages` passed through |
| `agents.ts` | changed | pre-allocated id + `title`; `direct(rec, text)` (user → agent, attended, not relayed); `held` wired; reports call `sessions.agentTurnEnded` |
| `ledger.ts` | changed | rows keyed by `Driver`; `botId: BotId \| null` (own sessions: no cap, always attended) |
| `policy.ts` | changed | exports `floors(call, ctx): Decision \| null`, the floors alone |
| `serve.ts`, `parse.ts`, `protocol.ts`, `protocol2.ts` | changed | watch frames and channels; new types; protocol 2 untouched |
| `push.ts` | changed | `notify` takes a target (bot or session), so an own-session card pushes `claudiobot://session/<id>` |
| `world.ts`, `store.ts` | changed | `World.sessions`, `sessionPrefs`, `checkStateFile`, `fromV3` defaults |

Import discipline is encoded: a test (`imports.test.ts`) fails if any module other than `catalog.ts` or `threads.ts` imports `transcript.ts`, or if anything other than `sessions.ts` imports catalog, threads or own. Bot tools cannot reach a transcript reader, and `~/.claude/projects` stays on the private floor for every bot and agent. Call chain: serve → hub → sessions → (threads | own | agents). That is three hops.

### 4.2 Interfaces (bodies elided)

```ts
// transcript.ts
export type Entry = { uuid: string; parent: string | null; logicalParent: string | null; at: string; kind: "user" | "assistant" | "system" | "meta";
  entrypoint: string | null; message: unknown; flags: { sidechain: boolean; meta: boolean; compactSummary: boolean; apiError: boolean } };
/** The facts of a transcript from its head and tail only. Throws nothing: a malformed line is skipped and counted. */
export function readHead(file: string): Promise<Head | null> { throw new Error("not implemented") }
/** Newest page on the leaf's chain, walking backwards from `before` (null: end of file). O(page). */
export function readPage(file: string, before: Cursor | null, budget = PAGE): Promise<{ entries: Entry[]; before: Cursor | null }> { throw new Error("not implemented") }
/** Lines appended since `offset`. A partial last line stays for the next call. */
export function follow(file: string, offset: number): Promise<{ entries: Entry[]; offset: number }> { throw new Error("not implemented") }
/** Pure: entries in chain order → items. Stable ids (message.id:block, tool_use id, user uuid), so live and history agree. */
export function project(entries: readonly Entry[], prior?: ProjectionTail): { items: SessionItem[]; tail: ProjectionTail } { throw new Error("not implemented") }
// TODO project(): a text block or a user prompt closes the open "work" run; tool_result settles its step (output tail 2 KB);
// Edit/Write/MultiEdit give the diff stat from toolUseResult.structuredPatch, falling back to the input's line counts; TodoWrite
// upserts one "todo" per turn; ExitPlanMode → plan; AskUserQuestion → ask (answered from its tool_result); Task/Agent → one step,
// no sidechain items; compact_boundary → compaction and the chain continues through logicalParentUuid; an envelope-framed user
// text ("[Alex]", "[Message from bot …]", "[Agent …]") → user item with `from`, its header stripped.

// claudeApps.ts
export type Live = { pid: number; sessionId: SessionId; entrypoint: string; busy: boolean };
export type ClaudeApps = {
  holders(): ReadonlyMap<SessionId, Live>;      // our own child pids excluded (session.ts reports spawned pids)
  desktop(): ReadonlyMap<SessionId, { archived: boolean; parent: SessionId | null; title: string | null }>;   // keyed by cliSessionId
  desktopState(): "absent" | "background" | "front";   // running = a live claude-desktop process; front = lsappinfo front
  importToDesktop(id: SessionId): Promise<boolean>;   // open -g claude://resume?session=<id>; true once the store lists it (polls 5 s)
  onChange(f: () => void): void;
};

// sessions.ts
export type Sessions = Tickable & {
  handle(m: SessionClientMessage): Promise<ServerMessage[]>;
  watchList(): Extract<ServerMessage, { type: "sessions" }>;
  watchThread(id: SessionId, after: ThreadPosition | null): ServerMessage[];   // snapshot, or the replay since `after`
  unwatchThread(id: SessionId): void;        // records visitedAt
  agentTurnEnded(rec: AgentRecord): void;    // the mirror policy
  resume(): void;                            // boot: expire open own cards, start own drivers with queued input, start watchers
  stop(): void;
};
type Writer = { kind: "agent"; rec: AgentRecord } | { kind: "own"; drive: OwnDrive } | { kind: "none"; reason: string };
function driverOf(id: SessionId): Writer { throw new Error("not implemented") }
// TODO driverOf: an AgentRecord with session.id === id → agent (a cloud agent: follow-up through cloud.ts);
// otherwise a transcript must exist (else "This session's transcript is gone") → own, created lazily with cwd from the head.

// own.ts
export type Own = {
  driver(rec: SessionRecord): Session;       // one per id; dormant ones are closed and forgotten (session.onDormant)
  decide(rec: SessionRecord, cardId: MessageId, choice: PermissionChoice): Result;
  answer(rec: SessionRecord, cardId: MessageId, answers: Record<string, string> | null): Result;
  set(rec: SessionRecord, patch: { model?: string | null; mode?: PermissionMode }): Promise<Result>;   // live: setModel / setPermissionMode
};
```

### 4.3 Runtime decisions

- **One long-lived streaming-input query per driven session.** `session.ts` already is that: a durable inbox, one message per turn, Stop, background-task tracking and idle close. Own sessions reuse it whole, with `idleMs = 10 min` (agents keep 15). Follow-ups **queue**. "Stop and send" (`interrupt: true`) stops the turn alone, then queues; background tasks keep running, and Stop keeps the user's queued messages. True steering (`priority: "now"` mid-turn) is deferred until a recorded transcript shows how its uuid echoes interact with `session.ts`'s turn matching. Today one message per turn is a guarded invariant.
- **Approvals for own sessions are native.** `canUseTool` parks a promise tied to `signal` and posts a `permission` item: once, always (= allow plus the SDK's `suggestions` scoped `session`), deny, never (= deny plus interrupt). `AskUserQuestion` becomes an `ask` item, answered with `updatedInput {questions, answers}`. `ExitPlanMode` becomes a `plan` item: approve → allow + `setPermissionMode(modeBefore)`; reject → deny with "keep planning". A PreToolUse hook applies **only the policy floors**, deny-only. The phone is a remote surface, and the floors are what it must never be talked into. There is no bridge sandbox and no risk table: these are the user's own sessions and must behave as they do in the desktop app. The same id may be continued there, so two regimes on one transcript would be the real surprise. Cards are saved with `persist("now")` when opened, and expire after 2 h (deny + notice). At boot, every open card becomes `expired`, because the query that waited on it died with the bridge.
- **Agent sessions keep the gate.** The phone's `direct` turn is `initiator: user`, so the agent's attended column applies, inside its sandbox. Its cards stay gate cards. `threads.ts` projects `world.gate.open` cards for the agent into the thread, and the user can answer in either place, first answer wins, as today.
- **Ledger.** Own sessions write rows with `botId: null` and no cap. Feature 1's plan usage frame is the guard, and the composer shows its chip.
- **Yield and hold.** `session.ts` asks `held()` before starting a turn. When another live process is busy on the id, the head parks as `elsewhere` and the clock re-checks every 15 s. When a holder turns busy while our query is idle, `sessions` calls `session.reopen()`, which closes it now.
- **Stale ids.** For an own session, "No conversation found" fails the turn with a notice (`forgotten: "fail"`) and never starts a new session silently. A transcript that vanishes (Claude Code's `cleanupPeriodDays`, a delete in the app) removes the row. Its overlay record is pruned 7 days later unless an agent links it.
- **Restart idempotence.** The index is rebuilt from the cache plus a stat sweep. Own inboxes resume like agents' (`pending.length > 0` → driver). The pre-allocated id goes `sessionId` vs `resume` by whether the file exists. Mirroring checks the desktop store again, so re-running it is a no-op.

### 4.4 Agent dispatch and the desktop app

- **Placement.** New worktrees go to `<repo>/.claude/worktrees/claudio-<8>` on branch `claudio/<8>`, the desktop app's own convention. This was settled by reading the app's sidebar code (§8.2): the app groups a session by repo only when it can read git info for the session's folder, and it reads git info only for trusted folders. A worktree under `~/.claudiobot-worktrees` is untrusted, so the app would file it under its own folder name. Under `<repo>/.claude/worktrees/` it inherits the repo's trust. The move costs four narrow changes: `projectConfigOf` ignores `.claude/worktrees`; `auto` isolate ignores that directory when deciding the checkout is dirty; `.claude/worktrees/` goes into `<commonDir>/info/exclude` when `git check-ignore` says it is not ignored; and the policy and sandbox treat that exact worktree root as the agent's cwd, not as Claude configuration. Existing worktrees keep their paths, and ClaudioBot groups them by `commondir` either way.
- **Identity.** The id is pre-allocated (`sessionId`), and `title` is passed on the first query only (the agent's title; phone sessions get Claude's own `ai-title`).
- **Mirror policy** (`sessionPrefs.mirror`, phone setting "Show agent sessions in the Claude app: Automatically / When I tap"; default **auto**):
  - Auto imports after the first `done` turn of an agent session or a phone-created session, but only while `desktopState()` is `background`. The deep link launches the app when it is absent and changes its view when it is in front. So in `front` or `absent` the import waits, re-checked by the clock for up to 24 h.
  - Imports run at most one per 60 s, newest first.
  - "Open in Claude app" (`session_open_desktop`) on any row imports when needed and brings the app forward with a plain `open`. It is the on-demand path, and it is the only path when the setting is "When I tap" or the user turned off claude:// handling.
- **Cloud.** A cloud agent becomes a row with origin `cloud`, `url`, and its project from `rec.repo`. Its thread is the AgentRecord's messages projected as user/assistant items, under a banner with "Open on claude.ai". Sending calls `agents.message(rec, text, user)` → `followUpCloudSession`, so the bridge never pretends to have its transcript. Phone-created cloud sessions are out of scope for v1 (`canCloud` is reserved).

## 5. iOS

### 5.1 View tree

```
MainView (NavigationSplitView; iPhone collapses it into one stack)
├─ sidebar: SidebarRoot
│   ├─ toolbar .principal: Picker("", selection: $router.mode) { Bots | Sessions }   (@SceneStorage, segmented)
│   ├─ .bots     → HomeView (unchanged)
│   └─ .sessions → SessionsSidebar
│        List(selection: $router.selection) {
│          SearchField (title, project, branch; filters the index, no server round-trip)
│          FilterChips: All · Working · Needs you · Unread
│          ForEach(index.projects) { Section(header: ProjectHeader(name, count, "+", menu: Hide project · Open in Finder… n/a)) {
│              ForEach(index.visible(project)) { SessionRowView(row); ForEach(children) { SessionRowView(child).padding(.leading, 20) } }
│              if hiddenCount > 0 { ShowMoreRow }   // 5 per project, then +10 per tap
│          } }
│        }  .swipeActions: Hide · Open in Claude app ; .contextMenu: Rename · Mark read · Copy id
└─ detail: NavigationStack
    switch router.selection { .bot(id) → ChatView ; .session(id) → SessionThreadView ; nil → ContentUnavailableView }
    SessionThreadView(id)
      ├─ HolderBanner ("Working in the Claude app — read only" / "Cloud session · Open on claude.ai")
      ├─ ScrollView { LazyVStack { LoadEarlierRow (on appear → session_page); ForEach(model.items, id: \.id) { ThreadRow(item) } } }
      │    .defaultScrollAnchor(.bottom) .scrollPosition(id:) (holds position across prepends)
      │    ThreadRow: UserBubble · AssistantText (MarkdownText from model.rendered[id]) · ThinkingDisclosure ·
      │               WorkGroupRow ("Edited 3 files, ran 2 commands", expands to ToolStepRow with +/− and output, "Full output" → session_tool) ·
      │               TodoCard · PlanCard · PermissionCardView (reused) · AskCard · NoticeLine · CompactionDivider · StreamingTail
      └─ .composerBar { SessionComposer: PromptTextView (reused) · model menu · mode menu · Stop · UsageChip (feature 1) · "Queued 2" }
    NewSessionSheet(project): prompt, model, mode, "Work in a new worktree" toggle → session_create, then router.open(.session(id))
```

### 5.2 Store

```swift
enum Selection: Hashable { case bot(BotID), session(SessionID) }      // Router.selection becomes this; deep link claudiobot://session/<id>
@Observable @MainActor final class SessionIndex {                     // AppStore.sessions (a let: its changes don't invalidate AppStore readers)
    private(set) var projects: [SessionProject] = []                   // ordered by newest lastAt, derived in apply
    private(set) var rows: [SessionID: SessionRow] = [:]
    private(set) var order: [ProjectID: [SessionID]] = [:]             // roots only, newest first; children in `children`
    private(set) var children: [SessionID: [SessionID]] = [:]
    func apply(_ f: SessionsFrame) { /* replace on .sessions; merge on .rowsChanged; re-sort only touched projects */ }
}
@Observable @MainActor final class ThreadModel {                       // one per open thread; Threads keeps an LRU of 4
    let id: SessionID
    private(set) var items: [SessionItem] = []; private var index: [ItemID: Int] = [:]
    private(set) var before: Cursor?; private(set) var controls: SessionControls?; private(set) var position: ThreadPosition?
    let live = LiveText()                                              // its own @Observable: a delta re-renders one row only
    private(set) var rendered: [ItemID: AttributedString] = [:]       // markdown parsed once per (id, text hash)
    func apply(_ f: ThreadFrame) { /* snapshot replaces; upsert by index; page prepends; delta → live if offset matches */ }
}
```

The reducer is pure over frames (`SessionIndex.apply`, `ThreadModel.apply`), and StoreTests feed it fixtures. `BridgeClient` sends `watch_sessions` while the Sessions tab is visible and `watch_session` while a thread is on screen. After every hello it re-sends both with the last `ThreadPosition`.

### 5.3 States, accessibility, performance

- **States:**
  - Loading: skeleton rows and a skeleton thread.
  - Empty: "No Claude Code sessions on this Mac yet", plus a new-session button per scanned project.
  - Bridge without the feature: "Update the bridge".
  - Offline: the cached index with a "Last updated 3 min ago" banner; the composer disabled, with the reason from `controls.reason`.
  - Transcript gone: a notice and the row removed.
- **Status is never color alone.** Working: a spinner ring, static under Reduce Motion. Needs you: an orange `exclamationmark.circle`. Unread: a filled dot. Failed: `xmark.circle`. The origin badge is the bot's avatar, or an SF Symbol for desktop, terminal, cloud and phone.
- **VoiceOver:** each row is one combined element ("solta-o-som, Update README, working, by Claudio Bot's agent, 5 minutes ago") with custom actions Hide, Open in Claude app and Mark read. Cards are announced on arrival.
- **Dynamic Type:** all text styles, badges at `@ScaledMetric`, rows wrap at accessibility sizes, tap targets of at least 44 pt.
- **Performance:**
  - The sidebar uses `List`: cell reuse, sections and swipe actions. The thread uses a `LazyVStack` (like ChatView) with stable server ids and `Equatable` row views.
  - Snapshots are bounded (120 items, 512 KB), and tool output is clipped to 2 KB with full output on demand.
  - Server deltas are coalesced at 60 ms. The client applies them to `LiveText` only.
  - Markdown is cached per item. Collapsed work groups render one line.
  - Prepends keep the anchor through `scrollPosition(id:)`.
  - The goal is under 16 ms per frame while streaming on an iPhone 13; it is checked with Instruments in U9.

## 6. Delivery plan

Each unit ends in a check. Units marked ∥ can run in parallel. The parallel feature-1 work is touching `ledger.ts`, `session.ts`, `agents.ts` and the fixtures now, so U6 and U7 start after it merges.

| # | Unit | Files | Check |
|---|---|---|---|
| U0 ∥ | Probes in scratch (haiku, about $0.05): **E6** the desktop app idle on S → bridge resumes S → user types in the app: does the app's turn chain from the bridge's turn or fork from its stale leaf? **E7** import a session whose cwd is a `~/.claudiobot-worktrees` worktree: does it group under the repo? **E8** do SDK `message.id`, tool ids and the user uuid we send match the transcript? **E9** does an SDK query appear in `~/.claude/sessions`? | none | written findings; E6 decides whether `idle` holders allow sends, E7 decides placement |
| U1 ∥ | `transcript.ts`: head, backward page, follow, projection | transcript.ts, test/transcript.test.ts, test/transcripts/jsonl/*.jsonl (scrubbed real files, recorded by a new script mode) | bun test: the item golden files; a 40 MB synthetic file gives its first page in under 150 ms; a branch (rewind) and a compaction project correctly |
| U2 ∥ | `projectOf` + `findProject` by repo name | projects.ts, hub.ts (findProject), test/projects.test.ts | bun test with temp repos, worktrees and a removed worktree; "solta-o-som" resolves to br-soundless |
| U3 | `claudeApps.ts` reads + `catalog.ts` index, cache and watch, rows | claudeApps.ts, catalog.ts, tests with a fake `~/.claude` tree | bun test: 300 synthetic transcripts, cold index under 1 s, warm boot under 100 ms, diff on append, holder busy/idle, bot homes excluded |
| U4 | protocol + fixtures + parse + serve channels + `threads.ts` (read only) + `sessions.ts` skeleton | protocol.ts, parse.ts, serve.ts, threads.ts, sessions.ts, hub.ts, world.ts, store.ts, fixtures | bun test (protocol, serve replay vs snapshot, imports.test); verify-claudio-bot `raw watch_sessions` / `watch_session` against the real `~/.claude` |
| U5 ∥ after U4's fixtures | iOS read-only: the switch, sidebar and thread | Protocol.swift, Store.swift (SessionIndex, ThreadModel), SessionsSidebar.swift, SessionThreadView.swift, ThreadItems.swift, MainView, Router, FakeBridge | ProtocolTests, StoreTests; simulator screenshots on iPhone and iPad with Dynamic Type XXL |
| U6 | dispatch: pre-allocated id, title, mirror policy, Open in Claude app | agents.ts, session.ts (sessionId vs resume), sessions.ts, claudeApps.ts | agents.test; transcript replay; verify-claudio-bot: a bot starts an agent in a real repo and the desktop store gains `cliSessionId` (evidence) |
| U7 | own drivers: OwnActor, `forgotten`, `held`, inline approvals, ask, plan, model and mode, ledger | session.ts, ledger.ts, policy.ts (floors), own.ts, sessions.ts, push.ts | session/own/ledger tests on FakeQuery; new recorded transcripts `own-ask.ndjson`, `own-plan.ndjson`, `own-permission.ndjson` |
| U8 | deltas: `includePartialMessages`, coalescing, `live` seed | session.ts, threads.ts | replay test: delta offsets, a reconnect mid-block seeds `live` |
| U9 | iOS interactive: composer, cards, Stop, new session, deltas, usage chip | SessionComposer.swift, AskCard.swift, PlanCard.swift, NewSessionSheet.swift | simulator flow via verify-claudio-bot (send, approve, stop); Instruments while streaming |
| U10 | agent-session `direct`, cloud rows, session card pushes, docs | agents.ts, sessions.ts, push.ts, docs/design.md, V3-CONTRACT.md | agents.test (inbox order of a bot and a user input on one id); verify-claudio-bot F5 run |

## 7. Rationale

### Alternatives considered (whole shapes)

1. **A bridge registry as the session list** (only sessions the bridge started or imported). The smallest reader, but it hand-syncs a list against files another program writes, and it misses the desktop and terminal sessions the user asked to see.
2. **SDK `listSessions`/`getSessionMessages` as the only reader.** Documented, but the messages leave out what items need (content block index, tool results, flags), and there is no tail and no `entrypoint`, `pr-link` or `permissionMode`. Built instead (§8.3): the SDK gives the list and a thread's chain order, and `transcript.ts` reads the lines themselves for content, heads and the live tail.
3. **Own sessions as gate actors** (a pseudo-bot using deny-and-regrant). One approval mechanism, but it writes `[Alex allowed once: …]` envelopes and continuation turns into the user's own transcript, which the desktop app then shows, and it puts the bot risk table on hand-driven sessions.
4. **Per-turn `query` + `resume`.** No idle queries, but background tasks are lost between turns and Claude Code respawns every turn.
5. **Session frames through the global replay ring.** One busy thread would evict the bots' frames from the 2,000-frame ring.
6. **Remote Control or the alpha `attachBridgeSession`.** It does not turn on from SDK `query()` (E2), it is alpha, and it needs the OAuth token.

### Red-flag screen

- **Deep, not shallow:** `sessions.ts` has six calls and hides the scan, cache, watchers, three external stores, writer routing and the mirror policy.
- **No leakage:** the jsonl format lives in one file, and content-derived ids make live and history agree.
- **One owner per fact:** see §2.1. The one-writer rule is one function.
- **One way to decide a card:** the client sends one verb. The two back ends (gate, native) split by actor kind, deliberately.
- **Internals not importable:** `imports.test.ts` enforces it.
- **No temporal decomposition:** live and history share `project()`.

### Tradeoffs accepted

- We accept parsing an undocumented JSONL format (and reading the desktop store and `~/.claude/sessions`) in exchange for O(page) opens, live tails of any writer, and origin, PR and branch without extra calls. A tolerant parser that skips and counts unknown lines, and golden files re-recorded after each Claude Code upgrade, contain the damage.
- We accept file-tail latency (about 100 ms flush plus 100 ms debounce) for items even on the bridge's own sessions, in exchange for one item source whatever the writer. Deltas hide the latency.
- We accept the desktop app's view jumping to an imported session (when it is in the background) in exchange for meeting "appears in my Claude app" without the user doing anything. The "When I tap" setting turns it off.
- We accept no steering in v1 (Stop and send instead) in exchange for keeping `session.ts`'s one-message-per-turn invariant.
- We accept that cost of turns the desktop app ran on an agent session lands on that agent's next bridge row (the SDK's cumulative total), in exchange for leaving the ledger's baseline rule untouched.

### Product calls (decided, each reversible from Settings or one constant)

1. **A session open but idle in the Claude app accepts phone messages**, with a banner "Also open in the Claude app". A busy holder blocks sends. Probe E6 measures whether the app forks after a phone turn; if it does, the banner becomes "Open in the Claude app to continue" and the composer locks.
2. **Desktop mirroring defaults to automatic**, guarded (§8.4). Settings has "Show agent sessions in the Claude app: Automatically / When I tap / Never".
3. **Phone-started sessions use the permission mode from your Claude Code settings** (`permissions.defaultMode`, else `default`). The composer's mode menu switches it live. `bypassPermissions` is never offered from the phone.
4. **The bot hears about a direct reply through a one-line note** in its agent's next report, not the full turn.
5. **SDK-tool sessions are listed** under their projects with an "SDK" origin badge. Bot-home sessions are not listed: bots live in the Bots view. Nor are sessions left in temp folders outside the project roots.

### Risks

- E6 fork risk: an idle desktop process may write its next turn on its stale leaf and branch the transcript. The projector follows the newest leaf, so the phone stays coherent, but the app may not be.
- Formats change without notice: jsonl record types, the desktop store fields, the `~/.claude/sessions` registry. Each reader degrades to "fact unknown" rather than failing, and `claudiobot doctor` reports the parser's skip counts.
- `fs.watch` recursive across a 2.8 GB tree: FSEvents coalescing can drop events. The 60 s stat sweep bounds staleness.
- Push now reaches beyond bots: card pushes for own sessions must stay content-free ("A session needs you"), as bot pushes are.
- Holder detection by pid can misattribute after pid reuse. A matching `procStart` guards it, as `lock.ts` does.


## 8. Synthesis

### 8.1 How this design was chosen
Three Opus runners wrote independent designs from one brief. A cross-judge on a different model family scored them on six criteria: ownership and concurrency, fit with the bridge, UX, performance, desktop visibility, and deliverability. The judge and the lead both picked candidate 1 (this body) as the base. It leaves `Actor`, the gate and the bot sandbox untouched, makes the one-writer rule a single typed function, keeps reads bounded and has the fullest UX.

All three converged on the following, which is therefore high confidence:
- Disk is the truth for what exists, merged with bridge-owned facts at one read boundary.
- `~/.claude/sessions/<pid>.json` is the cross-process writer signal.
- The session id is pre-allocated, and `title` goes on the first query.
- `session.ts`'s long-lived query is reused, and follow-ups queue.
- Thread frames use per-session channels with their own ring, outside the global replay ring.
- Deltas are offset-checked and unsequenced.
- Opens are bounded and paged.
- `transcript.ts` is the only transcript reader.
- Cloud agents appear as link-out rows.

Rejected whole shapes:
- **Candidate 3's single `code.ts` runtime that absorbs mac agents.** Its ownership story is the cleanest, but it migrates `AgentRecord.session` mid-stack and would collide with feature 1's edits. `driverOf` routing into the agent's existing inbox gives the same one-writer guarantee without the migration.
- **Candidate 3's deny-and-regrant approvals for your own sessions.** They write bridge envelopes into a transcript the desktop app also shows, and they cost an extra model round trip per approval.
- **Candidate 2's bot-less `desk` member of the bot-keyed `Actor` union.** It would ripple through every exhaustive switch.

### 8.2 Worktree placement (settled by reading the desktop app)
The desktop sidebar is claude.ai's renderer. It reads `cwd`, `originCwd`, `harnessCwd` and `branch` from a session record, never `gitAnchors`. The group key is the git `owner/name` when `getGitInfo(cwd)` answers, else the folder path, labelled with its basename. `getGitInfo` answers only when `requireTrustedCwd` passes: `hasTrustDialogAccepted` in `~/.claude.json` for the nearest folder holding a `.git` entry, then its parents. For an external worktree that nearest folder is the worktree itself. It is untrusted, so the session would get its own group named after the worktree folder. Under `<repo>/.claude/worktrees/` the trusted repo is a parent, so the session joins the repo's group under its remote name ("solta-o-som" for `br-soundless`). New worktrees therefore move there (§4.4).

### 8.3 Grafts
- **From candidate 2.**
  - **The cross-process hold reuses the existing retry.** `spec.blocked?()` returns non-null while another live process is busy on the id, and `session.ts` treats that like its existing `unstarted` path: the input stays queued and the turn retries on `START_RETRY_MS`. This replaces the new `ParkReason "elsewhere"` and its 15 s clock.
  - **The catalog and the first page come from the SDK.** Candidate 2 measured `listSessions` at 102 to 113 ms for 334 transcripts (2.8 GB) and `getSessionMessages` at 85 ms for a 63 MB transcript on this Mac. So the catalog runs `listSessions({dir})` for each project folder an `fs.watch` event names, never for all of them. A small cached head sniff, keyed by `(size, mtime)`, adds what the SDK does not return: `entrypoint` and the `pr-link`. Opening a thread runs `getSessionMessages` once per `(size, mtime)` into an LRU of parsed projections (4 threads, 64 MB cap), and the snapshot is bounded server side. The live tail of another writer parses appended jsonl lines with the same projector. The SDK readers are a supported API, so this deletes the hand-written backward reader and its format risk.
  - **The idle gate for auto-mirroring.** See §8.4.
- **From candidate 3.**
  - **Unread** is true only for a session the bridge drives, or one you have opened before (`visitedAt` set), when `lastAt > visitedAt` and the last item is the assistant's. Without that rule, 300 untouched sessions would all show as unread.
  - **Fork detection in the live tail.** An appended entry whose `parentUuid` is not the current leaf bumps the thread's generation and sends a fresh snapshot.
  - **Mirror bookkeeping.** `requestedAt` and `failed` are persisted per session, with capped retries.
  - **`session_removed {movedTo}`** when an agent session restarts under a new id.
- **From the cross-judge.**
  - `Transport.signal` is extended with a topic argument instead of adding a parallel `Transport.channel`.
  - The two `session_tool` frames are renamed `session_tool_output` (server) and `session_tool` (client).

### 8.4 Desktop mirroring policy
After the first `done` turn of an agent session or a phone-created session, the bridge runs `open -g "claude://resume?session=<id>"`, but only when all of these hold:
- the setting is Automatically;
- the bridge's query on that id is closed or idle;
- the Claude app is running and not frontmost (`lsappinfo front`);
- the Mac has been idle at least 120 s (`ioreg -c IOHIDSystem`, HIDIdleTime).

The import moves the app's view to that session, and these gates keep it from happening while you work there.

Retries come on the bridge clock every 60 s for up to 24 h, newest session first, at most one import per 60 s. Success means an entry whose `cliSessionId` is the id appears in the app's store within 10 s. The file name is no guide: a session the app started itself is `local_<the app's own uuid>.json` (100 of 102 on the first Mac measured), and only an imported one was seen named after the Claude Code id. So the bridge reads every `local_*.json` and keys them by `cliSessionId`. A no-show sets `failed` and stops automatic retries for that session; you may have turned off `claude://` handling. "Open in Claude app" on any row imports when needed, then brings the app forward. An entry already listing the id makes every attempt a no-op.

### 8.5 Delivery
Feature 1 (optional caps, plan usage) lands first on this branch because it edits `ledger.ts`, `session.ts` and the protocol files. The units of §6 follow, with these changes:
- U1 uses the SDK readers (§8.3).
- U0's E7 is answered (§8.2), so U6 includes the worktree move.
- U7's park state is the `blocked` retry.
