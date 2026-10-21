import { expect, test } from "bun:test";
import { placeAgent, type PlaceInput, type Placement } from "../src/machine/place";
import type { MachineId } from "../src/machine/wire";

const OMARCHY = "m_omarchy" as MachineId;
const SELF = OMARCHY;
const MAC = "m_mac" as MachineId;
const home = { id: OMARCHY, name: "Omarchy", online: true };
const mac = { id: MAC, name: "Tuba's MacBook", online: true };
const asleep = { ...mac, online: false };
const both = [home, mac];

const base = { asked: null, preferred: null, where: "mac", project: "shop", machines: both } as const;
const onHome = (project: Partial<Extract<Placement, { ok: true }>["project"]> = {}): Placement => ({
  ok: true,
  machine: SELF,
  name: "Omarchy",
  online: true,
  project: { githubRepo: null, name: "shop", ...project },
});
const onMac = (over: Partial<Extract<Placement, { ok: true }>> = {}): Placement => ({ ok: true, machine: MAC, name: "Tuba's MacBook", online: true, project: { githubRepo: null, name: "shop" }, ...over });

test.each<[string, Partial<Omit<PlaceInput, "self">>, Placement]>([
  ["one machine: self, the name as given", { machines: [home] }, onHome()],
  ["self keeps a path, which its own roots resolve", { project: "/home/alex/code/shop" }, onHome({ name: "/home/alex/code/shop" })],
  ["an owner/repo names the GitHub repo", { project: "acme/shop" }, onHome({ githubRepo: "acme/shop", name: "acme/shop" })],
  ["the machine the bot named, by id", { asked: MAC }, onMac()],
  ["the machine the bot named, by name in any case", { asked: " tuba's macbook " }, onMac()],
  ["the machine named wins over the bot's agentsOn", { asked: "omarchy", preferred: MAC }, onHome()],
  ["the bot's agentsOn when it names none", { preferred: MAC }, onMac()],
  ["another machine gets a path as its folder name", { asked: MAC, project: "/home/alex/code/shop" }, onMac()],
  ["an offline machine still places, so the start can wait for it", { asked: MAC, machines: [home, asleep] }, onMac({ online: false })],
  ["a cloud agent starts from the home whatever the bot named", { asked: MAC, preferred: MAC, where: "cloud" }, onHome()],
  ["an unknown machine is refused with the names", { asked: "studio" }, { ok: false, reason: `No machine "studio". Machines: Omarchy, Tuba's MacBook.` }],
  [
    "an agentsOn no longer enrolled is refused",
    { preferred: "m_gone" as MachineId },
    { ok: false, reason: "This bot's agents run on a machine that is no longer enrolled. Name one of Omarchy, Tuba's MacBook in machine." },
  ],
])("%s", (_, input, placed) => {
  expect(placeAgent({ ...base, ...input, self: SELF })).toEqual(placed);
});
