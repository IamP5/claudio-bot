// A small shell tokenizer, pure. policy.ts turns the words into path touches and command rows; this file only knows
// how a line splits into simple commands and words, which words are redirect targets, and where a word stops being a
// literal path (its first unquoted $ ` * ? [ { ). It is best effort: the auto classifier still screens whatever passes.
//
// Heredocs are stripped before the main scan (stripHeredocs): a `<<[-]WORD` body is skipped so its text cannot desync
// the quote/paren scanners (the classic `git commit -m "$(cat <<'EOF' … EOF)"` would otherwise hide every later command).
// An unquoted delimiter means the body is expanded, so command substitutions inside it are still parsed; a quoted
// delimiter (`'EOF'`, `"EOF"`, `\EOF`) means a literal body, which is skipped whole.

/** A word of a simple command, after quotes and escapes are removed. */
export type Word = {
  /** The whole word, de-quoted. `$VAR`, `${…}`, `$(…)` and backticks stay as their literal source. */
  text: string;
  /** `text` up to its first unquoted shell metacharacter ($ ` * ? [ {). Equals `text` when the word is a plain path. */
  literal: string;
  /** text !== literal: the word carries an unresolved expansion or glob, so only its literal prefix is a known path. */
  dynamic: boolean;
  /** The word is the operand of a redirect (`<`, `>`, `>>`, `&>`, `>&`, `<<<`, …), so it is a path even behind a `-`. */
  redirect: boolean;
  /** The redirect that this word is the operand of writes the file (`>`, `>>`, `&>`, `>&`, `>|`), rather than reads it. */
  redirectOut: boolean;
  /** The word carries unquoted brace expansion (`{a,b}`), so its literal is one of several alternatives. */
  brace: boolean;
};

/** One simple command: its words in order and the raw source slice it came from (for the raw-text scan). */
type Command = {
  words: Word[];
  raw: string;
  /** Paren/substitution nesting. 0 is the top level; anything deeper is a subshell whose `cd` cannot leak outward. */
  subshell: number;
  /** The command runs only if the one before it did (it follows `&&`, `||`, `|`): a `cd` here may not have happened. */
  cond: boolean;
};

/** Nesting of command substitutions past this is a denial, not a parse: it stops quadratic blowup on crafted input. */
const MAX_DEPTH = 48;

const META = new Set(["$", "`", "*", "?", "[", "{"]);
const isDigits = (s: string) => s.length > 0 && /^\d+$/.test(s);

/** Index of the backtick that closes the one at `open`, honouring `\\\``. End of string if unterminated. */
function scanBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  return src.length;
}

/** A backtick body as the shell runs it: inside backticks a backslash escapes only `$`, a backtick and itself, so an
 *  escaped inner backtick becomes a real one and nests a second substitution. */
const unescapeBacktick = (body: string) => body.replace(/\\([$`\\])/g, "$1");

/** Index of the `)` that closes the `(` at `open`, honouring quotes, escapes and nested `(`. End of string if unbalanced. */
export function closing(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j === -1 ? src.length : j;
    } else if (c === '"') i = skipDouble(src, i);
    else if (c === "`") i = scanBacktick(src, i);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/** Index of the `"` that closes the one at `open`, skipping `\"` and nested `$(…)`. End of string if unterminated. */
function skipDouble(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && src[i + 1] === "(") i = closing(src, i + 1);
    else if (c === "`") i = scanBacktick(src, i);
  }
  return src.length;
}

type Heredoc = { delim: string; expand: boolean; strip: boolean };

/** The heredoc operators on one line, and the line with those operators (but not here-strings) excised. */
function findHeredocOps(line: string): { cleaned: string; heredocs: Heredoc[] } {
  const heredocs: Heredoc[] = [];
  const keep: string[] = [];
  // A tiny context stack so `<<` is read as a heredoc only at command level, never inside quotes or `$((…))` arithmetic.
  const stack: ("code" | "dq")[] = ["code"];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    const top = stack[stack.length - 1];
    if (c === "\\") {
      keep.push(line.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (top === "code" && c === "'") {
      const j = line.indexOf("'", i + 1);
      const end = j === -1 ? line.length : j;
      keep.push(line.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      if (top === "dq") stack.pop();
      else stack.push("dq");
      keep.push(c);
      i++;
      continue;
    }
    if (c === "`") {
      const end = scanBacktick(line, i);
      keep.push(line.slice(i, Math.min(end + 1, line.length)));
      i = Math.min(end + 1, line.length);
      continue;
    }
    if (c === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      // Arithmetic `$((…))`: skip whole, so a `<<` shift operator is never read as a heredoc.
      const end = closing(line, i + 2);
      keep.push(line.slice(i, Math.min(end + 2, line.length)));
      i = Math.min(end + 2, line.length);
      continue;
    }
    if ((top === "code" || top === "dq") && c === "$" && line[i + 1] === "(") {
      stack.push("code");
      keep.push(line.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (top !== "dq" && c === "(" && line[i + 1] === "(") {
      const end = closing(line, i + 1);
      keep.push(line.slice(i, Math.min(end + 2, line.length)));
      i = Math.min(end + 2, line.length);
      continue;
    }
    if (top === "code" && c === ")" && stack.length > 1) {
      stack.pop();
      keep.push(c);
      i++;
      continue;
    }
    if (top === "code" && c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      keep.push(line.slice(i));
      break;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
      keep.push("<<<"); // a here-string's operand is a word, not a heredoc delimiter
      i += 3;
      continue;
    }
    if ((top === "code" || top === "dq") && c === "<" && line[i + 1] === "<") {
      let k = i + 2;
      const strip = line[k] === "-";
      if (strip) k++;
      while (line[k] === " " || line[k] === "\t") k++;
      let delim = "";
      let expand = true;
      if (line[k] === "'" || line[k] === '"') {
        const q = line[k]!;
        const j = line.indexOf(q, k + 1);
        const end = j === -1 ? line.length : j;
        delim = line.slice(k + 1, end);
        expand = false;
        k = end + 1;
      } else {
        while (k < line.length && !/[\s;&|<>()#]/.test(line[k]!)) {
          if (line[k] === "\\") {
            expand = false;
            k++;
            if (k < line.length) delim += line[k];
          } else if (line[k] === "'" || line[k] === '"') {
            expand = false;
          } else delim += line[k];
          k++;
        }
      }
      if (delim !== "") {
        heredocs.push({ delim, expand, strip });
        i = k; // excise the whole `<<[-]DELIM`
        continue;
      }
    }
    keep.push(c);
    i++;
  }
  return { cleaned: keep.join(""), heredocs };
}

/** Command-substitution bodies found inside an expanded heredoc body, so a `$(…)` there is still parsed. */
function extractSubsts(body: string, out: string[]): void {
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") i++;
    else if (c === "$" && body[i + 1] === "(") {
      const end = closing(body, i + 1);
      out.push(body.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      const end = scanBacktick(body, i);
      out.push(unescapeBacktick(body.slice(i + 1, end)));
      i = end;
    }
  }
}

/** Remove heredoc bodies so the main scan never sees them. Returns the cleaned source and the substitution bodies of
 *  expanded heredocs (parsed as their own commands). */
function stripHeredocs(src: string): { code: string; extra: string[] } {
  if (!src.includes("<<")) return { code: src, extra: [] };
  const lines = src.split("\n");
  const code: string[] = [];
  const extra: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const { cleaned, heredocs } = findHeredocOps(lines[i]!);
    code.push(cleaned);
    i++;
    for (const hd of heredocs) {
      const bodyLines: string[] = [];
      while (i < lines.length) {
        const line = lines[i]!;
        const term = hd.strip ? line.replace(/^\t+/, "") : line;
        if (term === hd.delim) {
          i++;
          break;
        }
        bodyLines.push(hd.strip ? line.replace(/^\t+/, "") : line);
        i++;
      }
      if (hd.expand) extractSubsts(bodyLines.join("\n"), extra);
    }
  }
  return { code: code.join("\n"), extra };
}

/**
 * Split a shell line into simple commands. Breaks on ; & | && || newlines and parentheses outside quotes. Command
 * substitutions ($(…), `…`, <(…), >(…)) are parsed as commands of their own, listed before the command that holds them,
 * so a dangerous command hidden in a substitution is still seen. Throws when substitutions nest past MAX_DEPTH.
 */
export function shellCommands(src: string): Command[] {
  const out: Command[] = [];
  const { code, extra } = stripHeredocs(src);
  parse(code, 0, out, 0, false);
  for (const body of extra) parse(body, 1, out, 1, false);
  return out;
}

function parse(src: string, depth: number, out: Command[], scope: number, startCond: boolean): void {
  if (depth > MAX_DEPTH) throw new Error("shell command nested too deep to read");
  let words: Word[] = [];
  let rawStart = 0;
  let parenDepth = 0;
  let cond = startCond;
  let nextCond = false;

  let text = "";
  let literal = "";
  let meta = false;
  let brace = false;
  let inWord = false;
  let redirect = false;
  let redirectOut = false;
  let pendingRedirect = false;
  let pendingOut = false;

  const arm = () => {
    if (pendingRedirect && !inWord) {
      redirect = true;
      redirectOut = pendingOut;
      pendingRedirect = false;
    }
  };
  const addQuoted = (s: string) => {
    arm();
    text += s;
    if (!meta) literal += s;
    inWord = true;
  };
  const addRaw = (c: string) => {
    arm();
    text += c;
    if (c === "{") brace = true;
    if (!meta) {
      if (META.has(c)) meta = true;
      else literal += c;
    }
    inWord = true;
  };
  const reset = () => {
    text = "";
    literal = "";
    meta = false;
    brace = false;
    inWord = false;
    redirect = false;
    redirectOut = false;
  };
  const endWord = () => {
    if (inWord) words.push({ text, literal, dynamic: meta, redirect, redirectOut, brace });
    reset();
  };
  const endSegment = (rawEnd: number) => {
    endWord();
    if (words.length > 0) out.push({ words, raw: src.slice(rawStart, rawEnd).trim(), subshell: scope + parenDepth, cond });
    words = [];
    rawStart = rawEnd;
    cond = nextCond;
    nextCond = false;
  };
  const substitute = (start: number, bodyStart: number, end: number, backtick = false) => {
    arm();
    const body = src.slice(bodyStart, end);
    parse(backtick ? unescapeBacktick(body) : body, depth + 1, out, scope + parenDepth + 1, false);
    const slice = src.slice(start, Math.min(end + 1, src.length));
    text += slice;
    meta = true; // a substitution is never a literal path prefix
    inWord = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      if (i + 1 < src.length && src[i + 1] !== "\n") addQuoted(src[i + 1]!);
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      addQuoted(src.slice(i + 1, end));
      i = end;
    } else if (c === "$" && src[i + 1] === "'") {
      const end = ansiC(src, i + 2);
      addQuoted(unescapeAnsiC(src.slice(i + 2, end)));
      i = end;
    } else if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") {
      const end = closing(src, i + 1);
      substitute(i, i + 2, end);
      i = end;
    } else if (c === '"' || (c === "$" && src[i + 1] === '"')) {
      const open = c === "$" ? i + 1 : i;
      arm();
      inWord = true;
      for (i = open + 1; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\" && i + 1 < src.length) addQuoted(src[++i]!);
        else if (src[i] === "$" && src[i + 1] === "(") {
          const end = closing(src, i + 1);
          substitute(i, i + 2, end);
          i = end;
        } else if (src[i] === "`") {
          const end = scanBacktick(src, i);
          substitute(i, i + 1, end, true);
          i = end;
        } else if (src[i] === "$") addRaw("$");
        else addQuoted(src[i]!);
      }
    } else if (c === "`") {
      const end = scanBacktick(src, i);
      substitute(i, i + 1, end, true);
      i = end;
    } else if (c === "#" && !inWord) {
      const j = src.indexOf("\n", i);
      i = j === -1 ? src.length : j - 1;
    } else if (c === "<" || c === ">" || (c === "&" && (src[i + 1] === ">" || src[i + 1] === "<"))) {
      // Leading bare digits are the redirect's fd, not a word of their own.
      if (inWord && isDigits(text)) reset();
      else endWord();
      const opEnd = consumeRedirect(src, i);
      pendingOut = src.slice(i, opEnd).includes(">");
      i = opEnd - 1;
      pendingRedirect = true;
    } else if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
      const twoChar = (c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|");
      // A command after && || | may not have run, so its cd is uncertain; ; & newline ( ) start a fresh, certain segment.
      nextCond = twoChar || c === "|";
      endSegment(i);
      if (c === "(") parenDepth++;
      else if (c === ")" && parenDepth > 0) parenDepth--;
      if (twoChar) i++;
      rawStart = i + 1;
      pendingRedirect = false;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      addRaw(c);
    }
  }
  endSegment(src.length);
}

/** Past the opening `$'`, the index of the closing `'`, honouring `\'`. */
function ansiC(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "'") return i;
  }
  return src.length;
}

const ANSI_SIMPLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b", "?": "?" };
const hexVal = (s: string) => Number.parseInt(s, 16);
/** Decode a `$'…'` body: simple escapes plus \xHH, \0ooo / \ooo octal, \uHHHH, \UHHHHHHHH, and \cX control chars. */
function unescapeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\" || i + 1 >= body.length) {
      out += body[i];
      continue;
    }
    const n = body[++i]!;
    if (n === "x") {
      let h = "";
      while (h.length < 2 && /[0-9a-fA-F]/.test(body[i + 1] ?? "")) h += body[++i];
      out += h ? String.fromCharCode(hexVal(h)) : "x";
    } else if (n === "u" || n === "U") {
      const max = n === "u" ? 4 : 8;
      let h = "";
      while (h.length < max && /[0-9a-fA-F]/.test(body[i + 1] ?? "")) h += body[++i];
      out += h ? String.fromCodePoint(hexVal(h)) : n;
    } else if (n >= "0" && n <= "7") {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) o += body[++i];
      out += String.fromCharCode(Number.parseInt(o, 8) & 0xff);
    } else if (n === "c") {
      const x = body[++i];
      out += x === undefined ? "c" : String.fromCharCode(x.toUpperCase().charCodeAt(0) ^ 0x40);
    } else out += ANSI_SIMPLE[n] ?? n;
  }
  return out;
}

/** Past a redirect operator starting at `i`, the index just after it. Handles `>> &>> &> >& >| <<< << <& <> < >`. */
function consumeRedirect(src: string, i: number): number {
  let j = i;
  if (src[j] === "&") j++; // &> &>>
  while (src[j] === "<" || src[j] === ">") j++; // >, >>, <, <<, <<<
  if (src[j] === "&" || src[j] === "|") j++; // >&, <&, >|
  return j;
}
