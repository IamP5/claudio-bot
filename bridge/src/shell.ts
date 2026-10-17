// A small shell tokenizer, pure. policy.ts turns the words into path touches and command rows; this file only knows
// how a line splits into simple commands and words, which words are redirect targets, and where a word stops being a
// literal path (its first unquoted $ ` * ? [ { ). It is best effort: the auto classifier still screens whatever passes.
// Owner: U1.

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
};

/** One simple command: its words in order and the raw source slice it came from (for the raw-text scan). */
export type Command = { words: Word[]; raw: string };

/** Nesting of command substitutions past this is a denial, not a parse: it stops quadratic blowup on crafted input. */
const MAX_DEPTH = 48;

const META = new Set(["$", "`", "*", "?", "[", "{"]);
const isDigits = (s: string) => s.length > 0 && /^\d+$/.test(s);

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
    else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      i = j === -1 ? src.length : j;
    } else if (c === "(") depth++;
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
    else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      i = j === -1 ? src.length : j;
    }
  }
  return src.length;
}

/**
 * Split a shell line into simple commands. Breaks on ; & | && || newlines and parentheses outside quotes. Command
 * substitutions ($(…), `…`, <(…), >(…)) are parsed as commands of their own, listed before the command that holds them,
 * so a dangerous command hidden in a substitution is still seen. Throws when substitutions nest past MAX_DEPTH.
 */
export function shellCommands(src: string): Command[] {
  const out: Command[] = [];
  parse(src, 0, out);
  return out;
}

function parse(src: string, depth: number, out: Command[]): void {
  if (depth > MAX_DEPTH) throw new Error("shell command nested too deep to read");
  let words: Word[] = [];
  let rawStart = 0;

  let text = "";
  let literal = "";
  let meta = false;
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
    inWord = false;
    redirect = false;
    redirectOut = false;
  };
  const endWord = () => {
    if (inWord) words.push({ text, literal, dynamic: meta, redirect, redirectOut });
    reset();
  };
  const endSegment = (rawEnd: number) => {
    endWord();
    if (words.length > 0) out.push({ words, raw: src.slice(rawStart, rawEnd).trim() });
    words = [];
    rawStart = rawEnd;
  };
  const substitute = (start: number, bodyStart: number, end: number) => {
    arm();
    parse(src.slice(bodyStart, end), depth + 1, out);
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
          const j = src.indexOf("`", i + 1);
          const end = j === -1 ? src.length : j;
          substitute(i, i + 1, end);
          i = end;
        } else if (src[i] === "$") addRaw("$");
        else addQuoted(src[i]!);
      }
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j === -1 ? src.length : j;
      substitute(i, i + 1, end);
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
      endSegment(i);
      if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) i++;
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

const ANSI_C: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", "0": "\0" };
function unescapeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) out += ANSI_C[body[++i]!] ?? body[i]!;
    else out += body[i];
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
