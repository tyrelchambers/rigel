import { describe, expect, it } from "vitest";
import { ShellParseError, splitSegments, tokenizeShell } from "./shellWords";

const words = (s: string) => splitSegments(tokenizeShell(s).tokens).map((g) => g.words);

describe("tokenizeShell", () => {
  it("keeps quoted text as one word", () => {
    expect(words(`ssh web-1 'journalctl -u nginx | grep err'`)).toEqual([
      ["ssh", "web-1", "journalctl -u nginx | grep err"],
    ]);
  });

  it("splits on control operators outside quotes", () => {
    expect(words("a b | c && d; e || f & g")).toEqual([["a", "b"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
  });

  it("treats newlines as separators", () => {
    expect(words("a\nb")).toEqual([["a"], ["b"]]);
  });

  it("handles double quotes, escapes, and adjacent quoting", () => {
    expect(words(`echo "a \\"b\\" c" 'd'"e" f\\ g`)).toEqual([["echo", `a "b" c`, "de", "f g"]]);
  });

  it("collects redirects with targets and folds fd prefixes", () => {
    const [seg] = splitSegments(tokenizeShell("cat x 2>/dev/null >out 2>&1 <in").tokens);
    expect(seg!.words).toEqual(["cat", "x"]);
    expect(seg!.redirects).toEqual([
      { op: ">", target: "/dev/null" },
      { op: ">", target: "out" },
      { op: ">&", target: "1" },
      { op: "<", target: "in" },
    ]);
  });

  it("flags command and process substitution", () => {
    expect(tokenizeShell("echo $(id)").substitution).toBe(true);
    expect(tokenizeShell("echo `id`").substitution).toBe(true);
    expect(tokenizeShell(`echo "$(id)"`).substitution).toBe(true);
    expect(tokenizeShell("diff <(a) b").substitution).toBe(true);
    expect(tokenizeShell("echo '$(id)'").substitution).toBe(false);
  });

  it("drops comments", () => {
    expect(words("ls # rm -rf /")).toEqual([["ls"]]);
  });

  it("throws on unterminated quotes", () => {
    expect(() => tokenizeShell("echo 'oops")).toThrow(ShellParseError);
    expect(() => tokenizeShell('echo "oops')).toThrow(ShellParseError);
  });
});
