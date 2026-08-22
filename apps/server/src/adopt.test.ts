import { describe, expect, test, vi, beforeEach } from "vitest";

const { kubectlMock, discoverMock } = vi.hoisted(() => ({ kubectlMock: vi.fn(), discoverMock: vi.fn() }));
vi.mock("@rigel/k8s/src/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rigel/k8s/src/run")>();
  return { ...actual, kubectl: kubectlMock };
});
vi.mock("./purge", () => ({ discover: discoverMock }));

import { fileNameFor, planAdoption } from "./adopt";

const DEPLOY = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: reddex-deploy
  namespace: default
  uid: 8f14e45f
spec:
  replicas: 3
status:
  readyReplicas: 3
`;

const SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: reddex-env
  namespace: default
type: Opaque
data:
  DATABASE_URL: ${Buffer.from("postgres://real:creds@host/db").toString("base64")}
`;

const workload = { kind: "deployment", name: "reddex-deploy", namespace: "default" };

const LABELS = { "workload.user.cattle.io/workloadselector": "apps.deployment-default-reddex-deploy" };

/** The live objects the closure walks, as `-o json` returns them. */
const DEPLOY_JSON = {
  kind: "Deployment",
  metadata: { name: "reddex-deploy", namespace: "default" },
  spec: {
    selector: { matchLabels: LABELS },
    template: { spec: { containers: [{ name: "c", envFrom: [{ secretRef: { name: "reddex-env" } }] }] } },
  },
};

const SERVICES = {
  items: [
    { kind: "Service", metadata: { name: "reddex-deploy", namespace: "default" }, spec: { selector: LABELS } },
    {
      kind: "Service",
      metadata: { name: "reddex-custom-website-deploy", namespace: "default" },
      spec: { selector: { app: "other" } },
    },
  ],
};

const INGRESSES = {
  items: [
    {
      kind: "Ingress",
      metadata: { name: "reddex-ingress", namespace: "default" },
      spec: { rules: [{ http: { paths: [{ backend: { service: { name: "reddex-deploy" } } }] } }] },
    },
    {
      kind: "Ingress",
      metadata: { name: "reddex-custom-website-ingress", namespace: "default" },
      spec: { rules: [{ http: { paths: [{ backend: { service: { name: "reddex-custom-website-deploy" } } }] } }] },
    },
  ],
};

/** Answers the closure's json reads, then the per-resource yaml exports. */
function clusterReads(yamlFor: (kind: string, name: string) => { code: number; stdout: string } = () => ({ code: 0, stdout: DEPLOY })) {
  return async (_ctx: unknown, args: string[]) => {
    const json = args.includes("json");
    const kind = args[1] ?? "";
    const named = args[2] && !args[2].startsWith("-") ? args[2] : "";
    if (json && named) return { code: 0, stdout: JSON.stringify(DEPLOY_JSON), stderr: "" };
    if (json && kind === "service") return { code: 0, stdout: JSON.stringify(SERVICES), stderr: "" };
    if (json && kind === "ingress") return { code: 0, stdout: JSON.stringify(INGRESSES), stderr: "" };
    if (json) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
    return { ...yamlFor(kind, named), stderr: "" };
  };
}

beforeEach(() => {
  kubectlMock.mockReset();
  discoverMock.mockReset();
});

describe("planAdoption", () => {
  test("takes only what belongs to this workload, not what shares its name", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockImplementation(clusterReads());

    const plan = await planAdoption(null, workload, "manifests");

    expect(plan.ok).toBe(true);
    // reddex-custom-website-* is a different app that merely shares a prefix.
    expect(plan.files!.map((f) => f.path)).toEqual([
      "manifests/deployment-reddex-deploy.yaml",
      "manifests/service-reddex-deploy.yaml",
      "manifests/ingress-reddex-ingress.yaml",
      "manifests/secret-reddex-env.yaml.example",
    ]);
    expect(JSON.stringify(plan.files)).not.toContain("custom-website");
    // Cleaned on the way out, so the committed file can actually be applied.
    expect(plan.files![0]!.content).not.toContain("uid:");
    expect(plan.files![0]!.content).not.toContain("status:");
    // The workload, its Service, its Ingress, and the Secret its pod reads.
    expect(plan.included).toHaveLength(4);
  });

  // The kind prefix is why a Deployment and its Service can share a name.
  test("names files by kind and name", () => {
    expect(fileNameFor("Deployment", "web")).toBe("deployment-web.yaml");
    expect(fileNameFor("service", "web")).toBe("service-web.yaml");
  });

  test("a Secret is exported as its shape, and never as something appliable", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockImplementation(clusterReads((kind) => ({ code: 0, stdout: kind === "secret" ? SECRET : DEPLOY })));

    const plan = await planAdoption(null, workload, "manifests");
    const file = plan.files!.find((f) => f.path.includes("secret"))!;

    // .yaml.example is invisible to `kubectl apply -R`, so a sync can never
    // write this over the live Secret's real values.
    expect(file.path).toBe("manifests/secret-reddex-env.yaml.example");
    expect(file.content).not.toContain("postgres://real:creds@host/db");
    expect(file.content).not.toContain(Buffer.from("postgres://real:creds@host/db").toString("base64"));
    expect(file.content).toContain("DATABASE_URL");
    expect(file.content).toContain("fill them in before applying");
  });

  test("a Helm release refuses, naming the release", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [], helmRelease: "sh.helm.release.v1.reddex.v3" });
    const plan = await planAdoption(null, workload, "manifests");
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain("Helm release");
    expect(plan.message).toContain("drifts");
  });

  test("a protected namespace refuses with the engine's own reason", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [], blockedReason: "kube-system is protected" });
    const plan = await planAdoption(null, { ...workload, namespace: "kube-system" }, "manifests");
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain("protected");
  });

  test("one unreadable resource does not sink the rest", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockImplementation(
      clusterReads((kind) => (kind === "ingress" ? { code: 1, stdout: "" } : { code: 0, stdout: DEPLOY })),
    );

    const plan = await planAdoption(null, workload, "manifests");
    expect(plan.ok).toBe(true);
    expect(plan.included).not.toContain("ingress/reddex-ingress");
    expect(plan.included).toContain("deployment/reddex-deploy");
  });

  test("a workload that cannot be read refuses rather than opening an empty pull request", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" });
    const plan = await planAdoption(null, workload, "manifests");
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain("reddex-deploy");
  });

  test("a source rooted at the repo puts files at the top level", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockImplementation(clusterReads());
    const plan = await planAdoption(null, workload, ".");
    expect(plan.files![0]!.path).toBe("deployment-reddex-deploy.yaml");
  });
});
