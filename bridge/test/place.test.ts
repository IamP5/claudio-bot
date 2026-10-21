import { expect, test } from "bun:test";
import { placeAgent, type PlaceInput, type Placement } from "../src/machine/place";
import type { MachineId } from "../src/machine/wire";

const OMARCHY = "m_omarchy" as MachineId;
const SELF = OMARCHY;
const MAC = "m_mac" as MachineId;
const home = { id: OMARCHY, online: true, profile: { name: "Omarchy" } };
const mac = { id: MAC, online: true, profile: { name: "Mac" } };
const asleep = { ...mac, online: false };

test.each<[string, Omit<PlaceInput, "self">, Placement]>([
  ["one machine: self, the name as given", { asked: null, project: "shop", machines: [home] }, { ok: true, machine: SELF, project: { githubRepo: null, name: "shop" } }],
  ["self keeps a path, which its own roots resolve", { asked: null, project: "/home/alex/code/shop", machines: [home] }, { ok: true, machine: SELF, project: { githubRepo: null, name: "/home/alex/code/shop" } }],
  ["an owner/repo names the GitHub repo", { asked: null, project: "acme/shop", machines: [home] }, { ok: true, machine: SELF, project: { githubRepo: "acme/shop", name: "acme/shop" } }],
  ["the machine asked for", { asked: MAC, project: "shop", machines: [home, mac] }, { ok: true, machine: MAC, project: { githubRepo: null, name: "shop" } }],
  ["another machine gets a path as its folder name", { asked: MAC, project: "/home/alex/code/shop", machines: [home, mac] }, { ok: true, machine: MAC, project: { githubRepo: null, name: "shop" } }],
  ["the machine asked for is offline", { asked: MAC, project: "shop", machines: [home, asleep] }, { ok: false, reason: "Mac is offline." }],
  ["an unknown machine", { asked: "m_gone" as MachineId, project: "shop", machines: [home, mac] }, { ok: false, reason: 'No machine "m_gone".' }],
])("%s", (_, input, placed) => {
  expect(placeAgent({ ...input, self: SELF })).toEqual(placed);
});
