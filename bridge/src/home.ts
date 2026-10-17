import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentId, Attachment, BotId, LibraryFile, Upload } from "./protocol";
import { BOT_WRITABLE } from "./sandbox";

const TEXT_LIMIT = 1024 * 1024;
const BINARY_LIMIT = 10 * 1024 * 1024;
/** How many folders deep under library/ the listing goes, and how many entries it looks at in all. */
export const LIBRARY_DEPTH_MAX = 8;
export const LIBRARY_ENTRIES_MAX = 1000;

function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type FileView = { mime: string; content: string | null; data: string | null };

export function createHomes(root: string) {
  const homeOf = (id: BotId) => join(root, "bots", id);
  const userMd = join(root, "USER.md");

  function inside(id: BotId, path: string): string | null {
    const home = realpathSync(homeOf(id));
    const target = resolve(home, path);
    if (!existsSync(target)) return null;
    const real = realpathSync(target);
    return real === home || real.startsWith(home + sep) ? real : null;
  }

  /**
   * The bot writes its library, so the walk never follows a symlink (a loop, or a link to / or out of the home), and an
   * entry it cannot read is left out rather than failing the whole listing.
   */
  function walk(dir: string, depth: number, base: string, out: LibraryFile[], seen: { entries: number }) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (++seen.entries > LIBRARY_ENTRIES_MAX) return;
      const path = join(dir, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) {
        if (depth < LIBRARY_DEPTH_MAX) walk(path, depth + 1, base, out, seen);
      } else if (stat?.isFile()) out.push({ path: relative(base, path), size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }

  return {
    userMd,
    homeOf,

    /** An empty folder, in the bridge home where no bot or agent reaches, that stands in for an untrusted repo's config. */
    agentConfig(id: AgentId): string {
      const dir = join(root, "agent-config", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },

    removeAgentConfig(id: AgentId) {
      const parent = join(root, "agent-config");
      const dir = join(parent, id);
      if (dirname(dir) !== parent) throw new Error(`${id} is not an agent id`);
      rmSync(dir, { recursive: true, force: true });
    },

    ensureUserMd(userName: string) {
      mkdirSync(root, { recursive: true });
      if (!existsSync(userMd)) writeFileSync(userMd, `# About ${userName}\n\n`, { mode: 0o600 });
    },

    /** The folders the bot's sandbox lets it write, made for a bot created before work/ existed. */
    ensureFolders(id: BotId) {
      for (const dir of BOT_WRITABLE) mkdirSync(join(homeOf(id), dir), { recursive: true });
    },

    create(id: BotId, memory: string) {
      const home = homeOf(id);
      for (const dir of BOT_WRITABLE) mkdirSync(join(home, dir), { recursive: true });
      if (!existsSync(join(home, "CLAUDE.md"))) writeFileSync(join(home, "CLAUDE.md"), memory);
    },

    // Paths are relative to the bot home, so the app requests them back with file as they are.
    library(id: BotId): LibraryFile[] {
      const home = homeOf(id);
      const out: LibraryFile[] = [];
      if (lstatSync(join(home, "library"), { throwIfNoEntry: false })?.isDirectory()) walk(join(home, "library"), 0, home, out, { entries: 0 });
      return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    },

    async read(id: BotId, path: string): Promise<FileView | { error: string }> {
      const real = inside(id, path);
      if (!real || !statSync(real).isFile()) return { error: `No file ${path} in this bot's home` };
      const file = Bun.file(real);
      const type = file.type.split(";")[0]!;
      if (type.startsWith("image/")) {
        const data = file.size <= BINARY_LIMIT ? Buffer.from(await file.arrayBuffer()).toString("base64") : null;
        return { mime: type, content: null, data };
      }
      if (file.size > TEXT_LIMIT) return { mime: type, content: null, data: null };
      const content = utf8Text(new Uint8Array(await file.arrayBuffer()));
      if (content === null) return { mime: type, content: null, data: null };
      return { mime: type === "application/octet-stream" ? "text/plain" : type, content, data: null };
    },

    saveUploads(id: BotId, uploads: Upload[]): Attachment[] | { error: string } {
      const files = uploads.map((u) => ({ ...u, bytes: Buffer.from(u.data, "base64") }));
      const big = files.find((f) => f.bytes.length > BINARY_LIMIT);
      if (big) return { error: `${big.name} is over 10 MB` };
      const inbox = join(homeOf(id), "inbox");
      mkdirSync(inbox, { recursive: true });
      return files.map((f) => {
        const clean = basename(f.name).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") || "upload";
        const ext = extname(clean);
        let name = clean;
        for (let n = 2; existsSync(join(inbox, name)); n++) name = `${clean.slice(0, clean.length - ext.length)}-${n}${ext}`;
        writeFileSync(join(inbox, name), f.bytes);
        return { name: f.name, mime: f.mime, path: `inbox/${name}` };
      });
    },

    trash(id: BotId, at: Date) {
      const home = homeOf(id);
      if (!existsSync(home)) return;
      mkdirSync(join(root, "trash"), { recursive: true });
      renameSync(home, join(root, "trash", `${id}-${at.getTime()}`));
    },
  };
}

export type Homes = ReturnType<typeof createHomes>;
