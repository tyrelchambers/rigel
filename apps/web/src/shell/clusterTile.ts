/**
 * Two-letter initials for a cluster tile. Splits the context name on non-
 * alphanumeric separators and takes the first letter of the first two parts; a
 * single part uses its first two letters. Falls back to "?" when there's nothing.
 */
export function tileInitials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!;
  return letters.toUpperCase() || "?";
}

/** Cluster provider class, derived from the kubeconfig context name + server URL. */
export type ProviderKind = "local" | "aws" | "gcp" | "azure" | "digitalocean" | "generic";

/** The host portion of a kube API server URL ("" when unparseable). */
function serverHost(server: string): string {
  try {
    return new URL(server).hostname;
  } catch {
    return "";
  }
}

/** Is this a localhost / RFC1918-private / CGNAT(Tailscale) address → treat as local. */
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "kubernetes.docker.internal") return true;
  if (/^(127\.|0\.0\.0\.0$|10\.|192\.168\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // 100.64.0.0/10 — CGNAT, used by Tailscale (homelab-over-tailscale)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

/**
 * Classify a kubeconfig context by provider. Name signals (gke_/arn:aws:eks/
 * kind-/k3d-/well-known local names) and server host (eks/azmk8s/ondigitalocean,
 * or a local/private address) are the tells. GKE's server is a bare IP, so its
 * `gke_` name prefix is the only reliable signal — name checks come first.
 */
export function classifyProvider(ctx: { name: string; server: string }): ProviderKind {
  const name = ctx.name.toLowerCase();
  const host = serverHost(ctx.server).toLowerCase();

  if (name.startsWith("gke_")) return "gcp";
  if (name.startsWith("arn:aws:eks") || host.endsWith(".eks.amazonaws.com")) return "aws";
  if (host.endsWith(".azmk8s.io")) return "azure";
  if (host.endsWith(".k8s.ondigitalocean.com")) return "digitalocean";

  if (
    /^(kind|k3d)-/.test(name) ||
    name === "docker-desktop" ||
    name === "minikube" ||
    name === "rancher-desktop" ||
    name === "colima"
  ) {
    return "local";
  }
  if (host && isLocalHost(host)) return "local";

  return "generic";
}

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  local: "Local cluster",
  aws: "Amazon EKS",
  gcp: "Google GKE",
  azure: "Azure AKS",
  digitalocean: "DigitalOcean",
  generic: "Kubernetes cluster",
};

/** Human label for the provider, shown in the tile tooltip. */
export function providerLabel(kind: ProviderKind): string {
  return PROVIDER_LABELS[kind];
}
