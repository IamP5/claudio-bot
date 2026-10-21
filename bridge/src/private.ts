import type { Platform } from "./machine/profile";

// What no bot or agent may reach under the user's home, as paths relative to it, per platform. The gate's floors
// (policy.ts) refuse every tool call that names one, and the sandbox (sandbox.ts) denies all of them to every Bash
// command at the OS level.
export type PrivatePaths = Readonly<Record<"bridge" | "keys" | "browser" | "creds" | "personal", readonly string[]>>;

const BRIDGE = [".claudiobot", ".claudebot"];

const KEYS = [".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud"];

const CREDS = [
  // .netrc also holds the Heroku CLI's token.
  ".netrc",
  ".config/gh",
  ".config/op",
  ".kube",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  ".git-credentials",
  ".password-store",
  ".claude.json",
  ".claude/.credentials.json",
  ".claude/history.jsonl",
  ".claude/projects",
  ".local/share/com.vercel.cli",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".terraform.d/credentials.tfrc.json",
  ".gem/credentials",
  // Not .terraformrc or .m2/settings.xml: builds read them for mirrors and proxies, and a token in either should move
  // to credentials.tfrc.json or settings-security.xml, which stay private.
  ".m2/settings-security.xml",
  ".config/stripe",
  ".config/doctl",
  ".netlify",
  ".config/configstore/firebase-tools.json",
  ".oci",
  // Shell and REPL histories hold whatever was typed inline: tokens, passwords, connection strings.
  ".zsh_history",
  ".zsh_sessions",
  ".bash_history",
  ".bash_sessions",
  ".local/share/fish/fish_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".sqlite_history",
  ".cursor/mcp.json",
  ".cursor/cli-config.json",
  ".cursor/projects",
];

export const PRIVATE: Readonly<Record<Platform, PrivatePaths>> = {
  darwin: {
    bridge: BRIDGE,
    keys: [...KEYS, "Library/Keychains"],
    browser: [
      "Library/Application Support/Google/Chrome",
      "Library/Application Support/Google/Chrome Beta",
      "Library/Application Support/Chromium",
      "Library/Application Support/BraveSoftware",
      "Library/Application Support/Firefox",
      "Library/Application Support/Mozilla",
      "Library/Application Support/Arc",
      "Library/Application Support/Microsoft Edge",
      "Library/Application Support/com.operasoftware.Opera",
      "Library/Application Support/Vivaldi",
      "Library/Application Support/Orion",
      "Library/Application Support/Zen",
      "Library/Application Support/Slack",
      "Library/Application Support/discord",
      "Library/Safari",
      "Library/Containers/com.apple.Safari",
      "Library/Cookies",
    ],
    creds: [
      ...CREDS,
      "Library/Application Support/1Password",
      "Library/Application Support/com.vercel.cli",
      "Library/Application Support/doctl",
      "Library/Preferences/netlify",
      // The Claude desktop app's login, MCP server env and sessions; not the whole folder, which holds worktrees and
      // scratch workspaces that can be projects.
      "Library/Application Support/Claude/claude_desktop_config.json",
      "Library/Application Support/Claude/config.json",
      "Library/Application Support/Claude/buddy-tokens.json",
      "Library/Application Support/Claude/Cookies",
      "Library/Application Support/Claude/Local State",
      "Library/Application Support/Claude/Local Storage",
      "Library/Application Support/Claude/IndexedDB",
      "Library/Application Support/Claude/Session Storage",
      "Library/Application Support/Claude/Partitions",
      "Library/Application Support/Claude/claude-code-sessions",
      "Library/Application Support/Cursor",
    ],
    personal: ["Library/Messages", "Library/Mail", "Library/Application Support/AddressBook", "Library/Calendars"],
  },
  linux: {
    bridge: BRIDGE,
    // GNOME Keyring and KDE Wallet stand where the macOS Keychain does.
    keys: [...KEYS, ".local/share/keyrings", ".local/share/kwalletd"],
    browser: [
      ".config/google-chrome",
      ".config/google-chrome-beta",
      ".config/chromium",
      ".config/BraveSoftware",
      ".mozilla",
      ".config/microsoft-edge",
      ".config/opera",
      ".config/vivaldi",
      ".zen",
      ".config/Slack",
      ".config/discord",
    ],
    creds: [...CREDS, ".config/1Password", ".config/netlify", ".config/Claude", ".config/Cursor"],
    personal: [".thunderbird", ".local/share/evolution", ".config/evolution"],
  },
};
