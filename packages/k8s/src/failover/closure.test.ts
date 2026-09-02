import { describe, expect, it } from "vitest";
import {
  crossNamespaceServiceRefs,
  failoverClosure,
  helmReleaseOf,
  ingressTlsSecrets,
  middlewaresForIngress,
  rbacForServiceAccount,
} from "./closure";
import type { ClusterObject } from "../workloadClosure";

const labels = { app: "web" };

const workload = (over: Partial<ClusterObject> = {}): ClusterObject => ({
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", labels: { "app.kubernetes.io/managed-by": "Helm", "app.kubernetes.io/instance": "wildbarrens" } },
  spec: {
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: {
        serviceAccountName: "web-sa",
        containers: [
          {
            name: "c",
            env: [{ name: "REDIS", value: "redis.redis-actual.svc.cluster.local:6379" }],
          },
        ],
      },
    },
  },
  ...over,
});

const svc: ClusterObject = {
  kind: "Service",
  metadata: { name: "web", namespace: "default" },
  spec: { selector: labels },
};

const ingress = (over: Partial<ClusterObject> = {}): ClusterObject => ({
  kind: "Ingress",
  metadata: {
    name: "web",
    namespace: "default",
    annotations: { "traefik.ingress.kubernetes.io/router.middlewares": "default-redirect@kubernetescrd" },
  },
  spec: {
    tls: [{ secretName: "web-tls" }],
    rules: [{ http: { paths: [{ backend: { service: { name: "web" } } }] } }],
  },
  ...over,
});

describe("ingressTlsSecrets", () => {
  it("takes spec.tls secretName", () => {
    expect(ingressTlsSecrets(ingress())).toEqual(["web-tls"]);
  });
  it("ignores an Ingress with no tls", () => {
    expect(ingressTlsSecrets(ingress({ spec: { rules: [] } }))).toEqual([]);
  });
});

describe("middlewaresForIngress", () => {
  const mw: ClusterObject = { metadata: { name: "redirect", namespace: "default" } };
  it("matches namespace-name@kubernetescrd against live objects", () => {
    expect(middlewaresForIngress(ingress(), [mw]).map((m) => m.metadata?.name)).toEqual(["redirect"]);
  });
  it("does not take a similarly named Middleware in another namespace", () => {
    expect(
      middlewaresForIngress(ingress(), [{ metadata: { name: "redirect", namespace: "other" } }]),
    ).toEqual([]);
  });
});

describe("crossNamespaceServiceRefs", () => {
  it("parses *.svc.cluster.local env values outside the workload namespace", () => {
    expect(crossNamespaceServiceRefs(workload())).toEqual([{ namespace: "redis-actual", name: "redis" }]);
  });
  it("skips a host in the same namespace", () => {
    const w = workload();
    (w.spec as { template: { spec: { containers: Array<{ env: Array<{ value: string }> }> } } }).template.spec.containers[0]!.env =
      [{ name: "DB", value: "postgres-rw.default.svc.cluster.local" }];
    expect(crossNamespaceServiceRefs(w)).toEqual([]);
  });
});

describe("helmReleaseOf", () => {
  it("reads Helm instance labels", () => {
    expect(helmReleaseOf(workload())).toEqual({ name: "wildbarrens", namespace: "default" });
  });
  it("ignores a workload Helm did not install", () => {
    expect(helmReleaseOf(workload({ metadata: { name: "web", namespace: "default", labels: {} } }))).toBeUndefined();
  });
});

describe("rbacForServiceAccount", () => {
  it("follows RoleBinding to Role and ClusterRoleBinding to ClusterRole", () => {
    const members = rbacForServiceAccount(
      { name: "web-sa", namespace: "default" },
      {
        rolebindings: [
          {
            metadata: { name: "web-bind", namespace: "default" },
            subjects: [{ kind: "ServiceAccount", name: "web-sa", namespace: "default" }],
            roleRef: { kind: "Role", name: "web-role" },
          },
        ],
        clusterrolebindings: [
          {
            metadata: { name: "web-cluster" },
            subjects: [{ kind: "ServiceAccount", name: "web-sa", namespace: "default" }],
            roleRef: { kind: "ClusterRole", name: "manage-deployments" },
          },
        ],
      },
    );
    expect(members).toEqual(
      expect.arrayContaining([
        { kind: "ServiceAccount", namespace: "default", name: "web-sa" },
        { kind: "RoleBinding", namespace: "default", name: "web-bind" },
        { kind: "Role", namespace: "default", name: "web-role" },
        { kind: "ClusterRoleBinding", namespace: "", name: "web-cluster" },
        { kind: "ClusterRole", namespace: "", name: "manage-deployments" },
      ]),
    );
  });
  it("does not take a binding for a different ServiceAccount", () => {
    const members = rbacForServiceAccount(
      { name: "web-sa", namespace: "default" },
      {
        rolebindings: [
          {
            metadata: { name: "other", namespace: "default" },
            subjects: [{ kind: "ServiceAccount", name: "other-sa", namespace: "default" }],
            roleRef: { kind: "Role", name: "other-role" },
          },
        ],
      },
    );
    expect(members.map((m) => m.name)).toEqual(["web-sa"]);
  });
});

describe("failoverClosure", () => {
  it("includes TLS Secret, Certificate, Middleware, SA RBAC, PDB, HPA, cross-ns Service and Helm release", () => {
    const members = failoverClosure([workload()], [svc], [ingress()], {
      certificates: [{ metadata: { name: "web-cert", namespace: "default" }, spec: { secretName: "web-tls" } }],
      middlewares: [{ metadata: { name: "redirect", namespace: "default" } }],
      rolebindings: [
        {
          metadata: { name: "web-bind", namespace: "default" },
          subjects: [{ kind: "ServiceAccount", name: "web-sa", namespace: "default" }],
          roleRef: { kind: "Role", name: "web-role" },
        },
      ],
      pdbs: [
        {
          metadata: { name: "web-pdb", namespace: "default" },
          spec: { selector: { matchLabels: labels } },
        },
      ],
      hpas: [
        {
          metadata: { name: "web-hpa", namespace: "default" },
          spec: { scaleTargetRef: { kind: "Deployment", name: "web" } },
        },
      ],
    });
    const keys = members.map((m) => `${m.kind}/${m.namespace}/${m.name}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "Deployment/default/web",
        "Service/default/web",
        "Ingress/default/web",
        "Secret/default/web-tls",
        "Certificate/default/web-cert",
        "Middleware/default/redirect",
        "ServiceAccount/default/web-sa",
        "RoleBinding/default/web-bind",
        "Role/default/web-role",
        "PodDisruptionBudget/default/web-pdb",
        "HorizontalPodAutoscaler/default/web-hpa",
        "Service/redis-actual/redis",
        "HelmRelease/default/wildbarrens",
      ]),
    );
  });

  it("does not pull a Certificate for a different TLS Secret", () => {
    const members = failoverClosure([workload()], [svc], [ingress()], {
      certificates: [{ metadata: { name: "other", namespace: "default" }, spec: { secretName: "other-tls" } }],
    });
    expect(members.some((m) => m.kind === "Certificate")).toBe(false);
  });
});
