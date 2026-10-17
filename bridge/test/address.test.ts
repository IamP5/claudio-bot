import { expect, test } from "bun:test";
import { bonjourName, bridgeUrls, tailnetName } from "../src/address";

test("the tailnet name comes first, then the Bonjour name, then each LAN address", () => {
  expect(bridgeUrls({ tailnet: "mac.tail-1234.ts.net", localHost: "Alexs-Mac.local" }, ["10.0.0.20", "100.64.0.3"], 7878)).toEqual([
    "ws://mac.tail-1234.ts.net:7878/ws",
    "ws://Alexs-Mac.local:7878/ws",
    "ws://10.0.0.20:7878/ws",
    "ws://100.64.0.3:7878/ws",
  ]);
});

test("with no names and no LAN the bridge offers loopback, so it still prints something", () => {
  expect(bridgeUrls({ tailnet: null, localHost: null }, [], 7878)).toEqual(["ws://127.0.0.1:7878/ws"]);
});

test.each([
  ["an online node", { Self: { DNSName: "mac.tail-1234.ts.net.", Online: true } }, "mac.tail-1234.ts.net"],
  ["an offline node", { Self: { DNSName: "mac.tail-1234.ts.net.", Online: false } }, null],
  ["a logged-out node", { BackendState: "NeedsLogin", Self: { DNSName: "" } }, null],
  ["a name outside ts.net", { Self: { DNSName: "mac.example.com.", Online: true } }, null],
])("tailnetName: %s", (_, status, name) => {
  expect(tailnetName(JSON.stringify(status))).toBe(name);
});

test("tailnetName reads nothing from output that is not JSON", () => {
  expect(tailnetName("")).toBeNull();
  expect(tailnetName("failed to connect to local tailscaled")).toBeNull();
});

test("bonjourName adds .local to a valid LocalHostName and refuses anything else", () => {
  expect(bonjourName("Alexs-MacBook-Pro\n")).toBe("Alexs-MacBook-Pro.local");
  expect(bonjourName("")).toBeNull();
  expect(bonjourName("has space")).toBeNull();
});
