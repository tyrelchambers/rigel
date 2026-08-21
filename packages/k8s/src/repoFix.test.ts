import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { runProcess } from "./run";
import { ensureCheckout, previewRepoFix, proposeRepoFix } from "./repoFix";
import type { ResolvedTarget } from "./gitSources";

// The repo-fix core spawns `git` (via runProcess) and touches the filesystem;
// mock both so these are pure unit tests with no real clone/commit/push. The
// GitHub PR call goes through global fetch, which each test stubs as needed.
vi.mock("./run", () => ({ runProcess: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  rm: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

const mockRun = vi.mocked(runProcess);
const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);

const DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
`;

/** Lay out a manifest tree in the source's manifest directory: { name: content }. */
function repoTree(files: Record<string, string>): void {
  mockReaddir.mockImplementation((async () => Object.keys(files)) as never);
  mockReadFile.mockImplementation((async (abs: string) => {
    const hit = Object.entries(files).find(([name]) => String(abs).endsWith(`/${name}`));
    if (!hit) throw new Error(`ENOENT ${abs}`);
    return hit[1];
  }) as never);
}

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
  mockReaddir.mockReset();
  mockReadFile.mockReset();
  vi.mocked(writeFile).mockClear();
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
      vi.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })),
    );
    const res = await proposeRepoFix(input);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Validation Failed");
  });

  test("returns the PR number from the create response", async () => {
    mockRun.mockImplementation(gitOk());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _init?: unknown) =>
        new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
      ),
    );
    const res = await proposeRepoFix(input);
    expect(res.number).toBe(7);
  });

  test("labels the PR with rigel + its origin, creating the labels first", async () => {
    mockRun.mockImplementation(gitOk());
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proposeRepoFix({ ...input, origin: "agent" });
    expect(res.ok).toBe(true);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // Each label is created (ignored if it already exists) before being applied.
    expect(urls.filter((u) => u.endsWith("/labels"))).toContain("https://api.github.com/repos/owner/repo/labels");
    const add = fetchMock.mock.calls.find(
      (c) => String(c[0]) === "https://api.github.com/repos/owner/repo/issues/7/labels",
    );
    expect(add).toBeDefined();
    const sent = JSON.parse((add![1] as RequestInit).body as string) as { labels: string[] };
    expect(sent.labels).toEqual(["rigel", "rigel:agent"]);
  });

  test("uses the chat origin label for chat-opened PRs", async () => {
    mockRun.mockImplementation(gitOk());
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await proposeRepoFix({ ...input, origin: "chat" });
    const add = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/issues/7/labels"));
    const sent = JSON.parse((add![1] as RequestInit).body as string) as { labels: string[] };
    expect(sent.labels).toEqual(["rigel", "rigel:chat"]);
  });

  test("a labelling failure never fails the PR", async () => {
    mockRun.mockImplementation(gitOk());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).endsWith("/pulls")
          ? new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 })
          : new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
      ),
    );
    const res = await proposeRepoFix({ ...input, origin: "agent" });
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe("https://github.com/owner/repo/pull/7");
  });

  test("skips labelling when no origin is given", async () => {
    mockRun.mockImplementation(gitOk());
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await proposeRepoFix(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("a typed edit plans the change from the repo, commits the planned file and opens the PR", async () => {
    mockRun.mockImplementation(gitOk());
    repoTree({ "web.yaml": DEPLOY });
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proposeRepoFix({
      source: target,
      token: "TOK",
      title: "Scale web to 4",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });
    expect(res.ok).toBe(true);

    // The file the planner picked is the one committed, path relative to the repo.
    expect(vi.mocked(writeFile).mock.calls[0]![0]).toContain("/k8s/web.yaml");
    expect(String(vi.mocked(writeFile).mock.calls[0]![1])).toContain("replicas: 4");
    expect(callMatching((a) => a[0] === "-C" && a.includes("add") && a.includes("k8s/web.yaml"))).toBeDefined();
    // The planned file comes back, because only the planner knew which it was.
    expect(res.filePath).toBe("k8s/web.yaml");
  });

  test("a typed edit the planner refuses never runs a git write", async () => {
    mockRun.mockImplementation(gitOk());
    repoTree({ "web.yaml": DEPLOY });
    const res = await proposeRepoFix({
      source: target,
      token: "TOK",
      title: "Scale api",
      target: { kind: "deployment", name: "api", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("api");
    expect(callMatching((a) => a.includes("commit"))).toBeUndefined();
    expect(callMatching((a) => a.includes("push"))).toBeUndefined();
  });

  test("giving both a file and an edit, or neither, is refused before any clone", async () => {
    const both = await proposeRepoFix({ ...input, target: { kind: "deployment", name: "web", namespace: "shop" }, edit: { op: "scale", replicas: 4 } });
    expect(both.ok).toBe(false);
    const neither = await proposeRepoFix({ source: target, token: "TOK", title: "t" });
    expect(neither.ok).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  test("a PR that fails to open deletes the branch it pushed", async () => {
    mockRun.mockImplementation(gitOk());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })),
    );
    const res = await proposeRepoFix(input);
    expect(res.ok).toBe(false);
    const deleted = callMatching((a) => a.includes("push") && a.includes("--delete"));
    expect(deleted).toBeDefined();
    expect(deleted).toContain(res.branch);
  });

  test("labels a voice-opened PR as rigel:voice", async () => {
    mockRun.mockImplementation(gitOk());
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await proposeRepoFix({ ...input, origin: "voice" });
    const add = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/issues/7/labels"));
    const sent = JSON.parse((add![1] as RequestInit).body as string) as { labels: string[] };
    expect(sent.labels).toEqual(["rigel", "rigel:voice"]);
  });
});

describe("a typed edit against a source whose path is wrong", () => {
  test("a manifest directory that is not in the repo says so, rather than blaming the workload", async () => {
    mockRun.mockImplementation(gitOk());
    mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = await proposeRepoFix({
      source: target,
      token: "TOK",
      title: "Scale web",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("k8s");
    expect(res.message).toContain("main");
    expect(res.message).toMatch(/not in the repository/i);
    expect(res.message).not.toMatch(/no manifest/i);
  });

  test("a directory with no YAML in it is named as empty, not as a missing workload", async () => {
    mockRun.mockImplementation(gitOk());
    repoTree({ "README.md": "# nothing here", "kustomization.json": "{}" });
    const res = await proposeRepoFix({
      source: target,
      token: "TOK",
      title: "Scale web",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no YAML/i);
    expect(res.message).toContain("k8s");
  });

  test("a source with no manifest path searches the whole repository", async () => {
    mockRun.mockImplementation(gitOk());
    repoTree({ "deploy/web.yaml": DEPLOY });
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proposeRepoFix({
      source: { ...target, path: "" },
      token: "TOK",
      title: "Scale web",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });

    expect(res.ok).toBe(true);
    // Found without a configured directory, and reported at its repo path.
    expect(res.filePath).toBe("deploy/web.yaml");
  });
});

describe("previewRepoFix with a typed edit", () => {
  test("returns the planned change's diff without committing", async () => {
    mockRun.mockImplementation(gitOk("@@ -6 +6 @@\n-  replicas: 2\n+  replicas: 4"));
    repoTree({ "web.yaml": DEPLOY });
    const res = await previewRepoFix({
      source: target,
      token: "TOK",
      title: "Scale web to 4",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 4 },
    });
    expect(res.ok).toBe(true);
    expect(res.diff).toContain("replicas: 4");
    expect(callMatching((a) => a.includes("commit"))).toBeUndefined();
  });

  test("surfaces the planner's refusal", async () => {
    mockRun.mockImplementation(gitOk());
    repoTree({ "web.yaml": DEPLOY });
    const res = await previewRepoFix({
      source: target,
      token: "TOK",
      title: "t",
      target: { kind: "deployment", name: "web", namespace: "shop" },
      edit: { op: "scale", replicas: 2 },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("already");
  });
});
