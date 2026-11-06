import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const files = [...new Bun.Glob("**/*.ts").scanSync(SRC)].map((f) => join(SRC, f));

/** Every module a file imports or re-exports at runtime, by path under src without the extension. Type-only imports are left out. */
function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const statement = /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of source.matchAll(statement)) {
    const [, typeOnly, clause, from, bare, dynamic] = m;
    const spec = from ?? bare ?? dynamic!;
    if (!spec.startsWith(".")) continue;
    const braces = clause?.match(/^\{([\s\S]*)\}$/);
    const allTypes = braces !== null && braces !== undefined && braces[1]!.split(",").every((s) => s.trim() === "" || s.trim().startsWith("type "));
    if (typeOnly || allTypes) continue;
    found.push(relative(SRC, resolve(dirname(file), spec)).replace(/\.ts$/, ""));
  }
  return found;
}

const importersOf = (target: string) => files.filter((f) => valueImports(f).includes(target)).map((f) => relative(SRC, f));

test("only modules under machine/ import agents.ts, so everything else reaches agents through a machine", () => {
  const importers = importersOf("agents");
  expect(importers).toContain("machine/runtime.ts");
  expect(importers.filter((f) => !f.startsWith("machine/"))).toEqual([]);
});

test("the hub imports nothing from agents.ts at runtime", () => {
  expect(valueImports(join(SRC, "hub.ts")).filter((m) => m === "agents")).toEqual([]);
});
