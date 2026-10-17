import { describe, expect, test } from "bun:test";
import { displayName, hasHiddenCharacters, maskSecrets, redact } from "../src/text";

describe("displayName", () => {
  test.each([
    ["Alex\u0000's\u0007 iPhone", 64, "Alex's iPhone"],
    ["Alex\n\tiPhone", 64, "Alex iPhone"],
    ["\u202Eenohp\u202C \u200Bx", 64, "enohp x"],
    ["evil\u2066bot\u2069", 40, "evilbot"],
    ["\u{1F469}\u200D\u{1F4BB} Engineer", 40, "\u{1F469}\u200D\u{1F4BB} Engineer"],
    ["y".repeat(41), 40, "y".repeat(39) + "\u2026"],
    ["\u0000\u200B", 64, ""],
  ])("%p capped at %p shows as %p", (name, max, shown) => {
    expect(displayName(name, max)).toBe(shown);
  });

  test("a name with a bidi override or a zero-width space is hidden text; an emoji joiner is not", () => {
    expect(["left\u200Emark", "a\u202Eb", "zero\u200Bwidth", "\u{1F469}\u200D\u{1F4BB}"].map(hasHiddenCharacters)).toEqual([true, true, true, false]);
  });
});

describe("maskSecrets", () => {
  test("masks a key in Claude Code's stderr but keeps a commit SHA", () => {
    const out = maskSecrets("auth failed for sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx at 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a");
    expect(out).toBe("auth failed for «redacted:37 chars» at 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a");
  });
});

describe("redact", () => {
  const secrets = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-1234567890-abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "Q2xhdWRpb0JvdERldmljZVRva2VuMTIzNDU2Nzg5MA",
  ];
  for (const secret of secrets) {
    test(`masks ${secret.slice(0, 8)}…`, () => {
      const out = JSON.stringify(redact({ command: `deploy --key ${secret} now` }));
      expect(out).not.toContain(secret);
      expect(out).toContain("«redacted:");
    });
  }
  test("masks keyed values and secret-named fields, however short", () => {
    const out = JSON.stringify(redact({ command: "login --password=hunter22 && curl -H 'Authorization: Bearer tok123456'", token: "abc", apiKey: "k1" }));
    for (const s of ["hunter22", "tok123456", '"abc"', '"k1"']) expect(out).not.toContain(s);
  });
  test("file bodies become their size and hash", () => {
    expect(redact({ file_path: "a.md", content: "hello" })).toEqual({
      file_path: "a.md",
      content: { bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    });
    const edits = redact({ file_path: "a.md", edits: [{ old_string: "hello", new_string: "héllo" }] }) as { edits: { new_string: { bytes: number } }[] };
    expect(edits.edits[0]!.new_string.bytes).toBe(6);
  });
  test("keeps ordinary text, paths and commit SHAs", () => {
    const input = { command: "git checkout 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a && cat /Users/alex/Projects/app2/src/Component.tsx" };
    expect(redact(input)).toEqual(input);
  });
});
