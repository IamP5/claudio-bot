import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The machine's own files: keys, the registry, the outbox. Each is 0600 in a 0700 folder.

/** The file's text, or null when it does not exist. A symlink is refused, so a planted link cannot stand in for a key. */
export function readPrivate(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file.`);
  return readFileSync(path, "utf8");
}

/** Replaces the file whole: a temp file, fsynced, renamed over it. A crash leaves the old file or the new one. */
export function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Appends one line. A process killed mid-append leaves at most a torn last line, which readLines skips. A symlink is
 * refused, as readPrivate does.
 */
export function appendLine(path: string, line: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Each line parsed as JSON; a line that does not parse is dropped. */
export function readLines(path: string): unknown[] {
  const raw = readPrivate(path);
  if (raw === null) return [];
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}
