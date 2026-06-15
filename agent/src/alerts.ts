// agent/src/alerts.ts
// Deterministic, model-less alert-rule evaluation — the free rider on the tick's
// existing pods+deployments fetch. Mirrors the wire shapes in
// packages/k8s/src/alerts.ts (the agent is a standalone deployable, so the types
// are duplicated across the ConfigMap-JSON boundary, like detector.ts).

export type AlertScope = "cluster" | "namespace" | "workload" | "pod" | "database";

export interface AlertTarget {
  scope: AlertScope;
  namespace?: string;
  kind?: string;
  name?: string;
  labelSelector?: string;
}

export type AlertCondition =
  | { type: "podRestarts"; threshold: number; windowMinutes: number }
  | { type: "crashLoop" }
  | { type: "oomKilled" }
  | { type: "pendingTooLong"; minutes: number }
  | { type: "notReady"; minutes: number }
  | { type: "deploymentDegraded"; minutes: number };

export interface AlertRule {
  id: string;
  enabled: boolean;
  text: string;
  target: AlertTarget;
  condition: AlertCondition;
  cooldownMinutes: number;
  createdAt: string;
}

export interface AlertState {
  lastFiredAt: Record<string, string>;
  restartBaselines: Record<string, { count: number; since: string }>;
}

export interface AlertEvent {
  ruleId: string;
  message: string;
}

export function emptyAlertState(): AlertState {
  return { lastFiredAt: {}, restartBaselines: {} };
}

const CRASH_REASONS = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"]);
const CONDITION_TYPES = new Set([
  "podRestarts", "crashLoop", "oomKilled", "pendingTooLong", "notReady", "deploymentDegraded",
]);

function conditionFieldsValid(c: { type?: string; threshold?: unknown; windowMinutes?: unknown; minutes?: unknown }): boolean {
  if (c.type === "podRestarts") return typeof c.threshold === "number" && c.threshold > 0 && typeof c.windowMinutes === "number" && c.windowMinutes > 0;
  if (c.type === "pendingTooLong" || c.type === "notReady" || c.type === "deploymentDegraded") return typeof c.minutes === "number" && c.minutes >= 0;
  return true; // crashLoop / oomKilled have no numeric fields
}

/** Tolerant parse of the alertRules JSON from assistant-config. Drops malformed. */
export function parseAlertRules(json: string | undefined | null): AlertRule[] {
  if (!json) return [];
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: AlertRule[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<AlertRule>;
    if (typeof r.id !== "string" || !r.target || !r.condition) continue;
    if (!CONDITION_TYPES.has((r.condition as { type?: string }).type ?? "")) continue;
    if (!conditionFieldsValid(r.condition as { type?: string; threshold?: unknown; windowMinutes?: unknown; minutes?: unknown })) continue;
    out.push({
      id: r.id,
      enabled: r.enabled !== false,
      text: typeof r.text === "string" ? r.text : "",
      target: r.target,
      condition: r.condition,
      cooldownMinutes: typeof r.cooldownMinutes === "number" && r.cooldownMinutes > 0 ? r.cooldownMinutes : 5,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }
  return out;
}

type Pod = Record<string, unknown>;
type Dep = Record<string, unknown>;

function labelsMatch(labels: Record<string, string> | undefined, selector: string): boolean {
  const want = selector.split(",").map((s) => s.trim()).filter(Boolean);
  return want.every((pair) => {
    const [k, v] = pair.split("=");
    return labels?.[k!.trim()] === v?.trim();
  });
}

/** Does this pod fall under the rule's target? */
export function podMatchesTarget(pod: Pod, t: AlertTarget): boolean {
  const meta = pod.metadata as Record<string, unknown> | undefined;
  const ns: string = (meta?.["namespace"] as string | undefined) ?? "default";
  const name: string = (meta?.["name"] as string | undefined) ?? "";
  const labels = meta?.["labels"] as Record<string, string> | undefined;

  if (t.namespace && ns !== t.namespace) return false;
  if (t.labelSelector && !labelsMatch(labels, t.labelSelector)) return false;
  switch (t.scope) {
    case "cluster": return true;
    case "namespace": return true;
    case "pod": return name === t.name;
    case "database": return labels?.["cnpg.io/cluster"] === t.name;
    case "workload": return !!t.name && (name === t.name || name.startsWith(`${t.name}-`));
  }
}

/** Does this deployment fall under the rule's target? (only namespace/workload/cluster apply) */
export function deploymentMatchesTarget(dep: Dep, t: AlertTarget): boolean {
  if (t.scope !== "cluster" && t.scope !== "namespace" && t.scope !== "workload") return false;
  const meta = dep.metadata as Record<string, unknown> | undefined;
  const ns: string = (meta?.["namespace"] as string | undefined) ?? "default";
  const name: string = (meta?.["name"] as string | undefined) ?? "";
  if (t.namespace && ns !== t.namespace) return false;
  if (t.labelSelector && !labelsMatch(meta?.["labels"] as Record<string, string> | undefined, t.labelSelector)) return false;
  if (t.scope === "workload") return name === t.name;
  return true;
}

function totalRestarts(pod: Pod): number {
  const status = pod.status as Record<string, unknown> | undefined;
  const containerStatuses = (status?.containerStatuses as Record<string, unknown>[] | undefined) ?? [];
  return containerStatuses.reduce(
    (sum: number, cs: Record<string, unknown>) =>
      sum + (typeof cs["restartCount"] === "number" ? (cs["restartCount"] as number) : 0),
    0,
  );
}

function podHasCrashLoop(pod: Pod): boolean {
  const status = pod.status as Record<string, unknown> | undefined;
  const containerStatuses = (status?.containerStatuses as Record<string, unknown>[] | undefined) ?? [];
  return containerStatuses.some((cs) => {
    const state = cs["state"] as Record<string, unknown> | undefined;
    const waiting = state?.["waiting"] as Record<string, unknown> | undefined;
    return CRASH_REASONS.has(waiting?.["reason"] as string);
  });
}

function podHasOom(pod: Pod): boolean {
  const status = pod.status as Record<string, unknown> | undefined;
  const containerStatuses = (status?.containerStatuses as Record<string, unknown>[] | undefined) ?? [];
  return containerStatuses.some((cs) => {
    const lastState = cs["lastState"] as Record<string, unknown> | undefined;
    const lastTerminated = lastState?.["terminated"] as Record<string, unknown> | undefined;
    const state = cs["state"] as Record<string, unknown> | undefined;
    const terminated = state?.["terminated"] as Record<string, unknown> | undefined;
    return (lastTerminated?.["reason"] ?? terminated?.["reason"]) === "OOMKilled";
  });
}

function pendingForMs(pod: Pod, now: number): number {
  const status = pod.status as Record<string, unknown> | undefined;
  if ((status?.["phase"] as string | undefined) !== "Pending") return -1;
  const start = (status?.["startTime"] as string | undefined)
    ?? ((pod.metadata as Record<string, unknown> | undefined)?.["creationTimestamp"] as string | undefined);
  const ms = start ? Date.parse(start) : NaN;
  return Number.isNaN(ms) ? 0 : now - ms;
}

function notReadyForMs(pod: Pod, now: number): number {
  const status = pod.status as Record<string, unknown> | undefined;
  const conditions = (status?.["conditions"] as Record<string, unknown>[] | undefined) ?? [];
  const cond = conditions.find((c) => c["type"] === "Ready");
  if (!cond || cond["status"] === "True") return -1;
  const ms = cond["lastTransitionTime"] ? Date.parse(cond["lastTransitionTime"] as string) : NaN;
  return Number.isNaN(ms) ? 0 : now - ms;
}

function degradedForMs(dep: Dep, now: number): number {
  const spec = dep.spec as Record<string, unknown> | undefined;
  const status = dep.status as Record<string, unknown> | undefined;
  const desired: number =
    (spec?.["replicas"] as number | undefined) ??
    (status?.["replicas"] as number | undefined) ?? 0;
  const ready: number = (status?.["readyReplicas"] as number | undefined) ?? 0;
  if (!(desired > 0 && ready < desired)) return -1;
  const conditions = (status?.["conditions"] as Record<string, unknown>[] | undefined) ?? [];
  const cond = conditions.find((c) => c["type"] === "Available" || c["type"] === "Progressing");
  const ms = cond?.["lastTransitionTime"] ? Date.parse(cond["lastTransitionTime"] as string) : NaN;
  return Number.isNaN(ms) ? 0 : now - ms;
}

/**
 * Evaluate every enabled rule against the current snapshot. Pure: returns the
 * events to fire (respecting per-rule cooldown) and the next AlertState (cooldown
 * stamps + tumbling restart baselines). Baselines are rebuilt from currently-
 * matched pods only, so the map can't grow unbounded as pods churn.
 */
export function evaluateAlertRules(
  rules: AlertRule[],
  pods: Pod[],
  deps: Dep[],
  prev: AlertState,
  now: number,
): { events: AlertEvent[]; alertState: AlertState } {
  const events: AlertEvent[] = [];
  const next: AlertState = { lastFiredAt: {}, restartBaselines: {} };
  const activeIds = new Set(rules.map((r) => r.id));
  for (const [id, at] of Object.entries(prev.lastFiredAt)) {
    if (activeIds.has(id)) next.lastFiredAt[id] = at;
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const detail = evaluateCondition(rule, pods, deps, prev, next, now);
    if (!detail) continue;
    const last = prev.lastFiredAt[rule.id];
    const elapsed = last ? now - Date.parse(last) : Infinity;
    if (elapsed >= rule.cooldownMinutes * 60_000) {
      events.push({ ruleId: rule.id, message: `⚠️ Alert "${rule.text}": ${detail}` });
      next.lastFiredAt[rule.id] = new Date(now).toISOString();
    }
  }
  return { events, alertState: next };
}

/** Returns a non-empty detail string when the rule's condition is met, else "".
 * For podRestarts, also updates next.restartBaselines as a side effect (avoids a second pod scan). */
function evaluateCondition(
  rule: AlertRule, pods: Pod[], deps: Dep[], prev: AlertState, next: AlertState, now: number,
): string {
  const c = rule.condition;
  if (c.type === "deploymentDegraded") {
    for (const d of deps) {
      if (!deploymentMatchesTarget(d, rule.target)) continue;
      const ms = degradedForMs(d, now);
      if (ms >= c.minutes * 60_000) {
        const meta = d.metadata as Record<string, unknown> | undefined;
        const status = d.status as Record<string, unknown> | undefined;
        const spec = d.spec as Record<string, unknown> | undefined;
        const ns = (meta?.["namespace"] as string | undefined) ?? "default";
        const ready = (status?.["readyReplicas"] as number | undefined) ?? 0;
        const desired = (spec?.["replicas"] as number | undefined) ?? 0;
        return `deployment ${ns}/${meta?.["name"]} degraded (${ready}/${desired} ready)`;
      }
    }
    return "";
  }

  const matched = pods.filter((p) => podMatchesTarget(p, rule.target));

  if (c.type === "podRestarts") {
    let hit = "";
    for (const p of matched) {
      const meta = p.metadata as Record<string, unknown> | undefined;
      const ns = (meta?.["namespace"] as string | undefined) ?? "default";
      const key = `${rule.id}|${ns}/${meta?.["name"]}`;
      const current = totalRestarts(p);
      let base = prev.restartBaselines[key];
      if (!base || now - Date.parse(base.since) >= c.windowMinutes * 60_000) {
        base = { count: current, since: new Date(now).toISOString() };
      }
      next.restartBaselines[key] = base;
      // first-hit: one alert per rule per tick even if several pods qualify
      if (current - base.count >= c.threshold && !hit) {
        hit = `${ns}/${meta?.["name"]} restarted ${current - base.count}× in the last ${c.windowMinutes}m`;
      }
    }
    return hit;
  }

  for (const p of matched) {
    const meta = p.metadata as Record<string, unknown> | undefined;
    const ns = (meta?.["namespace"] as string | undefined) ?? "default";
    const loc = `${ns}/${meta?.["name"]}`;
    if (c.type === "crashLoop" && podHasCrashLoop(p)) return `${loc} is crash-looping`;
    if (c.type === "oomKilled" && podHasOom(p)) return `${loc} was OOM-killed`;
    if (c.type === "pendingTooLong") {
      const ms = pendingForMs(p, now);
      if (ms >= c.minutes * 60_000) return `${loc} has been Pending for >${c.minutes}m`;
    }
    if (c.type === "notReady") {
      const ms = notReadyForMs(p, now);
      if (ms >= c.minutes * 60_000) return `${loc} has been not-ready for >${c.minutes}m`;
    }
  }
  return "";
}
