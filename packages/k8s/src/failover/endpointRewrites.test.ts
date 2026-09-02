import { describe, expect, it } from "vitest";
import { applyEndpointRewrites, planEndpointRewrites, postgresRoutes } from "./endpointRewrites";
import type { DataPlan } from "./types";

const plans: DataPlan[] = [
  { subject: { kind: "Cluster", namespace: "default", name: "postgres" }, kind: "pgDump" },
];

const rw = {
  kind: "Service",
  metadata: { name: "postgres-rw", namespace: "default" },
  spec: { type: "ClusterIP", selector: { "cnpg.io/cluster": "postgres" }, ports: [{ port: 5432 }] },
};

const lb = {
  kind: "Service",
  metadata: { name: "postgres-lb", namespace: "default" },
  spec: {
    type: "LoadBalancer",
    selector: { "cnpg.io/cluster": "postgres", role: "primary" },
    ports: [{ port: 5432, nodePort: 32107 }],
  },
  status: {
    loadBalancer: { ingress: [{ hostname: "default-postgres-lb.tail8a13da.ts.net" }, { ip: "100.112.95.117" }] },
  },
};

const nodePort = {
  kind: "Service",
  metadata: { name: "postgres-external", namespace: "default" },
  spec: {
    type: "NodePort",
    selector: { "cnpg.io/cluster": "postgres", role: "primary" },
    ports: [{ port: 5432, nodePort: 30432 }],
  },
};

const poolerSvc = {
  kind: "Service",
  metadata: {
    name: "postgres-pooler",
    namespace: "default",
    labels: { "cnpg.io/cluster": "postgres", "cnpg.io/poolerName": "postgres-pooler" },
  },
  spec: { type: "ClusterIP", selector: { "cnpg.io/poolerName": "postgres-pooler" }, ports: [{ port: 5432 }] },
};

const poolerLb = {
  kind: "Service",
  metadata: { name: "postgres-pooler-lb", namespace: "default" },
  spec: { type: "LoadBalancer", selector: { "cnpg.io/poolerName": "postgres-pooler" }, ports: [{ port: 5432 }] },
  status: { loadBalancer: { ingress: [{ ip: "100.95.105.9" }] } },
};

const services = [rw, lb, nodePort, poolerSvc, poolerLb];

function secret(name: string, data: Record<string, string>) {
  return {
    kind: "Secret",
    metadata: { name, namespace: "default" },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")])),
  };
}

describe("postgresRoutes", () => {
  it("keeps the read-write service portable and marks every other route", () => {
    const routes = postgresRoutes(services, plans);
    const portable = routes.filter((r) => r.portable).map((r) => r.service);
    const moving = routes.filter((r) => !r.portable).map((r) => r.service);
    expect(portable).toEqual(["postgres-rw"]);
    expect(moving).toEqual(["postgres-lb", "postgres-external", "postgres-pooler", "postgres-pooler-lb"]);
  });

  it("follows poolerName back to the cluster the pooler fronts", () => {
    const routes = postgresRoutes(services, plans);
    expect(routes.find((r) => r.service === "postgres-pooler-lb")?.cluster).toBe("postgres");
  });

  it("ignores services for a cluster the failover is not restoring", () => {
    expect(postgresRoutes(services, [])).toEqual([]);
  });
});

describe("planEndpointRewrites", () => {
  it("repoints a pooler URL at the primary service", () => {
    const out = planEndpointRewrites({
      objects: [secret("rigel-api", { DATABASE_URL: "postgres://rigel:pw@postgres-pooler.default:5432/rigel" })],
      services,
      plans,
    });
    expect(out.blockers).toEqual([]);
    expect(out.rewrites).toHaveLength(1);
    expect(out.rewrites[0]).toMatchObject({
      key: "DATABASE_URL",
      to: "postgres://rigel:pw@postgres-rw.default.svc.cluster.local:5432/rigel",
      via: "postgres-pooler",
    });
  });

  it("repoints a tailnet MagicDNS host", () => {
    const out = planEndpointRewrites({
      objects: [secret("wildbarrens-secrets", { DB_HOST: "default-postgres-lb.tail8a13da.ts.net" })],
      services,
      plans,
    });
    expect(out.rewrites[0]).toMatchObject({
      key: "DB_HOST",
      from: "default-postgres-lb.tail8a13da.ts.net",
      to: "postgres-rw.default.svc.cluster.local",
    });
  });

  it("repoints a tailnet address reached by ip", () => {
    const out = planEndpointRewrites({
      objects: [secret("app", { DATABASE_URL: "postgres://a:b@100.112.95.117:5432/app" })],
      services,
      plans,
    });
    expect(out.rewrites[0]?.to).toBe("postgres://a:b@postgres-rw.default.svc.cluster.local:5432/app");
  });

  it("repoints a NodePort reached through a node address it cannot enumerate", () => {
    const out = planEndpointRewrites({
      objects: [secret("canadahires-api", { DB_HOST: "k8s.local", DB_PORT: "30432" })],
      services,
      plans,
    });
    expect(out.rewrites).toEqual([
      expect.objectContaining({ key: "DB_HOST", from: "k8s.local", to: "postgres-rw.default.svc.cluster.local" }),
      expect.objectContaining({ key: "DB_PORT", from: "30432", to: "5432" }),
    ]);
  });

  it("leaves an in-cluster name that the closure already recreates", () => {
    const out = planEndpointRewrites({
      objects: [
        secret("esports-bot-env", { DATABASE_URL: "postgres://a:b@postgres-rw.default.svc.cluster.local:5432/bot" }),
      ],
      services,
      plans,
    });
    expect(out.rewrites).toEqual([]);
    expect(out.blockers).toEqual([]);
  });

  it("leaves anything that is not a Postgres endpoint alone", () => {
    const out = planEndpointRewrites({
      objects: [secret("app", { REDIS_URL: "redis://redis.redis-actual.svc.cluster.local:6379", API_URL: "https://x" })],
      services,
      plans,
    });
    expect(out.rewrites).toEqual([]);
    expect(out.blockers).toEqual([]);
  });

  it("blocks a database the failover is not restoring at all", () => {
    const out = planEndpointRewrites({
      objects: [secret("canadahires-api", { DATABASE_URL: "postgres://a:b@100.85.103.61:5432/canada" })],
      services,
      plans,
    });
    expect(out.rewrites).toEqual([]);
    expect(out.blockers[0]).toMatchObject({
      rule: "secretPointsAtUnrestoredDatabase",
      severity: "blocker",
      subject: { kind: "Secret", namespace: "default", name: "canadahires-api" },
    });
  });

  it("reads ConfigMap values as plain text", () => {
    const out = planEndpointRewrites({
      objects: [
        {
          kind: "ConfigMap",
          metadata: { name: "reddex-env", namespace: "default" },
          data: { PGHOST: "postgres-pooler" },
        },
      ],
      services,
      plans,
    });
    expect(out.rewrites[0]).toMatchObject({
      subject: { kind: "ConfigMap", namespace: "default", name: "reddex-env" },
      to: "postgres-rw.default.svc.cluster.local",
    });
  });
});

describe("applyEndpointRewrites", () => {
  const yaml = [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    "  name: rigel-api",
    "  namespace: default",
    "data:",
    `  DATABASE_URL: ${Buffer.from("postgres://a:b@postgres-pooler.default:5432/rigel").toString("base64")}`,
    `  APP_KEY: ${Buffer.from("keep-me").toString("base64")}`,
  ].join("\n");

  it("re-encodes only the rewritten key", () => {
    const rewrites = planEndpointRewrites({
      objects: [secret("rigel-api", { DATABASE_URL: "postgres://a:b@postgres-pooler.default:5432/rigel" })],
      services,
      plans,
    }).rewrites;
    const out = applyEndpointRewrites(yaml, rewrites);
    const data = out.split("\n").filter((l) => l.startsWith("  "));
    const url = data.find((l) => l.includes("DATABASE_URL"))!.split(": ")[1]!;
    expect(Buffer.from(url, "base64").toString()).toBe(
      "postgres://a:b@postgres-rw.default.svc.cluster.local:5432/rigel",
    );
    expect(out).toContain(Buffer.from("keep-me").toString("base64"));
  });

  it("leaves a manifest with no rewrites byte-identical", () => {
    expect(applyEndpointRewrites(yaml, [])).toBe(yaml);
  });

  it("ignores rewrites addressed to a different object", () => {
    const other = [
      {
        subject: { kind: "Secret", namespace: "default", name: "somewhere-else" },
        key: "DATABASE_URL",
        from: "x",
        to: "y",
        via: "postgres-lb",
      },
    ];
    expect(applyEndpointRewrites(yaml, other)).toBe(yaml);
  });

  it("writes ConfigMap values as plain text", () => {
    const cm = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: reddex-env", "  namespace: default", "data:", "  PGHOST: postgres-pooler"].join("\n");
    const out = applyEndpointRewrites(cm, [
      {
        subject: { kind: "ConfigMap", namespace: "default", name: "reddex-env" },
        key: "PGHOST",
        from: "postgres-pooler",
        to: "postgres-rw.default.svc.cluster.local",
        via: "postgres-pooler",
      },
    ]);
    expect(out).toContain("PGHOST: postgres-rw.default.svc.cluster.local");
  });
});
