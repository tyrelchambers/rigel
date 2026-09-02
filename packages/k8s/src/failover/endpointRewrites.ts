import { parseDocument } from "yaml";
import type { ClusterObject } from "../workloadClosure";
import type { DataPlan, PortabilityFinding } from "./types";

const CLUSTER_LABEL = "cnpg.io/cluster";
const POOLER_LABEL = "cnpg.io/poolerName";
const PG_PORT = 5432;
const PG_SCHEMES = ["postgres", "postgresql"];
const HOST_KEY = /(?:^|_)(?:DB|DATABASE|POSTGRES|PG)_?(?:HOST|HOSTNAME|URL|URI|DSN|ADDR|SERVER)$/i;
const PORT_KEY = /(?:^|_)(?:DB|DATABASE|POSTGRES|PG)_?PORT$/i;
const URL_VALUE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?([^/?#]+)(.*)$/i;

export interface PostgresRoute {
  service: string;
  namespace: string;
  cluster: string;
  /** True when the target recreates this name on its own, so nothing needs saying. */
  portable: boolean;
  hosts: string[];
  nodePort?: number;
}

export interface EndpointRewrite {
  subject: { kind: string; namespace: string; name: string };
  key: string;
  from: string;
  to: string;
  /** The home-cluster route this value was travelling through. */
  via: string;
}

interface ServiceSpec {
  type?: string;
  selector?: Record<string, string>;
  ports?: Array<{ port?: number; nodePort?: number }>;
}

function labelsOf(o: ClusterObject): Record<string, string> {
  return (o.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};
}

function specOf(o: ClusterObject): ServiceSpec {
  return (o.spec as ServiceSpec | undefined) ?? {};
}

function loadBalancerHosts(o: ClusterObject): string[] {
  const ingress =
    (o as { status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } } }).status
      ?.loadBalancer?.ingress ?? [];
  return ingress.flatMap((i) => [i.hostname, i.ip].filter((h): h is string => !!h));
}

function dnsForms(name: string, namespace: string): string[] {
  return [name, `${name}.${namespace}`, `${name}.${namespace}.svc`, `${name}.${namespace}.svc.cluster.local`];
}

/** Every Service that carries Postgres traffic for a Cluster this failover restores. */
export function postgresRoutes(services: ClusterObject[], plans: DataPlan[]): PostgresRoute[] {
  const restored = new Set(
    plans.filter((p) => p.subject.kind === "Cluster").map((p) => `${p.subject.namespace}/${p.subject.name}`),
  );
  if (restored.size === 0) return [];

  const poolerCluster = new Map<string, string>();
  for (const svc of services) {
    const labels = labelsOf(svc);
    const pooler = labels[POOLER_LABEL];
    const cluster = labels[CLUSTER_LABEL];
    if (pooler && cluster) poolerCluster.set(pooler, cluster);
  }

  const routes: PostgresRoute[] = [];
  for (const svc of services) {
    const name = svc.metadata?.name ?? "";
    const namespace = svc.metadata?.namespace ?? "";
    const spec = specOf(svc);
    const labels = labelsOf(svc);
    const pooler = spec.selector?.[POOLER_LABEL] ?? labels[POOLER_LABEL];
    const cluster =
      spec.selector?.[CLUSTER_LABEL] ?? labels[CLUSTER_LABEL] ?? (pooler ? poolerCluster.get(pooler) : undefined);
    if (!cluster || !restored.has(`${namespace}/${cluster}`)) continue;

    const type = spec.type ?? "ClusterIP";
    const portable = type === "ClusterIP" && [`${cluster}-rw`, `${cluster}-ro`, `${cluster}-r`].includes(name);
    routes.push({
      service: name,
      namespace,
      cluster,
      portable,
      hosts: [...dnsForms(name, namespace), ...loadBalancerHosts(svc)],
      nodePort: spec.ports?.find((p) => p.nodePort)?.nodePort,
    });
  }
  return routes;
}

function primaryHost(route: PostgresRoute): string {
  return `${route.cluster}-rw.${route.namespace}.svc.cluster.local`;
}

function splitHostPort(authority: string): { host: string; port?: string } {
  const at = authority.lastIndexOf(":");
  if (at === -1) return { host: authority };
  const port = authority.slice(at + 1);
  if (!/^\d+$/.test(port)) return { host: authority };
  return { host: authority.slice(0, at), port };
}

function objectValues(o: ClusterObject): Array<{ key: string; value: string; encoded: boolean }> {
  const out: Array<{ key: string; value: string; encoded: boolean }> = [];
  const data = (o as { data?: Record<string, string> }).data ?? {};
  const stringData = (o as { stringData?: Record<string, string> }).stringData ?? {};
  const encoded = o.kind === "Secret";
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    if (!encoded) {
      out.push({ key, value, encoded: false });
      continue;
    }
    try {
      out.push({ key, value: Buffer.from(value, "base64").toString("utf-8"), encoded: true });
    } catch {
      /* a value that is not valid base64 is not an endpoint we can read */
    }
  }
  for (const [key, value] of Object.entries(stringData)) {
    if (typeof value === "string") out.push({ key, value, encoded: false });
  }
  return out;
}

export interface EndpointRewriteInput {
  /** Secrets and ConfigMaps already in the closure. */
  objects: ClusterObject[];
  services: ClusterObject[];
  plans: DataPlan[];
}

/** One rule: a Postgres endpoint that cannot survive the move points at the restored primary. */
export function planEndpointRewrites(
  input: EndpointRewriteInput,
): { rewrites: EndpointRewrite[]; blockers: PortabilityFinding[] } {
  const routes = postgresRoutes(input.services, input.plans);
  const moving = routes.filter((r) => !r.portable);
  const portableHosts = new Set(routes.filter((r) => r.portable).flatMap((r) => r.hosts));
  const rewrites: EndpointRewrite[] = [];
  const blockers: PortabilityFinding[] = [];
  if (routes.length === 0) return { rewrites, blockers };

  const routeForHost = (host: string) => moving.find((r) => r.hosts.includes(host));

  for (const o of input.objects) {
    const subject = {
      kind: o.kind ?? "Secret",
      namespace: o.metadata?.namespace ?? "",
      name: o.metadata?.name ?? "",
    };
    const values = objectValues(o);
    // A NodePort is reached through a node address this cluster cannot enumerate,
    // so the port is what identifies the route for every key in the object.
    const viaNodePort = values.reduce<PostgresRoute | undefined>((found, v) => {
      if (found || !PORT_KEY.test(v.key)) return found;
      return moving.find((r) => r.nodePort != null && String(r.nodePort) === v.value.trim());
    }, undefined);

    for (const { key, value } of values) {
      const raw = value.trim();
      if (!raw) continue;

      if (PORT_KEY.test(key) && viaNodePort && String(viaNodePort.nodePort) === raw) {
        rewrites.push({ subject, key, from: raw, to: String(PG_PORT), via: viaNodePort.service });
        continue;
      }

      const url = URL_VALUE.exec(raw);
      const isPgUrl = url != null && PG_SCHEMES.includes(url[1]!.toLowerCase());
      if (!isPgUrl && !HOST_KEY.test(key)) continue;
      if (url != null && !isPgUrl) continue;

      const authority = isPgUrl ? url![3]! : raw;
      const { host, port } = splitHostPort(authority);
      if (portableHosts.has(host)) continue;

      const route = routeForHost(host) ?? viaNodePort;
      if (!route) {
        blockers.push({
          rule: "secretPointsAtUnrestoredDatabase",
          severity: "blocker",
          subject,
          whatsWrong: `${subject.kind} ${subject.namespace}/${subject.name} key ${key} points at ${host}, which this failover does not restore.`,
        });
        continue;
      }

      const newAuthority = port ? `${primaryHost(route)}:${PG_PORT}` : primaryHost(route);
      const to = isPgUrl
        ? `${url![1]}://${url![2] ? `${url![2]}@` : ""}${newAuthority}${url![4] ?? ""}`
        : newAuthority;
      rewrites.push({ subject, key, from: raw, to, via: route.service });
    }
  }

  return { rewrites, blockers };
}

/** Applies rewrites to an exported manifest. The home cluster is never touched. */
export function applyEndpointRewrites(yaml: string, rewrites: EndpointRewrite[]): string {
  if (rewrites.length === 0) return yaml;
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) return yaml;
  const kind = doc.getIn(["kind"]);
  const name = doc.getIn(["metadata", "name"]);
  const namespace = doc.getIn(["metadata", "namespace"]);
  const mine = rewrites.filter(
    (r) => r.subject.kind === kind && r.subject.name === name && r.subject.namespace === namespace,
  );
  if (mine.length === 0) return yaml;

  for (const r of mine) {
    const field = doc.hasIn(["stringData", r.key]) ? "stringData" : "data";
    if (!doc.hasIn([field, r.key])) continue;
    const encode = kind === "Secret" && field === "data";
    doc.setIn([field, r.key], encode ? Buffer.from(r.to, "utf-8").toString("base64") : r.to);
  }
  return String(doc);
}
