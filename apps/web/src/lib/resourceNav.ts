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
  "certificates.cert-manager.io": { route: "/certificates", focusKind: "certificate" },
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

/** Kinds the Logs panel can open directly (workloads stream by selector, pods by name). */
export type LogFocusKind = "pod" | "deployment" | "statefulset" | "daemonset";

/** Navigate to the Logs panel and request a workload's/pod's logs be opened + streamed. */
export function goToLogs(navigate: NavigateFn, ref: { kind: LogFocusKind; namespace?: string; name: string }): void {
  const key = `${ref.namespace ?? "default"}/${ref.name}`;
  navigate("/logs");
  useCluster.getState().setFocusRequest({ route: "/logs", kind: ref.kind, key });
}

export function routeForKind(storeKind: string): string | undefined {
  return NAV_META[storeKind]?.route;
}
