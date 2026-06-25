import { useCluster } from "@/store/cluster";
import type { RelatedRef } from "./relatedResources";

type NavTarget = { route: string; focusKind: string };

// store kind (plural) → router route + the singular `focusRequest.kind` panels match on.
const NAV_META: Record<string, NavTarget> = {
  pods: { route: "/pods", focusKind: "pod" },
  deployments: { route: "/deployments", focusKind: "deployment" },
  statefulsets: { route: "/workloads", focusKind: "statefulset" },
  daemonsets: { route: "/workloads", focusKind: "daemonset" },
  services: { route: "/services", focusKind: "service" },
  ingresses: { route: "/ingresses", focusKind: "ingress" },
  configmaps: { route: "/configmaps", focusKind: "configmap" },
  secrets: { route: "/secrets", focusKind: "secret" },
  persistentvolumeclaims: { route: "/storage", focusKind: "persistentvolumeclaim" },
  nodes: { route: "/nodes", focusKind: "node" },
};

type NavigateFn = (to: string) => void;

/** The focus key panels compare against: uid-preferred, falling back to ns/name. */
export function focusKeyFor(o: { metadata?: { uid?: string; name?: string; namespace?: string } }): string {
  const m = o.metadata ?? {};
  return m.uid ?? `${m.namespace ?? "default"}/${m.name}`;
}

/** Navigate to a related resource and request its row be focused/expanded. */
export function goToResource(navigate: NavigateFn, ref: RelatedRef): void {
  const meta = NAV_META[ref.kind];
  if (!meta) return;
  const key = ref.uid ?? (ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name);
  navigate(meta.route);
  useCluster.getState().setFocusRequest({ route: meta.route, kind: meta.focusKind, key });
}

export function routeForKind(storeKind: string): string | undefined {
  return NAV_META[storeKind]?.route;
}
