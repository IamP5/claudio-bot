import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Attachment, BotId, LibraryFile, Upload } from "./protocol";

const TEXT_LIMIT = 1024 * 1024;
const BINARY_LIMIT = 10 * 1024 * 1024;

function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type FileView = { mime: string; content: string | null; data: string | null };

// The bridge's folder on disk: USER.md, each bot's home, and the trash.
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

  function walk(dir: string, base: string, out: LibraryFile[]) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, base, out);
      else if (stat.isFile()) out.push({ path: relative(base, path), size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }

  return {
    userMd,
    homeOf,

    ensureUserMd(userName: string) {
      mkdirSync(root, { recursive: true });
      if (!existsSync(userMd)) writeFileSync(userMd, `# About ${userName}\n\n`);
    },

    create(id: BotId, memory: string) {
      const home = homeOf(id);
      for (const dir of ["library", "inbox"]) mkdirSync(join(home, dir), { recursive: true });
      if (!existsSync(join(home, "CLAUDE.md"))) writeFileSync(join(home, "CLAUDE.md"), memory);
    },

    // Paths are relative to the bot home, so the app requests them back with file as they are.
    library(id: BotId): LibraryFile[] {
      const home = homeOf(id);
      const out: LibraryFile[] = [];
      if (existsSync(join(home, "library"))) walk(join(home, "library"), home, out);
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
