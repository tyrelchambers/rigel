// packages/k8s/src/alerts.ts
// Natural-language alert rules — the domain types + pure helpers shared by the
// server (which stores rules) and the web panel (which lists them). The agent
// owns a mirror of these shapes in agent/src/alerts.ts (wire contract).

export type AlertScope = "cluster" | "namespace" | "workload" | "pod" | "database";

export interface AlertTarget {
  scope: AlertScope;
  namespace?: string;
  kind?: "Deployment" | "StatefulSet" | "DaemonSet";
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

export interface SuggestedAlert {
  label: string;
  text: string;
  target: AlertTarget;
  condition: AlertCondition;
  cooldownMinutes?: number;
}

export interface AlertRule {
  id: string;
  enabled: boolean;
  text: string;
  target: AlertTarget;
  condition: AlertCondition;
  cooldownMinutes: number;
  createdAt: string;
}

const SCOPES = new Set<AlertScope>(["cluster", "namespace", "workload", "pod", "database"]);
const CONDITION_TYPES = new Set([
  "podRestarts", "crashLoop", "oomKilled", "pendingTooLong", "notReady", "deploymentDegraded",
]);

/** The condition's natural time window in minutes, or 0 for snapshot conditions. */
function conditionWindowMinutes(c: AlertCondition): number {
  if (c.type === "podRestarts") return c.windowMinutes;
  if (c.type === "pendingTooLong" || c.type === "notReady" || c.type === "deploymentDegraded") return c.minutes;
  return 0;
}

/** Validate a target shape, throwing on anything malformed. */
function validateTarget(t: AlertTarget): void {
  if (!t || !SCOPES.has(t.scope)) throw new Error(`invalid alert target scope: ${String(t?.scope)}`);
  if (t.scope !== "cluster" && t.scope !== "namespace" && !t.name) {
    throw new Error(`alert target scope "${t.scope}" requires a name`);
  }
  if (t.scope === "namespace" && !t.namespace) throw new Error(`namespace scope requires a namespace`);
}

/** Validate a condition shape (numbers present + sane), throwing on bad input. */
function validateCondition(c: AlertCondition): void {
  if (!c || !CONDITION_TYPES.has((c as { type?: string }).type ?? "")) {
    throw new Error(`invalid alert condition: ${JSON.stringify(c)}`);
  }
  if (c.type === "podRestarts" && (!(c.threshold > 0) || !(c.windowMinutes > 0))) {
    throw new Error("podRestarts needs threshold>0 and windowMinutes>0");
  }
  for (const k of ["minutes"] as const) {
    if (k in c && !((c as unknown as Record<string, number>)[k] >= 0)) throw new Error(`${c.type} needs ${k}>=0`);
  }
}

/** Turn a model-emitted block into a stored rule (server-side). Throws on bad shape. */
export function normalizeAlertRule(block: SuggestedAlert, id: string, nowMs: number): AlertRule {
  if (typeof block?.text !== "string" || block.text.trim() === "") throw new Error("alert needs text");
  validateTarget(block.target);
  validateCondition(block.condition);
  const window = conditionWindowMinutes(block.condition);
  const cooldown = block.cooldownMinutes && block.cooldownMinutes > 0
    ? block.cooldownMinutes
    : Math.max(5, window);
  return {
    id,
    enabled: true,
    text: block.text.trim(),
    target: block.target,
    condition: block.condition,
    cooldownMinutes: cooldown,
    createdAt: new Date(nowMs).toISOString(),
  };
}

/** Tolerant parse of the `alertRules` JSON string. Drops anything malformed. */
export function parseAlertRules(json: string | undefined | null): AlertRule[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: AlertRule[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<AlertRule>;
    if (typeof r.id !== "string" || typeof r.text !== "string" || !r.target || !r.condition) continue;
    try {
      validateTarget(r.target);
      validateCondition(r.condition);
    } catch {
      continue;
    }
    out.push({
      id: r.id,
      enabled: r.enabled !== false,
      text: r.text,
      target: r.target,
      condition: r.condition,
      cooldownMinutes: typeof r.cooldownMinutes === "number" && r.cooldownMinutes > 0
        ? r.cooldownMinutes
        : Math.max(5, conditionWindowMinutes(r.condition)),
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }
  return out;
}

export function serializeAlertRules(rules: AlertRule[]): string {
  return JSON.stringify(rules);
}

/** Pure mutation of the rule list — add/delete/toggle, returning a new array. */
export function nextAlertRules(
  rules: AlertRule[],
  op:
    | { op: "add"; rule: AlertRule }
    | { op: "delete"; id: string }
    | { op: "toggle"; id: string; enabled: boolean },
): AlertRule[] {
  if (op.op === "add") return [...rules.filter((r) => r.id !== op.rule.id), op.rule];
  if (op.op === "delete") return rules.filter((r) => r.id !== op.id);
  return rules.map((r) => (r.id === op.id ? { ...r, enabled: op.enabled } : r));
}

/** A human one-liner for the panel/notification, e.g. "database prod/postgres — not ready 2m". */
export function alertRuleSummary(rule: AlertRule): string {
  const t = rule.target;
  const loc =
    t.scope === "cluster" ? "anything in the cluster"
    : t.scope === "namespace" ? `namespace ${t.namespace}`
    : `${t.scope} ${t.namespace ? `${t.namespace}/` : ""}${t.name}`;
  const c = rule.condition;
  const cond =
    c.type === "podRestarts" ? `restarts >${c.threshold} in ${c.windowMinutes}m`
    : c.type === "crashLoop" ? "crash-looping"
    : c.type === "oomKilled" ? "OOM-killed"
    : c.type === "pendingTooLong" ? `pending >${c.minutes}m`
    : c.type === "notReady" ? `not ready ${c.minutes}m`
    : `degraded ${c.minutes}m`;
  return `${loc} — ${cond}`;
}
