import { test, expect, describe } from "vitest";
import { handleUpdates } from "./updates";
import { UpdateResolver, type TagSource } from "@helmsman/catalog";

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
    // @ts-expect-error exercising the defensive non-array guard
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

  test("Tier 2 GitHub releases when registry declines → kind 'version'", async () => {
    const resolver = new UpdateResolver({
      tagSourceFor: () => null,
      githubSource: new MockTagSource(["v2.2.0"]),
    });
    const res = await handleUpdates(
      { images: ["quay.io/x/y:v2.1.0"] },
      resolver,
    );
    // No repoURL is attached when the handler builds an InstalledImage from a
    // bare ref, so the releases tier can't fire — falls through to unknown.
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
