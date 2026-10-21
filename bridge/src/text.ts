import { createHash } from "node:crypto";

// Text that leaves the bridge for a phone, a chat, a log or the audit file: names, errors, and anything that may carry
// a secret. One rule set for each, so a name or a key is cleaned the same way wherever it shows.

export const errorText = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unprintable error";
  }
};

/** Push titles and every phone's bot list show a bot's name. */
export const BOT_NAME_MAX = 40;

/** Control and format characters (bidi overrides and zero-width ones included), but not the joiner inside an emoji. */
const HIDDEN = /(?!\u200D)[\p{Cc}\p{Cf}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

/** A name that would show something other than what it says. */
export const hasHiddenCharacters = (name: string): boolean => HIDDEN.test(name);

/** A name as a phone or a log shows it: one line, nothing hidden, at most `max` characters (the last an ellipsis). */
export function displayName(name: string, max: number): string {
  const chars = Array.from(name.replace(/\s+/g, " ").replace(HIDDEN_ALL, "").replace(/ {2,}/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}\u2026`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** A keyword (any `[\w-]*` prefix allowed, so AWS_SECRET_ACCESS_KEY= and MY_TOKEN= match) then its value after = or :. */
const ASSIGNED = String.raw`\b[\w-]*(?:password|passwd|pwd|secret|token|access[_-]?key|api[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?`;
/** A credential spoken in a header or a command line: "Bearer <value>". In prose the word after "token" is a word. */
const SPOKEN = String.raw`\b(?:Bearer|Basic|token)\s+`;
const keyed = (lead: string) => new RegExp(`(${lead})([^\\s"'&,;]{3,})`, "gi");
/** A URL's user:password, curl's -u user:pass, and mysql's -p<password>. The value is masked; the user is kept. */
const URL_CREDENTIAL = /(:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g;
const CURL_USER = /((?:-u|--user)\s+[^\s:]+:)(\S+)/g;
const MYSQL_PASSWORD = /(^|\s)(-p)([^\s]{2,})/g;
/** A long run mixing upper case, lower case and digits looks like a key. Commit SHAs (lower-case hex) do not. */
const LONG_RUN = /[A-Za-z0-9+_=-]{32,}/g;

const masked = (n: number) => `«redacted:${n} chars»`;

type Rule = readonly [RegExp, (match: string, ...groups: string[]) => string];
const maskValue = (_: string, lead: string, value: string) => lead + masked(value.length);
const URL_RULE: Rule = [URL_CREDENTIAL, (_, lead, value, tail) => lead + masked(value.length) + tail];
const SHAPES: readonly Rule[] = [
  ...SECRET_PATTERNS.map((p): Rule => [p, (m) => masked(m.length)]),
  [LONG_RUN, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? masked(m.length) : m)],
];
// Keyed rules run first so a keyed value is masked once, not twice.
const SECRET_RULES: readonly Rule[] = [[keyed(`${SPOKEN}|${ASSIGNED}`), maskValue], URL_RULE, [CURL_USER, maskValue], [MYSQL_PASSWORD, (_, pre, flag, value) => pre + flag + masked(value.length)], ...SHAPES];
const PROSE_RULES: readonly Rule[] = [[keyed(ASSIGNED), maskValue], URL_RULE, ...SHAPES];

const applying = (rules: readonly Rule[]) => (text: string) => rules.reduce((out, [re, to]) => out.replace(re, to), text);

/** Secret-shaped substrings of a command, an output or a log become «redacted:N chars». */
export const maskSecrets = applying(SECRET_RULES);

/**
 * maskSecrets for words a model wrote about a call (a description, a summary): assignments and key shapes are masked,
 * but not the word after "token", "Basic" or "Bearer", which in prose is an ordinary word.
 */
export const maskProse = applying(PROSE_RULES);

export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more chars)`);
const CLIP = 4096;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Tool-input keys whose value is a file's new contents, never a path and never worth keeping in an audit row. */
export const BODY_KEYS: ReadonlySet<string> = new Set(["content", "old_string", "new_string", "new_source"]);

/** A key whose value is a secret by its name alone, however short the value. */
const SECRET_KEY = /secret|token|password|passwd|passcode|api.?key|access.?key|authorization|cookie|credential|otp|totp|cvv|cvc|card.?number|private.?key|client.?secret/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function redactAt(value: unknown, key: string | null): unknown {
  if (typeof value === "string") {
    if (key !== null && BODY_KEYS.has(key)) return { bytes: Buffer.byteLength(value, "utf8"), sha256: sha256(value) };
    if (key !== null && SECRET_KEY.test(key)) return masked(value.length);
    return clip(maskSecrets(value), CLIP);
  }
  if (Array.isArray(value)) return value.map((v) => redactAt(v, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAt(v, k)]));
  return value;
}

/** For audit rows. Secret-shaped strings become «redacted:N chars», file bodies {bytes, sha256}, long strings clipped. */
export function redact(input: unknown): unknown {
  return redactAt(input, null);
}
