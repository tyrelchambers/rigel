import { describe, it, expect } from "vitest";
import { selectorMatches, podRefs, relatedKindsFor, computeRelated } from "./relatedResources";

const deploy = {
  metadata: { name: "backend", namespace: "prod", uid: "d1", labels: { app: "backend" } },
  spec: {
    selector: { matchLabels: { app: "backend" } },
    template: {
      metadata: { labels: { app: "backend" } },
      spec: {
        containers: [{
          name: "c",
          envFrom: [{ configMapRef: { name: "backend-config" } }, { secretRef: { name: "backend-env" } }],
          env: [{ valueFrom: { secretKeyRef: { name: "backend-token" } } }],
        }],
        volumes: [
          { configMap: { name: "backend-files" } },
          { persistentVolumeClaim: { claimName: "backend-data" } },
        ],
        imagePullSecrets: [{ name: "regcred" }],
      },
    },
  },
};
const pod = (name: string, labels: Record<string, string>, uid: string) => ({
  metadata: { name, namespace: "prod", uid, labels },
  spec: { nodeName: "node-1", containers: [] },
  status: { phase: "Running", containerStatuses: [{ ready: true }] },
});

function store(slices: Record<string, any[]>) {
  const out: Record<string, Record<string, any>> = {};
  for (const [kind, items] of Object.entries(slices)) {
    out[kind] = {};
    for (const o of items) out[kind][`${o.metadata.namespace}/${o.metadata.name}`] = o;
  }
  return out;
}

describe("selectorMatches", () => {
  it("matches when every selector entry is present", () => {
    expect(selectorMatches({ app: "x" }, { app: "x", t: "1" })).toBe(true);
  });
  it("never matches an empty selector", () => {
    expect(selectorMatches({}, { app: "x" })).toBe(false);
  });
  it("fails when a value differs", () => {
    expect(selectorMatches({ app: "x" }, { app: "y" })).toBe(false);
  });
});

describe("podRefs", () => {
  it("collects configmap/secret/pvc refs from env, envFrom, volumes, imagePullSecrets", () => {
    const refs = podRefs(deploy.spec.template.spec);
    expect(refs.configmaps.sort()).toEqual(["backend-config", "backend-files"]);
    expect(refs.secrets.sort()).toEqual(["backend-env", "backend-token", "regcred"]);
    expect(refs.pvcs).toEqual(["backend-data"]);
  });
});

describe("relatedKindsFor", () => {
  it("lists the target kinds a deployment needs", () => {
    expect(relatedKindsFor("deployment")).toEqual(
      expect.arrayContaining(["pods", "services", "configmaps", "secrets", "persistentvolumeclaims"]),
    );
  });
});

describe("computeRelated", () => {
  it("workload → pods via selector, with status from readiness", () => {
    const s = store({
      pods: [pod("backend-1", { app: "backend" }, "p1"), pod("other", { app: "x" }, "p2")],
    });
    const groups = computeRelated("deployment", deploy, s);
    const pods = groups.find((g) => g.kind === "pods")!;
    expect(pods.items.map((i) => i.name)).toEqual(["backend-1"]);
    expect(pods.items[0].status).toBe("ok");
    expect(pods.items[0].node).toBe("node-1");
  });

  it("workload → services whose selector matches the pod template labels", () => {
    const s = store({
      services: [
        { metadata: { name: "backend", namespace: "prod", uid: "s1" }, spec: { selector: { app: "backend" } } },
        { metadata: { name: "nope", namespace: "prod", uid: "s2" }, spec: { selector: { app: "x" } } },
      ],
    });
    const svc = computeRelated("deployment", deploy, s).find((g) => g.kind === "services")!;
    expect(svc.items.map((i) => i.name)).toEqual(["backend"]);
  });

  it("flags a referenced configmap that does not exist as missing", () => {
    const s = store({ configmaps: [{ metadata: { name: "backend-config", namespace: "prod", uid: "c1" } }] });
    const cms = computeRelated("deployment", deploy, s).find((g) => g.kind === "configmaps")!;
    const missing = cms.items.find((i) => i.name === "backend-files")!;
    expect(missing.status).toBe("missing");
    const present = cms.items.find((i) => i.name === "backend-config")!;
    expect(present.status).toBe("ok");
  });

  it("pod → owning workload via label match", () => {
    const p = pod("backend-1", { app: "backend" }, "p1");
    const s = store({ deployments: [deploy] });
    const owner = computeRelated("pod", p, s).find((g) => g.kind === "deployments")!;
    expect(owner.items.map((i) => i.name)).toEqual(["backend"]);
  });

  it("service → pods and reverse ingresses", () => {
    const svc = { metadata: { name: "backend", namespace: "prod", uid: "s1" }, spec: { selector: { app: "backend" } } };
    const ing = {
      metadata: { name: "web", namespace: "prod", uid: "i1" },
      spec: { rules: [{ http: { paths: [{ backend: { service: { name: "backend" } } }] } }] },
    };
    const s = store({ pods: [pod("backend-1", { app: "backend" }, "p1")], ingresses: [ing] });
    const groups = computeRelated("service", svc, s);
    expect(groups.find((g) => g.kind === "pods")!.items.map((i) => i.name)).toEqual(["backend-1"]);
    expect(groups.find((g) => g.kind === "ingresses")!.items.map((i) => i.name)).toEqual(["web"]);
  });

  it("ingress → services (backends) and tls secrets", () => {
    const ing = {
      metadata: { name: "web", namespace: "prod", uid: "i1" },
      spec: {
        tls: [{ secretName: "web-tls" }],
        rules: [{ http: { paths: [{ backend: { service: { name: "backend" } } }] } }],
      },
    };
    const s = store({
      services: [{ metadata: { name: "backend", namespace: "prod", uid: "s1" }, spec: { selector: { app: "backend" } } }],
      secrets: [{ metadata: { name: "web-tls", namespace: "prod", uid: "se1" } }],
    });
    const groups = computeRelated("ingress", ing, s);
    expect(groups.find((g) => g.kind === "services")!.items.map((i) => i.name)).toEqual(["backend"]);
    expect(groups.find((g) => g.kind === "secrets")!.items.map((i) => i.name)).toEqual(["web-tls"]);
  });
});

describe("relatedKindsFor — jobs & cronjobs", () => {
  it("job resolves pods + config kinds", () => {
    expect(relatedKindsFor("job")).toEqual(["pods", "configmaps", "secrets", "persistentvolumeclaims"]);
  });
  it("cronjob resolves jobs", () => {
    expect(relatedKindsFor("cronjob")).toEqual(["jobs"]);
  });
});

describe("computeRelated — job", () => {
  const jobObj = {
    metadata: { name: "backup", namespace: "prod", uid: "j1" },
    spec: { template: { spec: { containers: [{ envFrom: [{ secretRef: { name: "backup-creds" } }] }] } } },
  };
  it("finds pods owned by the job and secrets from its template", () => {
    const podA = { metadata: { name: "backup-abc", namespace: "prod", uid: "p1", ownerReferences: [{ uid: "j1", kind: "Job" }] }, spec: { containers: [] }, status: { phase: "Succeeded", containerStatuses: [{ ready: true }] } };
    const podB = { metadata: { name: "other-xyz", namespace: "prod", uid: "p2", ownerReferences: [{ uid: "zzz" }] }, spec: { containers: [] }, status: { phase: "Running" } };
    const groups = computeRelated("job", jobObj, store({ pods: [podA, podB], secrets: [{ metadata: { name: "backup-creds", namespace: "prod", uid: "s1" } }] }));
    const pods = groups.find((g) => g.kind === "pods");
    expect(pods?.items.map((i) => i.name)).toEqual(["backup-abc"]);
    const secrets = groups.find((g) => g.kind === "secrets");
    expect(secrets?.items.map((i) => i.name)).toEqual(["backup-creds"]);
  });
});

describe("computeRelated — cronjob", () => {
  const cronObj = { metadata: { name: "nightly", namespace: "prod", uid: "cj1" } };
  it("finds jobs owned by the cronjob", () => {
    const jobA = { metadata: { name: "nightly-1", namespace: "prod", uid: "j1", ownerReferences: [{ uid: "cj1", kind: "CronJob" }] } };
    const jobB = { metadata: { name: "unrelated", namespace: "prod", uid: "j2", ownerReferences: [{ uid: "other" }] } };
    const groups = computeRelated("cronjob", cronObj, store({ jobs: [jobA, jobB] }));
    const jobs = groups.find((g) => g.kind === "jobs");
    expect(jobs?.items.map((i) => i.name)).toEqual(["nightly-1"]);
  });
});
