import { describe, expect, test } from "vitest";
import type {
  CatalogApp,
  DeploymentLike,
  StatefulSetLike,
  DaemonSetLike,
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
    const targets = updateTargets(apps, deployments, [], [], []);
    expect(targets).toEqual([
      {
        appID: "plausible",
        image: "ghcr.io/plausible/community-edition:v2.1.4",
        workloadName: "plausible",
        workloadKind: "deployment",
        namespace: "analytics",
        container: "plausible",
        repoURL: "https://github.com/plausible/analytics",
        runningDigest: undefined,
      },
    ]);
  });

  test("marks a StatefulSet-backed app so setImage targets statefulset/…", () => {
    const apps = [app({ id: "signoz", matchImages: ["docker.io/signoz/signoz"] })];
    const statefulSets: StatefulSetLike[] = [
      {
        metadata: { name: "signoz", namespace: "signoz" },
        spec: { template: { spec: { containers: [{ name: "signoz", image: "docker.io/signoz/signoz:v0.126.1" }] } } },
      } as StatefulSetLike,
    ];
    const targets = updateTargets(apps, [], statefulSets, [], []);
    expect(targets[0]?.workloadKind).toBe("statefulset");
    expect(targets[0]?.workloadName).toBe("signoz");
    expect(targets[0]?.namespace).toBe("signoz");
  });

  test("omits apps with no matching container", () => {
    const apps = [app({ id: "memos", matchImages: ["neosmemo/memos"] })];
    const deployments = [deployment("other", "default", "c", "nginx:latest")];
    expect(updateTargets(apps, deployments, [], [], [])).toEqual([]);
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
    const targets = updateTargets(apps, deployments, [] as StatefulSetLike[], [], pods);
    expect(targets[0]?.runningDigest).toBe("sha256:abc123");
  });

  // --- Annotation-first targeting (catalog-link-workload spec) -------------
  test("annotated workload is the target over an image-matched candidate", () => {
    const apps = [app({ id: "foo", matchImages: ["ghcr.io/foo/foo"] })];
    // Image-matched deployment AND an annotated (mirror) deployment exist.
    const deployments = [
      deployment("image-foo", "a", "foo", "ghcr.io/foo/foo:1.0"),
      {
        metadata: { name: "mirror-foo", namespace: "apps", annotations: { "helmsman.dev/catalog-app": "foo" } },
        spec: { template: { spec: { containers: [{ name: "app", image: "registry.internal/team/foo:2.0" }] } } },
      } as DeploymentLike,
    ];
    const targets = updateTargets(apps, deployments, [], [], []);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.workloadName).toBe("mirror-foo");
    expect(targets[0]?.namespace).toBe("apps");
    expect(targets[0]?.container).toBe("app");
    expect(targets[0]?.image).toBe("registry.internal/team/foo:2.0");
  });

  test("annotated DaemonSet target carries workloadKind daemonset", () => {
    const apps = [app({ id: "ne", matchImages: ["quay.io/prometheus/node-exporter"] })];
    const daemonSets = [
      {
        metadata: { name: "node-exp", namespace: "mon", annotations: { "helmsman.dev/catalog-app": "ne" } },
        spec: { template: { spec: { containers: [{ name: "node-exporter", image: "quay.io/prometheus/node-exporter:v1.8.0" }] } } },
      } as DaemonSetLike,
    ];
    const targets = updateTargets(apps, [], [], daemonSets, []);
    expect(targets[0]?.workloadKind).toBe("daemonset");
    expect(targets[0]?.workloadName).toBe("node-exp");
  });

  test("catalog-container annotation selects that container on a multi-container workload", () => {
    const apps = [app({ id: "multi", matchImages: ["ghcr.io/multi/main"] })];
    const deployments = [
      {
        metadata: { name: "multi", namespace: "default", annotations: { "helmsman.dev/catalog-app": "multi", "helmsman.dev/catalog-container": "sidecar" } },
        spec: { template: { spec: { containers: [
          { name: "main", image: "ghcr.io/multi/main:1.0" },
          { name: "sidecar", image: "ghcr.io/multi/sidecar:9.9" },
        ] } } },
      } as DeploymentLike,
    ];
    const targets = updateTargets(apps, deployments, [], [], []);
    expect(targets[0]?.container).toBe("sidecar");
    expect(targets[0]?.image).toBe("ghcr.io/multi/sidecar:9.9");
  });

  test("multi-container, no container annotation → matchImage-matching container", () => {
    const apps = [app({ id: "multi", matchImages: ["ghcr.io/multi/main"] })];
    const deployments = [
      {
        metadata: { name: "multi", namespace: "default", annotations: { "helmsman.dev/catalog-app": "multi" } },
        spec: { template: { spec: { containers: [
          { name: "sidecar", image: "ghcr.io/multi/sidecar:9.9" },
          { name: "main", image: "ghcr.io/multi/main:1.0" },
        ] } } },
      } as DeploymentLike,
    ];
    const targets = updateTargets(apps, deployments, [], [], []);
    expect(targets[0]?.container).toBe("main");
  });

  test("stale catalog-container naming a missing container falls back", () => {
    const apps = [app({ id: "multi", matchImages: ["ghcr.io/multi/main"] })];
    const deployments = [
      {
        metadata: { name: "multi", namespace: "default", annotations: { "helmsman.dev/catalog-app": "multi", "helmsman.dev/catalog-container": "ghost" } },
        spec: { template: { spec: { containers: [
          { name: "sidecar", image: "ghcr.io/multi/sidecar:9.9" },
          { name: "main", image: "ghcr.io/multi/main:1.0" },
        ] } } },
      } as DeploymentLike,
    ];
    const targets = updateTargets(apps, deployments, [], [], []);
    // Falls back: matchImage-matching container.
    expect(targets[0]?.container).toBe("main");
  });

  test("two workloads with the same annotation → first in scan order wins", () => {
    const apps = [app({ id: "dup", matchImages: [] })];
    const deployments = [
      { metadata: { name: "dep-dup", namespace: "a", annotations: { "helmsman.dev/catalog-app": "dup" } }, spec: { template: { spec: { containers: [{ name: "c", image: "img:1" }] } } } } as DeploymentLike,
    ];
    const statefulSets = [
      { metadata: { name: "sts-dup", namespace: "b", annotations: { "helmsman.dev/catalog-app": "dup" } }, spec: { template: { spec: { containers: [{ name: "c", image: "img:2" }] } } } } as StatefulSetLike,
    ];
    const targets = updateTargets(apps, deployments, statefulSets, [], []);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.workloadName).toBe("dep-dup");
    expect(targets[0]?.workloadKind).toBe("deployment");
  });
});
