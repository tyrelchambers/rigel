import { describe, it, expect, vi } from "vitest";
import { recordPr, type RecordDeps } from "./record";
import type { GitSource } from "@rigel/k8s";

const sources: GitSource[] = [
  {
    name: "jobwatch",
    repoURL: "https://github.com/o/jobwatch.git",
    branch: "main",
    deployments: [{ name: "jobwatch-web", path: "k8s" }],
  },
];

function deps(over: Partial<RecordDeps> = {}): RecordDeps {
  return {
    getToken: async () => "TOK",
    getSources: async () => sources,
    getLedger: async () => [],
    writeLedger: vi.fn(async () => ({ ok: true })),
    fetchPr: async () => ({ title: "Raise memory", branch: "rigel/fix-x" }),
    applyLabels: vi.fn(async () => {}),
    now: () => Date.parse("2026-07-24T12:00:00.000Z"),
    uuid: () => "uuid-1",
    ...over,
  };
}

const URL = "https://github.com/o/jobwatch/pull/42";

describe("recordPr", () => {
  it("labels the PR and writes it to the ledger", async () => {
    const d = deps();
    const res = await recordPr({ prUrl: URL }, d);

    expect(res.ok).toBe(true);
    expect(d.applyLabels).toHaveBeenCalledWith({ owner: "o", repo: "jobwatch" }, "TOK", 42, "chat");
    const [written] = vi.mocked(d.writeLedger).mock.calls[0]!;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: "uuid-1",
      prUrl: URL,
      number: 42,
      repoSlug: "o/jobwatch",
      repoName: "jobwatch",
      source: "jobwatch-web",
      title: "Raise memory",
      branch: "rigel/fix-x",
    });
  });

  it("rejects a url that is not a GitHub pull request", async () => {
    const res = await recordPr({ prUrl: "https://github.com/o/jobwatch" }, deps());
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/pull request url/i);
  });

  it("fails when GitHub is not connected", async () => {
    const res = await recordPr({ prUrl: URL }, deps({ getToken: async () => null }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not connected/i);
  });

  it("uses an explicit --source over the inferred one", async () => {
    const d = deps();
    await recordPr({ prUrl: URL, source: "custom-dep" }, d);
    const [written] = vi.mocked(d.writeLedger).mock.calls[0]!;
    expect(written[0]!.source).toBe("custom-dep");
  });

  it("records with an empty source when the repo maps to no deployment", async () => {
    const d = deps({ getSources: async () => [] });
    const res = await recordPr({ prUrl: URL }, d);
    expect(res.ok).toBe(true);
    const [written] = vi.mocked(d.writeLedger).mock.calls[0]!;
    expect(written[0]!.source).toBe("");
  });

  it("leaves the source empty when the repo has several deployments to choose from", async () => {
    const many: GitSource[] = [
      {
        name: "jobwatch",
        repoURL: "https://github.com/o/jobwatch.git",
        branch: "main",
        deployments: [{ name: "a", path: "k8s/a" }, { name: "b", path: "k8s/b" }],
      },
    ];
    const d = deps({ getSources: async () => many });
    await recordPr({ prUrl: URL }, d);
    const [written] = vi.mocked(d.writeLedger).mock.calls[0]!;
    expect(written[0]!.source).toBe("");
  });

  it("still records when labelling fails", async () => {
    const d = deps({ applyLabels: vi.fn(async () => { throw new Error("no write access"); }) });
    const res = await recordPr({ prUrl: URL }, d);
    expect(res.ok).toBe(true);
    expect(res.labelled).toBe(false);
    expect(d.writeLedger).toHaveBeenCalled();
  });

  it("surfaces a ledger write failure", async () => {
    const d = deps({ writeLedger: vi.fn(async () => ({ ok: false, message: "forbidden" })) });
    const res = await recordPr({ prUrl: URL }, d);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("forbidden");
  });
});
