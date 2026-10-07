export type ShellToken = { kind: "word"; value: string } | { kind: "op"; value: string };

export interface ShellParse {
  tokens: ShellToken[];
  substitution: boolean;
}

export interface ShellSegment {
  words: string[];
  redirects: { op: string; target: string | null }[];
}

export class ShellParseError extends Error {}

const OPS = ["&>>", "<<<", "||", "&&", "|&", ";;", ">>", ">|", "&>", ">&", "<<", "<&", "<>", "|", ";", "&", ">", "<"];
const CONTROL_OPS = new Set(["||", "&&", "|", "|&", ";", ";;", "&"]);

export function tokenizeShell(input: string): ShellParse {
  const tokens: ShellToken[] = [];
  let substitution = false;
  let buf = "";
  let inWord = false;
  let quoted = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: buf });
    buf = "";
    inWord = false;
    quoted = false;
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ShellParseError("unterminated single quote");
      buf += input.slice(i + 1, end);
      inWord = true;
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      quoted = true;
      for (;;) {
        if (i >= input.length) throw new ShellParseError("unterminated double quote");
        const d = input[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        if (d === "`" || (d === "$" && input[i + 1] === "(")) substitution = true;
        buf += d;
        i++;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= input.length) throw new ShellParseError("trailing backslash");
      if (input[i + 1] !== "\n") {
        buf += input[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "`" || (c === "$" && input[i + 1] === "(") || ((c === "<" || c === ">") && input[i + 1] === "(")) {
      substitution = true;
    }
    if (c === "\n") {
      flush();
      tokens.push({ kind: "op", value: ";" });
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = input.indexOf("\n", i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    const op = OPS.find((o) => input.startsWith(o, i));
    if (op) {
      if (inWord && !quoted && /^\d+$/.test(buf) && (op[0] === ">" || op[0] === "<")) {
        buf = "";
        inWord = false;
      } else {
        flush();
      }
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    buf += c;
    inWord = true;
    i++;
  }
  flush();
  return { tokens, substitution };
}

export function splitSegments(tokens: ShellToken[]): ShellSegment[] {
  const out: ShellSegment[] = [];
  let cur: ShellSegment = { words: [], redirects: [] };
  const push = () => {
    if (cur.words.length || cur.redirects.length) out.push(cur);
    cur = { words: [], redirects: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "op" && CONTROL_OPS.has(t.value)) {
      push();
      continue;
    }
    if (t.kind === "op") {
      const next = tokens[i + 1];
      const target = next?.kind === "word" ? next.value : null;
      if (target !== null) i++;
      cur.redirects.push({ op: t.value, target });
      continue;
    }
    cur.words.push(t.value);
  }
  push();
  return out;
}
