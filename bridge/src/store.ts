import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const bridgeHome = () => process.env.CLAUDEBOT_HOME ?? join(homedir(), ".claudebot");

export async function loadOrCreateToken(home = bridgeHome()): Promise<string> {
  const file = Bun.file(join(home, "token"));
  if (await file.exists()) {
    const token = (await file.text()).trim();
    if (token !== "") return token;
  }
  mkdirSync(home, { recursive: true });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  await Bun.write(file, token + "\n");
  chmodSync(join(home, "token"), 0o600);
  return token;
}
