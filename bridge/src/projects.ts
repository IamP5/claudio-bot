import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectId } from "./protocol";

export type Project = { name: string; path: string; branch: string | null; githubRepo: string | null };

export function projectRoots(env = process.env): string[] {
  if (env.CLAUDIOBOT_ROOTS) return env.CLAUDIOBOT_ROOTS.split(":").filter((r) => r !== "");
  return ["Dev/projects", "code", "Developer", "Projects"].map((r) => join(homedir(), r));
}

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
    name,
    path,
    branch: branch || null,
    githubRepo: origin ? parseGithubRepo(origin) : null,
  };
}

/** The git folders directly under the roots, by realpath, without running git. */
export function projectFolders(roots = projectRoots()): { path: string; name: string }[] {
  const dirs: { path: string; name: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    // existsSync follows symlinks, so a symlinked project folder counts too. The path is the realpath, the name stays the folder name.
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (existsSync(join(path, ".git"))) dirs.push({ path: realpathSync(path), name });
    }
  }
  return dirs;
}

export async function scanProjects(roots = projectRoots()): Promise<Project[]> {
  const projects = await Promise.all(projectFolders(roots).map(describe));
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Matches by exact path, then folder name, then GitHub repo ("owner/name" or the name alone), case-insensitive. */
export function findProject(projects: Project[], ref: string): Project | undefined {
  const path = ref.trim();
  const key = path.toLowerCase();
  const repo = (p: Project) => p.githubRepo?.toLowerCase();
  return (
    projects.find((p) => p.path === path) ??
    projects.find((p) => p.name.toLowerCase() === key) ??
    projects.find((p) => repo(p) === key || repo(p)?.split("/")[1] === key)
  );
}

/** A cwd's project: the git repository's main checkout, which every worktree of it joins. */
export type ProjectOf = { id: ProjectId; root: string; name: string; githubRepo: string | null; worktree: boolean };

const projectIdOf = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 16) as ProjectId;

function nearestExisting(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function originOf(common: string): string | null {
  let config: string;
  try {
    config = readFileSync(join(common, "config"), "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
    const url = inOrigin && line.match(/^\s*url\s*=\s*(.+?)\s*$/i);
    if (url) return url[1]!;
  }
  return null;
}

/** Reads `.git` files the way git does, without running git: a cwd in a linked worktree resolves to the main checkout. */
function resolveProject(cwd: string): ProjectOf {
  const start = realpathSync(nearestExisting(cwd));
  for (let dir = start; ; dir = dirname(dir)) {
    const dot = join(dir, ".git");
    if (existsSync(dot)) {
      let common = dot;
      let worktree = false;
      if (!statSync(dot).isDirectory()) {
        const m = readFileSync(dot, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
        if (!m) break;
        const gitDir = resolve(dir, m[1]!);
        const commonFile = join(gitDir, "commondir");
        common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
        worktree = true;
      }
      if (!existsSync(common)) break;
      common = realpathSync(common);
      const bare = basename(common) !== ".git";
      const root = bare ? common : dirname(common);
      const origin = originOf(common);
      const githubRepo = origin ? parseGithubRepo(origin) : null;
      const name = githubRepo?.split("/")[1] ?? (bare ? basename(root).replace(/\.git$/, "") : basename(root));
      // A removed worktree under the repo's .claude/worktrees finds only the repo's own .git on the way up.
      const gone = !existsSync(cwd) && cwd.startsWith(join(root, ".claude", "worktrees") + "/");
      return { id: projectIdOf(root), root, name, githubRepo, worktree: worktree || gone };
    }
    if (dirname(dir) === dir) break;
  }
  const root = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return { id: projectIdOf(root), root, name: basename(root), githubRepo: null, worktree: false };
}

function readSaved(file: string | null): Record<string, ProjectOf> {
  if (file === null) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, ProjectOf>) : {};
  } catch {
    return {};
  }
}

/**
 * Remembers each cwd's project in `file` so a cwd that is gone (a removed worktree outside its repo) still maps to
 * its project in a later process. For a missing cwd the saved entry wins over the ancestor walk.
 */
export function createProjects(opts: { file: string | null }): { of(cwd: string): ProjectOf; save(): void } {
  const saved = readSaved(opts.file);
  const memo = new Map<string, ProjectOf>();
  let dirty = false;
  return {
    of(cwd) {
      const key = resolve(cwd);
      const hit = memo.get(key);
      if (hit) return hit;
      const old = saved[key];
      const project = old && !existsSync(key) ? old : resolveProject(key);
      memo.set(key, project);
      if (JSON.stringify(old) !== JSON.stringify(project)) {
        saved[key] = project;
        dirty = true;
      }
      return project;
    },
    save() {
      if (!dirty || opts.file === null) return;
      mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
      const tmp = `${opts.file}.${process.pid}.new`;
      writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
      renameSync(tmp, opts.file);
      dirty = false;
    },
  };
}

/** What list_projects answers, from whichever machine scanned them. */
export const projectsText = (projects: readonly Project[]) => (projects.length === 0 ? "No projects found." : JSON.stringify(projects, null, 1));
