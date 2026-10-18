import type { Cursor, ItemId, ServerMessage, SessionControls, SessionId, SessionItem, ThreadChannelFrame, ThreadLive, ThreadPosition } from "./protocol";
import { emptyTail, extend, follow, pageOf, project, readThread, sdkReaders, statOf, toolOutput, type Chain, type Head, type ProjectContext, type ProjectionTail, type SdkReaders } from "./transcript";

// Watching one session's thread: the newest page as a snapshot, older pages by cursor, every change after as upserts
// on channel s:<id> with a per-thread rev and a ring to replay a reconnect from, and the streaming text of the item
// being written. Items come from the transcript whoever writes it; the bridge adds an overlay (cards, queued
// messages, notices) that replaces a transcript item of the same id or follows the transcript's items.

export type ThreadsDeps = {
  /** The bridge's epoch (the hello's): a position from another start is never replayed. */
  epoch: string;
  head(id: SessionId): Head | null;
  context(id: SessionId, head: Head | null): ProjectContext;
  overlay(id: SessionId): SessionItem[];
  controls(id: SessionId): SessionControls;
  publish(id: SessionId, frame: ThreadChannelFrame): void;
  watched(id: SessionId): boolean;
  log(line: string): void;
  sdk?: SdkReaders;
  /** Threads nobody watches that stay read, newest first, so reopening one is instant. */
  keep?: number;
};

export type Threads = {
  /** The reply to watch_session: a replay since `after` while the ring holds it, else a snapshot. */
  watch(id: SessionId, after: ThreadPosition | null): Promise<ServerMessage[]>;
  page(id: SessionId, before: Cursor): Promise<ServerMessage[]>;
  tool(id: SessionId, toolUseId: string): ServerMessage[];
  /** The overlay or the controls of a session may have changed: an open thread publishes what did. */
  refresh(id: SessionId): void;
  /** A transcript grew: its open thread reads the new lines. */
  appended(path: string): void;
  /** Every open thread whose transcript grew, or appeared, reads it now: what a missed watch event would have done. */
  poll(): Promise<void>;
  /** The transcript is gone: watchers get session_removed and the thread is dropped. */
  removed(id: SessionId, movedTo: SessionId | null): void;
  /** Text streaming into an item not yet in the transcript (the bridge's own query). */
  live(id: SessionId, live: ThreadLive | null): void;
  /** A socket left: a thread nobody watches is kept only among the newest `keep`. */
  release(id: SessionId): void;
  open(id: SessionId): boolean;
  stop(): void;
};

const RING_ITEMS = 256;
const RING_BYTES = 1 << 20;
const KEEP = 4;

type Frame = { rev: number; items: SessionItem[]; removed: ItemId[]; bytes: number };

type State = {
  id: SessionId;
  path: string | null;
  ctx: ProjectContext;
  epoch: string;
  items: SessionItem[];
  index: Map<ItemId, number>;
  tail: ProjectionTail;
  chain: Chain;
  offset: number;
  /** The overlay items last published, by id, as JSON; and the controls likewise. */
  overlay: Map<ItemId, string>;
  controls: string;
  /** Overlay user items the transcript now shows, so they are not shown twice. */
  shownByTranscript: Set<ItemId>;
  rev: number;
  ring: Frame[];
  live: ThreadLive | null;
  queue: Promise<void>;
  usedAt: number;
};

let generation = 0;

export function createThreads(deps: ThreadsDeps): Threads {
  const sdk = deps.sdk ?? sdkReaders;
  const states = new Map<SessionId, State>();
  const loading = new Map<SessionId, Promise<State>>();

  const indexOf = (items: readonly SessionItem[]) => new Map(items.map((item, i) => [item.id, i] as const));

  async function read(id: SessionId): Promise<Omit<State, "overlay" | "controls" | "shownByTranscript" | "rev" | "ring" | "live" | "queue" | "usedAt" | "epoch">> {
    const head = deps.head(id);
    const ctx = deps.context(id, head);
    if (!head) return { id, path: null, ctx, items: [], index: new Map(), tail: emptyTail(), chain: { uuids: new Set(), leaf: null }, offset: 0 };
    const thread = await readThread(id, head.file, head.cwd, sdk);
    const { items, tail } = project(thread.entries, ctx);
    return { id, path: head.file, ctx, items, index: indexOf(items), tail, chain: thread.chain, offset: thread.size };
  }

  async function load(id: SessionId): Promise<State> {
    const open = states.get(id);
    if (open) return open;
    const pending = loading.get(id);
    if (pending) return pending;
    const made = read(id)
      .then((r): State => {
        const s: State = {
          ...r,
          epoch: `${deps.epoch}.${++generation}`,
          overlay: new Map(),
          controls: "",
          shownByTranscript: new Set(),
          rev: 0,
          ring: [],
          live: null,
          queue: Promise.resolve(),
          usedAt: Date.now(),
        };
        absorbOverlay(s);
        states.set(id, s);
        return s;
      })
      .finally(() => loading.delete(id));
    loading.set(id, made);
    return made;
  }

  /** The overlay as it should show: suppressed items left out. Records it as published. */
  function absorbOverlay(s: State): SessionItem[] {
    const overlay = deps.overlay(s.id).filter((item) => !s.shownByTranscript.has(item.id));
    s.overlay = new Map(overlay.map((item) => [item.id, JSON.stringify(item)]));
    s.controls = JSON.stringify(deps.controls(s.id));
    return overlay;
  }

  /** The transcript's items with the overlay's replacements applied, then the overlay's own. */
  function merged(s: State): SessionItem[] {
    const overlay = deps.overlay(s.id).filter((item) => !s.shownByTranscript.has(item.id));
    const byId = new Map(overlay.map((item) => [item.id, item]));
    const out = s.items.map((item) => {
      const over = byId.get(item.id);
      if (over) byId.delete(item.id);
      return over ?? item;
    });
    return [...out, ...byId.values()];
  }

  function emit(s: State, items: SessionItem[], removed: ItemId[], controls: SessionControls | null) {
    if (items.length === 0 && removed.length === 0 && controls === null) return;
    s.rev++;
    const frame: Frame = { rev: s.rev, items, removed, bytes: JSON.stringify(items).length };
    s.ring.push(frame);
    let count = s.ring.reduce((n, f) => n + f.items.length + f.removed.length, 0);
    let bytes = s.ring.reduce((n, f) => n + f.bytes, 0);
    while (s.ring.length > 1 && (count > RING_ITEMS || bytes > RING_BYTES)) {
      const dropped = s.ring.shift()!;
      count -= dropped.items.length + dropped.removed.length;
      bytes -= dropped.bytes;
    }
    // An upsert brings the item's whole text, so its streaming text is done.
    if (s.live && items.some((i) => i.id === s.live!.itemId)) s.live = null;
    deps.publish(s.id, { type: "session_items", sessionId: s.id, rev: s.rev, items, removed, controls });
  }

  /** What the overlay and controls changed since last published, with the transcript items it now replaces. */
  function overlayDiff(s: State, transcriptChanged: readonly SessionItem[]): { items: SessionItem[]; removed: ItemId[]; controls: SessionControls | null } {
    for (const t of transcriptChanged) {
      if (t.kind !== "user") continue;
      for (const o of deps.overlay(s.id)) if (o.kind === "user" && o.queued && o.text.trim() === t.text.trim() && !s.shownByTranscript.has(o.id)) s.shownByTranscript.add(o.id);
    }
    const before = s.overlay;
    const beforeControls = s.controls;
    const overlay = absorbOverlay(s);
    const items = overlay.filter((item) => before.get(item.id) !== JSON.stringify(item));
    const removed = [...before.keys()].filter((id) => !s.overlay.has(id) && !s.index.has(id));
    // An overlay item that replaced a transcript item and went away brings the transcript's back.
    const restored = [...before.keys()].filter((id) => !s.overlay.has(id) && s.index.has(id)).map((id) => s.items[s.index.get(id)!]!);
    const controls = s.controls === beforeControls ? null : (JSON.parse(s.controls) as SessionControls);
    return { items: [...items, ...restored], removed, controls };
  }

  /** Transcript items as shown: an overlay item of the same id wins. */
  const shown = (s: State, items: readonly SessionItem[]) => {
    const overlay = new Map(deps.overlay(s.id).map((item) => [item.id, item]));
    return items.map((item) => overlay.get(item.id) ?? item);
  };

  function upsertTranscript(s: State, changed: readonly SessionItem[]) {
    for (const item of changed) {
      const at = s.index.get(item.id);
      if (at === undefined) {
        s.index.set(item.id, s.items.length);
        s.items.push(item);
      } else s.items[at] = item;
    }
  }

  async function catchUp(s: State) {
    if (s.path === null) {
      const head = deps.head(s.id);
      if (!head) return;
      const fresh = await read(s.id);
      Object.assign(s, fresh);
      const o = overlayDiff(s, fresh.items);
      emit(s, [...shown(s, fresh.items), ...o.items], o.removed, o.controls);
      return;
    }
    let read_: ReturnType<typeof follow>;
    try {
      read_ = follow(s.path, s.offset);
    } catch {
      return removed(s.id, null);
    }
    s.offset = read_.offset;
    const { appended, forked } = extend(s.chain, read_.entries);
    if (forked) return reread(s);
    if (appended.length === 0) return;
    const { items, tail } = project(appended, s.ctx, s.tail);
    s.tail = tail;
    upsertTranscript(s, items);
    const o = overlayDiff(s, items);
    emit(s, [...shown(s, items), ...o.items], o.removed, o.controls);
  }

  /** A fork: the whole transcript again, published as what changed against what was shown. */
  async function reread(s: State) {
    const old = new Map(s.items.map((item) => [item.id, JSON.stringify(item)]));
    const fresh = await read(s.id);
    Object.assign(s, fresh);
    const changed = fresh.items.filter((item) => old.get(item.id) !== JSON.stringify(item));
    const gone = [...old.keys()].filter((id) => !s.index.has(id)) as ItemId[];
    const o = overlayDiff(s, changed);
    emit(s, [...shown(s, changed), ...o.items], [...gone, ...o.removed], o.controls);
  }

  function serial(s: State, op: () => Promise<void> | void) {
    s.queue = s.queue.then(op).catch((e) => deps.log(`sessions: thread ${s.id}: ${e}`));
    return s.queue;
  }

  function snapshot(s: State): ServerMessage[] {
    const page = pageOf(merged(s), null)!;
    return [
      {
        type: "session",
        sessionId: s.id,
        epoch: s.epoch,
        rev: s.rev,
        items: page.items,
        before: page.before === null ? null : (page.before as string as Cursor),
        controls: deps.controls(s.id),
        live: s.live,
      },
    ];
  }

  function replay(s: State, after: ThreadPosition): ServerMessage[] | null {
    if (after.epoch !== s.epoch || after.rev > s.rev) return null;
    const first = s.ring[0]?.rev ?? s.rev + 1;
    if (after.rev < first - 1) return null;
    const items = new Map<ItemId, SessionItem>();
    const removed = new Set<ItemId>();
    for (const f of s.ring) {
      if (f.rev <= after.rev) continue;
      for (const item of f.items) {
        items.set(item.id, item);
        removed.delete(item.id);
      }
      for (const id of f.removed) {
        items.delete(id);
        removed.add(id);
      }
    }
    const out: ServerMessage[] = [{ type: "session_items", sessionId: s.id, rev: s.rev, items: [...items.values()], removed: [...removed], controls: deps.controls(s.id) }];
    if (s.live) out.push({ type: "session_delta", sessionId: s.id, itemId: s.live.itemId, offset: 0, text: s.live.text });
    return out;
  }

  function trim() {
    const idle = [...states.values()].filter((s) => !deps.watched(s.id)).sort((a, b) => b.usedAt - a.usedAt);
    for (const s of idle.slice(deps.keep ?? KEEP)) states.delete(s.id);
  }

  function removed(id: SessionId, movedTo: SessionId | null) {
    if (!states.has(id)) return;
    states.delete(id);
    deps.publish(id, { type: "session_removed", sessionId: id, movedTo });
  }

  return {
    async watch(id, after) {
      const s = await load(id);
      s.usedAt = Date.now();
      await s.queue;
      return (after && replay(s, after)) ?? snapshot(s);
    },

    async page(id, before) {
      const s = await load(id);
      await s.queue;
      const page = pageOf(merged(s), before as string as ItemId);
      if (!page) return [{ type: "error", message: "That part of the thread changed. Reopen the session to load it again." }];
      return [{ type: "session_page", sessionId: id, items: page.items, before: page.before === null ? null : (page.before as string as Cursor) }];
    },

    tool(id, toolUseId) {
      const head = deps.head(id);
      const output = head ? toolOutput(head.file, toolUseId) : null;
      if (output === null) return [{ type: "error", message: "That tool call's output is not in the transcript." }];
      return [{ type: "session_tool_output", sessionId: id, toolUseId, output }];
    },

    refresh(id) {
      const s = states.get(id);
      if (!s) return;
      void serial(s, () => {
        const o = overlayDiff(s, []);
        emit(s, o.items, o.removed, o.controls);
      });
    },

    appended(path) {
      const id = path.split("/").pop()?.replace(/\.jsonl$/, "") as SessionId | undefined;
      const s = id === undefined ? undefined : states.get(id);
      if (s && (s.path === null || s.path === path)) void serial(s, () => catchUp(s));
    },

    async poll() {
      const due = [...states.values()].filter((s) => {
        if (s.path === null) return deps.head(s.id) !== null;
        const f = statOf(s.path);
        return f === null || f.size > s.offset;
      });
      await Promise.all(due.map((s) => serial(s, () => catchUp(s))));
    },

    removed,

    live(id, live) {
      const s = states.get(id);
      if (s) s.live = live;
    },

    release(id) {
      const s = states.get(id);
      if (s) s.usedAt = Date.now();
      trim();
    },

    open: (id) => states.has(id),

    stop() {
      states.clear();
    },
  };
}
