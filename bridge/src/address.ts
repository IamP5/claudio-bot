import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

// The addresses the bridge prints, best first. The pairing QR code carries them all; the app redeems the code at the
// first that answers and keeps that one.
// - The tailnet name (mac.tailnet-1234.ts.net) reaches the Mac from anywhere the phone runs Tailscale, and the app's
//   ATS exception covers ws:// to *.ts.net. A raw 100.x address would also work but changes if the node is re-added.
// - The Bonjour name (Mac.local) survives the router handing the Mac a new LAN address.
// - Then each IPv4 address, for a network that blocks mDNS.

export type Names = { tailnet: string | null; localHost: string | null };

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

export function bridgeUrls(names: Names, lan: string[], port: number): string[] {
  const hosts = [names.tailnet, names.localHost, ...(lan.length > 0 ? lan : ["127.0.0.1"])].filter((h): h is string => h !== null);
  return [...new Set(hosts)].map((host) => `ws://${host}:${port}/ws`);
}

/** claudiobot://pair?url=…&url=…&code=…, one url per address. An app that reads only the first url still pairs. */
export function pairLink(urls: string[], code: string): string {
  return `claudiobot://pair?${urls.map((u) => `url=${encodeURIComponent(u)}`).join("&")}&code=${code}`;
}

/** Self.DNSName from `tailscale status --json`, when this node is signed in and online. */
export function tailnetName(statusJson: string): string | null {
  try {
    const self = (JSON.parse(statusJson) as { Self?: { DNSName?: unknown; Online?: unknown } }).Self;
    const name = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
    return self?.Online !== false && name.endsWith(".ts.net") ? name : null;
  } catch {
    return null;
  }
}

/** `scutil --get LocalHostName` is the Bonjour name without ".local", and only letters, digits and hyphens. */
export function bonjourName(localHostName: string): string | null {
  const name = localHostName.trim();
  return /^[A-Za-z0-9-]+$/.test(name) ? `${name}.local` : null;
}

/** Where Homebrew and the Tailscale installer put the CLI; launchd's PATH for the service may hold neither. */
const TAILSCALE_PATH = "/opt/homebrew/bin:/usr/local/bin";

/** `run` gives "" for a command that is missing, fails or hangs, so a stuck tailscaled never holds up the start. */
export async function readNames(run: (argv: string[]) => Promise<string>): Promise<Names> {
  const tailscale = Bun.which("tailscale") ?? Bun.which("tailscale", { PATH: TAILSCALE_PATH }) ?? (existsSync(TAILSCALE_APP) ? TAILSCALE_APP : null);
  const [status, local] = await Promise.all([tailscale ? run([tailscale, "status", "--json"]) : "", run(["scutil", "--get", "LocalHostName"])]);
  return { tailnet: tailnetName(status), localHost: bonjourName(local) };
}
