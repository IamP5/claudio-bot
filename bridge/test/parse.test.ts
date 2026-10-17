import { expect, test } from "bun:test";
import fixtures from "../../fixtures/protocol.json";
import { parseClientMessage } from "../src/parse";

// Every field of every client fixture (scripts/fixtures.ts pins one per message type), broken one at a time.
type Raw = Record<string, unknown>;
const client = fixtures.client as Raw[];

/** Fields a message may leave out. Every other field is required. */
const OPTIONAL: Record<string, string[]> = { send: ["uploads", "clientId"] };

/** A value of the wrong type for whatever the field holds. */
const wrongFor = (value: unknown) => (typeof value === "number" ? "5" : 42);

const fields = client.flatMap((m) =>
  Object.keys(m)
    .filter((k) => k !== "type")
    .map((k) => [`${m.type}.${k}`, m, k] as const),
);

test.each(fields)("%s of the wrong type is rejected, and the error names it", (_, m, key) => {
  const parsed = parseClientMessage(JSON.stringify({ ...m, [key]: wrongFor(m[key]) }));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error).toContain(key);
});

test.each(fields.filter(([, m, k]) => !OPTIONAL[m.type as string]?.includes(k)))("%s missing is rejected, and the error names it", (_, m, key) => {
  const { [key]: _dropped, ...rest } = m;
  const parsed = parseClientMessage(JSON.stringify(rest));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error).toContain(key);
});

test.each(fields.filter(([, m, k]) => OPTIONAL[m.type as string]?.includes(k)))("%s may be left out", (_, m, key) => {
  const { [key]: _dropped, ...rest } = m;
  expect(parseClientMessage(JSON.stringify(rest)).ok).toBe(true);
});

const patchFields = client
  .filter((m) => m.type === "update_bot")
  .flatMap((m) => Object.keys(m.patch as Raw).map((k) => [k, m] as const));

test.each(patchFields)("update_bot patch.%s of the wrong type is rejected, and the error names it", (key, m) => {
  const patch = m.patch as Raw;
  const parsed = parseClientMessage(JSON.stringify({ ...m, patch: { ...patch, [key]: wrongFor(patch[key]) } }));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error).toContain(key);
});

test("an empty patch is a valid no-op, and a title of null clears it", () => {
  expect(parseClientMessage(JSON.stringify({ type: "update_bot", botId: "b1", patch: {} }))).toEqual({ ok: true, message: { type: "update_bot", botId: "b1", patch: {} } } as never);
  expect(parseClientMessage(JSON.stringify({ type: "update_bot", botId: "b1", patch: { title: null } }))).toEqual({ ok: true, message: { type: "update_bot", botId: "b1", patch: { title: null } } } as never);
});

test.each(client.map((m) => [m.type, m] as const))("fields the bridge does not know are dropped from %s", (_, m) => {
  const parsed = parseClientMessage(JSON.stringify({ ...m, extra: "ignored" }));
  expect(parsed).toEqual({ ok: true, message: m } as never);
});

test.each([
  ["an array", "[]"],
  ["null", "null"],
  ["a string", '"open"'],
  ["a type that is not a string", '{"type":7}'],
  ["no type", '{"botId":"b1"}'],
])("a message that is %s is rejected", (_, raw) => {
  expect(parseClientMessage(raw).ok).toBe(false);
});
