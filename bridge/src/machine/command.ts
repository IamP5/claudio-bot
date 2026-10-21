import { join } from "node:path";
import { z } from "zod";
import { accessOf } from "../access";
import type { PairOffer } from "../protocol";
import { errorText } from "../text";
import type { EnrollResponse } from "./enroll";
import { computerName, loadIdentity, saveIdentity } from "./identity";
import type { MachineId } from "./wire";

// `claudiobot machine …`: what a person types on the home to invite a computer, and on that computer to enroll it.

export const MACHINE_USAGE = `usage: claudiobot machine <show|invite|enroll <home-url> <code>>

  show     this bridge's machine id, and the home it is enrolled into, if any
  invite   on the home: a one-time code another computer enrolls with (the bridge must be running)
  enroll   on another computer: become a machine of that home. Its agents then run here, under this computer's
           own access mode, and the home's bots start them
`;

export type MachineCommandDeps = {
  bridgeHome: string;
  /** The environment the bridge runs with: this shell's, over the installed service's. */
  env: Readonly<Record<string, string | undefined>>;
  run: (argv: string[]) => Promise<string>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  out: (text: string) => void;
};

/** What a person may paste for the home: its http:// base, a ws:// URL from the phone, or a bare host:port. */
export function homeBase(raw: string): string | null {
  const text = /^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const scheme = { "http:": "http:", "ws:": "http:", "https:": "https:", "wss:": "https:" }[url.protocol];
  if (!scheme || url.hostname === "") return null;
  return `${scheme}//${url.host}`;
}

const ANSWER: z.ZodType<EnrollResponse> = z.object({
  homeMachineId: z.string().regex(/^m_[0-9a-f-]{36}$/) as unknown as z.ZodType<MachineId>,
  homePublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  homeName: z.string().min(1),
});

const modeLine = (env: MachineCommandDeps["env"]) => {
  const access = accessOf(env);
  return `Agents here run with ${access.full ? "full" : "guarded"} access, sandbox ${access.sandbox ? "on" : "off"}: this computer's own mode, which the home never changes.`;
};

export async function machineCommand(argv: string[], deps: MachineCommandDeps): Promise<number> {
  const { out } = deps;
  switch (argv[0]) {
    case "show":
    case undefined: {
      const me = loadIdentity(deps.bridgeHome, await computerName(deps.run));
      out(`machine "${me.name}" (${me.machineId})\n`);
      out(me.home ? `enrolled into "${me.home.name}" at ${me.home.url}\n` : "not enrolled: this bridge is a home\n");
      out(`${modeLine(deps.env)}\n`);
      return 0;
    }

    case "invite": {
      let offer: PairOffer;
      try {
        const res = await deps.fetch("http://localhost/machine-code", { method: "POST", unix: join(deps.bridgeHome, "run", "control.sock") } as RequestInit);
        if (!res.ok) throw new Error(`the bridge answered ${res.status}`);
        offer = (await res.json()) as PairOffer;
      } catch (e) {
        out(`No running bridge answered at ${join(deps.bridgeHome, "run", "control.sock")} (${errorText(e)}). Start the bridge on this home, then try again.\n`);
        return 1;
      }
      out(`machine code: ${offer.code} (single use, until ${new Date(offer.expiresAt).toLocaleTimeString()})\n`);
      out(`On the other computer, run one of:\n`);
      for (const url of offer.urls) out(`  claudiobot machine enroll ${url} ${offer.code}\n`);
      return 0;
    }

    case "enroll": {
      const [, rawUrl, code] = argv;
      const base = rawUrl ? homeBase(rawUrl) : null;
      if (!base || !code) {
        out(MACHINE_USAGE);
        return 2;
      }
      const me = loadIdentity(deps.bridgeHome, await computerName(deps.run));
      if (me.home && homeBase(me.home.url) !== base) {
        out(`This computer is already a machine of "${me.home.name}" (${me.home.url}). It was not enrolled anywhere else.\n`);
        return 1;
      }
      let res: Response;
      try {
        res = await deps.fetch(`${base}/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, machineId: me.machineId, name: me.name, publicKey: me.publicKey }),
        });
      } catch (e) {
        out(`Could not reach the home at ${base}: ${errorText(e)}\n`);
        return 1;
      }
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        out(`The home refused: ${(body as { error?: unknown } | null)?.error ?? `status ${res.status}`}\n`);
        return 1;
      }
      const answer = ANSWER.safeParse(body);
      if (!answer.success) {
        out(`The home at ${base} did not answer as a ClaudioBot home.\n`);
        return 1;
      }
      const { homeMachineId, homePublicKey, homeName } = answer.data;
      if (me.home && me.home.machineId !== homeMachineId) {
        out(`The bridge at ${base} is no longer "${me.home.name}", which this computer is a machine of. Nothing was changed.\n`);
        return 1;
      }
      saveIdentity(deps.bridgeHome, { ...me, home: { url: base, machineId: homeMachineId, publicKey: homePublicKey, name: homeName } });
      out(`Enrolled "${me.name}" into "${homeName}".\n`);
      out(`${modeLine(deps.env)}\n`);
      out(`Start or restart the bridge here (claudiobot install) and it runs as a machine of "${homeName}": no bots of its own, its agents only.\n`);
      return 0;
    }

    default:
      out(MACHINE_USAGE);
      return argv[0] === "help" ? 0 : 2;
  }
}
