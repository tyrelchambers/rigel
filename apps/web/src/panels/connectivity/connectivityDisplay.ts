import type { Ingress } from "../ingresses/types";
import type { Service } from "../services/types";
import type { Pod } from "../pods/types";
import { flattenRoutes } from "../ingresses/ingressesDisplay";
import { typeLabel } from "../services/servicesDisplay";
import type { Flow, Health } from "./types";

/**
 * Pure functions for the Connectivity panel. Direct port of the Swift
 * `Connectivity` enum (`Sources/Helmsman/Cluster/Connectivity.swift`). Selector→
 * pod matching and health classification live here so they can be unit-tested
 * without the live store. See `docs/parity/connectivity.md`.
 */

/**
 * A pod is a ready endpoint when it's Running with all containers ready.
 * Mirrors Swift `Connectivity.isPodReady`: phase=Running AND at least one
 * containerStatus AND every containerStatus.ready === true.
 */
export function isPodReady(pod: Pod): boolean {
  if (pod.status?.phase !== "Running") return false;
  const cs = pod.status?.containerStatuses ?? [];
  return cs.length > 0 && cs.every((c) => c.ready);
}

/**
 * Derive a flow's health. Mirrors Swift `Connectivity.Flow.health`:
 * no issues → ok; otherwise external problems are broken, internal ones warn.
 */
export function getFlowHealth(flow: Pick<Flow, "issues" | "isExternal">): Health {
  if (flow.issues.length === 0) return "ok";
  return flow.isExternal ? "broken" : "warn";
}

/** Sort rank for health: broken (0) → warn (1) → ok (2). */
function healthRank(h: Health): number {
  return h === "broken" ? 0 : h === "warn" ? 1 : 2;
}

interface Front {
  hosts: Set<string>;
  ingresses: Set<string>;
}

/**
 * Resolve ingresses + services + pods into a flat, sorted list of Flows.
 * Direct port of Swift `Connectivity.flows(ingresses:services:pods:)`.
 */
export function computeFlows(
  ingresses: Ingress[],
  services: Service[],
  pods: Pod[],
): Flow[] {
  // 1. Map each "namespace/service-name" target to the hosts + ingress names
  //    fronting it.
  const fronts = new Map<string, Front>();
  for (const ing of ingresses) {
    const ns = ing.metadata.namespace ?? "default";
    for (const route of flattenRoutes(ing)) {
      if (route.service === "—") continue;
      const key = `${ns}/${route.service}`;
      const f = fronts.get(key) ?? { hosts: new Set<string>(), ingresses: new Set<string>() };
      if (route.host !== "*") f.hosts.add(route.host);
      f.ingresses.add(ing.metadata.name);
      fronts.set(key, f);
    }
  }

  const serviceKeys = new Set(
    services.map((s) => `${s.metadata.namespace ?? "default"}/${s.metadata.name}`),
  );
  const flows: Flow[] = [];

  // 2. One flow per service.
  for (const svc of services) {
    const ns = svc.metadata.namespace ?? "default";
    const key = `${ns}/${svc.metadata.name}`;
    const front = fronts.get(key);
    const isExternal = (front?.ingresses.size ?? 0) > 0;

    const selector = svc.spec?.selector ?? {};
    const selectorEntries = Object.entries(selector);
    const matched =
      selectorEntries.length === 0
        ? []
        : pods.filter((pod) => {
            if ((pod.metadata.namespace ?? "default") !== ns) return false;
            const labels = pod.metadata.labels ?? {};
            return selectorEntries.every(([k, v]) => labels[k] === v);
          });
    const ready = matched.filter(isPodReady).length;

    const issues: string[] = [];
    if (selectorEntries.length > 0) {
      if (matched.length === 0) {
        issues.push("Selector matches no pods");
      } else if (ready === 0) {
        issues.push(`${matched.length} pod${matched.length === 1 ? "" : "s"}, 0 ready`);
      }
    }

    flows.push(
      finalizeFlow({
        id: key,
        hosts: front ? [...front.hosts].sort((a, b) => a.localeCompare(b)) : [],
        ingressNames: front ? [...front.ingresses].sort((a, b) => a.localeCompare(b)) : [],
        serviceName: svc.metadata.name,
        namespace: ns,
        serviceType: typeLabel(svc),
        serviceExists: true,
        readyPods: ready,
        totalPods: matched.length,
        podNames: matched.map((p) => p.metadata.name).sort((a, b) => a.localeCompare(b)),
        isExternal,
        issues,
      }),
    );
  }

  // 3. Dangling ingress routes — point at a service that doesn't exist.
  for (const [key, front] of fronts) {
    if (serviceKeys.has(key)) continue;
    const slash = key.indexOf("/");
    const ns = slash >= 0 ? key.slice(0, slash) : "default";
    const name = slash >= 0 ? key.slice(slash + 1) : key;
    flows.push(
      finalizeFlow({
        id: key,
        hosts: [...front.hosts].sort((a, b) => a.localeCompare(b)),
        ingressNames: [...front.ingresses].sort((a, b) => a.localeCompare(b)),
        serviceName: name,
        namespace: ns,
        serviceType: "—",
        serviceExists: false,
        readyPods: 0,
        totalPods: 0,
        podNames: [],
        isExternal: true,
        issues: ["Ingress points to a service that doesn't exist"],
      }),
    );
  }

  // 4. Sort: broken → warn → ok, then namespace, then serviceName.
  return flows.sort((a, b) => {
    const ra = healthRank(a.health);
    const rb = healthRank(b.health);
    if (ra !== rb) return ra - rb;
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    if (a.serviceName !== b.serviceName) return a.serviceName < b.serviceName ? -1 : 1;
    return 0;
  });
}

/** Attach the derived `health` field to a flow draft. */
function finalizeFlow(draft: Omit<Flow, "health">): Flow {
  return { ...draft, health: getFlowHealth(draft) };
}
