import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Devices } from "./devices";

// Protocol 2's shared token keeps today's phone connected for one release, as the legacy device. Owner: U5.
// Revoking that phone leaves a marker next to state.json, because the token file alone can come back (an old bridge
// run writes a new one, a backup restores it). Once the marker exists, no token is ever imported again.

export type Legacy = {
  /** At start: drops the legacy device for good once it was revoked, else imports the shared token if there is one. */
  reconcile(devices: Devices): void;
  /** Before devices.revoke: the marker, then the token file, so no crash point lets a restart import it again. */
  close(): void;
};

export function legacyToken(home: string): Legacy {
  const tokenFile = join(home, "token");
  const marker = join(home, "token.revoked");
  return {
    reconcile(devices) {
      if (existsSync(marker)) {
        for (const d of devices.list(null)) if (d.legacy) devices.revoke(d.id);
        return;
      }
      const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
      if (token !== "") devices.importLegacy(token);
    },
    close() {
      writeFileSync(marker, "The phone paired before protocol 3 was revoked. Its shared token is never accepted again.\n", { mode: 0o600 });
      rmSync(tokenFile, { force: true });
    },
  };
}
