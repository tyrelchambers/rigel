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

beforeEach(() => {
  kubectlMock.mockReset();
  discoverMock.mockReset();
});

describe("planAdoption", () => {
  test("exports every discovered resource as its own cleaned file", async () => {
    discoverMock.mockResolvedValue({
      ok: true,
      discovered: [
        { kind: "deployment", name: "reddex-deploy", namespace: "default" },
        { kind: "service", name: "reddex-deploy", namespace: "default" },
        { kind: "ingress", name: "reddex-ingress", namespace: "default" },
      ],
    });
    kubectlMock.mockResolvedValue({ code: 0, stdout: DEPLOY, stderr: "" });

    const plan = await planAdoption(null, workload, "manifests");

    expect(plan.ok).toBe(true);
    expect(plan.files!.map((f) => f.path)).toEqual([
      "manifests/deployment-reddex-deploy.yaml",
      "manifests/service-reddex-deploy.yaml",
      "manifests/ingress-reddex-ingress.yaml",
    ]);
    // Cleaned on the way out, so the committed file can actually be applied.
    expect(plan.files![0]!.content).not.toContain("uid:");
    expect(plan.files![0]!.content).not.toContain("status:");
    expect(plan.included).toHaveLength(3);
  });

  // The kind prefix is why a Deployment and its Service can share a name.
  test("names files by kind and name", () => {
    expect(fileNameFor("Deployment", "web")).toBe("deployment-web.yaml");
    expect(fileNameFor("service", "web")).toBe("service-web.yaml");
  });

  test("a Secret is exported as its shape, and never as something appliable", async () => {
    discoverMock.mockResolvedValue({
      ok: true,
      discovered: [{ kind: "secret", name: "reddex-env", namespace: "default" }],
    });
    kubectlMock.mockResolvedValue({ code: 0, stdout: SECRET, stderr: "" });

    const plan = await planAdoption(null, workload, "manifests");
    const file = plan.files![0]!;

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
    discoverMock.mockResolvedValue({
      ok: true,
      discovered: [
        { kind: "deployment", name: "reddex-deploy", namespace: "default" },
        { kind: "ingress", name: "gone", namespace: "default" },
      ],
    });
    kubectlMock.mockImplementation(async (_ctx: unknown, args: string[]) =>
      args.includes("gone") ? { code: 1, stdout: "", stderr: "NotFound" } : { code: 0, stdout: DEPLOY, stderr: "" },
    );

    const plan = await planAdoption(null, workload, "manifests");
    expect(plan.ok).toBe(true);
    expect(plan.files).toHaveLength(1);
    expect(plan.included).toEqual(["deployment/reddex-deploy"]);
  });

  test("nothing readable at all refuses rather than opening an empty pull request", async () => {
    discoverMock.mockResolvedValue({ ok: true, discovered: [] });
    kubectlMock.mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" });
    const plan = await planAdoption(null, workload, "manifests");
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain("reddex-deploy");
  });

  test("a source rooted at the repo puts files at the top level", async () => {
    discoverMock.mockResolvedValue({
      ok: true,
      discovered: [{ kind: "deployment", name: "reddex-deploy", namespace: "default" }],
    });
    kubectlMock.mockResolvedValue({ code: 0, stdout: DEPLOY, stderr: "" });
    const plan = await planAdoption(null, workload, ".");
    expect(plan.files![0]!.path).toBe("deployment-reddex-deploy.yaml");
  });
});
