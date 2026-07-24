import { describe, it, expect } from "vitest";
import { mergePrRows } from "./pendingPrs";
import type { ChatPrRecord } from "@/panels/gitops/gitApi";
import type { AssistantPullRequest } from "@rigel/k8s";

const chat = (over: Partial<ChatPrRecord> = {}): ChatPrRecord => ({
  id: "c1",
  prUrl: "https://github.com/o/repo/pull/7",
  number: 7,
  repoSlug: "o/repo",
  repoName: "repo",
  source: "web",
  title: "Chat fix",
  branch: "rigel/a",
  filePath: "k8s/a.yaml",
  createdAt: "2026-07-24T10:00:00.000Z",
  ...over,
});

const agent = (over: Partial<AssistantPullRequest> = {}): AssistantPullRequest => ({
  at: "2026-07-24T09:00:00.000Z",
  fingerprint: "fp1",
  filePath: "k8s/b.yaml",
  incident: "OOMKilled",
  app: "api",
  repo: "https://github.com/o/other.git",
  branch: "rigel/b",
  prUrl: "https://github.com/o/other/pull/12",
  title: "Agent fix",
  summary: "ok",
  status: "open",
  kind: "config",
  ...over,
});

describe("mergePrRows", () => {
  it("tags each row with its origin", () => {
    const rows = mergePrRows([chat()], [agent()]);
    expect(rows.map((r) => r.origin)).toEqual(["chat", "agent"]);
  });

  it("sorts newest first across both sources", () => {
    const rows = mergePrRows(
      [chat({ id: "old", prUrl: "https://github.com/o/repo/pull/1", createdAt: "2026-07-20T00:00:00.000Z" })],
      [agent({ at: "2026-07-23T00:00:00.000Z" })],
    );
    expect(rows.map((r) => r.origin)).toEqual(["agent", "chat"]);
  });

  it("derives repo slug, number, and sync source for agent rows", () => {
    const [row] = mergePrRows([], [agent()]);
    expect(row).toMatchObject({ repoSlug: "o/other", number: 12, source: "api", title: "Agent fix" });
  });

  it("marks a failed agent PR and gives it no PR url", () => {
    const [row] = mergePrRows([], [agent({ status: "failed", prUrl: undefined })]);
    expect(row.fallbackState).toBe("failed");
    expect(row.prUrl).toBeUndefined();
  });

  it("dedupes a PR recorded in both sources", () => {
    const url = "https://github.com/o/repo/pull/7";
    const rows = mergePrRows([chat({ prUrl: url })], [agent({ prUrl: url })]);
    expect(rows).toHaveLength(1);
  });
});
