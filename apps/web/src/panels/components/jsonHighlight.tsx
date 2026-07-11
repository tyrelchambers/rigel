import { Fragment } from "react";

const TOKEN_RE = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}[\],:]|\s+/g;
const WHITESPACE_RE = /^\s+$/;
const KEY_FOLLOWS_RE = /^\s*:/;
const NUMBER_OR_LITERAL_RE = /^(?:-?\d|true|false|null)/;

const KEY_COLOR = "#7DD3FC";
const STRING_COLOR = "#10B981";
const NUMBER_COLOR = "#E2B33E";
const PUNCTUATION_COLOR = "#6B6B73";

/** Pretty-printed, syntax-highlighted JSON for the expanded annotation/label blocks. */
export function JsonHighlight({ data }: { data: unknown }) {
  const pretty = JSON.stringify(data, null, 2);
  const tokens = [...pretty.matchAll(TOKEN_RE)];
  return (
    <pre className="whitespace-pre-wrap font-mono text-xs" style={{ lineHeight: 1.5, margin: 0 }}>
      {tokens.map((match, i) => {
        const text = match[0];
        if (WHITESPACE_RE.test(text)) return <Fragment key={i}>{text}</Fragment>;
        if (text[0] === '"') {
          const rest = pretty.slice(match.index + text.length);
          const isKey = KEY_FOLLOWS_RE.test(rest);
          return (
            <span key={i} style={{ color: isKey ? KEY_COLOR : STRING_COLOR }}>
              {text}
            </span>
          );
        }
        if (NUMBER_OR_LITERAL_RE.test(text)) {
          return (
            <span key={i} style={{ color: NUMBER_COLOR }}>
              {text}
            </span>
          );
        }
        return (
          <span key={i} style={{ color: PUNCTUATION_COLOR }}>
            {text}
          </span>
        );
      })}
    </pre>
  );
}
