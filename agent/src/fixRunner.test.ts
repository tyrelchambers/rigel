import { describe, expect, test, vi } from "vitest";
import { parseFixSpec, serializeResult, runFix, type FixRunnerDeps } from "./fixRunner.js";
import type { FixSpec } from "./fixJob.js";
import type { RepoFixInput, RepoFixResult } from "@rigel/k8s/src/repoFix.js";

const SPEC: FixSpec = {
  source: { name: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" },
  filePath: "apps/memos/deployment.yaml",
  content: "kind: Deployment\n...",
  title: "Bump memos image to a healthy tag",
  body: "The pinned tag CrashLoops.",
};

describe("parseFixSpec", () => {
  test("round-trips a valid spec", () => {
    expect(parseFixSpec(JSON.stringify(SPEC))).toEqual(SPEC);
  });

  test("defaults source.path to '.' and tolerates a missing body", () => {
    const { body, ...noBody } = SPEC;
    const spec = parseFixSpec(JSON.stringify({ ...noBody, source: { ...noBody.source, path: undefined } }));
    expect(spec.source.path).toBe(".");
    expect(spec.body).toBeUndefined();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseFixSpec("{not json")).toThrow(/not valid JSON/);
  });

  test.each(["source", "filePath", "title"])("throws when %s is missing", (field) => {
    const obj = JSON.parse(JSON.stringify(SPEC)) as Record<string, unknown>;
    delete obj[field];
    expect(() => parseFixSpec(JSON.stringify(obj))).toThrow(new RegExp(field));
  });

  test("throws when content is not a string (empty content is allowed)", () => {
    expect(() => parseFixSpec(JSON.stringify({ ...SPEC, content: 5 }))).toThrow(/content/);
    expect(parseFixSpec(JSON.stringify({ ...SPEC, content: "" })).content).toBe("");
  });
});

describe("serializeResult", () => {
  test("emits ok + prUrl + branch on success", () => {
    const json = serializeResult({ ok: true, prUrl: "https://github.com/me/infra/pull/7", branch: "rigel/fix-x" });
    expect(JSON.parse(json)).toEqual({ ok: true, prUrl: "https://github.com/me/infra/pull/7", branch: "rigel/fix-x" });
  });

  test("omits absent optional fields", () => {
    expect(JSON.parse(serializeResult({ ok: false }))).toEqual({ ok: false });
  });

  test("truncates a huge message so the JSON stays under the byte cap", () => {
    const json = serializeResult({ ok: false, branch: "b", message: "x".repeat(20_000) }, 3500);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(3500);
    const parsed = JSON.parse(json) as { ok: boolean; branch: string; message: string };
    // The non-message fields survive intact and a truncation marker is present.
    expect(parsed.ok).toBe(false);
    expect(parsed.branch).toBe("b");
    expect(parsed.message.endsWith("…")).toBe(true);
  });

  test("does not corrupt multi-byte characters when truncating", () => {
    const json = serializeResult({ ok: false, message: "你好".repeat(5000) }, 200);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(200);
  });
});

describe("runFix", () => {
  function deps(over: Partial<FixRunnerDeps> = {}): { d: FixRunnerDeps; written: () => string | undefined; propose: ReturnType<typeof vi.fn> } {
    let written: string | undefined;
    const propose = vi.fn<(i: RepoFixInput) => Promise<RepoFixResult>>(async () => ({ ok: true, prUrl: "https://x/pull/1", branch: "rigel/fix-x", message: "ok" }));
    const d: FixRunnerDeps = {
      readSpec: async () => JSON.stringify(SPEC),
      getToken: () => "ghp_token",
      propose,
      writeResult: async (json) => { written = json; },
      ...over,
    };
    return { d, written: () => written, propose };
  }

  test("opens the PR with the spec + mounted token and writes a success result (exit 0)", async () => {
    const { d, written, propose } = deps();
    const code = await runFix(d);
    expect(code).toBe(0);
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({
      source: SPEC.source, token: "ghp_token", filePath: SPEC.filePath, content: SPEC.content, title: SPEC.title,
    }));
    expect(JSON.parse(written()!)).toMatchObject({ ok: true, prUrl: "https://x/pull/1" });
  });

  test("a failed PR (ok:false) writes the result and exits non-zero", async () => {
    const propose = vi.fn(async () => ({ ok: false, message: "GitHub PR creation failed" }) as RepoFixResult);
    const { d, written } = deps({ propose });
    expect(await runFix(d)).toBe(1);
    expect(JSON.parse(written()!)).toMatchObject({ ok: false, message: "GitHub PR creation failed" });
  });

  test("a malformed spec is reported (never reaches propose) and exits non-zero", async () => {
    const { d, written, propose } = deps({ readSpec: async () => "{bad" });
    expect(await runFix(d)).toBe(1);
    expect(propose).not.toHaveBeenCalled();
    expect(JSON.parse(written()!)).toMatchObject({ ok: false });
  });

  test("a thrown propose is captured into the result (never escapes)", async () => {
    const propose = vi.fn(async () => { throw new Error("git exploded"); });
    const { d, written } = deps({ propose: propose as never });
    expect(await runFix(d)).toBe(1);
    expect(JSON.parse(written()!)).toMatchObject({ ok: false, message: expect.stringContaining("git exploded") });
  });
});
