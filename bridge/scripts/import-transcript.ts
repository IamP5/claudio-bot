import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { maskSecrets } from "../src/text";

// Imports a Claude Code transcript of a scenario run as a test fixture: bun scripts/import-transcript.ts <src.jsonl> <name> <session-id>
// Writes test/transcripts/jsonl/<name>.jsonl scrubbed like record-transcript.ts scrubs a kept transcript, and also of
// this machine's environment: hook commands, titles, run folders, temp folders, the home folder and emails. Session
// ids become <session-id>. It refuses to write a fixture that still names a local path.

const OUT = join(import.meta.dir, "..", "test", "transcripts", "jsonl");
/** Transcript lines that hold whole API requests or file backups: large, and nothing a thread shows. */
const DROPPED_LINES: ReadonlySet<string> = new Set(["api-request", "api-request-blob", "api-request-shape", "file-history-snapshot", "file-history-delta"]);
const CHAIN_FIELDS = ["type", "subtype", "uuid", "parentUuid", "logicalParentUuid", "isSidechain", "timestamp", "sessionId"];
const ID_KEY = /(^|_)(id|uuid|uuids|ID)$|Id$|ID$/;
const LEAKS = ["/Users/", "/private/", "claudiobot-verify/runs", "SUPERSET", homedir(), userInfo().username];

const [src, name, session] = process.argv.slice(2);
if (!src || !name || !session) {
  console.error("usage: bun scripts/import-transcript.ts <src.jsonl> <name> <session-id>");
  process.exit(1);
}

const lines = readFileSync(src, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const ids = new Set(lines.flatMap((o) => (typeof o.sessionId === "string" ? [o.sessionId] : [])));
const cwds = new Set(lines.flatMap((o) => (typeof o.cwd === "string" ? [o.cwd, o.cwd.replace(/^\/private\//, "/")] : [])));
const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
const home = homedir();
const paths = [...[...cwds].flatMap((c) => [[c, "<cwd>"], [slug(c), "<cwd-slug>"]]), [home, "<home>"], [slug(home), "<home-slug>"]].sort((a, b) => b[0]!.length - a[0]!.length) as [string, string][];

function text(s: string, key: string): string {
  let out = s;
  for (const id of ids) out = out.replaceAll(id, session!);
  for (const [from, to] of paths) out = out.replaceAll(from, to);
  out = out.replace(/(?:\/private)?\/tmp\/claude-\d+\/[^/\s"]+/g, "<tmp>");
  out = out.replace(/(?:\/private)?\/var\/folders\/[^\s"]*?\/T\//g, "<tmpdir>/");
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>");
  return ID_KEY.test(key) ? out : maskSecrets(out);
}

function walk(v: unknown, key: string): unknown {
  if (key === "signature" && typeof v === "string") return "<signature>";
  if (typeof v === "string") return text(v, key);
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
}

function slim(o: Record<string, unknown>): Record<string, unknown> {
  // An attachment stays a link in the chain; what it attached (skill lists, environment) is not test material.
  if (o.type === "attachment") {
    const { rendered: _, ...rest } = o;
    return { ...rest, attachment: { type: (o.attachment as { type?: unknown } | null)?.type } };
  }
  if (o.type === "system" && o.subtype === "stop_hook_summary") return Object.fromEntries(CHAIN_FIELDS.flatMap((k) => (k in o ? [[k, o[k]]] : [])));
  if (o.type === "ai-title") return { ...o, aiTitle: "Scenario transcript" };
  if (o.type === "custom-title") return { ...o, customTitle: "Scenario transcript" };
  return o;
}

const out = lines.filter((o) => !DROPPED_LINES.has(String(o.type))).map((o) => JSON.stringify(walk(slim(o), "")));
const body = `${out.join("\n")}\n`;
const leaks = LEAKS.filter((s) => body.includes(s));
if (leaks.length > 0) {
  console.error(`${name}: not written, it still contains ${leaks.join(", ")}`);
  process.exit(1);
}
writeFileSync(join(OUT, `${name}.jsonl`), body);
console.log(`${name}: ${out.length} of ${lines.length} lines, ${Buffer.byteLength(body)} bytes`);
