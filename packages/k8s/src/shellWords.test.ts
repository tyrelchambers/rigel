import { describe, expect, it } from "vitest";
import { flagValues, parseShell, ShellParseError, splitHead, splitSegments, tokenizeShell } from "./shellWords";

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

describe("parseShell", () => {
  it.each([
    ["ls *.log", [false, true]],
    ["ls '*.log'", [false, false]],
    ['ls "*.log"', [false, false]],
    ["ls \\*.log", [false, false]],
    ["echo a'*'b*", [false, true]],
    ["echo {a,b}", [false, true]],
    ["echo '{a,b}'", [false, false]],
    ["cat ~/x", [false, true]],
    ["cat '~/x'", [false, false]],
    ["kubectl get pods -o jsonpath='{.items[*]}'", [false, false, false, false, false]],
  ])("%s marks unquoted glob words as %j", (cmd, globs) => {
    expect(parseShell(cmd)!.segments[0]!.wordGlobs).toEqual(globs);
  });

  it("returns null instead of throwing on a parse error", () => {
    expect(parseShell("echo 'oops")).toBeNull();
    expect(parseShell("echo ok")).toEqual({
      segments: [{ words: ["echo", "ok"], wordGlobs: [false, false], redirects: [] }],
      substitution: false,
    });
  });
});

describe("splitHead", () => {
  it.each([
    ["kubectl", { dir: null, name: "kubectl" }],
    ["/usr/bin/kubectl", { dir: "/usr/bin", name: "kubectl" }],
    ["/x", { dir: "", name: "x" }],
    ["./uptime", { dir: ".", name: "uptime" }],
  ])("%s", (word, parts) => {
    expect(splitHead(word)).toEqual(parts);
  });
});

describe("flagValues", () => {
  it("reads both the separate and the = form, every occurrence", () => {
    expect(flagValues(["--context", "a", "get", "--context=b", "--context="], ["--context"])).toEqual(["a", "b"]);
    expect(flagValues(["get", "--context"], ["--context"])).toEqual([]);
  });
});
