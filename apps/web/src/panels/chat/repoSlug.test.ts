import { describe, it, expect } from "vitest";
import { repoSlugFromSource, repoSlugFromText, prUrlFromText, prNumberFromUrl, collectRepoBadges } from "./repoSlug";
import type { GitSource } from "@/panels/gitops/gitApi";
import type { SuggestedAction } from "@/lib/actionBlocks";

const action = (over: Partial<SuggestedAction>): SuggestedAction =>
  ({ label: "Open PR", kind: "proposeRepoFix", ...over }) as SuggestedAction;

const sources: GitSource[] = [
  {
    name: "JobWatch",
    repoURL: "https://github.com/tyrelchambers/jobwatch-canada.git",
    branch: "main",
    deployments: [{ name: "jobwatch-web", path: "k8s" }],
  },
];

describe("repoSlugFromSource", () => {
  it("resolves a deployment source slug to owner/repo", () => {
    expect(repoSlugFromSource(sources, "jobwatch-web")).toBe("tyrelchambers/jobwatch-canada");
  });

  it("returns null when the source is not found", () => {
    expect(repoSlugFromSource(sources, "unknown")).toBeNull();
  });

  it("returns null when the source is undefined", () => {
    expect(repoSlugFromSource(sources, undefined)).toBeNull();
  });

  it("returns null for a non-GitHub repo URL", () => {
    const nonGh: GitSource[] = [
      { name: "x", repoURL: "https://gitlab.com/a/b.git", branch: "main", deployments: [{ name: "d", path: "." }] },
    ];
    expect(repoSlugFromSource(nonGh, "d")).toBeNull();
  });
});

describe("repoSlugFromText", () => {
  it("extracts owner/repo from a pull-request URL", () => {
    expect(
      repoSlugFromText("Opened pull request: https://github.com/tyrelchambers/jobwatch-canada/pull/42"),
    ).toBe("tyrelchambers/jobwatch-canada");
  });

  it("returns null when there is no pull-request URL", () => {
    expect(repoSlugFromText("nothing to see here")).toBeNull();
  });

  it("ignores a non-PR GitHub URL", () => {
    expect(repoSlugFromText("see https://github.com/tyrelchambers/jobwatch-canada for details")).toBeNull();
  });
});

describe("prUrlFromText", () => {
  it("returns the full pull-request URL", () => {
    expect(
      prUrlFromText("Opened pull request: https://github.com/tyrelchambers/jobwatch-canada/pull/42"),
    ).toBe("https://github.com/tyrelchambers/jobwatch-canada/pull/42");
  });

  it("returns null when there is no pull-request URL", () => {
    expect(prUrlFromText("nothing here")).toBeNull();
  });
});

describe("prNumberFromUrl", () => {
  it("extracts the PR number", () => {
    expect(prNumberFromUrl("https://github.com/tyrelchambers/jobwatch-canada/pull/42")).toBe(42);
  });

  it("returns null when there is no PR number", () => {
    expect(prNumberFromUrl("https://github.com/tyrelchambers/jobwatch-canada")).toBeNull();
  });
});

describe("collectRepoBadges", () => {
  it("makes an unlinked badge from a proposeRepoFix action", () => {
    expect(collectRepoBadges([action({ source: "jobwatch-web" })], "I'll update it", sources)).toEqual([
      { slug: "tyrelchambers/jobwatch-canada" },
    ]);
  });

  it("makes a linked badge from a PR URL in the message text", () => {
    expect(
      collectRepoBadges([], "Opened pull request: https://github.com/tyrelchambers/jobwatch-canada/pull/42", sources),
    ).toEqual([{ slug: "tyrelchambers/jobwatch-canada", href: "https://github.com/tyrelchambers/jobwatch-canada/pull/42" }]);
  });

  it("dedupes multiple actions for the same repo", () => {
    const acts = [action({ source: "jobwatch-web" }), action({ source: "jobwatch-web" })];
    expect(collectRepoBadges(acts, "", sources)).toHaveLength(1);
  });

  it("ignores non-proposeRepoFix actions and returns nothing when no repo is involved", () => {
    expect(collectRepoBadges([action({ kind: "restart", source: undefined })], "just chatting", sources)).toEqual([]);
  });
});
