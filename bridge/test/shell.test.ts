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

describe("heredocs: the body is stdin, not commands", () => {
  const verbs = (src: string) => shellCommands(src).map((c) => c.words[0]!.text);
  test("an apostrophe in a quoted heredoc inside $(…) no longer hides the next command", () => {
    const src = `git commit -m "$(cat <<'EOF'\nFix the user's bug\nEOF\n)" && gh pr merge 1`;
    expect(words(src)).toEqual([["cat"], ["git", "commit", "-m", "$(cat \n)"], ["gh", "pr", "merge", "1"]]);
  });
  test("a quoted delimiter skips the whole body, even a substitution in it", () => {
    expect(verbs(`cat <<'EOF'\n$(npm publish)\nEOF\nls`)).toEqual(["cat", "ls"]);
    expect(verbs(`cat <<"EOF"\n$(npm publish)\nEOF\nls`)).toEqual(["cat", "ls"]);
    expect(verbs(`cat <<\\EOF\n$(npm publish)\nEOF\nls`)).toEqual(["cat", "ls"]);
  });
  test("an unquoted delimiter expands the body, so its substitutions are parsed", () => {
    expect(verbs(`cat <<EOF\nhello $(npm publish) \`gh pr merge 1\`\nEOF`)).toEqual(["cat", "npm", "gh"]);
  });
  test("plain body text with quotes and operators is not parsed", () => {
    expect(verbs(`cat > notes.md <<EOF\nit's "half; done | ok\nEOF\nnpm publish`)).toEqual(["cat", "npm"]);
  });
  test("<<- strips leading tabs from the body and the delimiter line", () => {
    expect(verbs(`cat <<-EOF\n\tx\n\tEOF\nnpm publish`)).toEqual(["cat", "npm"]);
  });
  test("a space after << and two heredocs on one line", () => {
    expect(verbs(`cat << EOF\nx\nEOF\nnpm publish`)).toEqual(["cat", "npm"]);
    expect(verbs(`cat <<A <<B\nx\nA\ny\nB\nnpm publish`)).toEqual(["cat", "npm"]);
  });
  test("a redirect after the heredoc operator is still a redirect", () => {
    expect(redirects(`cat <<EOF >out.txt\nx\nEOF`)).toEqual([">out.txt"]);
  });
  test("an unterminated heredoc reads to the end", () => {
    expect(verbs(`cat <<EOF\nnpm publish`)).toEqual(["cat"]);
  });
  test("a here-string and an arithmetic shift are not heredocs", () => {
    expect(words("cat <<< hi && npm publish")).toEqual([["cat", "hi"], ["npm", "publish"]]);
    expect(verbs("echo $((1<<2))\nnpm publish")).toContain("npm");
  });
});

describe("ANSI-C quoting decodes every escape", () => {
  const first = (src: string) => shellCommands(src)[0]!.words.map((w) => w.text);
  test("hex, octal, unicode and control escapes", () => {
    expect(first(`$'\\x6e\\x70\\x6d' publish`)).toEqual(["npm", "publish"]);
    expect(first(`$'\\156pm' publish`)).toEqual(["npm", "publish"]);
    expect(first(`$'\\u006epm' publish`)).toEqual(["npm", "publish"]);
    expect(first(`echo $'a\\cAb'`)).toEqual(["echo", "a\x01b"]);
  });
  test("a decoded piece glues onto a bare one", () => {
    expect(first(`n$'\\x70'm publish`)).toEqual(["npm", "publish"]);
  });
});

describe("backticks honour backslash escapes", () => {
  test("an escaped inner backtick nests a second substitution instead of closing the first", () => {
    expect(words("echo `echo \\`npm publish\\``")).toEqual([["npm", "publish"], ["echo", "`npm publish`"], ["echo", "`echo \\`npm publish\\``"]]);
  });
});

describe("brace expansion is marked on the word", () => {
  const ws = (src: string) => shellCommands(src)[0]!.words;
  test("brace-built flags and paths carry brace, plain words do not", () => {
    expect(ws("rm {-r,-f} dir").map((w) => w.brace)).toEqual([false, true, false]);
    expect(ws("rm -{r,f} dir")[1]).toMatchObject({ brace: true, dynamic: true });
    expect(ws(`rm "{a,b}"`)[1]).toMatchObject({ brace: false });
  });
});

describe("commands know their subshell depth and whether they ran conditionally", () => {
  const shape = (src: string) => shellCommands(src).map((c) => [c.words[0]!.text, c.subshell, c.cond]);
  test("&& || and | make the next command conditional; ; and newline do not", () => {
    expect(shape("a && b || c | d ; e\nf")).toEqual([["a", 0, false], ["b", 0, true], ["c", 0, true], ["d", 0, true], ["e", 0, false], ["f", 0, false]]);
  });
  test("a parenthesised group and a substitution are subshells", () => {
    expect(shape("a; (cd x; b); c")).toEqual([["a", 0, false], ["cd", 1, false], ["b", 1, false], ["c", 0, false]]);
    expect(shape("echo $(cd x)")[0]).toEqual(["cd", 1, false]);
  });
});
