import { expect, test } from "bun:test";
import { botName } from "../src/tools";

test.each([
  ["Digest", true],
  ["  Daily Digest  ", true],
  ["👩‍💻 Engineer", true],
  ["x".repeat(40), true],
  ["x".repeat(41), false],
  ["   ", false],
  ["Line\nbreak", false],
  ["evil‮esrever", false],
])("bot name %p is accepted: %p", (name, ok) => {
  expect(botName.safeParse(name).success).toBe(ok);
});
