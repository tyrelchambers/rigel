// Cluster-aware chat suggestion chips. Port of the Swift `SuggestedPromptsBuilder`
// (Sources/Helmsman/Chat/SuggestedPrompts.swift). Computed server-side from
// one-shot kubectl reads so it stays isolated from the per-panel watch store
// (which the namespace filter mutates). Priority: unhealthy pods > degraded
// deployments > grouped warning events > node pressure > "Investigate" fallback.

export type SuggestionKind = "pod" | "deploy" | "warn" | "node" | "investigate";

export interface SuggestedPrompt {
  id: string;
  kind: SuggestionKind;
  label: string;
  /** The full prompt sent to the copilot when the chip fires. */
  prompt: string;
}

// --- Minimal shapes of the kubectl JSON we read (everything else ignored). ---
interface Meta { name?: string; namespace?: string; uid?: string }
interface ContainerStatus { restartCount?: number; state?: { waiting?: { reason?: string } } }
interface Pod {
  metadata?: Meta;
  spec?: { nodeName?: string };
  status?: { phase?: string; containerStatuses?: ContainerStatus[] };
}
interface Deployment {
  metadata?: Meta;
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; replicas?: number };
}
interface NodeCondition { type?: string; status?: string }
interface Node { metadata?: Meta; status?: { conditions?: NodeCondition[] } }
interface K8sEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
}

const ERROR_WAITING_REASONS = new Set([
  "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError",
  "CreateContainerError", "InvalidImageName", "RunContainerError",
]);

function podErrorReason(pod: Pod): string | null {
  for (const cs of pod.status?.containerStatuses ?? []) {
    const r = cs.state?.waiting?.reason;
    if (r && ERROR_WAITING_REASONS.has(r)) return r;
  }
  if (pod.status?.phase === "Failed") return "Failed";
  return null;
}

function totalRestarts(pod: Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0);
}

interface WarningGroup {
  reason: string; kind: string; namespace: string;
  total: number; sampleMessage: string; objectNames: string[];
}

function compactMessage(s: string): string {
  let m = s;
  const marker = "(combined from similar events): ";
  const i = m.indexOf(marker);
  if (i !== -1) m = m.slice(0, i) + m.slice(i + marker.length);
  return m.split(/\s+/).filter(Boolean).join(" ");
}

/** Bucket warnings by (reason, involved-kind, namespace), summing counts. */
export function groupWarnings(events: K8sEvent[]): WarningGroup[] {
  const order: string[] = [];
  const acc = new Map<string, { total: number; msgs: Map<string, number>; names: string[]; seen: Set<string> }>();
  const meta = new Map<string, { reason: string; kind: string; ns: string }>();

  for (const e of events) {
    const reason = e.reason ?? "Warning";
    const kind = e.involvedObject?.kind ?? "Resource";
    const ns = e.involvedObject?.namespace ?? "default";
    const key = `${reason}|${kind}|${ns}`;
    if (!acc.has(key)) {
      acc.set(key, { total: 0, msgs: new Map(), names: [], seen: new Set() });
      meta.set(key, { reason, kind, ns });
      order.push(key);
    }
    const a = acc.get(key)!;
    const occ = Math.max(1, e.count ?? 1);
    a.total += occ;
    const msg = compactMessage(e.message ?? "");
    if (msg) a.msgs.set(msg, (a.msgs.get(msg) ?? 0) + occ);
    const name = e.involvedObject?.name;
    if (name && !a.seen.has(name)) { a.seen.add(name); a.names.push(name); }
  }

  return order
    .map((key) => {
      const a = acc.get(key)!;
      const m = meta.get(key)!;
      let sample = "";
      let best = -1;
      for (const [msg, c] of a.msgs) if (c > best) { best = c; sample = msg; }
      return { reason: m.reason, kind: m.kind, namespace: m.ns, total: a.total, sampleMessage: sample, objectNames: a.names };
    })
    .sort((x, y) => y.total - x.total);
}

function shortLabel(g: WarningGroup): string {
  const base = g.sampleMessage || g.reason;
  return base.length > 44 ? base.slice(0, 44) + "…" : base;
}

function groupPrompt(g: WarningGroup): string {
  const names = g.objectNames.slice(0, 8).join(", ");
  const more = g.objectNames.length > 8 ? ` (+${g.objectNames.length - 8} more)` : "";
  const affected = names ? `\nAffected ${g.kind}: ${names}${more}` : "";
  return `${g.total} Warning event${g.total === 1 ? "" : "s"} in namespace **${g.namespace}** — reason **${g.reason}** on ${g.kind} resources.\nMessage: "${g.sampleMessage}"${affected}\n\nInvestigate the root cause and tell me what needs attention and how to fix it.`;
}

/** Build the chip list from one-shot cluster reads. Capped at 8. */
export function buildSuggestions(data: {
  pods: Pod[]; deployments: Deployment[]; nodes: Node[]; events: K8sEvent[];
}): SuggestedPrompt[] {
  const out: SuggestedPrompt[] = [];

  // 1. Unhealthy pods (top 3 by restarts)
  const unhealthy = data.pods
    .filter((p) => podErrorReason(p) !== null)
    .sort((a, b) => totalRestarts(b) - totalRestarts(a));
  for (const pod of unhealthy.slice(0, 3)) {
    const reason = podErrorReason(pod) ?? "unhealthy";
    const name = pod.metadata?.name ?? "?";
    const ns = pod.metadata?.namespace ?? "default";
    out.push({
      id: `pod-${pod.metadata?.uid ?? name}`,
      kind: "pod",
      label: `Why is ${name} ${reason.toLowerCase()}?`,
      prompt: `Pod **${name}** in namespace **${ns}** is in ${reason}.\nRestarts: ${totalRestarts(pod)}. Node: ${pod.spec?.nodeName ?? "?"}.\n\nInvestigate why. Run kubectl describe + logs + events as needed. Be specific about the root cause and what to do.`,
    });
  }

  // 2. Degraded deployments (top 3 by gap)
  const degraded = data.deployments
    .filter((d) => {
      const ready = d.status?.readyReplicas ?? 0;
      const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
      return desired > 0 && ready < desired;
    })
    .sort((a, b) => {
      const ga = (a.spec?.replicas ?? 0) - (a.status?.readyReplicas ?? 0);
      const gb = (b.spec?.replicas ?? 0) - (b.status?.readyReplicas ?? 0);
      return gb - ga;
    });
  for (const dep of degraded.slice(0, 3)) {
    const ready = dep.status?.readyReplicas ?? 0;
    const desired = dep.spec?.replicas ?? dep.status?.replicas ?? 0;
    const name = dep.metadata?.name ?? "?";
    const ns = dep.metadata?.namespace ?? "default";
    out.push({
      id: `dep-${dep.metadata?.uid ?? name}`,
      kind: "deploy",
      label: `Why is ${name} degraded?`,
      prompt: `Deployment **${name}** in namespace **${ns}** is degraded — ${ready}/${desired} replicas ready.\n\nInvestigate why pods aren't coming up. Check rollout status, pod events, recent template changes. Be specific.`,
    });
  }

  // 3. Recent warning events (grouped), once there's a meaningful surge
  const warnings = data.events.filter((e) => e.type === "Warning");
  if (warnings.length >= 3) {
    for (const g of groupWarnings(warnings).slice(0, 3)) {
      out.push({
        id: `warn-${g.reason}|${g.kind}|${g.namespace}`,
        kind: "warn",
        label: `${g.total}× ${shortLabel(g)}`,
        prompt: groupPrompt(g),
      });
    }
  }

  // 4. Node pressure
  for (const node of data.nodes) {
    const pressure = (node.status?.conditions ?? []).some((c) => c.type !== "Ready" && c.status === "True");
    if (!pressure) continue;
    const name = node.metadata?.name ?? "?";
    out.push({
      id: `node-${node.metadata?.uid ?? name}`,
      kind: "node",
      label: `${name}: node pressure`,
      prompt: `Node **${name}** is reporting pressure conditions. Look at its status and recent events, identify the cause, and tell me how to relieve it.`,
    });
    if (out.length >= 6) break;
  }

  // 5. Always-on fallback
  out.push({
    id: "investigate",
    kind: "investigate",
    label: "Investigate cluster",
    prompt: "Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual.\n\nBe concise. Group findings by severity. If everything looks fine, say so briefly.",
  });

  return out.slice(0, 8);
}
