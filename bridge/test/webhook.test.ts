import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BotId, RoutineId } from "../src/protocol";
import type { Envelope } from "../src/prompts";
import { createScheduler } from "../src/scheduler";
import { createWebhooks, HOOK_COOLDOWN_MS, PAYLOAD_MAX_BYTES, type Webhooks } from "../src/webhook";
import { emptyWorld, newBot, type EnvelopeId, type Pending, type RoutineRecord } from "../src/world";

const BOT = "b_eng" as BotId;
const PORT = 7879;
type RoutineEnvelope = Extract<Envelope, { from: "routine" }>;

function harness(port: number | null = PORT, opts: { enabled?: boolean } = {}) {
  let now = new Date("2026-10-19T08:00:00Z");
  const events: string[] = [];
  const delivered: RoutineEnvelope[] = [];
  const world = emptyWorld();
  const bot = newBot({ id: BOT, name: "Eng", avatar: { shape: "circle", color: "white" }, at: now.toISOString() });
  world.bots.set(bot.id, bot);
  const scheduler = createScheduler({
    world,
    deliver: (b, e) => {
      if (e.from !== "routine") throw new Error(`unexpected ${e.from}`);
      events.push("deliver");
      delivered.push(e);
      (b.session.pending as unknown as Pending[]).push({ id: e.run.runId as string as EnvelopeId, kind: "envelope", at: now.toISOString(), text: "", initiator: { kind: "routine", run: e.run, manual: e.manual }, settles: e.run, attempts: 0 });
    },
    note: () => {},
    changed: (_b, urgency) => {
      events.push(urgency === "now" ? "persist now" : "persist");
    },
    log: () => {},
    parked: () => false,
    now: () => now,
  });
  scheduler.upsertHook(BOT, { name: "deploys", prompt: "Summarize the deploy.", enabled: opts.enabled });
  const routine = bot.routines.find((r) => r.name === "deploys") as RoutineRecord;
  const webhooks = createWebhooks({ world, scheduler, persist: () => {}, port, now: () => now, log: () => {} });
  return {
    webhooks,
    scheduler,
    bot,
    routine,
    delivered,
    events,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    /** The turn ends: the envelope leaves the queue and the run settles. */
    finish() {
      const ref = delivered.at(-1)!.run;
      const pending = bot.session.pending as unknown as Pending[];
      pending.splice(pending.findIndex((p) => p.settles?.runId === ref.runId), 1);
      scheduler.settle(BOT, ref, { status: "ok", note: null });
    },
  };
}

function mint(webhooks: Webhooks, routineId: RoutineId) {
  const made = webhooks.token(BOT, routineId);
  if ("error" in made) throw new Error(made.error);
  return made;
}

type Call = { method?: string; path?: string; host?: string; origin?: string; auth?: string | null; body?: string };

function request(token: string, routineId: RoutineId, c: Call = {}): Request {
  const headers = new Headers({ host: c.host ?? `127.0.0.1:${PORT}` });
  if (c.origin !== undefined) headers.set("origin", c.origin);
  const auth = c.auth === undefined ? `Bearer ${token}` : c.auth;
  if (auth !== null) headers.set("authorization", auth);
  const method = c.method ?? "POST";
  return new Request(`http://127.0.0.1:${PORT}${c.path ?? `/hook/${routineId}`}`, { method, headers, body: method === "GET" ? undefined : (c.body ?? '{"ok":true}') });
}

const rows: { name: string; call?: Call; before?: (h: ReturnType<typeof harness>, token: string) => Promise<void> | void; enabled?: boolean; status: number; fires: boolean }[] = [
  { name: "a POST with the right token", status: 202, fires: true },
  { name: "Host localhost:<port>", call: { host: `localhost:${PORT}` }, status: 202, fires: true },
  { name: "GET", call: { method: "GET" }, status: 405, fires: false },
  { name: "another path", call: { path: "/hooks" }, status: 404, fires: false },
  { name: "the root path", call: { path: "/" }, status: 404, fires: false },
  { name: "an Origin header, even a local one", call: { origin: `http://127.0.0.1:${PORT}` }, status: 403, fires: false },
  { name: "a foreign Host (DNS rebinding)", call: { host: `evil.example:${PORT}` }, status: 403, fires: false },
  { name: "a loopback Host on another port", call: { host: "127.0.0.1:80" }, status: 403, fires: false },
  { name: "no Authorization", call: { auth: null }, status: 401, fires: false },
  { name: "a wrong token", call: { auth: "Bearer whk_wrong" }, status: 401, fires: false },
  { name: "the token without Bearer", call: { auth: "{token}" }, status: 401, fires: false },
  { name: "an unknown routine", call: { path: "/hook/r_unknown" }, status: 401, fires: false },
  { name: `a body of exactly ${PAYLOAD_MAX_BYTES} bytes`, call: { body: "x".repeat(PAYLOAD_MAX_BYTES) }, status: 202, fires: true },
  { name: "a body one byte over", call: { body: "x".repeat(PAYLOAD_MAX_BYTES + 1) }, status: 413, fires: false },
  { name: "a paused routine", enabled: false, status: 409, fires: false },
  {
    name: "a second call inside the cooldown, after the first run ended",
    before: async (h, token) => {
      expect((await h.webhooks.handle(request(token, h.routine.id))).status).toBe(202);
      h.finish();
      h.advance(HOOK_COOLDOWN_MS - 1000);
    },
    status: 429,
    fires: false,
  },
  {
    name: "a call once the cooldown has passed",
    before: async (h, token) => {
      expect((await h.webhooks.handle(request(token, h.routine.id))).status).toBe(202);
      h.finish();
      h.advance(HOOK_COOLDOWN_MS);
    },
    status: 202,
    fires: true,
  },
  {
    name: "a call past the cooldown while the previous run is still going",
    before: async (h, token) => {
      expect((await h.webhooks.handle(request(token, h.routine.id))).status).toBe(202);
      h.advance(HOOK_COOLDOWN_MS);
    },
    status: 409,
    fires: false,
  },
];

for (const row of rows) {
  test(`handle: ${row.name} gives ${row.status}`, async () => {
    const h = harness(PORT, { enabled: row.enabled });
    const { token } = mint(h.webhooks, h.routine.id);
    await row.before?.(h, token);
    const already = h.delivered.length;
    const call = row.call?.auth === "{token}" ? { ...row.call, auth: token } : row.call;
    const res = await h.webhooks.handle(request(token, h.routine.id, call));
    expect(res.status).toBe(row.status);
    expect(h.delivered.length - already).toBe(row.fires ? 1 : 0);
  });
}

test("the payload reaches the routine as text, persisted before delivery, and the response never carries bot output", async () => {
  const h = harness();
  const { token } = mint(h.webhooks, h.routine.id);
  h.events.length = 0;
  const body = JSON.stringify({ service: "api", sha: "9f2c1e" });
  const res = await h.webhooks.handle(request(token, h.routine.id, { body }));
  expect(res.status).toBe(202);
  expect(await res.text()).toBe("Fired.\n");
  expect(h.events).toEqual(["persist now", "deliver"]);
  expect(h.delivered[0]).toMatchObject({ from: "routine", name: "deploys", manual: false, payload: body });
  expect(h.routine.runs[0]).toMatchObject({ status: "running", manual: false });
});

test("a refused call says why", async () => {
  const h = harness(PORT, { enabled: false });
  const { token } = mint(h.webhooks, h.routine.id);
  expect(await (await h.webhooks.handle(request(token, h.routine.id))).text()).toBe("Not fired: The routine is paused.\n");
});

test("two concurrent calls fire once", async () => {
  const h = harness();
  const { token } = mint(h.webhooks, h.routine.id);
  const statuses = await Promise.all([1, 2, 3].map((i) => h.webhooks.handle(request(token, h.routine.id, { body: `{"n":${i}}` })).then((r) => r.status)));
  expect(statuses.sort()).toEqual([202, 429, 429]);
  expect(h.delivered).toHaveLength(1);
  expect(h.routine.runs).toHaveLength(1);
});

test("a token is whk_ plus 32 random bytes, only its sha256 is stored, and rotating it invalidates the old one", async () => {
  const h = harness();
  const first = mint(h.webhooks, h.routine.id);
  expect(first.url).toBe(`http://127.0.0.1:${PORT}/hook/${h.routine.id}`);
  expect(first.token).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
  expect(h.routine.trigger).toEqual({ kind: "webhook", tokenHash: createHash("sha256").update(first.token).digest("hex") });
  expect(JSON.stringify(h.routine)).not.toContain(first.token.slice(4));

  const second = mint(h.webhooks, h.routine.id);
  expect(second.token).not.toBe(first.token);
  expect((await h.webhooks.handle(request(first.token, h.routine.id))).status).toBe(401);
  expect((await h.webhooks.handle(request(second.token, h.routine.id))).status).toBe(202);
});

test("a token is refused without a listener port or for a cron routine", () => {
  expect(harness(null).webhooks.token(BOT, "r_any" as RoutineId)).toEqual({ error: "Webhooks are off on this bridge." });
  const h = harness();
  h.scheduler.upsert(BOT, { name: "digest", schedule: "0 9 * * *", prompt: "p" });
  const digest = h.bot.routines.find((r) => r.name === "digest")!;
  expect(h.webhooks.token(BOT, digest.id)).toEqual({ error: "This routine runs on a schedule, not a webhook." });
  expect(digest.trigger).toEqual({ kind: "cron", schedule: "0 9 * * *" });
});

let started: Webhooks | null = null;
afterEach(() => {
  started?.stop();
  started = null;
});

test("the listener binds 127.0.0.1 only and fires on a real loopback POST", async () => {
  const h = harness(0);
  const realServe = Bun.serve;
  let server: ReturnType<typeof Bun.serve> | null = null;
  (Bun as { serve: typeof Bun.serve }).serve = ((options: Parameters<typeof Bun.serve>[0]) => (server = realServe(options))) as typeof Bun.serve;
  try {
    h.webhooks.start();
    started = h.webhooks;
  } finally {
    (Bun as { serve: typeof Bun.serve }).serve = realServe;
  }
  expect(server).not.toBeNull();
  expect(server!.hostname).toBe("127.0.0.1");

  const { url, token } = mint(h.webhooks, h.routine.id);
  expect(url).toBe(`http://127.0.0.1:${server!.port}/hook/${h.routine.id}`);

  const browser = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" }, body: "{}" });
  expect(browser.status).toBe(403);
  const huge = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "x".repeat(PAYLOAD_MAX_BYTES + 1) });
  expect(huge.status).toBe(413);
  const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"sha":"9f2c1e"}' });
  expect(ok.status).toBe(202);
  expect(h.delivered.map((e) => e.payload)).toEqual(['{"sha":"9f2c1e"}']);
});
