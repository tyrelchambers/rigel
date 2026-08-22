import { describe, it, test, expect } from "vitest";
import { cleanExportedManifest, stripStatusBlock } from "./manifestClean";

test("stripStatusBlock drops a top-level status block, keeps the rest", () => {
  const input = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    "  replicas: 2",
    "status:",
    "  readyReplicas: 2",
    "  conditions:",
    "  - type: Available",
  ].join("\n");
  const out = stripStatusBlock(input);
  expect(out).toContain("kind: Deployment");
  expect(out).toContain("replicas: 2");
  expect(out).not.toContain("status:");
  expect(out).not.toContain("readyReplicas");
});

test("stripStatusBlock keeps a status block that ends before another top-level key", () => {
  const input = ["kind: Deployment", "status:", "  ready: 1", "spec:", "  replicas: 3"].join("\n");
  const out = stripStatusBlock(input);
  expect(out).not.toContain("ready: 1");
  expect(out).toContain("replicas: 3"); // spec after status survives
});

test("stripStatusBlock leaves an indented status: key (e.g. configmap data) untouched", () => {
  const input = "apiVersion: v1\nkind: ConfigMap\ndata:\n  status: not-a-block\n";
  expect(stripStatusBlock(input)).toBe(input);
});

test("stripStatusBlock preserves the trailing newline when status is the final block", () => {
  const input = "kind: Deployment\nspec:\n  replicas: 1\nstatus:\n  readyReplicas: 1\n";
  expect(stripStatusBlock(input)).toBe("kind: Deployment\nspec:\n  replicas: 1\n");
});

describe("cleanExportedManifest", () => {
  const live = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  uid: 8f14e45f-ea8d-4c2b-9f1a-000000000000
  resourceVersion: "884213"
  creationTimestamp: "2026-01-04T02:11:00Z"
  generation: 7
  selfLink: /apis/apps/v1/namespaces/shop/deployments/web
  annotations:
    deployment.kubernetes.io/revision: "12"
    kubectl.kubernetes.io/last-applied-configuration: '{"kind":"Deployment"}'
    rigel.dev/source-repo: shop-web-82b3ade
    example.com/owner: platform
  ownerReferences:
    - apiVersion: v1
      kind: Foo
      name: bar
      uid: x
spec:
  replicas: 2
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: "2026-08-01T10:00:00Z"
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:1.2.0
status:
  readyReplicas: 2
`;

  const cleaned = () => cleanExportedManifest(live);

  it("removes what the API server owns", () => {
    const out = cleaned();
    for (const field of ["uid:", "resourceVersion:", "creationTimestamp:", "generation:", "selfLink:", "status:", "ownerReferences:"]) {
      expect(out, field).not.toContain(field);
    }
  });

  it("removes the annotations that pin it to this cluster, and keeps the operator's own", () => {
    const out = cleaned();
    expect(out).not.toContain("last-applied-configuration");
    expect(out).not.toContain("deployment.kubernetes.io/revision");
    expect(out).not.toContain("restartedAt");
    // Re-stamped by every sync, so committing it would fight the syncer.
    expect(out).not.toContain("rigel.dev/source-repo");
    expect(out).toContain("example.com/owner");
  });

  it("keeps what makes it a deployable manifest", () => {
    const out = cleaned();
    expect(out).toContain("kind: Deployment");
    expect(out).toContain("name: web");
    expect(out).toContain("namespace: shop");
    expect(out).toContain("replicas: 2");
    expect(out).toContain("ghcr.io/acme/web:1.2.0");
  });

  it("drops a Service's allocated addresses, which belong to the cluster that assigned them", () => {
    const out = cleanExportedManifest(`apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  clusterIP: 10.43.225.117
  clusterIPs:
    - 10.43.225.117
  ipFamilies:
    - IPv4
  ipFamilyPolicy: SingleStack
  internalTrafficPolicy: Cluster
  ports:
    - port: 3000
`);
    expect(out).not.toContain("10.43.225.117");
    expect(out).not.toContain("ipFamilies");
    expect(out).toContain("port: 3000");
  });

  it("drops a PVC's bound volume, so it can bind fresh", () => {
    const out = cleanExportedManifest(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  volumeName: pvc-8f14e45f
  resources:
    requests:
      storage: 10Gi
`);
    expect(out).not.toContain("volumeName");
    expect(out).toContain("storage: 10Gi");
  });

  it("leaves a manifest that is already clean alone", () => {
    const clean = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  a: b\n";
    expect(cleanExportedManifest(clean).trim()).toBe(clean.trim());
  });
});
