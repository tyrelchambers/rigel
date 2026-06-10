/**
 * @-mention resource candidates for the chat composer. Mirrors the Swift
 * `MentionIndex` — deployments, pods, and nodes pulled from the live cluster
 * store. Picking one inserts an inline reference + gives Claude a one-line
 * context summary so it doesn't need to re-fetch.
 */

export type MentionKind = "deployment" | "pod" | "node";

export interface MentionCandidate {
  id: string;
  kind: MentionKind;
  name: string;
  namespace?: string;
  /** One-line summary appended to the prompt when picked. */
  context: string;
}

export const MENTION_KIND_LABEL: Record<MentionKind, string> = {
  deployment: "DEPLOY",
  pod: "POD",
  node: "NODE",
};

interface MetaObj {
  metadata?: { uid?: string; name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    nodeName?: string;
    template?: { spec?: { containers?: Array<{ image?: string }> } };
  };
  status?: {
    readyReplicas?: number;
    replicas?: number;
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: Array<{ restartCount?: number; state?: { waiting?: { reason?: string } } }>;
  };
}

function recordValues(resources: Record<string, unknown>, kind: string): MetaObj[] {
  return Object.values((resources[kind] ?? {}) as Record<string, MetaObj>);
}

/** Build the candidate list from the live store (deployments first). */
export function buildMentions(resources: Record<string, unknown>): MentionCandidate[] {
  const out: MentionCandidate[] = [];

  for (const d of recordValues(resources, "deployments")) {
    const name = d.metadata?.name;
    if (!name) continue;
    const ns = d.metadata?.namespace ?? "default";
    const ready = d.status?.readyReplicas ?? 0;
    const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
    const image = d.spec?.template?.spec?.containers?.[0]?.image ?? "—";
    out.push({
      id: `dep-${d.metadata?.uid ?? name}`,
      kind: "deployment",
      name,
      namespace: ns,
      context: `Deployment ${name} in ${ns}: ${ready}/${desired} ready, image ${image}`,
    });
  }

  for (const p of recordValues(resources, "pods")) {
    const name = p.metadata?.name;
    if (!name) continue;
    const ns = p.metadata?.namespace ?? "default";
    const phase = p.status?.phase ?? "?";
    const restarts = (p.status?.containerStatuses ?? []).reduce((a, c) => a + (c.restartCount ?? 0), 0);
    const bad = (p.status?.containerStatuses ?? []).map((c) => c.state?.waiting?.reason).find(Boolean);
    out.push({
      id: `pod-${p.metadata?.uid ?? name}`,
      kind: "pod",
      name,
      namespace: ns,
      context: `Pod ${name} in ${ns}: phase ${phase}${bad ? ` (${bad})` : ""}, restarts ${restarts}, node ${p.spec?.nodeName ?? "?"}`,
    });
  }

  for (const n of recordValues(resources, "nodes")) {
    const name = n.metadata?.name;
    if (!name) continue;
    const ready = (n.status?.conditions ?? []).find((c) => c.type === "Ready")?.status === "True";
    out.push({
      id: `node-${n.metadata?.uid ?? name}`,
      kind: "node",
      name,
      context: `Node ${name}: ${ready ? "Ready" : "NotReady"}`,
    });
  }

  return out;
}

function kindRank(k: MentionKind): number {
  return k === "deployment" ? 0 : k === "pod" ? 1 : 2;
}

/** Filter + rank candidates by query (deployments boosted). */
export function filterMentions(
  candidates: MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const q = query.toLowerCase();
  if (!q) {
    return [...candidates]
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : kindRank(a.kind) - kindRank(b.kind)))
      .slice(0, limit);
  }
  const scored: Array<{ c: MentionCandidate; score: number }> = [];
  for (const c of candidates) {
    const name = c.name.toLowerCase();
    const ns = (c.namespace ?? "").toLowerCase();
    let best = -1;
    if (name === q) best = 1000;
    else if (name.startsWith(q)) best = 500;
    else if (name.includes(q)) best = 200 - name.indexOf(q);
    else if (ns.includes(q)) best = 50;
    if (best >= 0) scored.push({ c, score: best + (c.kind === "deployment" ? 20 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.c);
}
