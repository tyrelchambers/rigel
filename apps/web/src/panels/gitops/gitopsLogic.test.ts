import { describe, expect, test } from "vitest";
import type { Deployment } from "../deployments/types";
import { slug, repoToName, deriveDeployName, groupLinkedByDeployment } from "./gitopsLogic";
import { SOURCE_REPO_ANNOTATION } from "./linkSource";

function dep(name: string, source?: string): Deployment {
  return {
    metadata: {
      name,
      namespace: "default",
      uid: `u-${name}`,
      annotations: source ? { [SOURCE_REPO_ANNOTATION]: source } : undefined,
    },
    spec: { replicas: 1 },
  };
}

describe("slug", () => {
  test("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(slug("My App")).toBe("my-app");
    expect(slug("Foo_Bar.Baz")).toBe("foo-bar-baz");
  });
  test("trims leading/trailing dashes and whitespace", () => {
    expect(slug("  Hello World  ")).toBe("hello-world");
    expect(slug("--weird--")).toBe("weird");
    expect(slug("!!!only!!!")).toBe("only");
  });
});

describe("repoToName", () => {
  test("takes the repo part of owner/repo and slugs it", () => {
    expect(repoToName("octocat/Hello-World")).toBe("hello-world");
    expect(repoToName("my-org/My_Cool.Repo")).toBe("my-cool-repo");
  });
  test("handles a bare name with no slash", () => {
    expect(repoToName("StandaloneRepo")).toBe("standalonerepo");
  });
});

describe("deriveDeployName", () => {
  test("uses the last meaningful path segment", () => {
    expect(deriveDeployName("apps/marketing", "fallback")).toBe("marketing");
  });
  test("skips generic dirs to find a meaningful segment", () => {
    expect(deriveDeployName("marketing/k8s", "fallback")).toBe("marketing");
    expect(deriveDeployName("api/deploy/manifests", "fallback")).toBe("api");
    expect(deriveDeployName("svc/kubernetes/base/overlays/prod", "fallback")).toBe("svc");
  });
  test("ignores leading '.' and empty segments", () => {
    expect(deriveDeployName("./apps/web", "fallback")).toBe("web");
  });
  test("falls back to the last segment when all are generic", () => {
    expect(deriveDeployName("k8s/base", "fallback")).toBe("base");
  });
  test("uses repoName when path has no usable segments", () => {
    expect(deriveDeployName(".", "My Repo")).toBe("my-repo");
  });
});

describe("groupLinkedByDeployment", () => {
  test("groups workloads by their source annotation", () => {
    const a = dep("web", "marketing");
    const b = dep("api", "marketing");
    const c = dep("worker", "backend");
    const map = groupLinkedByDeployment([a, b, c]);
    expect(map.get("marketing")).toEqual([a, b]);
    expect(map.get("backend")).toEqual([c]);
  });
  test("skips workloads with no source annotation", () => {
    const linked = dep("web", "marketing");
    const unlinked = dep("api");
    const map = groupLinkedByDeployment([linked, unlinked]);
    expect(map.get("marketing")).toEqual([linked]);
    expect(map.size).toBe(1);
  });
  test("empty input yields an empty map", () => {
    expect(groupLinkedByDeployment([]).size).toBe(0);
  });
});
