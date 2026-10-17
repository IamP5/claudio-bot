import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Project, ProjectId } from "./protocol";

export function projectRoots(env = process.env): string[] {
  if (env.CLAUDEBOT_ROOTS) return env.CLAUDEBOT_ROOTS.split(":").filter((r) => r !== "");
  return ["Dev/projects", "code", "Developer", "Projects"].map((r) => join(homedir(), r));
}

export const projectId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 16) as ProjectId;

export function parseGithubRepo(url: string): string | null {
  const m = url.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

async function describe(path: string): Promise<Project> {
  const [branch, origin] = await Promise.all([
    git(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(path, ["remote", "get-url", "origin"]),
  ]);
  return {
    id: projectId(path),
    name: basename(path),
    path,
    // A repo with no commits reports "HEAD" or fails; neither is a branch name.
    branch: branch && branch !== "HEAD" ? branch : null,
    githubRepo: origin ? parseGithubRepo(origin) : null,
  };
}

export async function scanProjects(roots = projectRoots()): Promise<Project[]> {
  const dirs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && existsSync(join(path, ".git")) && statSync(path).isDirectory()) dirs.push(path);
    }
  }
  const projects = await Promise.all(dirs.map(describe));
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
