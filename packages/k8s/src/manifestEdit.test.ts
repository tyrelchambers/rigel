import { describe, expect, test } from "vitest";
import { parseAllDocuments } from "yaml";
import { planManifestEdit, type ManifestFile } from "./manifestEdit";

const DEPLOY = `# the shop web front end
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  annotations:
    rigel.dev/source-repo: shop-manifests
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:1.2.0
        - name: sidecar
          image: ghcr.io/acme/sidecar:0.1.0
`;

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  ports:
    - port: 80
`;

const target = { kind: "deployment", name: "web", namespace: "shop", dir: "manifests" };

const files = (...f: ManifestFile[]): ManifestFile[] => f;
const one = (content: string, path = "manifests/web.yaml"): ManifestFile[] => [{ path, content }];

function docOf(content: string, index = 0): Record<string, any> {
  return parseAllDocuments(content)[index]!.toJSON() as Record<string, any>;
}

describe("planManifestEdit — locating the document", () => {
  test("edits the one matching document and names its file", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "annotate",
      annotations: { "example.com/owner": "platform" },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.filePath).toBe("manifests/web.yaml");
    expect(docOf(plan.content).metadata.annotations["example.com/owner"]).toBe("platform");
  });

  test("matches the kind case-insensitively", () => {
    const plan = planManifestEdit(one(DEPLOY), { ...target, kind: "Deployment" }, { op: "scale", replicas: 5 });
    expect(plan.ok).toBe(true);
  });

  test("a document with no namespace matches the target's namespace", () => {
    const noNs = DEPLOY.replace("  namespace: shop\n", "");
    const plan = planManifestEdit(one(noNs), target, { op: "scale", replicas: 5 });
    expect(plan.ok).toBe(true);
  });

  test("a different namespace does not match", () => {
    const plan = planManifestEdit(one(DEPLOY), { ...target, namespace: "staging" }, { op: "scale", replicas: 5 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("deployment");
    expect(plan.message).toContain("web");
    expect(plan.message).toContain("staging");
  });

  test("a repo-wide search says so rather than naming a directory called dot", () => {
    const plan = planManifestEdit(one(SERVICE), { ...target, dir: "." }, { op: "scale", replicas: 5 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("in the repository");
    expect(plan.message).not.toContain("under .");
  });

  test("no match names the kind, the name and the searched directory", () => {
    const plan = planManifestEdit(one(SERVICE), target, { op: "scale", replicas: 5 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("manifests");
    expect(plan.message).not.toContain("templated");
  });

  test("no match plus an unparseable file says the manifests may be templated", () => {
    const helm = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels: {{- toYaml .Values.labels | nindent 4 }
`;
    const plan = planManifestEdit(
      files({ path: "manifests/svc.yaml", content: SERVICE }, { path: "chart/deploy.yaml", content: helm }),
      target,
      { op: "scale", replicas: 5 },
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("templated");
    expect(plan.message).toContain("chart/deploy.yaml");
  });

  test("two matching documents refuse and name both files", () => {
    const plan = planManifestEdit(
      files({ path: "base/web.yaml", content: DEPLOY }, { path: "overlay/web.yaml", content: DEPLOY }),
      target,
      { op: "scale", replicas: 5 },
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("base/web.yaml");
    expect(plan.message).toContain("overlay/web.yaml");
  });

  test("edits the matching document of a multi-document file and leaves its siblings byte for byte", () => {
    const multi = `${SERVICE}---\n${DEPLOY}`;
    const plan = planManifestEdit(one(multi), target, { op: "scale", replicas: 4 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(docOf(plan.content, 1).spec.replicas).toBe(4);
    expect(plan.content).toContain("    - port: 80");
    expect(plan.content).toContain("# the shop web front end");
  });
});

describe("planManifestEdit — annotate and label", () => {
  test("keeps existing keys and comments while adding one", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "annotate",
      annotations: { "example.com/owner": "platform" },
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.content).toContain("# the shop web front end");
    expect(docOf(plan.content).metadata.annotations["rigel.dev/source-repo"]).toBe("shop-manifests");
  });

  test("a null value removes the key", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "annotate",
      annotations: { "rigel.dev/source-repo": null, "example.com/owner": "platform" },
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).metadata.annotations).toEqual({ "example.com/owner": "platform" });
  });

  test("removing the last key removes the empty map", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "annotate",
      annotations: { "rigel.dev/source-repo": null },
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).metadata.annotations).toBeUndefined();
    expect(plan.content).not.toContain("annotations:");
  });

  test("removing a key that is not there is refused rather than passed off as a change", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "annotate", annotations: { "a.io/nope": null } });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("a.io/nope");
  });

  test("labels are set on metadata.labels", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "label", labels: { tier: "front" } });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).metadata.labels).toEqual({ tier: "front" });
  });
});

describe("planManifestEdit — setImage", () => {
  test("names the container to edit", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "setImage",
      container: "sidecar",
      image: "ghcr.io/acme/sidecar:0.2.0",
    });
    if (!plan.ok) throw new Error(plan.message);
    const containers = docOf(plan.content).spec.template.spec.containers;
    expect(containers[0].image).toBe("ghcr.io/acme/web:1.2.0");
    expect(containers[1].image).toBe("ghcr.io/acme/sidecar:0.2.0");
  });

  test("omitting the container edits a single-container spec", () => {
    const single = DEPLOY.replace("        - name: sidecar\n          image: ghcr.io/acme/sidecar:0.1.0\n", "");
    const plan = planManifestEdit(one(single), target, { op: "setImage", image: "ghcr.io/acme/web:2.0.0" });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:2.0.0");
  });

  test("omitting the container with several of them refuses and names them", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "setImage", image: "ghcr.io/acme/web:2.0.0" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("web");
    expect(plan.message).toContain("sidecar");
  });

  test("a container that is not in the spec refuses", () => {
    const plan = planManifestEdit(one(DEPLOY), target, {
      op: "setImage",
      container: "worker",
      image: "ghcr.io/acme/worker:1",
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("worker");
  });

  test("a bare Pod's containers live at spec.containers", () => {
    const pod = `apiVersion: v1
kind: Pod
metadata:
  name: web
  namespace: shop
spec:
  containers:
    - name: web
      image: ghcr.io/acme/web:1.0.0
`;
    const plan = planManifestEdit(one(pod), { ...target, kind: "pod" }, { op: "setImage", image: "ghcr.io/acme/web:2" });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).spec.containers[0].image).toBe("ghcr.io/acme/web:2");
  });

  test("a CronJob's containers live under the job template", () => {
    const cron = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: web
  namespace: shop
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: web
              image: ghcr.io/acme/web:1.0.0
`;
    const plan = planManifestEdit(
      one(cron),
      { ...target, kind: "cronjob" },
      { op: "setImage", image: "ghcr.io/acme/web:2" },
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).spec.jobTemplate.spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:2");
  });

  test("a document with no containers at all refuses", () => {
    const plan = planManifestEdit(one(SERVICE), { ...target, kind: "service" }, { op: "setImage", image: "x:1" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("container");
  });
});

describe("planManifestEdit — scale", () => {
  test("sets spec.replicas", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "scale", replicas: 7 });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).spec.replicas).toBe(7);
  });

  test("zero is allowed, because a pull request is reviewed before it merges", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "scale", replicas: 0 });
    if (!plan.ok) throw new Error(plan.message);
    expect(docOf(plan.content).spec.replicas).toBe(0);
  });

  test("a negative count refuses", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "scale", replicas: -1 });
    expect(plan.ok).toBe(false);
  });
});

describe("planManifestEdit — no-op edits", () => {
  test("setting a value it already has refuses rather than opening an empty pull request", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "scale", replicas: 2 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("already");
  });

  test("an empty edit refuses", () => {
    const plan = planManifestEdit(one(DEPLOY), target, { op: "annotate", annotations: {} });
    expect(plan.ok).toBe(false);
  });
});
