import { test, expect, describe } from "vitest";
import { handleUpdates } from "./updates";
import { UpdateResolver, type TagSource } from "@rigel/catalog";

// A stub tag source so the handler never touches the network. Returns canned
// tag lists keyed by registry via the injected `tagSourceFor`.
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

describe("handleUpdates", () => {
  test("empty / missing images → empty results", async () => {
    expect(await handleUpdates({ images: [] })).toEqual({ results: [] });
    // Both arrays are optional now (charts-only checks); an empty body is a no-op.
    expect(await handleUpdates({})).toEqual({ results: [] });
  });

  test("Tier 1 version → kind 'version', updateAvailable, latest set", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v2.1.4", "v2.2.0", "latest"]),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["ghcr.io/plausible/ce:v2.1.4"] },
      resolver,
    );
    expect(res.results).toEqual([
      {
        image: "ghcr.io/plausible/ce:v2.1.4",
        currentTag: "v2.1.4",
        latest: "v2.2.0",
        updateAvailable: true,
        kind: "version",
      },
    ]);
  });

  test("Tier 1 nothing newer → up to date (latest null, no update)", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v2.1.4", "v2.0.0"]),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["ghcr.io/x/y:v2.1.4"] },
      resolver,
    );
    expect(res.results[0]).toEqual({
      image: "ghcr.io/x/y:v2.1.4",
      currentTag: "v2.1.4",
      latest: null,
      updateAvailable: false,
      kind: "version",
    });
  });

  test("Tier 1.5 moving tag (digest mismatch) → kind 'digest'", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () =>
        new MockTagSource(["v1.0.0", "v2.0.0"], {
          "v2.0.0": "sha256:new",
          latest: "sha256:old",
        }),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["ghcr.io/myrepo/app:latest"] },
      resolver,
    );
    expect(res.results[0]).toEqual({
      image: "ghcr.io/myrepo/app:latest",
      currentTag: "latest",
      latest: "v2.0.0",
      updateAvailable: true,
      kind: "digest",
    });
  });

  test("moving tag: a stale pod digest is an update even when the tag's registry digest is current", async () => {
    // Real-world Affine case: `:stable` in the registry already points at the
    // newest build, but the pod pulled an older `:stable` months ago and never
    // restarted. Without forwarding runningDigest the resolver compares the
    // registry tag to itself and wrongly reports up-to-date.
    const resolver = new UpdateResolver({
      tagSourceFor: () =>
        new MockTagSource(["v1.0.0", "v2.0.0"], {
          "v2.0.0": "sha256:new",
          stable: "sha256:new", // the moving tag already points at the newest build
        }),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: [{ image: "ghcr.io/toeverything/affine:stable", runningDigest: "sha256:old" }] },
      resolver,
    );
    expect(res.results[0]).toMatchObject({
      image: "ghcr.io/toeverything/affine:stable",
      updateAvailable: true,
      kind: "digest",
      latest: "v2.0.0",
    });
  });

  test("moving tag: pod digest already current → up to date", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () =>
        new MockTagSource(["v2.0.0"], { "v2.0.0": "sha256:new", stable: "sha256:new" }),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: [{ image: "ghcr.io/toeverything/affine:stable", runningDigest: "sha256:new" }] },
      resolver,
    );
    expect(res.results[0]).toMatchObject({ updateAvailable: false, kind: "digest" });
  });

  test("Tier 2 GitHub releases fires for a catalog image via repoURL enrichment → kind 'version'", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => null,
      githubSource: new MockTagSource(["1.31.0"]),
    });
    const res = await handleUpdates(
      { images: ["docker.io/vaultwarden/server:1.30.0"] },
      resolver,
    );
    expect(res.results[0]).toEqual({
      image: "docker.io/vaultwarden/server:1.30.0",
      currentTag: "1.30.0",
      latest: "1.31.0",
      updateAvailable: true,
      kind: "version",
    });
  });

  test("image with no catalog match gets no repoURL → releases tier can't fire → unknown", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => null,
      githubSource: new MockTagSource(["v2.2.0"]),
    });
    const res = await handleUpdates(
      { images: ["quay.io/x/y:v2.1.0"] },
      resolver,
    );
    expect(res.results[0].kind).toBe("unknown");
  });

  test("unknown registry, no repo → kind 'unknown' with reason (no 500)", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => null,
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["quay.io/x/y:v1.0"] },
      resolver,
    );
    expect(res.results[0].kind).toBe("unknown");
    expect(res.results[0].updateAvailable).toBe(false);
    expect(typeof res.results[0].reason).toBe("string");
  });

  test("digest-only image → currentTag null, unknown", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => new MockTagSource(["v1.0"]),
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["ghcr.io/x/y@sha256:abc"] },
      resolver,
    );
    expect(res.results[0].currentTag).toBeNull();
    expect(res.results[0].kind).toBe("unknown");
  });

  test("a throwing tier is isolated per-image; batch still completes", async () => {
    const throwing: TagSource = {
      async listTags() {
        throw new Error("network");
      },
    };
    const resolver = new UpdateResolver({
      tagSourceFor: (host) =>
        host === "ghcr.io" ? new MockTagSource(["v1.0", "v2.0"]) : throwing,
      githubSource: null,
    });
    const res = await handleUpdates(
      { images: ["docker.io/library/postgres:v1.0", "ghcr.io/a/b:v1.0"] },
      resolver,
    );
    expect(res.results).toHaveLength(2);
    // The first image's tier throws but the resolver swallows it → unknown.
    expect(res.results[0].kind).toBe("unknown");
    // The second resolves normally.
    expect(res.results[1]).toEqual({
      image: "ghcr.io/a/b:v1.0",
      currentTag: "v1.0",
      latest: "v2.0",
      updateAvailable: true,
      kind: "version",
    });
  });
});

// ---------------------------------------------------------------------------
// Helm-managed apps — compare the deployed chart version against the chart
// repo's index (never the container image tag).
// ---------------------------------------------------------------------------
describe("handleUpdates charts", () => {
  const signoz = { release: "signoz", namespace: "signoz", repoURL: "https://charts.signoz.io", chart: "signoz" };
  const noImages = new UpdateResolver({ tagSourceFor: () => null, githubSource: null });
  const deps = (over: Partial<import("./updates").ChartUpdateDeps> = {}): import("./updates").ChartUpdateDeps => ({
    releaseChart: async () => ({ name: "signoz", version: "0.126.1" }),
    chartVersions: async () => ["0.148.0-rc.1", "0.147.0", "0.126.1"],
    ...over,
  });

  test("newer stable chart → updateAvailable with the chart version (prereleases ignored)", async () => {
    const res = await handleUpdates({ images: [], charts: [signoz] }, noImages, deps());
    expect(res).toEqual({
      results: [],
      charts: [{ release: "signoz", namespace: "signoz", chart: "signoz", currentVersion: "0.126.1", latest: "0.147.0", updateAvailable: true, kind: "version" }],
    });
  });

  test("already on the newest chart → up to date", async () => {
    const res = await handleUpdates({ charts: [signoz] }, noImages, deps({ releaseChart: async () => ({ name: "signoz", version: "0.147.0" }) }));
    expect(res.charts![0]).toEqual({ release: "signoz", namespace: "signoz", chart: "signoz", currentVersion: "0.147.0", latest: null, updateAvailable: false, kind: "version" });
  });

  test("release missing → unknown with a reason", async () => {
    const res = await handleUpdates({ charts: [signoz] }, noImages, deps({ releaseChart: async () => null }));
    expect(res.charts![0]).toMatchObject({ currentVersion: null, updateAvailable: false, kind: "unknown", reason: "could not read Helm release signoz/signoz" });
  });

  test("release runs a different chart than the catalog's → unknown (never upgrade across charts)", async () => {
    const res = await handleUpdates({ charts: [signoz] }, noImages, deps({ releaseChart: async () => ({ name: "k8s-infra", version: "0.13.0" }) }));
    expect(res.charts![0]).toMatchObject({ currentVersion: "0.13.0", updateAvailable: false, kind: "unknown", reason: "release signoz/signoz runs chart k8s-infra, not signoz" });
  });

  test("unreadable chart index → unknown", async () => {
    const res = await handleUpdates({ charts: [signoz] }, noImages, deps({ chartVersions: async () => null }));
    expect(res.charts![0]).toMatchObject({ updateAvailable: false, kind: "unknown", reason: "could not read the chart index at https://charts.signoz.io" });
  });

  test("a throwing lookup is isolated per chart", async () => {
    const res = await handleUpdates(
      { charts: [signoz, { ...signoz, release: "other" }] },
      noImages,
      deps({ releaseChart: async (release) => { if (release === "signoz") throw new Error("helm not found"); return { name: "signoz", version: "0.147.0" }; } }),
    );
    expect(res.charts![0]).toMatchObject({ kind: "unknown", reason: "helm not found" });
    expect(res.charts![1]).toMatchObject({ release: "other", kind: "version", updateAvailable: false });
  });
});
