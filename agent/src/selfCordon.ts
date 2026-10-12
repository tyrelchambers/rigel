/**
 * Undo the agent's own cordons. An autonomous `cordon` stamps the node with
 * CORDONED_BY_ANNOTATION; once that node has been Ready for READY_STABLE_MS the
 * agent uncordons it without asking. A node cordoned by anyone else carries no
 * marker and is never touched. A marker left on a node that is already
 * schedulable (a human uncordoned it first) is stale and gets removed, so a later
 * manual cordon isn't mistaken for ours.
 */
export const CORDONED_BY_ANNOTATION = "rigel.run/cordoned-by";
export const CORDONED_BY_VALUE = "assistant";
export const READY_STABLE_MS = 5 * 60_000;

export interface SelfCordonPlan {
  uncordon: string[];
  stale: string[];
}

export function selfCordonedNodes(nodes: Record<string, unknown>[], now: number): SelfCordonPlan {
  const plan: SelfCordonPlan = { uncordon: [], stale: [] };
  for (const n of nodes as Record<string, any>[]) {
    const name = n?.metadata?.name;
    if (typeof name !== "string" || n.metadata.annotations?.[CORDONED_BY_ANNOTATION] !== CORDONED_BY_VALUE) continue;
    if (n.spec?.unschedulable !== true) {
      plan.stale.push(name);
      continue;
    }
    const ready = (n.status?.conditions ?? []).find((c: any) => c?.type === "Ready");
    const since = Date.parse(ready?.lastTransitionTime ?? "");
    if (ready?.status === "True" && Number.isFinite(since) && now - since >= READY_STABLE_MS) plan.uncordon.push(name);
  }
  return plan;
}
