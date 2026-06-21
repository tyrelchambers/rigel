/** A selectable Kubernetes version → the node image each tool needs. The
 *  "default" entry omits the image (the tool picks its built-in default).
 *
 *  NOTE: the pinned image tags below must be VERIFIED to exist (kind release
 *  notes for kindest/node, Docker Hub rancher/k3s tags); they go stale as new
 *  minors ship. "default" always works without an image. */
export interface K8sVersion {
  id: string;
  label: string;
  kindImage: string | null;
  k3dImage: string | null;
}

// WARNING: pinned image tags are unverified-at-build-time; confirm against
// https://github.com/kubernetes-sigs/kind/releases (kindest/node) and
// https://hub.docker.com/r/rancher/k3s/tags (rancher/k3s) before shipping.
export const K8S_VERSIONS: K8sVersion[] = [
  { id: "default", label: "Default (latest)", kindImage: null, k3dImage: null },
  { id: "v1.31", label: "v1.31", kindImage: "kindest/node:v1.31.0", k3dImage: "rancher/k3s:v1.31.0-k3s1" },
  { id: "v1.30", label: "v1.30", kindImage: "kindest/node:v1.30.0", k3dImage: "rancher/k3s:v1.30.0-k3s1" },
  { id: "v1.29", label: "v1.29", kindImage: "kindest/node:v1.29.0", k3dImage: "rancher/k3s:v1.29.0-k3s1" },
];

function versionById(id: string | undefined): K8sVersion {
  return K8S_VERSIONS.find((v) => v.id === id) ?? K8S_VERSIONS[0]!;
}

/** kind/k3d cluster-name rules: lowercase RFC1123-ish, <= 50 chars. Returns an
 *  error string or null when valid. */
export function validateClusterName(name: string): string | null {
  if (!name) return "Enter a cluster name.";
  if (name.length > 50) return "Name is too long (50 characters max).";
  if (name !== name.toLowerCase()) return "Use lowercase letters only.";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "Use lowercase letters, digits, and dashes (must start/end alphanumeric).";
  }
  return null;
}

export function buildKindCreateArgs(name: string, versionId?: string): string[] {
  const img = versionById(versionId).kindImage;
  return ["create", "cluster", "--name", name, ...(img ? ["--image", img] : [])];
}

export function buildK3dCreateArgs(name: string, versionId?: string): string[] {
  const img = versionById(versionId).k3dImage;
  return ["cluster", "create", name, ...(img ? ["--image", img] : [])];
}

export function buildKindDeleteArgs(name: string): string[] {
  return ["delete", "cluster", "--name", name];
}

export function buildK3dDeleteArgs(name: string): string[] {
  return ["cluster", "delete", name];
}

/** Map a kubeconfig context name back to the local tool + cluster name, or null
 *  when it isn't a kind/k3d context (delete is refused for those). */
export function toolForContext(context: string): { tool: "kind" | "k3d"; name: string } | null {
  if (context.startsWith("kind-")) return { tool: "kind", name: context.slice("kind-".length) };
  if (context.startsWith("k3d-")) return { tool: "k3d", name: context.slice("k3d-".length) };
  return null;
}
