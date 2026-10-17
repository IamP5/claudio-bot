import { claudeExecutable } from "./session";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

export type CloudCreated = { title: string; url: string; sessionId: string };

export function parseCloudCreated(stdout: string): CloudCreated | null {
  const text = stripAnsi(stdout);
  const title = text.match(/Created cloud session:[ \t]*(.+)/)?.[1]?.trim();
  const view = text.match(/View:[ \t]*(https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+))/);
  if (!view?.[1] || !view[2]) return null;
  return { title: title ?? "", url: view[1], sessionId: view[2] };
}

// Observed shape is {"ok":true,"session_id","url"}. It is undocumented, so anything not reporting failure counts.
export function followUpAccepted(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stripAnsi(stdout).trim());
    return !(parsed && typeof parsed === "object" && (parsed.ok === false || parsed.is_error === true));
  } catch {
    return false;
  }
}

const RUN_TIMEOUT_MS = 90_000;

async function run(cwd: string, argv: string[]) {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const detail = (out: { stdout: string; stderr: string }) => stripAnsi(out.stderr || out.stdout).trim().slice(-2000);

function executable(): string {
  const claude = claudeExecutable();
  if (!claude) throw new Error("claude was not found on PATH. Set CLAUDIOBOT_CLAUDE.");
  return claude;
}

export async function createCloudSession(cwd: string, prompt: string): Promise<CloudCreated> {
  // claude --cloud refuses to run without a terminal, so give it one through script(1).
  const out = await run(cwd, ["script", "-q", "/dev/null", executable(), "--cloud", prompt]);
  const created = parseCloudCreated(out.stdout);
  if (!created) throw new Error(`Could not create the cloud session. ${detail(out)}`.trim());
  return created;
}

export async function followUpCloudSession(cwd: string, sessionId: string, text: string): Promise<void> {
  const out = await run(cwd, [executable(), "-p", text, "--cloud", sessionId, "--output-format", "json"]);
  if (out.code !== 0 || !followUpAccepted(out.stdout)) throw new Error(`Could not send the follow-up. ${detail(out)}`.trim());
}
