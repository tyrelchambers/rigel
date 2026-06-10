import { describe, test, expect } from "bun:test";
import {
  core,
  isRelated,
  isProtectedNamespace,
  blockedNamespaceReason,
  isSharedInfraWorkload,
  helmReleaseFromSecretName,
  detectHelmRelease,
  filterDiscovered,
  canonicalKind,
  kubectlDeleteKind,
  defaultSelected,
  discoveryArgs,
  fallbackDiscoveryArgs,
  deleteArgs,
  helmUninstallArgs,
  DISCOVERY_KINDS,
  type RawResource,
} from "./purge";

// ---------------------------------------------------------------------------
// core() — identity-core extraction
// ---------------------------------------------------------------------------
describe("core", () => {
  test("drops role/env tokens and rejoins", () => {
    expect(core("memos-web")).toBe("memos");
    expect(core("paperless-api")).toBe("paperless");
    expect(core("foo-staging-server")).toBe("foo");
    expect(core("my_app_backend")).toBe("my"); // app+backend are role tokens
  });

  test("keeps all tokens when every token is a role token", () => {
    expect(core("web")).toBe("web");
    expect(core("api-server")).toBe("apiserver");
  });

  test("lowercases", () => {
    expect(core("Memos-Web")).toBe("memos");
  });
});

// ---------------------------------------------------------------------------
// isRelated() — prefix vs exact by core length
// ---------------------------------------------------------------------------
describe("isRelated", () => {
  test("prefix match when root core >= 4 chars", () => {
    expect(isRelated("memos-postgres", "memos")).toBe(true);
    expect(isRelated("memos", "memos-web")).toBe(true);
    expect(isRelated("paperless-redis", "paperless")).toBe(true);
  });

  test("unrelated names are not related", () => {
    expect(isRelated("grafana", "memos")).toBe(false);
  });

  test("short cores (<4) require exact core equality", () => {
    // core("ui-app") -> "ui" (2 chars) ; only exact ui matches
    expect(isRelated("ui", "ui-app")).toBe(true);
    expect(isRelated("uikit", "ui")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
describe("protected namespaces", () => {
  test("exact matches", () => {
    for (const ns of ["kube-system", "kube-public", "kube-node-lease", "default-system", "cert-manager", "cnpg-system"]) {
      expect(isProtectedNamespace(ns)).toBe(true);
    }
  });

  test("prefix matches", () => {
    expect(isProtectedNamespace("kube-anything")).toBe(true);
    expect(isProtectedNamespace("cattle-system")).toBe(true);
    expect(isProtectedNamespace("fleet-local")).toBe(true);
    expect(isProtectedNamespace("tigera-operator")).toBe(true);
    expect(isProtectedNamespace("calico-apiserver")).toBe(true);
  });

  test("default is purgeable", () => {
    expect(isProtectedNamespace("default")).toBe(false);
    expect(isProtectedNamespace("apps")).toBe(false);
  });

  test("blockedNamespaceReason", () => {
    expect(blockedNamespaceReason("kube-system")).toBe("kube-system is a protected system namespace");
    expect(blockedNamespaceReason("default")).toBeNull();
  });
});

describe("shared-infra workloads", () => {
  test("exact infra names protected", () => {
    expect(isSharedInfraWorkload("postgres")).toBe(true);
    expect(isSharedInfraWorkload("redis")).toBe(true);
    expect(isSharedInfraWorkload("mariadb")).toBe(true);
    expect(isSharedInfraWorkload("postgres-pooler")).toBe(true);
  });

  test("non-infra not protected", () => {
    expect(isSharedInfraWorkload("memos")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helm detection
// ---------------------------------------------------------------------------
describe("helm detection", () => {
  test("extracts release from secret name", () => {
    expect(helmReleaseFromSecretName("sh.helm.release.v1.memos.v3")).toBe("memos");
    expect(helmReleaseFromSecretName("sh.helm.release.v1.my-app.v12")).toBe("my-app");
  });

  test("non-helm secret returns null", () => {
    expect(helmReleaseFromSecretName("memos-tls")).toBeNull();
    expect(helmReleaseFromSecretName("sh.helm.release.v1.memos")).toBeNull(); // no .vN
  });

  test("detectHelmRelease keeps only related releases", () => {
    const names = ["sh.helm.release.v1.memos.v1", "sh.helm.release.v1.grafana.v2", "memos-tls"];
    expect(detectHelmRelease(names, "memos")).toBe("memos");
    expect(detectHelmRelease(names, "nothing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------
describe("kind mapping", () => {
  test("canonicalKind maps k8s kinds", () => {
    expect(canonicalKind("Deployment")).toBe("deployment");
    expect(canonicalKind("PersistentVolumeClaim")).toBe("persistentvolumeclaim");
    expect(canonicalKind("ServiceAccount")).toBe("serviceaccount");
    expect(canonicalKind("Pod")).toBeNull();
  });

  test("kubectlDeleteKind normalizes pvc", () => {
    expect(kubectlDeleteKind("persistentvolumeclaim")).toBe("pvc");
    expect(kubectlDeleteKind("deployment")).toBe("deployment");
  });

  test("defaultSelected: PVCs off, others on", () => {
    expect(defaultSelected("persistentvolumeclaim")).toBe(false);
    expect(defaultSelected("deployment")).toBe(true);
    expect(defaultSelected("secret")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterDiscovered
// ---------------------------------------------------------------------------
describe("filterDiscovered", () => {
  const raw: RawResource[] = [
    { kind: "Deployment", metadata: { name: "memos" } },
    { kind: "Service", metadata: { name: "memos" } },
    { kind: "PersistentVolumeClaim", metadata: { name: "memos-data" } },
    { kind: "Deployment", metadata: { name: "postgres" } }, // shared infra
    { kind: "Deployment", metadata: { name: "grafana" } }, // unrelated
    { kind: "Secret", metadata: { name: "sh.helm.release.v1.memos.v1" } }, // helm bookkeeping
    { kind: "Secret", metadata: { name: "memos-tls" } },
    { kind: "Pod", metadata: { name: "memos-abc" } }, // non-purgeable kind
  ];

  test("keeps related resources, drops infra/unrelated/helm-secret/pods", () => {
    const out = filterDiscovered(raw, "memos", "default");
    const names = out.map((r) => `${r.kind}/${r.name}`);
    expect(names).toContain("deployment/memos");
    expect(names).toContain("service/memos");
    expect(names).toContain("persistentvolumeclaim/memos-data");
    expect(names).toContain("secret/memos-tls");
    // protected shared-infra workload dropped
    expect(names).not.toContain("deployment/postgres");
    // unrelated dropped
    expect(names).not.toContain("deployment/grafana");
    // helm bookkeeping secret dropped
    expect(names).not.toContain("secret/sh.helm.release.v1.memos.v1");
    // non-purgeable kind dropped
    expect(names.some((n) => n.startsWith("pod/"))).toBe(false);
  });

  test("namespace is stamped from the argument", () => {
    const out = filterDiscovered(raw, "memos", "apps");
    expect(out.every((r) => r.namespace === "apps")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// argv builders — exact kubectl/helm commands
// ---------------------------------------------------------------------------
describe("argv builders", () => {
  test("discoveryArgs: label query with the full kind list", () => {
    expect(discoveryArgs("memos", "default")).toEqual([
      "get",
      DISCOVERY_KINDS.join(","),
      "-l",
      "app.kubernetes.io/instance=memos",
      "-n",
      "default",
      "-o",
      "json",
    ]);
  });

  test("discovery kind list matches the spec order/contents", () => {
    expect(DISCOVERY_KINDS.join(",")).toBe(
      "deployments,statefulsets,daemonsets,services,ingresses,configmaps,secrets,persistentvolumeclaims,jobs,cronjobs,serviceaccounts",
    );
  });

  test("fallbackDiscoveryArgs: no label selector", () => {
    expect(fallbackDiscoveryArgs("apps")).toEqual([
      "get",
      DISCOVERY_KINDS.join(","),
      "-n",
      "apps",
      "-o",
      "json",
    ]);
  });

  test("deleteArgs: kubectl delete <kind> <name> -n <ns>, pvc normalized", () => {
    expect(deleteArgs("deployment", "memos", "default")).toEqual([
      "delete", "deployment", "memos", "-n", "default",
    ]);
    expect(deleteArgs("persistentvolumeclaim", "memos-data", "default")).toEqual([
      "delete", "pvc", "memos-data", "-n", "default",
    ]);
  });

  test("helmUninstallArgs: uninstall <release> -n <ns>", () => {
    expect(helmUninstallArgs("memos", "default")).toEqual([
      "uninstall", "memos", "-n", "default",
    ]);
  });
});
