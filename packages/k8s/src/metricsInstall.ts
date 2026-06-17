// Renders the install manifest for a metrics backend (VictoriaMetrics or
// Prometheus). Ports Sources/Helmsman/Metrics/MetricsInstallManifests.swift.
//
// Both backends scrape cAdvisor through the API-server node proxy (works
// without direct node access) and expose a Prometheus-compatible query API on a
// Service named `helmsman-metrics`. Applied via `kubectl apply -f -`.

export type MetricsInstallBackend = "victoriaMetrics" | "prometheus";

/** Service (and Deployment/SA) name the install creates, in every namespace. */
export const METRICS_SERVICE_NAME = "helmsman-metrics";

const VM_IMAGE = "victoriametrics/victoria-metrics:v1.93.0";
const PROM_IMAGE = "prom/prometheus:v2.53.0";

/** Query-API port of the installed Service. */
export function metricsBackendPort(backend: MetricsInstallBackend): number {
  return backend === "victoriaMetrics" ? 8428 : 9090;
}

export function metricsBackendTitle(backend: MetricsInstallBackend): "VictoriaMetrics" | "Prometheus" {
  return backend === "victoriaMetrics" ? "VictoriaMetrics" : "Prometheus";
}

export interface InstalledBackend {
  namespace: string;
  service: string;
  port: number;
  flavor: "VictoriaMetrics" | "Prometheus";
}

/** The backend config pointing at the just-installed Service. */
export function resultingBackend(backend: MetricsInstallBackend, namespace: string): InstalledBackend {
  return {
    namespace,
    service: METRICS_SERVICE_NAME,
    port: metricsBackendPort(backend),
    flavor: metricsBackendTitle(backend),
  };
}

/** RFC-1123 label check for the target namespace (matches the Swift validator). */
export function namespaceValid(ns: string): boolean {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns.trim());
}

/** cAdvisor scrape job via the API-server node proxy (Prometheus scrape-config
 * format, shared by Prometheus and VictoriaMetrics' -promscrape.config). */
function scrapeConfig(): string {
  // `\${1}` keeps the literal `${1}` (a Prometheus relabel reference), not a TS
  // template interpolation.
  return `global:
  scrape_interval: 60s
scrape_configs:
  - job_name: kubernetes-cadvisor
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: true
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    kubernetes_sd_configs:
      - role: node
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/\${1}/proxy/metrics/cadvisor`;
}

function indent(text: string, by: number): string {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function rbac(ns: string): string {
  const n = METRICS_SERVICE_NAME;
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${n}
  namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${n}-${ns}
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods]
    verbs: [get, list, watch]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${n}-${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${n}-${ns}
subjects:
  - kind: ServiceAccount
    name: ${n}
    namespace: ${ns}`;
}

/** The `data` volume entry — a PVC reference or an emptyDir (8-space indented). */
function dataVolume(persistent: boolean): string {
  return persistent
    ? `        - name: data
          persistentVolumeClaim:
            claimName: ${METRICS_SERVICE_NAME}`
    : `        - name: data
          emptyDir: {}`;
}

function pvc(ns: string, sizeGiB: number): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${METRICS_SERVICE_NAME}
  namespace: ${ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: ${sizeGiB}Gi`;
}

function namespaceDoc(ns: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}`;
}

function configMapDoc(ns: string, name: string, key: string): string {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${ns}
data:
  ${key}: |
${indent(scrapeConfig(), 4)}`;
}

function serviceDoc(ns: string, port: number): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${METRICS_SERVICE_NAME}
  namespace: ${ns}
spec:
  selector: { app: ${METRICS_SERVICE_NAME} }
  ports:
    - { name: http, port: ${port}, targetPort: ${port} }`;
}

function victoriaMetrics(ns: string, persistent: boolean, sizeGiB: number): string {
  const n = METRICS_SERVICE_NAME;
  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${n}
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels: { app: ${n} }
  template:
    metadata:
      labels: { app: ${n} }
    spec:
      serviceAccountName: ${n}
      containers:
        - name: victoria-metrics
          image: ${VM_IMAGE}
          args:
            - -storageDataPath=/data
            - -retentionPeriod=1
            - -promscrape.config=/config/scrape.yml
            - -httpListenAddr=:8428
          ports:
            - containerPort: 8428
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: config, mountPath: /config }
      volumes:
${dataVolume(persistent)}
        - name: config
          configMap: { name: ${n}-scrape }`;

  const docs = [
    namespaceDoc(ns),
    rbac(ns),
    configMapDoc(ns, `${n}-scrape`, "scrape.yml"),
    deployment,
    serviceDoc(ns, 8428),
  ];
  if (persistent) docs.push(pvc(ns, sizeGiB));
  return docs.join("\n---\n") + "\n";
}

function prometheus(ns: string, persistent: boolean, sizeGiB: number): string {
  const n = METRICS_SERVICE_NAME;
  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${n}
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels: { app: ${n} }
  template:
    metadata:
      labels: { app: ${n} }
    spec:
      serviceAccountName: ${n}
      containers:
        - name: prometheus
          image: ${PROM_IMAGE}
          args:
            - --config.file=/config/prometheus.yml
            - --storage.tsdb.path=/data
            - --storage.tsdb.retention.time=30d
            - --web.listen-address=:9090
          ports:
            - containerPort: 9090
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: config, mountPath: /config }
      volumes:
${dataVolume(persistent)}
        - name: config
          configMap: { name: ${n}-config }`;

  const docs = [
    namespaceDoc(ns),
    rbac(ns),
    configMapDoc(ns, `${n}-config`, "prometheus.yml"),
    deployment,
    serviceDoc(ns, 9090),
  ];
  if (persistent) docs.push(pvc(ns, sizeGiB));
  return docs.join("\n---\n") + "\n";
}

/** Final multi-doc YAML for `kubectl apply -f -`. */
export function renderMetricsInstallManifest(
  backend: MetricsInstallBackend,
  namespace: string,
  persistent: boolean,
  sizeGiB: number,
): string {
  return backend === "victoriaMetrics"
    ? victoriaMetrics(namespace, persistent, sizeGiB)
    : prometheus(namespace, persistent, sizeGiB);
}
