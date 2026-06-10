import { describe, expect, test } from "vitest";
import type {
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  PodLike,
} from "@helmsman/catalog";
import { updateTargets, withTag } from "./updateTargets";

function app(partial: Partial<CatalogApp> & { id: string }): CatalogApp {
  return {
    name: partial.name ?? partial.id,
    tagline: "",
    description: "",
    category: partial.category ?? "other",
    iconSystemName: "x",
    docsURL: "https://x",
    tags: [],
    matchImages: partial.matchImages ?? [],
    requirements: { cpuRequest: "100m", memoryRequest: "128Mi" },
    persistence: false,
    exposesIngress: false,
    installPromptTemplate: "",
    ...partial,
  } as CatalogApp;
}

function deployment(
  name: string,
  namespace: string,
  container: string,
  image: string,
): DeploymentLike {
  return {
    metadata: { name, namespace },
    spec: { template: { spec: { containers: [{ name: container, image }] } } },
  } as DeploymentLike;
}

describe("withTag", () => {
  test("replaces a version tag", () => {
    expect(withTag("ghcr.io/x/y:v1.2.3", "v1.3.0")).toBe("ghcr.io/x/y:v1.3.0");
  });

  test("replaces a Docker Hub single-name tag", () => {
    expect(withTag("nextcloud:29-apache", "30")).toBe("nextcloud:30");
  });

  test("strips a digest before appending the new tag", () => {
    expect(withTag("repo/app@sha256:abc", "v2")).toBe("repo/app:v2");
  });

  test("appends a tag when the running ref has none", () => {
    expect(withTag("ghcr.io/x/y", "v1.0.0")).toBe("ghcr.io/x/y:v1.0.0");
  });

  test("a colon in the registry port is not mistaken for a tag", () => {
    expect(withTag("localhost:5000/app:v1", "v2")).toBe("localhost:5000/app:v2");
  });
});

describe("updateTargets", () => {
  test("returns workload coordinates for a matched deployment container", () => {
    const apps = [
      app({ id: "plausible", matchImages: ["ghcr.io/plausible/community-edition"], repoURL: "https://github.com/plausible/analytics" }),
    ];
    const deployments = [
      deployment("plausible", "analytics", "plausible", "ghcr.io/plausible/community-edition:v2.1.4"),
    ];
    const targets = updateTargets(apps, deployments, [], []);
    expect(targets).toEqual([
      {
        appID: "plausible",
        image: "ghcr.io/plausible/community-edition:v2.1.4",
        workloadName: "plausible",
        namespace: "analytics",
        container: "plausible",
        repoURL: "https://github.com/plausible/analytics",
        runningDigest: undefined,
      },
    ]);
  });

  test("omits apps with no matching container", () => {
    const apps = [app({ id: "memos", matchImages: ["neosmemo/memos"] })];
    const deployments = [deployment("other", "default", "c", "nginx:latest")];
    expect(updateTargets(apps, deployments, [], [])).toEqual([]);
  });

  test("recovers the running digest from pod status", () => {
    const apps = [app({ id: "vault", matchImages: ["vaultwarden/server"] })];
    const deployments = [
      deployment("vaultwarden", "default", "vaultwarden", "vaultwarden/server:latest"),
    ];
    const pods: PodLike[] = [
      {
        spec: { containers: [{ name: "vaultwarden", image: "vaultwarden/server:latest" }] },
        status: {
          containerStatuses: [
            { name: "vaultwarden", imageID: "docker-pullable://vaultwarden/server@sha256:abc123" },
          ],
        },
      } as PodLike,
    ];
    const targets = updateTargets(apps, deployments, [] as StatefulSetLike[], pods);
    expect(targets[0]?.runningDigest).toBe("sha256:abc123");
  });
});
