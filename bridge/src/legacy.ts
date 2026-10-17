import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Devices } from "./devices";

// Protocol 2's shared token keeps today's phone connected for one release, as the legacy device. Owner: U5.

export type Legacy = {
  /** At start: import the shared token as the legacy device. */
  reconcile(devices: Devices): void;
  /** Called when the legacy device is revoked, so a restart cannot import it again. */
  close(): void;
};

export function legacyToken(home: string): Legacy {
  const tokenFile = join(home, "token");
  return {
    reconcile(devices) {
      const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
      if (token !== "") devices.importLegacy(token);
    },
    close() {
      rmSync(tokenFile, { force: true });
    },
  };
}
