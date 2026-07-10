import { substitute } from "./substitute";

export type AddonGroup = "Scheduling" | "Metrics" | "Certificates" | "Ingress";
export type AddonWorkloadKind = "deployments" | "cronjobs";

export interface AddonField {
  key: string;
  label: string;
  type: "toggle" | "text" | "select" | "namespace" | "interval";
  default: string | boolean;
  options?: string[];
  help?: string;
}

export type AddonInstall =
  | { mode: "metricsServer" }
  | {
      mode: "helm";
      repoName: string;
      repoURL: string;
      chart: string;
      version?: string;
      releaseName: string;
      namespace: string;
      valuesTemplate?: string;
      buildValues?: (fields: Record<string, string | boolean>) => Record<string, unknown>;
    };

export interface AddonDetect {
  kind: AddonWorkloadKind;
  namespace: string;
  name: string;
}

export interface ClusterAddon {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  group: AddonGroup;
  docsURL: string;
  repoURL: string;
  install: AddonInstall;
  fields: AddonField[];
  detect: AddonDetect;
}

/** Descheduler v1alpha2 policy: CronJob + only the toggled-on balance strategies. */
function deschedulerValues(f: Record<string, string | boolean>): Record<string, unknown> {
  const enabled: string[] = [];
  if (f.lowNodeUtilization !== false) enabled.push("LowNodeUtilization");
  if (f.removeDuplicates !== false) enabled.push("RemoveDuplicates");
  if (f.topologySpread !== false) enabled.push("RemovePodsViolatingTopologySpreadConstraint");
  const pluginConfig: Record<string, unknown>[] = [
    { name: "DefaultEvictor", args: { evictSystemCriticalPods: false, evictLocalStoragePods: false } },
  ];
  if (enabled.includes("LowNodeUtilization")) {
    pluginConfig.push({
      name: "LowNodeUtilization",
      args: { thresholds: { cpu: 20, memory: 20, pods: 20 }, targetThresholds: { cpu: 50, memory: 50, pods: 50 } },
    });
  }
  return {
    kind: "CronJob",
    schedule: String(f.schedule ?? "*/30 * * * *"),
    deschedulerPolicy: { profiles: [{ name: "default", plugins: { balance: { enabled } }, pluginConfig }] },
  };
}

export const CLUSTER_ADDONS: ClusterAddon[] = [
  {
    id: "metrics-server",
    name: "Metrics Server",
    tagline: "Live pod & node CPU/memory for kubectl top and autoscaling.",
    description:
      "Installs the upstream metrics-server. Required for live resource readouts and Horizontal Pod Autoscaling.",
    icon: "Activity",
    group: "Metrics",
    docsURL: "https://github.com/kubernetes-sigs/metrics-server",
    repoURL: "https://github.com/kubernetes-sigs/metrics-server",
    install: { mode: "metricsServer" },
    fields: [
      {
        key: "kubeletInsecureTls",
        label: "Allow insecure kubelet TLS",
        type: "toggle",
        default: true,
        help: "Needed on k3s/kind/homelab clusters with self-signed kubelet certs. Turn off on managed clusters with valid certs.",
      },
    ],
    detect: { kind: "deployments", namespace: "kube-system", name: "metrics-server" },
  },
  {
    id: "descheduler",
    name: "Descheduler",
    tagline: "Rebalances pods across nodes on a schedule (fixes lopsided nodes).",
    description:
      "Runs the Kubernetes SIG descheduler as a CronJob. Evicts pods that violate its policy so the scheduler re-places them evenly — the piece core Kubernetes lacks. Respects PodDisruptionBudgets.",
    icon: "Scale",
    group: "Scheduling",
    docsURL: "https://github.com/kubernetes-sigs/descheduler",
    repoURL: "https://github.com/kubernetes-sigs/descheduler",
    install: {
      mode: "helm",
      repoName: "descheduler",
      repoURL: "https://kubernetes-sigs.github.io/descheduler/",
      chart: "descheduler",
      releaseName: "descheduler",
      namespace: "kube-system",
      buildValues: deschedulerValues,
    },
    fields: [
      { key: "schedule", label: "Run schedule", type: "interval", default: "*/30 * * * *", help: "How often to rebalance." },
      { key: "lowNodeUtilization", label: "Low-node utilization (move pods off busy nodes)", type: "toggle", default: true },
      { key: "removeDuplicates", label: "Spread duplicate replicas off the same node", type: "toggle", default: true },
      { key: "topologySpread", label: "Enforce topology spread constraints", type: "toggle", default: true },
    ],
    detect: { kind: "cronjobs", namespace: "kube-system", name: "descheduler" },
  },
  {
    id: "cert-manager",
    name: "cert-manager",
    tagline: "Automated TLS certificates (Let's Encrypt and more).",
    description:
      "Installs cert-manager and its CRDs. Issue and auto-renew TLS certificates for Ingress and workloads.",
    icon: "BadgeCheck",
    group: "Certificates",
    docsURL: "https://cert-manager.io/docs/",
    repoURL: "https://github.com/cert-manager/cert-manager",
    install: {
      mode: "helm",
      repoName: "jetstack",
      repoURL: "https://charts.jetstack.io",
      chart: "cert-manager",
      releaseName: "cert-manager",
      namespace: "cert-manager",
      valuesTemplate: "crds:\n  enabled: {{installCRDs}}\n",
    },
    fields: [
      { key: "installCRDs", label: "Install CRDs", type: "toggle", default: true, help: "Turn off only if the cert-manager CRDs are already installed separately." },
    ],
    detect: { kind: "deployments", namespace: "cert-manager", name: "cert-manager" },
  },
  {
    id: "ingress-nginx",
    name: "ingress-nginx",
    tagline: "The NGINX Ingress controller for HTTP routing.",
    description:
      "Installs the community ingress-nginx controller. Routes external HTTP(S) traffic to Services via Ingress objects.",
    icon: "Signpost",
    group: "Ingress",
    docsURL: "https://kubernetes.github.io/ingress-nginx/",
    repoURL: "https://github.com/kubernetes/ingress-nginx",
    install: {
      mode: "helm",
      repoName: "ingress-nginx",
      repoURL: "https://kubernetes.github.io/ingress-nginx",
      chart: "ingress-nginx",
      releaseName: "ingress-nginx",
      namespace: "ingress-nginx",
      valuesTemplate: "controller:\n  service:\n    type: {{serviceType}}\n",
    },
    fields: [
      {
        key: "serviceType",
        label: "Service type",
        type: "select",
        default: "LoadBalancer",
        options: ["LoadBalancer", "NodePort"],
      },
    ],
    detect: { kind: "deployments", namespace: "ingress-nginx", name: "ingress-nginx-controller" },
  },
];

export interface InstalledWorkload {
  kind: AddonWorkloadKind;
  namespace: string;
  name: string;
}

/** True when the add-on's declared workload is present in the cluster. */
export function detectInstalled(addon: ClusterAddon, workloads: InstalledWorkload[]): boolean {
  const d = addon.detect;
  return workloads.some((w) => w.kind === d.kind && w.namespace === d.namespace && w.name === d.name);
}

/** Build the helm values (YAML, or JSON — valid YAML for helm) for an add-on's fields. */
export function buildHelmValues(addon: ClusterAddon, fields: Record<string, string | boolean>): string {
  if (addon.install.mode !== "helm") return "";
  if (addon.install.buildValues) return JSON.stringify(addon.install.buildValues(fields));
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) vars[k] = String(v);
  return substitute(addon.install.valuesTemplate ?? "", vars);
}
