import { describe, expect, test } from "vitest";
import { backendServices, podLabelsOf, referencedResources, routingFor, selectorMatches } from "./workloadClosure";

const workload = {
  kind: "Deployment",
  metadata: { name: "reddex-deploy", namespace: "default" },
  spec: {
    selector: { matchLabels: { "workload.user.cattle.io/workloadselector": "apps.deployment-default-reddex-deploy" } },
    template: {
      spec: {
        containers: [
          {
            name: "container-0",
            envFrom: [{ configMapRef: { name: "reddex-config" } }, { secretRef: { name: "reddex-env" } }],
            env: [{ name: "KEY", valueFrom: { secretKeyRef: { name: "reddex-api-key" } } }],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "reddex-data" } },
          { name: "certs", secret: { secretName: "reddex-tls" } },
        ],
        imagePullSecrets: [{ name: "ghcr-creds" }],
      },
    },
  },
};

const svc = (name: string, selector: Record<string, string>) => ({
  kind: "Service",
  metadata: { name, namespace: "default" },
  spec: { selector },
});

const ing = (name: string, service: string) => ({
  kind: "Ingress",
  metadata: { name, namespace: "default" },
  spec: { rules: [{ http: { paths: [{ backend: { service: { name: service } } }] } }] },
});

describe("routingFor", () => {
  // The bug this exists for: name-prefix discovery returned
  // reddex-custom-website-deploy and its service and ingress for a query about
  // reddex-deploy. A different app, swept in by sharing four letters.
  test("takes only the Service that selects this workload's pods", () => {
    const found = routingFor(
      workload,
      [
        svc("reddex-deploy", { "workload.user.cattle.io/workloadselector": "apps.deployment-default-reddex-deploy" }),
        svc("reddex-custom-website-deploy", {
          "workload.user.cattle.io/workloadselector": "apps.deployment-default-reddex-custom-website-deploy",
        }),
        svc("reddex-custom-nextjs-deploy", { app: "something-else" }),
      ],
      [ing("reddex-ingress", "reddex-deploy"), ing("reddex-custom-website-ingress", "reddex-custom-website-deploy")],
    );
    expect(found.services).toEqual(["reddex-deploy"]);
    expect(found.ingresses).toEqual(["reddex-ingress"]);
  });

  test("a Service with no selector routes to nothing of ours", () => {
    const found = routingFor(workload, [{ kind: "Service", metadata: { name: "external" }, spec: {} }], []);
    expect(found.services).toEqual([]);
  });

  test("several Services on the same workload are all taken", () => {
    const labels = { "workload.user.cattle.io/workloadselector": "apps.deployment-default-reddex-deploy" };
    const found = routingFor(workload, [svc("web", labels), svc("web-metrics", labels)], []);
    expect(found.services).toEqual(["web", "web-metrics"]);
  });
});

describe("selectorMatches", () => {
  test("every label in the selector must be present and equal", () => {
    expect(selectorMatches({ app: "web" }, { app: "web", tier: "front" })).toBe(true);
    expect(selectorMatches({ app: "web", tier: "back" }, { app: "web", tier: "front" })).toBe(false);
    // An empty selector selects everything in Kubernetes, which is never what
    // "belongs to this workload" means.
    expect(selectorMatches({}, { app: "web" })).toBe(false);
  });
});

describe("referencedResources", () => {
  test("takes everything the pod actually reads or mounts, once each", () => {
    expect(referencedResources(workload)).toEqual([
      { kind: "configmap", name: "reddex-config" },
      { kind: "secret", name: "reddex-env" },
      { kind: "secret", name: "reddex-api-key" },
      { kind: "persistentvolumeclaim", name: "reddex-data" },
      { kind: "secret", name: "reddex-tls" },
      { kind: "secret", name: "ghcr-creds" },
    ]);
  });

  test("a workload that references nothing yields nothing", () => {
    expect(referencedResources({ kind: "Deployment", spec: { template: { spec: { containers: [{ name: "c" }] } } } })).toEqual([]);
  });
});

describe("podLabelsOf and backendServices", () => {
  test("pod labels come from the selector, falling back to the template", () => {
    expect(podLabelsOf(workload)).toHaveProperty("workload.user.cattle.io/workloadselector");
    expect(podLabelsOf({ spec: { template: { metadata: { labels: { app: "web" } } } } })).toEqual({ app: "web" });
  });

  test("backends are read from both the modern and legacy shapes", () => {
    expect(backendServices(ing("i", "web"))).toEqual(["web"]);
    expect(
      backendServices({ spec: { defaultBackend: { service: { name: "fallback" } } } }),
    ).toEqual(["fallback"]);
    expect(
      backendServices({ spec: { rules: [{ http: { paths: [{ backend: { serviceName: "legacy" } }] } }] } }),
    ).toEqual(["legacy"]);
  });
});
