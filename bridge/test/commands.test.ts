import { expect, test } from "bun:test";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { commandOf, createCommands, menuOf } from "../src/commands";
import type { BotId, Command, Skill } from "../src/protocol";

const row = (name: string, description = `About ${name}`, over: Partial<SlashCommand> = {}): SlashCommand => ({ name, description, argumentHint: "", ...over });

test("the menu shows every skill and only the built-ins on the allow list, with the location suffix cut", () => {
  const menu = menuOf([
    row("pineapple", "Answer with a secret code word. (project)", { argumentHint: "[fruit]" }),
    row("tdd", "Test-first development. (user)"),
    row("vercel:deploy", "Deploy the current project to Vercel."),
    row("docx", "Word documents. (claude.ai sync)"),
    row("clear", "Start a new session", { builtin: true, aliases: ["reset", "new"] }),
    row("model", "Set the AI model", { builtin: true }),
    row("next-new-builtin", "Something Claude Code adds later", { builtin: true }),
    row("compact", "Free up context", { builtin: true, argumentHint: "<instructions>" }),
    row("code-review", "Review the current diff", { builtin: true, aliases: ["review"] }),
  ]);

  expect(menu).toEqual([
    { name: "pineapple", description: "Answer with a secret code word.", argumentHint: "[fruit]", source: "skill" },
    { name: "tdd", description: "Test-first development.", argumentHint: "", source: "skill" },
    { name: "vercel:deploy", description: "Deploy the current project to Vercel.", argumentHint: "", source: "skill" },
    { name: "docx", description: "Word documents.", argumentHint: "", source: "skill" },
    { name: "compact", description: "Free up context", argumentHint: "<instructions>", source: "builtin" },
    { name: "code-review", description: "Review the current diff", argumentHint: "", source: "builtin" },
  ]);
});

test("a skill sharing a hidden built-in's name is hidden, since /name runs the built-in; a repeat shows once", () => {
  const menu = menuOf([row("clear", "My own clear (user)"), row("clear", "Start a new session", { builtin: true }), row("tdd"), row("tdd", "Again")]);
  expect(menu.map((c) => c.name)).toEqual(["tdd"]);
});

test("a description keeps its first line, its own parentheses, and at most 200 characters", () => {
  const [one, long] = menuOf([row("one", "(remotion) Export a video\nMore detail."), row("long", "x".repeat(300))]);
  expect(one!.description).toBe("(remotion) Export a video");
  expect([long!.description.length, long!.description.endsWith("…")]).toEqual([200, true]);
});

test("a name with a space cannot be typed as one word, so it is left out", () => {
  expect(menuOf([row("pstack:Poteto Mode"), row("pstack:poteto-mode")]).map((c) => c.name)).toEqual(["pstack:poteto-mode"]);
});

test("only /name or /name args with a name on the menu is a command", () => {
  const menu = menuOf([row("greet"), row("clear", "", { builtin: true })]);
  expect(commandOf("/greet", menu)).toBe("greet");
  expect(commandOf("  /greet Ana and Bo ", menu)).toBe("greet");
  expect(commandOf("/greet\nsecond line", menu)).toBe("greet");
  expect(commandOf("/clear", menu)).toBeNull();
  expect(commandOf("/greeting", menu)).toBeNull();
  expect(commandOf("please /greet", menu)).toBeNull();
  expect(commandOf("/ greet", menu)).toBeNull();
  expect(commandOf("//greet", menu)).toBeNull();
});

test("a skill saved while the bot's query is open shows in the menu at once, after a hidden built-in's name is refused", async () => {
  const bot = "b_1" as BotId;
  const saved: Skill[] = [];
  const menus: Command[][] = [];
  const open = { supportedCommands: async () => [row("tdd"), row("clear", "Start a new session", { builtin: true })] };
  const commands = createCommands({
    live: () => open,
    probe: async () => [],
    saved: () => saved,
    changed: (_id, menu) => menus.push(menu),
    log: () => {},
  });
  expect((await commands.list(bot)).map((c) => c.name)).toEqual(["tdd"]);

  saved.push({ name: "pineapple", description: "Answer with a code word.", updatedAt: "" }, { name: "clear", description: "Mine", updatedAt: "" }, { name: "tdd", description: "Again", updatedAt: "" });
  commands.refresh(bot);
  await Bun.sleep(0);

  expect(menus.at(-1)).toEqual([
    { name: "tdd", description: "About tdd", argumentHint: "", source: "skill" },
    { name: "pineapple", description: "Answer with a code word.", argumentHint: "", source: "skill" },
  ]);
  expect(commandOf("/pineapple banana", await commands.list(bot))).toBe("pineapple");
});
