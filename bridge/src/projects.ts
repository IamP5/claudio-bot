import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

async function describe({ path, name }: { path: string; name: string }): Promise<Project> {
  const [branch, origin] = await Promise.all([
    // symbolic-ref names the branch even before the first commit, and fails when HEAD is detached.
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(path, ["remote", "get-url", "origin"]),
  ]);
  return {
    id: projectId(path),
    name,
    path,
    branch: branch || null,
    githubRepo: origin ? parseGithubRepo(origin) : null,
  };
}

export async function scanProjects(roots = projectRoots()): Promise<Project[]> {
  const dirs: { path: string; name: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    // existsSync follows symlinks, so a symlinked project folder counts too. The path is the realpath, the name stays the folder name.
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (existsSync(join(path, ".git"))) dirs.push({ path: realpathSync(path), name });
    }
  }
  const projects = await Promise.all(dirs.map(describe));
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
