import { describe, expect, it } from "vitest";
import {
  candidateDetail,
  candidateKey,
  failoverCandidates,
  isSystemNamespace,
  selectionFromCandidates,
} from "./failoverCandidates";

const reddex = {
  kind: "Deployment",
  metadata: { name: "reddex-deploy", namespace: "default" },
  spec: { replicas: 2, template: { metadata: { labels: { app: "reddex" } } } },
};
const bot = {
  kind: "Deployment",
  metadata: { name: "esports-bot", namespace: "default" },
  spec: { replicas: 1, template: { metadata: { labels: { app: "bot" } } } },
};
const traefik = {
  kind: "Deployment",
  metadata: { name: "traefik", namespace: "kube-system" },
  spec: { replicas: 3, template: { metadata: { labels: { app: "traefik" } } } },
};
const pg = {
  kind: "StatefulSet",
  metadata: { name: "queue", namespace: "default" },
  spec: { replicas: 1, template: { metadata: { labels: { app: "queue" } } } },
};

const svc = {
  metadata: { name: "reddex-svc", namespace: "default" },
  spec: { selector: { app: "reddex" } },
};
const ing = {
  metadata: { name: "reddex", namespace: "default" },
  spec: {
    rules: [{ host: "reddex.app", http: { paths: [{ backend: { service: { name: "reddex-svc" } } } ] } }],
  },
};

describe("isSystemNamespace", () => {
  it("excludes cluster plumbing", () => {
    expect(isSystemNamespace("kube-system")).toBe(true);
    expect(isSystemNamespace("kube-anything")).toBe(true);
    expect(isSystemNamespace("cert-manager")).toBe(true);
    expect(isSystemNamespace("cnpg-system")).toBe(true);
  });

  it("keeps ordinary namespaces", () => {
    expect(isSystemNamespace("default")).toBe(false);
    expect(isSystemNamespace("dynamic-sites")).toBe(false);
  });
});

describe("failoverCandidates", () => {
  it("lists Deployments and StatefulSets outside system namespaces, sorted", () => {
    const out = failoverCandidates([reddex, bot, traefik, pg], [], []);
    expect(out.map((c) => `${c.namespace}/${c.name}`)).toEqual([
      "default/esports-bot",
      "default/queue",
      "default/reddex-deploy",
    ]);
    expect(out.find((c) => c.name === "queue")?.kind).toBe("StatefulSet");
  });

  it("attaches the host an Ingress routes to the workload", () => {
    const out = failoverCandidates([reddex, bot], [svc], [ing]);
    expect(out.find((c) => c.name === "reddex-deploy")?.hosts).toEqual(["reddex.app"]);
    expect(out.find((c) => c.name === "esports-bot")?.hosts).toEqual([]);
  });

  it("does not attach a host when the Ingress backs a different Service", () => {
    const other = {
      metadata: { name: "other", namespace: "default" },
      spec: { rules: [{ host: "other.app", http: { paths: [{ backend: { service: { name: "nope" } } }] } }] },
    };
    const out = failoverCandidates([reddex], [svc], [other]);
    expect(out[0]?.hosts).toEqual([]);
  });

  it("does not cross namespaces when matching Services", () => {
    const elsewhere = { metadata: { name: "reddex-svc", namespace: "other" }, spec: { selector: { app: "reddex" } } };
    const out = failoverCandidates([reddex], [elsewhere], [ing]);
    expect(out[0]?.hosts).toEqual([]);
  });

  it("defaults replicas to 1 when the spec omits it", () => {
    const noReplicas = { kind: "Deployment", metadata: { name: "x", namespace: "default" }, spec: {} };
    expect(failoverCandidates([noReplicas], [], [])[0]?.replicas).toBe(1);
  });

  it("keeps a workload scaled to zero", () => {
    const zero = { kind: "Deployment", metadata: { name: "civiclayer", namespace: "default" }, spec: { replicas: 0 } };
    expect(failoverCandidates([zero], [], [])[0]?.replicas).toBe(0);
  });
});

describe("candidateDetail", () => {
  it("names the host when one reaches it", () => {
    const [c] = failoverCandidates([reddex], [svc], [ing]);
    expect(candidateDetail(c!)).toBe("deployment · 2 replicas · reddex.app");
  });

  it("calls out a workload with no Ingress", () => {
    const [c] = failoverCandidates([bot], [], []);
    expect(candidateDetail(c!)).toBe("deployment · 1 replica · no Ingress, outbound actor");
  });
});

describe("selectionFromCandidates", () => {
  it("builds the workloads selection the server accepts", () => {
    const picked = failoverCandidates([reddex, pg], [], []);
    expect(selectionFromCandidates(picked)).toEqual({
      kind: "workloads",
      items: [
        { kind: "StatefulSet", namespace: "default", name: "queue" },
        { kind: "Deployment", namespace: "default", name: "reddex-deploy" },
      ],
    });
  });
});

describe("candidateKey", () => {
  it("separates same-named workloads of different kinds", () => {
    expect(candidateKey({ kind: "Deployment", namespace: "default", name: "x" })).not.toBe(
      candidateKey({ kind: "StatefulSet", namespace: "default", name: "x" }),
    );
  });
});
