import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { runProcess } from "./run";
import { ensureCheckout, previewRepoFix, proposeRepoFix } from "./repoFix";
import type { ResolvedTarget } from "./gitSources";

// The repo-fix core spawns `git` (via runProcess) and touches the filesystem;
// mock both so these are pure unit tests with no real clone/commit/push. The
// GitHub PR call goes through global fetch, which each test stubs as needed.
vi.mock("./run", () => ({ runProcess: vi.fn() }));
vi.mock("node:fs/promises", () => ({ rm: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));

const mockRun = vi.mocked(runProcess);

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ code: 1, stdout: "", stderr });

const target: ResolvedTarget = {
  name: "app",
  repoURL: "https://github.com/owner/repo",
  branch: "main",
  path: "k8s",
};

/** A git dispatcher: rev-parse → a sha, diff → diff text, everything else → ok. */
function gitOk(diffText = "DIFFTEXT") {
  return async (_bin: string, args: string[]) => {
    if (args.includes("rev-parse")) return ok("abc123\n");
    if (args.includes("diff")) return ok(diffText);
    return ok();
  };
}

const calls = () => mockRun.mock.calls.map((c) => c[1] as string[]);
const callMatching = (pred: (a: string[]) => boolean) => calls().find(pred);

beforeEach(() => {
  mockRun.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureCheckout", () => {
  test("clones the branch with the token embedded, scrubs the remote, returns the HEAD sha", async () => {
    mockRun.mockImplementation(gitOk());
    const res = await ensureCheckout(target, "TOK");
    expect(res.ok).toBe(true);
    expect(res.sha).toBe("abc123");
    expect(res.dir).toContain("rigel-repos/app");

    // Clone URL embeds the token (x-access-token) and targets the branch.
    const clone = callMatching((a) => a[0] === "clone");
    expect(clone).toBeDefined();
    expect(clone).toContain("https://x-access-token:TOK@github.com/owner/repo");
    expect(clone).toContain("--branch");
    expect(clone).toContain("main");
    expect(clone).toContain("--depth"); // shallow by default

    // The persisted remote is reset to the token-free URL.
    const scrub = callMatching((a) => a.includes("set-url"));
    expect(scrub).toBeDefined();
    expect(scrub).toContain("https://github.com/owner/repo");
  });

  test("shallow=false omits --depth (so the new branch can be pushed)", async () => {
    mockRun.mockImplementation(gitOk());
    await ensureCheckout(target, "TOK", false);
    const clone = callMatching((a) => a[0] === "clone");
    expect(clone).not.toContain("--depth");
  });

  test("a failed clone returns ok:false with a redacted message", async () => {
    mockRun.mockImplementation(async (_bin, args) => {
      if (args[0] === "clone") return fail("fatal: could not read https://x-access-token:SECRET@github.com/owner/repo");
      return ok();
    });
    const res = await ensureCheckout(target, "SECRET");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("x-access-token:***@");
    expect(res.message).not.toContain("SECRET");
  });
});

describe("previewRepoFix", () => {
  test("rejects a traversal file path before touching git", async () => {
    const res = await previewRepoFix({
      source: target,
      token: "TOK",
      filePath: "../escape.yaml",
      content: "x",
      title: "t",
    });
    expect(res.ok).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  test("returns the git diff for the proposed change", async () => {
    mockRun.mockImplementation(gitOk("@@ -1 +1 @@\n-old\n+new"));
    const res = await previewRepoFix({
      source: target,
      token: "TOK",
      filePath: "k8s/app.yaml",
      content: "new",
      title: "t",
    });
    expect(res.ok).toBe(true);
    expect(res.diff).toContain("+new");
    // --intent-to-add is used so brand-new files show in the diff.
    expect(callMatching((a) => a.includes("--intent-to-add"))).toBeDefined();
  });

  test("falls back to a placeholder when the diff is empty (new file)", async () => {
    mockRun.mockImplementation(gitOk("")); // empty diff
    const res = await previewRepoFix({
      source: target,
      token: "TOK",
      filePath: "k8s/new.yaml",
      content: "new",
      title: "t",
    });
    expect(res.ok).toBe(true);
    expect(res.diff).toContain("new file");
  });
});

describe("proposeRepoFix", () => {
  const input = {
    source: target,
    token: "TOK",
    filePath: "k8s/app.yaml",
    content: "new content",
    title: "Bump api memory limit",
    body: "OOMKilled; raise to 512Mi",
  };

  test("requires a token", async () => {
    const res = await proposeRepoFix({ ...input, token: null });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/token/i);
  });

  test("fails when owner/repo can't be parsed from the repoURL", async () => {
    const res = await proposeRepoFix({ ...input, source: { ...target, repoURL: "https://example.com/not-github" } });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/owner\/repo/);
  });

  test("rejects a traversal file path", async () => {
    const res = await proposeRepoFix({ ...input, filePath: "../escape.yaml" });
    expect(res.ok).toBe(false);
  });

  test("opens a ready-for-review PR on the happy path and returns its URL + branch", async () => {
    mockRun.mockImplementation(gitOk());
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proposeRepoFix(input);
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe("https://github.com/owner/repo/pull/7");
    expect(res.branch).toMatch(/^rigel\/fix-bump-api-memory-limit-/);

    // PR posted to the repo's pulls endpoint with our title/head/base.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/pulls");
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.base).toBe("main");
    expect(sent.head).toBe(res.branch);
    expect(sent.title).toBe(input.title);
    // Ready for review, NOT a draft.
    expect(sent.draft).toBeUndefined();

    // A branch was created and the fix committed under the Rigel identity.
    expect(callMatching((a) => a.includes("checkout") && a.includes("-b"))).toBeDefined();
    const commit = callMatching((a) => a.includes("commit"));
    expect(commit).toBeDefined();
    expect(commit!.join(" ")).toContain("user.name=Rigel");
  });

  test("a failed push returns ok:false with the branch and a redacted message", async () => {
    mockRun.mockImplementation(async (_bin, args) => {
      if (args.includes("rev-parse")) return ok("abc123\n");
      if (args.includes("push")) {
        return fail("fatal: could not read from https://x-access-token:SECRET@github.com/owner/repo");
      }
      return ok();
    });
    const res = await proposeRepoFix(input);
    expect(res.ok).toBe(false);
    expect(res.branch).toMatch(/^rigel\/fix-/);
    expect(res.message).toContain("x-access-token:***@");
    expect(res.message).not.toContain("SECRET");
  });

  test("surfaces a GitHub PR-creation failure", async () => {
    mockRun.mockImplementation(gitOk());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })),
    );
    const res = await proposeRepoFix(input);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Validation Failed");
  });
});
