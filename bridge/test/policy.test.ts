import { describe, expect, test } from "bun:test";
import { decide, detailOf, fingerprint, redact, type Decision, type PolicyContext, type Scope, type ToolCall } from "../src/policy";
import type { AgentId, BotId, MessageId, RoutineId, RunId } from "../src/protocol";
import type { Actor, Fingerprint, Grant, Initiator, Signature, StandingRule } from "../src/world";

const HOME = "/Users/alex";
const BRIDGE = `${HOME}/.claudiobot`;
const OWN = `${BRIDGE}/bots/b_1`;
const PROJECT = `${HOME}/code/app`;
const NOW = "2026-10-17T12:00:00.000Z";

const botScope: Scope = { bridgeHome: BRIDGE, own: OWN, userMd: `${BRIDGE}/USER.md`, homedir: HOME };
const agentScope: Scope = { bridgeHome: BRIDGE, own: PROJECT, userMd: null, homedir: HOME };
const bot: Actor = { kind: "bot", botId: "b_1" as BotId };
const agent: Actor = { kind: "agent", botId: "b_1" as BotId, agentId: "a_1" as AgentId };

const run = { routineId: "r_1" as RoutineId, runId: "run_1" as RunId };
const user: Initiator = { kind: "user" };
const routine: Initiator = { kind: "routine", run, manual: false };
const runNow: Initiator = { kind: "routine", run, manual: true };
const system: Initiator = { kind: "system" };
const viaBot = (hops: number): Initiator => ({ kind: "bot", botId: "b_2" as BotId, hops });

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  actor: bot,
  initiator: user,
  scope: botScope,
  rules: [],
  grants: [],
  headroom: { ok: true, capReached: false },
  callsToday: {},
  now: NOW,
  realpath: (p) => p,
  ...over,
});

function call(tool: string, input: Record<string, unknown>, over: Partial<ToolCall> = {}): ToolCall {
  const server = tool.startsWith("mcp__") ? tool.split("__")[1]! : null;
  return {
    tool,
    input,
    cwd: OWN,
    toolUseId: "toolu_1",
    subagent: null,
    mcpServer: server === null ? null : { name: server, source: server === "claudio" ? "sdk" : "user" },
    ...over,
  };
}
const sh = (command: string, over: Partial<ToolCall> = {}) => call("Bash", { command, description: "run it" }, over);

const outcome = (d: Decision) => {
  switch (d.kind) {
    case "pass":
      return "pass";
    case "allow":
      return `allow:${d.via}`;
    case "ask":
      return `ask:${d.rule}`;
    case "deny":
      return `deny:${d.rule}`;
  }
};
const verdict = (c: ToolCall, over: Partial<PolicyContext> = {}) => outcome(decide(c, ctx(over)));

const allowRule = (signature: string, appliesTo: "attended" | "all"): StandingRule => ({
  decision: "allow",
  appliesTo,
  signature: signature as Signature,
  label: signature,
  cardId: "m_rule" as MessageId,
  at: NOW,
});
const neverRule = (signature: string): StandingRule => ({ decision: "deny", signature: signature as Signature, label: "Push to the default branch", cardId: "m_never" as MessageId, at: NOW });
const grantFor = (c: ToolCall, over: Partial<Grant> = {}): Grant => ({
  actor: "bot:b_1",
  fingerprint: fingerprint(c),
  cardId: "m_grant" as MessageId,
  expiresAt: "2026-10-17T12:10:00.000Z",
  ...over,
});

describe("floors", () => {
  const cases: [string, ToolCall, Partial<PolicyContext>, string][] = [
    ["the bridge state file", call("Read", { file_path: `${BRIDGE}/state.json` }), {}, "deny:floor.bridge"],
    ["the bridge token through ~", sh("cat ~/.claudiobot/token"), {}, "deny:floor.bridge"],
    ["the audit log", sh(`tail -n 5 ${BRIDGE}/audit/2026-10.jsonl`), {}, "deny:floor.bridge"],
    ["the legacy bridge home", sh("cat ~/.claudebot/token"), {}, "deny:floor.bridge"],
    ["another bot's home", sh(`cat ${BRIDGE}/bots/b_2/CLAUDE.md`), {}, "deny:floor.bridge"],
    ["a sibling whose id starts with ours", call("Read", { file_path: `${BRIDGE}/bots/b_10/CLAUDE.md` }), {}, "deny:floor.bridge"],
    ["climbing out of its own home", sh("cat ../b_2/CLAUDE.md"), {}, "deny:floor.bridge"],
    ["its own home by absolute path in Bash", sh(`cat ${OWN}/CLAUDE.md && ls ${OWN}`), {}, "pass"],
    ["its own home by absolute path in Write", call("Write", { file_path: `${OWN}/notes.md`, content: "x" }), {}, "pass"],
    ["its own home by relative path", sh("ls library && cat ./CLAUDE.md"), {}, "pass"],
    ["USER.md", call("Edit", { file_path: `${BRIDGE}/USER.md`, old_string: "a", new_string: "b" }), {}, "pass"],
    ["USER.md from an agent", call("Read", { file_path: `${BRIDGE}/USER.md` }, { cwd: PROJECT }), { actor: agent, scope: agentScope }, "deny:floor.bridge"],
    ["the bot's home from its agent", call("Read", { file_path: `${OWN}/CLAUDE.md` }, { cwd: PROJECT }), { actor: agent, scope: agentScope }, "deny:floor.bridge"],
    [
      "an agent working inside the bot's home gets no exception",
      call("Read", { file_path: `${OWN}/CLAUDE.md` }),
      { actor: agent, scope: { ...agentScope, own: OWN } },
      "deny:floor.bridge",
    ],
    ["an SSH key", call("Read", { file_path: `${HOME}/.ssh/id_rsa` }), {}, "deny:floor.keys"],
    ["an SSH key through $HOME", sh("cat $HOME/.ssh/id_ed25519"), {}, "deny:floor.keys"],
    ["AWS credentials through ${HOME}", sh("cat ${HOME}/.aws/credentials"), {}, "deny:floor.keys"],
    ["the GPG home", sh(`gpg --homedir ${HOME}/.gnupg --export-secret-keys`), {}, "deny:floor.keys"],
    ["gcloud credentials", sh("ls ~/.config/gcloud"), {}, "deny:floor.keys"],
    ["the Keychain file", call("Read", { file_path: `${HOME}/Library/Keychains/login.keychain-db` }), {}, "deny:floor.keys"],
    ["a Keychain password", sh("security find-generic-password -s github -w"), {}, "deny:floor.keys"],
    ["a Keychain dump", sh("security dump-keychain"), {}, "deny:floor.keys"],
    ["a Keychain export", sh("security export -k login.keychain -o out.p12"), {}, "deny:floor.keys"],
    ["a harmless security verb", sh("security list-keychains"), {}, "pass"],
    ["Chrome cookies", call("Read", { file_path: `${HOME}/Library/Application Support/Google/Chrome/Default/Cookies` }), {}, "deny:floor.browser"],
    ["Safari data", sh("ls ~/Library/Safari"), {}, "deny:floor.browser"],
    ["the cookie jar", sh("cat ~/Library/Cookies/Cookies.binarycookies"), {}, "deny:floor.browser"],
    ["the Claude login", sh("cat ~/.claude/.credentials.json"), {}, "deny:floor.claude"],
    ["Claude settings", call("Read", { file_path: `${HOME}/.claude/settings.json` }), {}, "pass"],
    ["a checkout connector", call("mcp__shop__checkout", { cart: "c1" }), {}, "deny:floor.payment"],
    ["a password field", call("mcp__browser__fill_form", { selector: "#pw", password: "x" }), {}, "deny:floor.payment"],
    ["a one-time code", call("mcp__bank__submitOtp", { code: "123456" }), {}, "deny:floor.payment"],
    ["a payload is not a payment", call("mcp__api__get_payload", { id: 1 }), {}, "pass"],
    ["an MCP filesystem server", call("mcp__fs__read_text_file", { path: `${HOME}/.ssh/id_rsa` }), {}, "deny:floor.keys"],
    ["a Glob pattern", call("Glob", { pattern: `${HOME}/.ssh/*` }), {}, "deny:floor.keys"],
    ["cd, then a relative path", sh("cd ~ && cat .ssh/id_rsa"), {}, "deny:floor.keys"],
    ["quotes inside a path", sh('cat ~/.s"s"h/id_rsa'), {}, "deny:floor.keys"],
    ["bash -c", sh('bash -c "cat ~/.ssh/id_rsa"'), {}, "deny:floor.keys"],
    ["eval", sh("eval 'cat ~/.ssh/id_rsa'"), {}, "deny:floor.keys"],
    ["a command substitution", sh("echo $(cat ~/.ssh/id_rsa)"), {}, "deny:floor.keys"],
    ["a variable set first", sh("D=~/.ssh; cat $D/id_rsa"), {}, "deny:floor.keys"],
    ["a redirection", sh("echo key >> ~/.ssh/authorized_keys"), {}, "deny:floor.keys"],
    ["an option value", sh("aws --config-file=~/.aws/config s3 ls"), {}, "deny:floor.keys"],
    ["a wrapped security verb", sh("sudo -u root security find-internet-password -w"), {}, "deny:floor.keys"],
  ];
  for (const [name, c, over, expected] of cases) test(name, () => expect(verdict(c, over)).toBe(expected));

  test("a payment floor hands the step back to the user", () => {
    const d = decide(call("mcp__shop__checkout", {}), ctx());
    expect(d).toMatchObject({ kind: "deny", via: "floor", handOff: true });
    expect(decide(call("Read", { file_path: `${HOME}/.ssh/id_rsa` }), ctx())).toMatchObject({ handOff: false });
  });

  test("the bridge reached through a symlinked name is still the bridge, and the bot's own home through it is still its own", () => {
    const real = `${HOME}/.claudebot`;
    const realpath = (p: string) => (p === BRIDGE || p.startsWith(`${BRIDGE}/`) ? real + p.slice(BRIDGE.length) : p);
    const scope: Scope = { bridgeHome: real, own: `${real}/bots/b_1`, userMd: `${real}/USER.md`, homedir: HOME };
    const over = { scope, realpath };
    expect(verdict(sh("cat ~/.claudiobot/state.json"), over)).toBe("deny:floor.bridge");
    expect(verdict(sh(`cat ${OWN}/CLAUDE.md`), over)).toBe("pass");
    expect(verdict(sh("cat notes/today.md"), over)).toBe("pass");
    expect(verdict(call("Write", { file_path: `${OWN}/library/new.md`, content: "x" }), over)).toBe("pass");
  });

  test("a symlink inside its own home that points at the state file is the state file", () => {
    const realpath = (p: string) => (p === `${OWN}/link` ? `${BRIDGE}/state.json` : p);
    expect(verdict(call("Read", { file_path: `${OWN}/link` }), { realpath })).toBe("deny:floor.bridge");
  });

  test("a symlinked ~/.ssh is protected where it really lives", () => {
    const realpath = (p: string) => (p.startsWith(`${HOME}/.ssh`) ? `${HOME}/dotfiles/ssh${p.slice(`${HOME}/.ssh`.length)}` : p);
    expect(verdict(call("Read", { file_path: `${HOME}/dotfiles/ssh/id_rsa` }), { realpath })).toBe("deny:floor.keys");
  });

  test("a floor beats a grant and an Always rule", () => {
    const c = sh("cat ~/.ssh/id_rsa");
    expect(verdict(c, { grants: [grantFor(c)], rules: [allowRule("Bash:git.push", "all")] })).toBe("deny:floor.keys");
  });
});

describe("initiator bans", () => {
  const setRoutine = call("mcp__claudio__set_routine", { name: "digest", schedule: "0 8 * * *", prompt: "p" });
  const deleteRoutine = call("mcp__claudio__delete_routine", { name: "digest" });
  const messageBot = call("mcp__claudio__message_bot", { bot: "Researcher", text: "hi" });
  const createBot = call("mcp__claudio__create_bot", { name: "Helper", job: "help" });
  const cases: [string, ToolCall, Initiator, string][] = [
    ["a routine cannot change routines", setRoutine, routine, "deny:ban.routine_admin"],
    ["nor delete them", deleteRoutine, routine, "deny:ban.routine_admin"],
    ["nor when run by hand", setRoutine, runNow, "deny:ban.routine_admin"],
    ["the user's turn can", setRoutine, user, "pass"],
    ["message_bot at 2 hops", messageBot, viaBot(2), "deny:ban.hops"],
    ["create_bot at 3 hops", createBot, viaBot(3), "deny:ban.hops"],
    ["message_bot at 1 hop", messageBot, viaBot(1), "pass"],
    ["create_bot at 1 hop is unattended work, so it asks", createBot, viaBot(1), "ask:claudio.create_bot"],
  ];
  for (const [name, c, initiator, expected] of cases) test(name, () => expect(verdict(c, { initiator })).toBe(expected));

  test("a ban beats an Always rule and a grant", () => {
    expect(verdict(setRoutine, { initiator: routine, rules: [allowRule("mcp__claudio__set_routine:claudio.routines", "all")], grants: [grantFor(setRoutine)] })).toBe(
      "deny:ban.routine_admin",
    );
  });
});

describe("limits", () => {
  const createBot = call("mcp__claudio__create_bot", { name: "Helper", job: "help" });
  const startAgent = call("mcp__claudio__start_agent", { title: "t", prompt: "p", project: "app", where: "mac" });
  test("the daily spending cap blocks every call, even a read", () => {
    expect(verdict(call("Read", { file_path: `${OWN}/CLAUDE.md` }), { headroom: { ok: false, reason: "daily_cap", until: "2026-10-18T00:00:00.000Z" } })).toBe(
      "deny:limit.daily_cap",
    );
  });
  test("a spent agent budget blocks every call", () => {
    expect(verdict(sh("ls"), { actor: agent, scope: agentScope, headroom: { ok: false, reason: "agent_budget" } })).toBe("deny:limit.agent_budget");
  });
  test("a reached cap on an attended turn still runs", () => {
    expect(verdict(sh("ls"), { headroom: { ok: true, capReached: true } })).toBe("pass");
  });
  test("five bots a day, twenty agents a day", () => {
    expect(verdict(createBot, { callsToday: { mcp__claudio__create_bot: 4 } })).toBe("pass");
    expect(verdict(createBot, { callsToday: { mcp__claudio__create_bot: 5 } })).toBe("deny:limit.create_bot");
    expect(verdict(startAgent, { callsToday: { mcp__claudio__start_agent: 19 } })).toBe("pass");
    expect(verdict(startAgent, { callsToday: { mcp__claudio__start_agent: 20 } })).toBe("deny:limit.start_agent");
  });
  test("a limit beats a grant", () => {
    const c = sh("git push origin main");
    expect(verdict(c, { grants: [grantFor(c)], headroom: { ok: false, reason: "agent_budget" } })).toBe("deny:limit.agent_budget");
  });
});

describe("rule precedence", () => {
  const push = sh("git push origin main");
  test("Never beats a grant", () => {
    expect(verdict(push, { rules: [neverRule("Bash:git.push.default")], grants: [grantFor(push)] })).toBe("deny:Bash:git.push.default");
  });
  test("Never catches one segment of a compound command", () => {
    expect(verdict(sh("git status && git push origin main"), { rules: [neverRule("Bash:git.push.default")] })).toBe("deny:Bash:git.push.default");
  });
  test("Never holds even where the table would pass", () => {
    expect(verdict(sh("git push origin feature"), { rules: [neverRule("Bash:git.push")] })).toBe("deny:Bash:git.push");
  });
  test("a grant beats Always and is the one used", () => {
    expect(verdict(push, { grants: [grantFor(push)], rules: [allowRule("Bash:git.push.default", "all")] })).toBe("allow:grant");
  });
  test("a grant covers only the exact call, for its own actor, until it expires", () => {
    const g = grantFor(push);
    expect(verdict(push, { grants: [g] })).toBe("allow:grant");
    expect(verdict(call("Bash", { command: "  git push origin main ", timeout: 9 }), { grants: [g] })).toBe("allow:grant");
    expect(verdict(sh("git push upstream main"), { grants: [g] })).toBe("ask:git.push.default");
    expect(verdict(push, { grants: [grantFor(push, { actor: "agent:a_1" })] })).toBe("ask:git.push.default");
    expect(verdict(push, { grants: [grantFor(push, { expiresAt: NOW })] })).toBe("ask:git.push.default");
  });
  test("a grant names its card", () => {
    expect(decide(push, ctx({ grants: [grantFor(push)] }))).toEqual({ kind: "allow", via: "grant", rule: fingerprint(push), cardId: "m_grant" as MessageId });
  });
});

describe("Always and attendance", () => {
  const push = sh("git push origin main");
  const attendedOnly = [allowRule("Bash:git.push.default", "attended")];
  const everyTurn = [allowRule("Bash:git.push.default", "all")];
  test("an Always set in an attended turn covers attended turns", () => {
    expect(verdict(push, { rules: attendedOnly })).toBe("allow:always");
    expect(verdict(push, { rules: attendedOnly, initiator: runNow })).toBe("allow:always");
  });
  test("but not routines or other unattended work", () => {
    expect(verdict(push, { rules: attendedOnly, initiator: routine })).toBe("ask:git.push.default");
    expect(verdict(push, { rules: attendedOnly, initiator: viaBot(1) })).toBe("ask:git.push.default");
  });
  test("an Always set in an unattended turn covers every turn", () => {
    expect(verdict(push, { rules: everyTurn, initiator: routine })).toBe("allow:always");
    expect(verdict(push, { rules: everyTurn, initiator: user })).toBe("allow:always");
  });
  test("an Always on one segment leaves the rest to the classifier instead of allowing it", () => {
    expect(verdict(sh("git add . && git push origin main"), { rules: everyTurn })).toBe("pass");
  });
  test("an Always covering every segment allows the call", () => {
    expect(verdict(sh("git push origin main && git push upstream main"), { rules: everyTurn })).toBe("allow:always");
  });
  test("an Always on one risky segment still asks for the other", () => {
    expect(verdict(sh("git push origin main && npm publish"), { rules: everyTurn })).toBe("ask:publish");
  });
  test("an Always for one tool does not cover another", () => {
    expect(verdict(call("Edit", { file_path: `${PROJECT}/a.ts`, old_string: "a", new_string: "b" }), { rules: [allowRule("Write:fs.outside", "all")], initiator: routine })).toBe(
      "ask:fs.outside",
    );
  });
});

describe("the table", () => {
  const claudio = (name: string, input: Record<string, unknown> = {}) => call(`mcp__claudio__${name}`, input);
  // [name, call, attended (user), unattended (system)]
  const cases: [string, ToolCall, string, string][] = [
    ["push to main", sh("git push origin main"), "ask:git.push.default", "ask:git.push.default"],
    ["push HEAD to master", sh("git push origin HEAD:master"), "ask:git.push.default", "ask:git.push.default"],
    ["push to main with -C", sh("git -C ~/code/app push origin main"), "ask:git.push.default", "ask:git.push.default"],
    ["force-push", sh("git push --force origin feature"), "ask:git.rewrite", "ask:git.rewrite"],
    ["force-with-lease", sh("git push --force-with-lease"), "ask:git.rewrite", "ask:git.rewrite"],
    ["a + refspec", sh("git push origin +feature"), "ask:git.rewrite", "ask:git.rewrite"],
    ["reset to the remote", sh("git reset --hard origin/main"), "ask:git.rewrite", "ask:git.rewrite"],
    ["delete a branch", sh("git branch -D old"), "ask:git.rewrite", "ask:git.rewrite"],
    ["a local hard reset", sh("git reset --hard HEAD~1"), "pass", "pass"],
    ["push a branch", sh("git push -u origin feature"), "pass", "ask:git.push"],
    ["merge a PR", sh("gh pr merge 142 --squash"), "ask:gh.merge", "ask:gh.merge"],
    ["comment on a PR", sh("gh pr comment 142 --body done"), "pass", "ask:gh.post"],
    ["POST through gh api", sh("gh api -X POST repos/o/r/issues -f title=x"), "pass", "ask:gh.post"],
    ["read through gh api", sh("gh api repos/o/r/pulls"), "pass", "pass"],
    ["publish a package", sh("npm publish"), "ask:publish", "ask:publish"],
    ["cut a release", sh("gh release create v1.0.0"), "ask:publish", "ask:publish"],
    ["deploy to production", sh("vercel deploy --prod"), "ask:deploy", "ask:deploy"],
    ["apply terraform", sh("terraform apply -auto-approve"), "ask:deploy", "ask:deploy"],
    ["set a secret", sh("gh secret set TOKEN"), "ask:secrets", "ask:secrets"],
    ["POST with curl", sh("curl -X POST https://api.example.com -d @body.json"), "ask:http.send", "ask:http.send"],
    ["GET with curl", sh("curl -s https://example.com"), "pass", "pass"],
    ["rm -rf outside its folder", sh("rm -rf /tmp/build"), "ask:rm.outside", "ask:rm.outside"],
    ["rm -rf inside its folder", sh("rm -rf library/old"), "pass", "pass"],
    ["rm without -r outside", sh("rm /tmp/x.txt"), "pass", "pass"],
    ["write outside its folder", call("Write", { file_path: `${PROJECT}/x.ts`, content: "x" }), "pass", "ask:fs.outside"],
    ["write inside its folder", call("Write", { file_path: "notes.md", content: "x" }), "pass", "pass"],
    ["send through a connector", call("mcp__slack__send_message", { channel: "#x", text: "hi" }), "ask:connector.act", "ask:connector.act"],
    ["read through a connector", call("mcp__slack__list_channels", {}), "pass", "pass"],
    ["create a bot", claudio("create_bot", { name: "x", job: "y" }), "pass", "ask:claudio.create_bot"],
    ["start an agent", claudio("start_agent", { title: "t", prompt: "p", project: "app" }), "pass", "ask:claudio.start_agent"],
    ["change a routine", claudio("set_routine", { name: "d", schedule: "0 8 * * *", prompt: "p" }), "pass", "ask:claudio.routines"],
    ["message a bot", claudio("message_bot", { bot: "x", text: "y" }), "pass", "pass"],
    ["ask the user", claudio("ask", { question: "q", options: ["a", "b"] }), "pass", "pass"],
    ["read a file", call("Read", { file_path: "CLAUDE.md" }), "pass", "pass"],
    [
      "a claudio lookalike from a user server is a connector",
      call("mcp__claudio__create_bot", { name: "x", job: "y" }, { mcpServer: { name: "claudio", source: "user" } }),
      "ask:connector.act",
      "ask:connector.act",
    ],
  ];
  for (const [name, c, attendedCell, unattendedCell] of cases) {
    test(name, () => {
      expect(verdict(c, { initiator: user })).toBe(attendedCell);
      expect(verdict(c, { initiator: system })).toBe(unattendedCell);
    });
  }

  test("an ask carries the signature Always and Never would cover and says what Always means", () => {
    expect(decide(sh("git push origin main"), ctx())).toEqual({
      kind: "ask",
      rule: "git.push.default",
      label: "Push to the default branch",
      signature: "Bash:git.push.default" as Signature,
      always: "Push to the default branch, without asking, in turns you start",
    });
    expect(decide(call("mcp__slack__send_message", { text: "hi" }), ctx({ initiator: routine }))).toMatchObject({
      signature: "mcp__slack__send_message:connector.act",
      label: "Act through a connector: slack send_message",
      always: "Act through a connector: slack send_message, without asking, in any turn, routines included",
    });
  });
});

describe("Bash segments", () => {
  const cases: [string, string, string][] = [
    ["a risky command after a safe one", "git status && git push origin main", "ask:git.push.default"],
    ["the strictest segment wins", "git push origin feature && npm publish", "ask:publish"],
    ["through a pipe", "npm test | tee log && npm publish", "ask:publish"],
    ["after a cd", "cd repo; git push --force", "ask:git.rewrite"],
    ["behind sudo", "sudo git push origin main", "ask:git.push.default"],
    ["behind env and an assignment", "env FOO=1 BAR=2 npm publish", "ask:publish"],
    ["behind timeout", "timeout 60 npm publish", "ask:publish"],
    ["by absolute path", "/usr/bin/git push origin main", "ask:git.push.default"],
    ["inside bash -c", "bash -lc 'gh pr merge 1'", "ask:gh.merge"],
    ["inside eval", 'eval "npm publish"', "ask:publish"],
    ["inside a command substitution", "x=$(git push origin main)", "ask:git.push.default"],
    ["inside backticks", "echo `npm publish`", "ask:publish"],
    ["inside if/then", "if true; then git push origin main; fi", "ask:git.push.default"],
    ["inside a subshell", "(cd repo && npm publish)", "ask:publish"],
    ["quoted text is an argument, not a command", 'echo "git push origin main"', "pass"],
    ["a commit message is an argument too", 'git commit -m "fix; git push origin main"', "pass"],
    ["a comment does not run", "ls # npm publish", "pass"],
    ["a redirection does not hide the command after it", "npm test 2>&1 | tee log && npm publish", "ask:publish"],
    ["a line continuation joins one command", "npm \\\n  publish", "ask:publish"],
  ];
  for (const [name, command, expected] of cases) test(name, () => expect(verdict(sh(command))).toBe(expected));
});

describe("fail closed", () => {
  test("a realpath that throws denies at the floors", () => {
    const realpath = () => {
      throw new Error("EACCES");
    };
    expect(decide(call("Read", { file_path: "x" }), ctx({ realpath }))).toMatchObject({ kind: "deny", via: "floor" });
    expect(decide(call("mcp__slack__list_channels", {}), ctx({ realpath }))).toMatchObject({ kind: "deny", via: "floor", rule: "floor.bridge" });
  });
  test("nested shell scripts are read a few levels deep, and deeper ones are denied, not skipped", () => {
    const nest = (command: string, levels: number) => Array.from({ length: levels }).reduce<string>((c) => `bash -c ${JSON.stringify(c)}`, command);
    expect(verdict(sh(nest("npm publish", 3)))).toBe("ask:publish");
    expect(decide(sh(nest("ls", 6)), ctx())).toMatchObject({ kind: "deny" });
  });
  test("standing rules that cannot be read deny instead of passing", () => {
    const rules = new Proxy([] as StandingRule[], {
      get() {
        throw new Error("corrupt");
      },
    });
    expect(decide(sh("git push origin main"), ctx({ rules }))).toMatchObject({ kind: "deny", via: "never" });
  });
  test("daily counts that cannot be read deny instead of passing", () => {
    const callsToday = new Proxy({}, {
      get() {
        throw new Error("corrupt");
      },
    });
    expect(decide(call("mcp__claudio__create_bot", { name: "x", job: "y" }), ctx({ callsToday }))).toMatchObject({ kind: "deny", via: "limit" });
  });
});

describe("the SDK's own calls", () => {
  test("Agent and SubagentHandback always pass", () => {
    const capped = { initiator: routine, headroom: { ok: false as const, reason: "agent_budget" as const } };
    expect(verdict(call("Agent", { prompt: "look around", subagent_type: "general-purpose" }), capped)).toBe("pass");
    expect(verdict(call("SubagentHandback", { result: "done" }, { subagent: { id: "a57b", type: "general-purpose" } }), capped)).toBe("pass");
  });
  test("a subagent's own tool calls are gated like any other", () => {
    expect(verdict(sh("git push origin main", { subagent: { id: "a57b", type: "general-purpose" } }))).toBe("ask:git.push.default");
  });
});

describe("fingerprint", () => {
  test("Bash counts only the command", () => {
    expect(fingerprint(sh("ls -la"))).toBe(fingerprint(call("Bash", { command: " ls -la\n", timeout: 5000, run_in_background: true })));
    expect(fingerprint(sh("ls -la"))).not.toBe(fingerprint(sh("ls -l")));
  });
  test("other tools count the whole input, whatever its key order", () => {
    expect(fingerprint(call("mcp__x__do", { a: 1, b: { c: 2, d: 3 } }))).toBe(fingerprint(call("mcp__x__do", { b: { d: 3, c: 2 }, a: 1 })));
    expect(fingerprint(call("Write", { file_path: "a", content: "one" }))).not.toBe(fingerprint(call("Write", { file_path: "a", content: "two" })));
    expect(fingerprint(call("Write", { file_path: "a", content: "one" }))).not.toBe(fingerprint(call("Write", { file_path: "b", content: "one" })));
  });
  test("the tool is part of it", () => {
    expect(fingerprint(sh("ls"))).not.toBe(fingerprint(call("mcp__x__run", { command: "ls" })) as Fingerprint);
    expect(fingerprint(sh("ls")).startsWith("Bash:")).toBe(true);
  });
});

describe("detailOf", () => {
  test("Bash shows the exact command", () => {
    expect(detailOf(sh("  git push origin main  "))).toBe("git push origin main");
  });
  test("secrets in a command are masked", () => {
    const d = detailOf(sh('curl -H "Authorization: Bearer abcd1234efgh5678" https://api.example.com'));
    expect(d).not.toContain("abcd1234efgh5678");
    expect(d).toContain("«redacted:16 chars»");
  });
  test("Write shows the path and line count, never the content", () => {
    expect(detailOf(call("Write", { file_path: "notes.md", content: "a\nb\n" }))).toBe("Write notes.md (2 lines)");
  });
  test("an MCP call shows compact JSON, cut at 500 characters", () => {
    expect(detailOf(call("mcp__slack__send_message", { channel: "#x", text: "hi" }))).toBe('mcp__slack__send_message {"channel":"#x","text":"hi"}');
    const long = detailOf(call("mcp__slack__send_message", { text: "word ".repeat(200) }));
    expect(long.length).toBeLessThan(560);
    expect(long).toContain("more chars)");
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
