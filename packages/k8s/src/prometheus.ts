// packages/k8s/src/prometheus.ts
// Pure Prometheus/VictoriaMetrics backend detection + PromQL helpers, shared by
// the server (apps/server/src/prometheusMetrics.ts) and the in-cluster agent
// (agent/src/metrics.ts). No kubectl here — each caller supplies its own runner.

/** Service name Rigel's own metrics-install flow creates (MetricsInstallManifests). */
const INSTALL_SERVICE = "rigel-metrics";

export interface PromBackend {
  namespace: string;
  service: string;
  port: number;
  flavor: "VictoriaMetrics" | "Prometheus" | "Metrics";
}

export interface PromSeries {
  metric: Record<string, string>;
  value: [number, string];
}

interface ServicePort {
  name?: string;
  port: number;
}
export interface ServiceJson {
  metadata?: { name?: string; namespace?: string };
  spec?: { ports?: ServicePort[] };
}

export function flavorForPort(port: number): PromBackend["flavor"] {
  if (port === 8428 || port === 8481) return "VictoriaMetrics";
  if (port === 9090) return "Prometheus";
  return "Metrics";
}

export function detectAllBackendsFromServices(services: ServiceJson[]): PromBackend[] {
  const candidates: PromBackend[] = [];
  for (const svc of services) {
    const rawName = svc.metadata?.name ?? "";
    const name = rawName.toLowerCase();
    const ns = svc.metadata?.namespace ?? "default";
    const ports = svc.spec?.ports ?? [];
    if (!rawName) continue;

    if (
      name.includes("operator") ||
      name.includes("node-exporter") ||
      name.includes("alertmanager") ||
      name.includes("kube-state")
    ) {
      continue;
    }

    if (name === INSTALL_SERVICE) {
      const p =
        ports.find((x) => x.port === 8428 || x.port === 9090 || x.port === 8481) ?? ports[0];
      if (p) candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: flavorForPort(p.port) });
      continue;
    }

    if (name.includes("prometheus")) {
      const p =
        ports.find((x) => x.port === 9090) ??
        ports.find((x) => (x.name ?? "").includes("web") || (x.name ?? "") === "http");
      if (p) {
        candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: "Prometheus" });
        continue;
      }
    }

    if (name.includes("victoria") || name.startsWith("vmsingle") || name.includes("vmselect")) {
      const p = ports.find((x) => x.port === 8428 || x.port === 8481) ?? ports[0];
      if (p) candidates.push({ namespace: ns, service: rawName, port: p.port, flavor: "VictoriaMetrics" });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.namespace}/${c.service}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pickBackend(list: PromBackend[]): PromBackend | null {
  return (
    list.find((c) => c.service === INSTALL_SERVICE) ??
    list.find((c) => c.flavor === "VictoriaMetrics") ??
    list.find((c) => c.flavor === "Prometheus") ??
    list[0] ??
    null
  );
}

export function proxyBase(b: PromBackend): string {
  return `/api/v1/namespaces/${b.namespace}/services/${b.service}:${b.port}/proxy`;
}

export function promEncode(promql: string): string {
  return promql.replace(/[^A-Za-z0-9]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

export function parsePromInstant(stdout: string): PromSeries[] {
  try {
    const json = JSON.parse(stdout) as { status?: string; data?: { result?: unknown } };
    if (json?.status !== "success") return [];
    return Array.isArray(json.data?.result) ? (json.data!.result as PromSeries[]) : [];
  } catch {
    return [];
  }
}

/** Percent-of-capacity per node, grouped by the cAdvisor scrape's node label
 * (kubernetes_io_hostname). The rigel-metrics install scrapes cAdvisor via the
 * API-server node proxy; the root cgroup ({id="/"}) is the node total and
 * machine_* gauges are node capacity. */
export function nodeMemoryPercentQuery(node?: string): string {
  const w = node ? `,kubernetes_io_hostname="${node}"` : "";
  const cap = node ? `{kubernetes_io_hostname="${node}"}` : "";
  return `100 * max by (kubernetes_io_hostname) (container_memory_working_set_bytes{id="/"${w}}) / max by (kubernetes_io_hostname) (machine_memory_bytes${cap})`;
}

export function nodeCpuPercentQuery(node?: string): string {
  const w = node ? `,kubernetes_io_hostname="${node}"` : "";
  const cap = node ? `{kubernetes_io_hostname="${node}"}` : "";
  return `100 * sum by (kubernetes_io_hostname) (rate(container_cpu_usage_seconds_total{id="/"${w}}[5m])) / max by (kubernetes_io_hostname) (machine_cpu_cores${cap})`;
}

/** Fold an instant-query result into { nodeName: percent }, dropping series
 * without a hostname label or a finite value. */
export function seriesToNodeMap(series: PromSeries[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series) {
    const node = s.metric["kubernetes_io_hostname"];
    const v = Number(s.value?.[1]);
    if (node && Number.isFinite(v)) out[node] = v;
  }
  return out;
}
