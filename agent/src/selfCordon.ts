import type { Incident } from "./detector.js";
import type { SuggestedAction } from "./action.js";

/**
 * Undo the agent's own cordons. An autonomous `cordon` stamps the node with
 * CORDONED_BY_ANNOTATION; once that node has been Ready for READY_STABLE_MS it
 * becomes a `cordonedNode` incident that takes the Uncordon level like any other action. A node cordoned by anyone else carries no
 * marker and is never touched. A marker left on a node that is already
 * schedulable (a human uncordoned it first) is stale and gets removed, so a later
 * manual cordon isn't mistaken for ours.
 */
export const CORDONED_BY_ANNOTATION = "rigel.run/cordoned-by";
export const CORDONED_BY_VALUE = "assistant";
export const READY_STABLE_MS = 5 * 60_000;

export interface SelfCordonDetection {
  incidents: Incident[];
  stale: string[];
}

export function detectSelfCordonedNodes(nodes: Record<string, unknown>[], now: number): SelfCordonDetection {
  const out: SelfCordonDetection = { incidents: [], stale: [] };
  for (const n of nodes as Record<string, any>[]) {
    const name = n?.metadata?.name;
    if (typeof name !== "string" || n.metadata.annotations?.[CORDONED_BY_ANNOTATION] !== CORDONED_BY_VALUE) continue;
    if (n.spec?.unschedulable !== true) {
      out.stale.push(name);
      continue;
    }
    const ready = (n.status?.conditions ?? []).find((c: any) => c?.type === "Ready");
    const since = Date.parse(ready?.lastTransitionTime ?? "");
    if (ready?.status === "True" && Number.isFinite(since) && now - since >= READY_STABLE_MS) {
      out.incidents.push({ incidentKind: "cordonedNode", namespace: "", name, reason: "ReadyAgain", detail: `cordoned by the assistant, Ready for ${READY_STABLE_MS / 60_000}m` });
    }
  }
  return out;
}

export function selfUncordonAction(node: string): SuggestedAction {
  return { kind: "uncordon", node, label: `Uncordon ${node} now that it's been healthy for ${READY_STABLE_MS / 60_000} minutes` };
}
