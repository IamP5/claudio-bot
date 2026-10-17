import { describe, expect, test } from "bun:test";
import { accessLine, accessOf } from "../src/access";

describe("accessOf", () => {
  test("guarded with the sandbox on by default", () => {
    expect(accessOf({})).toEqual({ full: false, sandbox: true });
  });
  test("full turns the sandbox off unless it is asked for", () => {
    expect(accessOf({ CLAUDIOBOT_ACCESS: "full" })).toEqual({ full: true, sandbox: false });
    expect(accessOf({ CLAUDIOBOT_ACCESS: "FULL", CLAUDIOBOT_SANDBOX: "on" })).toEqual({ full: true, sandbox: true });
  });
  test("the sandbox can be turned off while guarded", () => {
    for (const v of ["off", "0", "false", "no"]) expect(accessOf({ CLAUDIOBOT_SANDBOX: v })).toEqual({ full: false, sandbox: false });
  });
  test("an unknown value keeps the safe defaults", () => {
    expect(accessOf({ CLAUDIOBOT_ACCESS: "everything", CLAUDIOBOT_SANDBOX: "maybe" })).toEqual({ full: false, sandbox: true });
  });
  test("one line for the banner", () => {
    expect(accessLine({ full: true, sandbox: false })).toBe("access: full, sandbox off");
  });
});
