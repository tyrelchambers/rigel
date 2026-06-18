import { describe, it, expect } from "vitest";
import { parseDiff } from "./DiffView";

const SAMPLE = [
  "diff --git a/x.yaml b/x.yaml",
  "index 6f041de..7af57fe 100644",
  "--- a/x.yaml",
  "+++ b/x.yaml",
  "@@ -1,4 +1,3 @@",
  "-# old comment",
  " apiVersion: v1",
  " kind: Ingress",
  "-  tls:",
  "+  rules: []",
  "", // trailing newline artifact
].join("\n");

describe("parseDiff", () => {
  const { rows, adds, dels } = parseDiff(SAMPLE);

  it("counts additions and deletions", () => {
    expect(adds).toBe(1);
    expect(dels).toBe(2);
  });

  it("strips the git preamble", () => {
    expect(rows.some((r) => r.text.includes("diff --git"))).toBe(false);
    expect(rows.some((r) => r.text.includes("index "))).toBe(false);
    expect(rows.some((r) => r.text.startsWith("a/x.yaml") || r.text.startsWith("b/x.yaml"))).toBe(false);
  });

  it("drops the trailing-newline artifact (no empty trailing row)", () => {
    const last = rows[rows.length - 1];
    expect(last.text).toBe("  rules: []");
  });

  it("emits a hunk row first and seeds line numbers from its header", () => {
    expect(rows[0].kind).toBe("hunk");
    const firstDel = rows[1];
    expect(firstDel.kind).toBe("del");
    expect(firstDel.oldNo).toBe(1);
    expect(firstDel.newNo).toBeNull();
  });

  it("advances both gutters on context, only one on add/del", () => {
    const ctx = rows.find((r) => r.kind === "context")!;
    expect(ctx.oldNo).toBe(2);
    expect(ctx.newNo).toBe(1);
    const add = rows.find((r) => r.kind === "add")!;
    expect(add.oldNo).toBeNull();
    expect(add.newNo).toBe(3);
  });
});
