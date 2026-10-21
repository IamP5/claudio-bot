import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { rejectsOrigin } from "./devices";
import type { PairOffer } from "./protocol";
import { errorText } from "./text";

// The same-user door: a unix socket in the bridge home that mints a pairing code for the ClaudioBot app on this Mac,
// and on a home a join code for `claudiobot machine invite`.
// The app redeems the code at POST /pair like any phone, so there is no second way to create a device. connect(2)
// needs write permission on the socket and search permission on its folder, so only this macOS user gets in, even
// where the home itself is 0755. Bots cannot reach it: the gate refuses tool calls naming the home, and the sandbox
// allows no unix socket but SSH_AUTH_SOCK.

/** sun_path on macOS is 104 bytes, the terminating NUL included. */
const SUN_PATH_BYTES = 104;

export type Control = { stop(): void };

/**
 * Listens on <home>/run/control.sock. Call only while holding the home lock, which is what makes a socket left at that
 * path stale. Null, with one log line, when the path is too long or the listen fails: the bridge runs on without it.
 */
export function serveControl(deps: { home: string; offer: () => PairOffer; machineOffer?: () => PairOffer; log: (line: string) => void }): Control | null {
  const dir = join(deps.home, "run");
  const path = join(dir, "control.sock");
  if (Buffer.byteLength(path) >= SUN_PATH_BYTES) {
    deps.log(`control: ${path} is too long for a unix socket, so this Mac's app cannot pair itself`);
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true });
    // mkdir leaves the mode of a folder that already exists.
    chmodSync(dir, 0o700);
    rmSync(path, { force: true });
    const server = Bun.serve({
      unix: path,
      development: false,
      fetch(req) {
        if (rejectsOrigin(req)) return new Response("Forbidden", { status: 403 });
        const path = new URL(req.url).pathname;
        const mint = path === "/pair-code" ? deps.offer : path === "/machine-code" ? deps.machineOffer : undefined;
        if (!mint) return new Response("Not found", { status: 404 });
        if (req.method !== "POST") return new Response("Use POST", { status: 405 });
        deps.log(`local ${path === "/pair-code" ? "pair" : "machine"} code minted`);
        return Response.json(mint());
      },
    });
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      server.stop(true);
      throw e;
    }
    return {
      stop() {
        server.stop(true);
        rmSync(path, { force: true });
      },
    };
  } catch (e) {
    deps.log(`control: ${path} is not listening, so this Mac's app cannot pair itself: ${errorText(e)}`);
    return null;
  }
}
