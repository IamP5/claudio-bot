import { isAbsolute, relative } from "node:path";

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function displayPath(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel.startsWith("..") ? path : rel;
}

function firstString(input: Input): string {
  for (const v of Object.values(input)) if (typeof v === "string" && v !== "") return v;
  return "";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const summaries: Record<string, (input: Input, cwd: string) => string> = {
  Bash: (i) => str(i.command),
  Read: (i, cwd) => displayPath(cwd, str(i.file_path)),
  Edit: (i, cwd) => displayPath(cwd, str(i.file_path)),
  Write: (i, cwd) => displayPath(cwd, str(i.file_path)),
  Grep: (i) => str(i.pattern),
  Glob: (i) => str(i.pattern),
  WebFetch: (i) => str(i.url),
};

export function toolSummary(name: string, input: Input, cwd: string): string {
  const summarize = summaries[name] ?? firstString;
  return oneLine(summarize(input, cwd));
}

const prefixLines = (text: string, prefix: string) =>
  text.split("\n").map((line) => prefix + line).join("\n");

const details: Record<string, (input: Input) => string> = {
  Bash: (i) => str(i.command),
  Edit: (i) => `${prefixLines(str(i.old_string), "- ")}\n${prefixLines(str(i.new_string), "+ ")}`,
  Write: (i) => str(i.content).split("\n").slice(0, 40).join("\n"),
};

export function approvalDetail(name: string, input: Input): string {
  const detail = details[name];
  return detail ? detail(input) : JSON.stringify(input, null, 2);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
