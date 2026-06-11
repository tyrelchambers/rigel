import { test, expect, describe } from "bun:test";
import {
  parseImageRef,
  parseReleaseVersion,
  versionLess,
  newestStableTag,
  pickLatestVersion,
  statusFromTags,
  schemeComparable,
  isNewerRelease,
  statusFromRelease,
  ownerRepo,
  GHCRTagSource,
  GitHubReleaseSource,
  DockerHubTagSource,
  tagSourceFor,
  registryIsKnown,
  UpdateResolver,
  type TagSource,
  type InstalledImage,
  type ReleaseVersion,
} from "./updates";
import { installedImages, runningImageDigest } from "./detection";
import type { CatalogApp } from "./types";

// ---------------------------------------------------------------------------
// parseImageRef
// ---------------------------------------------------------------------------
describe("parseImageRef", () => {
  test("empty / whitespace → null", () => {
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef("   ")).toBeNull();
  });

  test("bare official image normalizes to library/ with null tag", () => {
    expect(parseImageRef("nextcloud")).toEqual({
      registry: "docker.io",
      repository: "library/nextcloud",
      tag: null,
    });
  });

  test("official image with tag", () => {
    expect(parseImageRef("nextcloud:29-apache")).toEqual({
      registry: "docker.io",
      repository: "library/nextcloud",
      tag: "29-apache",
    });
  });

  test("explicit docker.io host: single-name official still gets library/ (matches Swift)", () => {
    // Swift normalizes any docker.io single-name repo to library/, regardless of
    // whether the host was explicit — the `library/` prefix is what the Hub API
    // expects for official images.
    expect(parseImageRef("docker.io/nextcloud:29-apache")).toEqual({
      registry: "docker.io",
      repository: "library/nextcloud",
      tag: "29-apache",
    });
  });

  test("two-segment docker hub repo (vaultwarden/server)", () => {
    expect(parseImageRef("vaultwarden/server:latest")).toEqual({
      registry: "docker.io",
      repository: "vaultwarden/server",
      tag: "latest",
    });
  });

  test("ghcr.io host + nested repo", () => {
    expect(parseImageRef("ghcr.io/plausible/community-edition:v2.1.4")).toEqual({
      registry: "ghcr.io",
      repository: "plausible/community-edition",
      tag: "v2.1.4",
    });
  });

  test("digest stripping (tag null when digest-only)", () => {
    expect(parseImageRef("ghcr.io/x/y@sha256:abc")).toEqual({
      registry: "ghcr.io",
      repository: "x/y",
      tag: null,
    });
  });

  test("localhost:port registry + digest stripping keeps tag", () => {
    expect(parseImageRef("localhost:5000/myapp:v1@sha256:abc")).toEqual({
      registry: "localhost:5000",
      repository: "myapp",
      tag: "v1",
    });
  });

  test("registry port colon is NOT mistaken for a tag", () => {
    expect(parseImageRef("registry.example.com:5000/app:v2")).toEqual({
      registry: "registry.example.com:5000",
      repository: "app",
      tag: "v2",
    });
  });
});

// ---------------------------------------------------------------------------
// parseReleaseVersion + comparison
// ---------------------------------------------------------------------------
describe("parseReleaseVersion", () => {
  test("non-version tags → null", () => {
    expect(parseReleaseVersion("latest")).toBeNull();
    expect(parseReleaseVersion("stable")).toBeNull();
    expect(parseReleaseVersion("main")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
    expect(parseReleaseVersion("1-alpine")).toEqual({
      components: [1],
      isPrerelease: false,
    });
  });

  test("leading non-digit (no numeric core) → null", () => {
    expect(parseReleaseVersion("alpine")).toBeNull();
  });

  test("v prefix stripped", () => {
    expect(parseReleaseVersion("v1.2.3")).toEqual({
      components: [1, 2, 3],
      isPrerelease: false,
    });
  });

  test("multi-component", () => {
    expect(parseReleaseVersion("15.1.0.147")).toEqual({
      components: [15, 1, 0, 147],
      isPrerelease: false,
    });
  });

  test("prerelease markers", () => {
    expect(parseReleaseVersion("v2.0.0-rc.1")).toEqual({
      components: [2, 0, 0],
      isPrerelease: true,
    });
    expect(parseReleaseVersion("3.0.0-alpha")?.isPrerelease).toBe(true);
    expect(parseReleaseVersion("3.0.0-beta.2")?.isPrerelease).toBe(true);
    expect(parseReleaseVersion("1.0.0-nightly")?.isPrerelease).toBe(true);
  });

  test("variant suffixes are NOT prerelease", () => {
    expect(parseReleaseVersion("1.0.0-alpine")?.isPrerelease).toBe(false);
    expect(parseReleaseVersion("24.3_ce")?.isPrerelease).toBe(false);
  });
});

describe("versionLess", () => {
  const v = (...components: number[]): ReleaseVersion => ({
    components,
    isPrerelease: false,
  });

  test("component-wise numeric (1.22 < 1.100)", () => {
    expect(versionLess(v(1, 22), v(1, 100))).toBe(true);
    expect(versionLess(v(1, 100), v(1, 22))).toBe(false);
  });

  test("shorter ranks lower with equal prefix (1.2 < 1.2.1)", () => {
    expect(versionLess(v(1, 2), v(1, 2, 1))).toBe(true);
  });

  test("stable outranks prerelease of same numbers", () => {
    const pre: ReleaseVersion = { components: [3, 0, 0], isPrerelease: true };
    const stable: ReleaseVersion = { components: [3, 0, 0], isPrerelease: false };
    expect(versionLess(pre, stable)).toBe(true);
    expect(versionLess(stable, pre)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickLatestVersion / newestStableTag
// ---------------------------------------------------------------------------
describe("pickLatestVersion", () => {
  test("newest stable newer than running, ignoring prerelease + non-version", () => {
    expect(
      pickLatestVersion(
        ["1.22", "1.23", "1.24", "v2.0.0-rc.1", "latest"],
        "1.22",
      ),
    ).toBe("1.24");
  });

  test("null when nothing newer", () => {
    expect(pickLatestVersion(["1.22", "1.23", "1.24"], "1.24")).toBeNull();
  });

  test("trailing-zero tolerance + ignores non-version", () => {
    expect(
      pickLatestVersion(["1.23.0", "1.23.1", "latest-alpine"], "1.23"),
    ).toBe("1.23.1");
  });

  test("null when running tag is not a version", () => {
    expect(pickLatestVersion(["1.0", "2.0"], "latest")).toBeNull();
  });
});

describe("newestStableTag", () => {
  test("newest stable in any list, ignoring prereleases", () => {
    expect(newestStableTag(["v1.0.0", "v1.1.0", "v2.0.0", "v2.1.0-rc.1"])).toBe(
      "v2.0.0",
    );
  });

  test("null when none parse", () => {
    expect(newestStableTag(["latest", "stable", "main"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// schemeComparable / isNewerRelease / statusFromRelease
// ---------------------------------------------------------------------------
describe("schemeComparable", () => {
  test("8-digit date vs semver → false", () => {
    expect(
      schemeComparable(
        { components: [20250609], isPrerelease: false },
        { components: [1, 2, 3], isPrerelease: false },
      ),
    ).toBe(false);
  });

  test("similar widths → true", () => {
    expect(
      schemeComparable(
        { components: [1, 22], isPrerelease: false },
        { components: [2, 0], isPrerelease: false },
      ),
    ).toBe(true);
  });
});

describe("isNewerRelease", () => {
  const v = (...components: number[]): ReleaseVersion => ({
    components,
    isPrerelease: false,
  });

  test("trailing-zero formatting → not newer", () => {
    expect(isNewerRelease(v(1, 23, 0), v(1, 23))).toBe(false);
  });

  test("genuinely newer", () => {
    expect(isNewerRelease(v(1, 24, 0), v(1, 23))).toBe(true);
  });
});

describe("statusFromRelease", () => {
  test("newer release → updateAvailable", () => {
    expect(
      statusFromRelease("ghcr.io/x/y:v1.23", "v1.24.0"),
    ).toEqual({ kind: "updateAvailable", current: "v1.23", latest: "v1.24.0" });
  });

  test("same release (trailing zero) → upToDate", () => {
    expect(statusFromRelease("ghcr.io/x/y:v1.23", "v1.23.0")).toEqual({
      kind: "upToDate",
      current: "v1.23",
    });
  });

  test("moving tag running → null", () => {
    expect(statusFromRelease("ghcr.io/x/y:latest", "v1.24.0")).toBeNull();
  });

  test("scheme mismatch → null", () => {
    expect(statusFromRelease("ghcr.io/x/y:v1.2.3", "20250609")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ownerRepo
// ---------------------------------------------------------------------------
describe("ownerRepo", () => {
  test("extracts owner/repo", () => {
    expect(ownerRepo("https://github.com/plausible/analytics")).toBe(
      "plausible/analytics",
    );
  });
  test("strips trailing .git", () => {
    expect(ownerRepo("https://github.com/plausible/analytics.git")).toBe(
      "plausible/analytics",
    );
  });
  test("null when too few path components", () => {
    expect(ownerRepo("https://github.com/plausible")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry abstraction: GHCR pagination (mocked Link headers)
// ---------------------------------------------------------------------------
describe("GHCRTagSource pagination", () => {
  test("nextPageURL parses rel=next and resolves relative reference", () => {
    expect(
      GHCRTagSource.nextPageURL(
        '</v2/repo/tags/list?last=tag2&n=100>; rel="next"',
        "https://ghcr.io",
      ),
    ).toBe("https://ghcr.io/v2/repo/tags/list?last=tag2&n=100");
  });

  test("nextPageURL null when no next", () => {
    expect(GHCRTagSource.nextPageURL(null, "https://ghcr.io")).toBeNull();
    expect(
      GHCRTagSource.nextPageURL('<...>; rel="prev"', "https://ghcr.io"),
    ).toBeNull();
  });

  test("parseTags decodes body + null on malformed", () => {
    expect(GHCRTagSource.parseTags('{"tags":["a","b"]}')).toEqual(["a", "b"]);
    expect(GHCRTagSource.parseTags('{"tags":null}')).toEqual([]);
    expect(GHCRTagSource.parseTags("not json")).toBeNull();
  });

  test("listTags walks EVERY page via Link header", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      if (url.includes("last=tag2")) {
        return new Response(JSON.stringify({ tags: ["tag3", "tag4"] }), {
          status: 200,
        });
      }
      if (url.includes("/tags/list")) {
        return new Response(JSON.stringify({ tags: ["tag1", "tag2"] }), {
          status: 200,
          headers: {
            Link: '<https://ghcr.io/v2/repo/tags/list?n=100&last=tag2>; rel="next"',
          },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const source = new GHCRTagSource({ fetch: mockFetch });
    expect(await source.listTags("repo")).toEqual([
      "tag1",
      "tag2",
      "tag3",
      "tag4",
    ]);
  });

  test("resolveDigest returns Docker-Content-Digest header", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      return new Response("", {
        status: 200,
        headers: { "Docker-Content-Digest": "sha256:deadbeef" },
      });
    }) as typeof fetch;
    const source = new GHCRTagSource({ fetch: mockFetch });
    expect(await source.resolveDigest("repo", "v1.0")).toBe("sha256:deadbeef");
  });
});

describe("DockerHubTagSource", () => {
  test("listTags maps results[].name", async () => {
    const mockFetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ results: [{ name: "16" }, { name: "16-alpine" }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const source = new DockerHubTagSource({ fetch: mockFetch });
    expect(await source.listTags("library/postgres")).toEqual(["16", "16-alpine"]);
  });
});

describe("GitHubReleaseSource", () => {
  test("listTags returns single-element [tag_name]", async () => {
    const mockFetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ tag_name: "v2.2.0" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const source = new GitHubReleaseSource({ fetch: mockFetch });
    expect(await source.listTags("plausible/analytics")).toEqual(["v2.2.0"]);
  });
});

describe("tagSourceFor / registryIsKnown", () => {
  test("known registries", () => {
    expect(tagSourceFor("docker.io")).toBeInstanceOf(DockerHubTagSource);
    expect(tagSourceFor("ghcr.io")).toBeInstanceOf(GHCRTagSource);
    expect(tagSourceFor("registry-1.docker.io")).toBeInstanceOf(DockerHubTagSource);
    expect(registryIsKnown("ghcr.io")).toBe(true);
  });
  test("unknown registry → null/false", () => {
    expect(tagSourceFor("quay.io")).toBeNull();
    expect(registryIsKnown("quay.io")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock TagSource for resolver tier tests
// ---------------------------------------------------------------------------
class MockTagSource implements TagSource {
  constructor(
    private tags: string[],
    private digests: Record<string, string> = {},
  ) {}
  async listTags(): Promise<string[]> {
    return this.tags;
  }
  async resolveDigest(_repo: string, ref: string): Promise<string | null> {
    return this.digests[ref] ?? null;
  }
}

describe("UpdateResolver.canResolveByRegistry", () => {
  const r = new UpdateResolver({ githubSource: null });
  test("version tag on known registry → true", () => {
    expect(r.canResolveByRegistry("ghcr.io/x/y:v1.2.3")).toBe(true);
  });
  test(":latest moving tag → false", () => {
    expect(r.canResolveByRegistry("ghcr.io/x/y:latest")).toBe(false);
  });
  test("digest-only → false", () => {
    expect(r.canResolveByRegistry("ghcr.io/x/y@sha256:abc")).toBe(false);
  });
  test("unknown registry → false", () => {
    expect(r.canResolveByRegistry("unknown.io/x/y:v1.0")).toBe(false);
  });
  test("non-version tag → false", () => {
    expect(r.canResolveByRegistry("x/y:latest-alpine")).toBe(false);
  });
});

describe("UpdateResolver tiers", () => {
  test("Tier 1: registry version → updateAvailable", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v2.1.4", "v2.2.0", "latest"]),
      githubSource: null,
    });
    const status = await r.resolveOne({
      appID: "plausible",
      image: "ghcr.io/plausible/ce:v2.1.4",
    });
    expect(status).toEqual({
      kind: "updateAvailable",
      current: "v2.1.4",
      latest: "v2.2.0",
    });
  });

  test("Tier 1: nothing newer → upToDate", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v2.1.4", "v2.0.0"]),
      githubSource: null,
    });
    const status = await r.resolveOne({
      appID: "x",
      image: "ghcr.io/x/y:v2.1.4",
    });
    expect(status).toEqual({ kind: "upToDate", current: "v2.1.4" });
  });

  test("Tier 1.5: moving tag with old running digest → updateAvailable", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () =>
        new MockTagSource(["v1.0.0", "v1.1.0", "v2.0.0"], {
          "v2.0.0": "sha256:new",
          latest: "sha256:old",
        }),
      githubSource: null,
    });
    const item: InstalledImage = {
      appID: "app1",
      image: "ghcr.io/myrepo/app:latest",
      runningDigest: "sha256:old",
    };
    expect(await r.resolveViaMovingTag(item)).toEqual({
      kind: "updateAvailable",
      current: "latest",
      latest: "v2.0.0",
    });
  });

  test("Tier 1.5: matching digest → upToDate", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () =>
        new MockTagSource(["v2.0.0"], { "v2.0.0": "sha256:same" }),
      githubSource: null,
    });
    const item: InstalledImage = {
      appID: "app1",
      image: "ghcr.io/myrepo/app:latest",
      runningDigest: "sha256:same",
    };
    expect(await r.resolveViaMovingTag(item)).toEqual({
      kind: "upToDate",
      current: "latest",
    });
  });

  test("Tier 1.5: no obtainable digest → null", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v2.0.0"], {}),
      githubSource: null,
    });
    const item: InstalledImage = {
      appID: "app1",
      image: "ghcr.io/myrepo/app:latest",
    };
    expect(await r.resolveViaMovingTag(item)).toBeNull();
  });

  test("Tier 2: GitHub releases when registry declines", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () => null, // unknown registry → tiers 1 & 1.5 decline
      githubSource: new MockTagSource(["v2.2.0"]),
    });
    const status = await r.resolveOne({
      appID: "x",
      image: "quay.io/x/y:v2.1.0",
      repoURL: "https://github.com/x/y",
    });
    expect(status).toEqual({
      kind: "updateAvailable",
      current: "v2.1.0",
      latest: "v2.2.0",
    });
  });

  test("all tiers decline → null (needs assist)", async () => {
    const r = new UpdateResolver({
      tagSourceFor: () => null,
      githubSource: null,
    });
    expect(
      await r.resolveOne({ appID: "x", image: "quay.io/x/y:v1.0" }),
    ).toBeNull();
  });

  test("registry error per-tier → null (no throw)", async () => {
    const throwing: TagSource = {
      async listTags() {
        throw new Error("network");
      },
    };
    const r = new UpdateResolver({
      tagSourceFor: () => throwing,
      githubSource: null,
    });
    expect(
      await r.resolveViaRegistry({ appID: "x", image: "ghcr.io/x/y:v1.0" }),
    ).toBeNull();
  });

  test("resolveBatch splits resolved vs needsAssist", async () => {
    const r = new UpdateResolver({
      tagSourceFor: (host) =>
        host === "ghcr.io" ? new MockTagSource(["v1.0", "v2.0"]) : null,
      githubSource: null,
    });
    const { resolved, needsAssist } = await r.resolveBatch([
      { appID: "a", image: "ghcr.io/a/a:v1.0" },
      { appID: "b", image: "quay.io/b/b:v1.0" },
    ]);
    expect(resolved.get("a")).toEqual({
      kind: "updateAvailable",
      current: "v1.0",
      latest: "v2.0",
    });
    expect(needsAssist.map((i) => i.appID)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// installedImages / runningImageDigest
// ---------------------------------------------------------------------------
describe("runningImageDigest", () => {
  test("extracts sha256 from imageID forms", () => {
    expect(runningImageDigest("ghcr.io/x/y@sha256:abc")).toBe("sha256:abc");
    expect(runningImageDigest("docker-pullable://x/y@sha256:def")).toBe(
      "sha256:def",
    );
    expect(runningImageDigest("sha256:bare")).toBe("sha256:bare");
  });
  test("null when no digest / undefined", () => {
    expect(runningImageDigest(undefined)).toBeNull();
    expect(runningImageDigest("ghcr.io/x/y:v1.0")).toBeNull();
  });
});

describe("installedImages", () => {
  const app: CatalogApp = {
    id: "plausible",
    name: "Plausible",
    tagline: "",
    description: "",
    category: "observability",
    iconSystemName: "chart.bar",
    docsURL: "",
    repoURL: "https://github.com/plausible/analytics",
    tags: [],
    matchImages: ["ghcr.io/plausible/community-edition"],
    requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
    persistence: false,
    exposesIngress: false,
    installPromptTemplate: "",
  };

  test("returns full ref + repoURL + runningDigest for matched app", () => {
    const result = installedImages(
      [app],
      [
        {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: "plausible",
                    image: "ghcr.io/plausible/community-edition:v2.1.4",
                  },
                ],
              },
            },
          },
        },
      ],
      [],
      [],
      [
        {
          spec: {
            containers: [
              {
                name: "plausible",
                image: "ghcr.io/plausible/community-edition:v2.1.4",
              },
            ],
          },
          status: {
            containerStatuses: [
              {
                name: "plausible",
                imageID:
                  "ghcr.io/plausible/community-edition@sha256:running",
              },
            ],
          },
        },
      ],
    );
    expect(result).toEqual([
      {
        appID: "plausible",
        image: "ghcr.io/plausible/community-edition:v2.1.4",
        repoURL: "https://github.com/plausible/analytics",
        runningDigest: "sha256:running",
      },
    ]);
  });

  test("omits apps with no matching container", () => {
    expect(installedImages([app], [], [], [], [])).toEqual([]);
  });

  test("annotation-bound workload supplies the running image over image match", () => {
    const result = installedImages(
      [app],
      [
        {
          metadata: {
            name: "mirror-plausible",
            namespace: "analytics",
            annotations: { "helmsman.dev/catalog-app": "plausible" },
          },
          spec: {
            template: {
              spec: {
                containers: [
                  { name: "plausible", image: "registry.internal/team/plausible:v2.0.0" },
                ],
              },
            },
          },
        },
      ],
      [],
      [],
      [],
    );
    expect(result).toEqual([
      {
        appID: "plausible",
        image: "registry.internal/team/plausible:v2.0.0",
        repoURL: "https://github.com/plausible/analytics",
        runningDigest: undefined,
      },
    ]);
  });
});
