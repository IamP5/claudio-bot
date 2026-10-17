import { expect, test } from "bun:test";
import { botName } from "../src/tools";

test.each([
  ["Digest", true],
  ["  Daily Digest  ", true],
  ["\u{1F469}\u200D\u{1F4BB} Engineer", true],
  ["x".repeat(40), true],
  ["x".repeat(41), false],
  ["   ", false],
  ["Line\nbreak", false],
  ["evil\u202Eesrever", false],
  ["left\u200Emark", false],
])("bot name %p is accepted: %p", (name, ok) => {
  expect(botName.safeParse(name).success).toBe(ok);
});
