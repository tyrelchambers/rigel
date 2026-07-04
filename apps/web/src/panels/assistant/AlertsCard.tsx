// AlertsCard — alert rules list + New Alert dialog for the Rules tab.
// Built to Pencil frame "Assistant — Rules (improved)" (Alerts card).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  BellPlus,
  BellRing,
  Box,
  ChevronDown,
  CircleAlert,
  CircleX,
  Clock,
  Cpu,
  Database,
  Flame,
  Globe,
  History,
  Pencil,
  Plus,
  Repeat,
  RotateCcw,
  Send,
  Server,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { handoffToChat } from "@/lib/chatHandoff";
import { useAssistantCtx } from "./AssistantContext";
import { relativeTime } from "./display";
import { fetchBackends } from "@/panels/rightsizing/useRightSizing";
import type { SuggestedAlert, AlertRule, AlertTarget, AlertCondition } from "@/lib/alerts";
import type { AlertScope } from "@rigel/k8s";

// Shared styling for the styled form controls in the New alert dialog — a
// surface-sunken box with a hairline border and accent focus (Pencil frame
// "New alert modal (improved)").
const controlClass =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-[11px] text-sm text-[var(--fg-primary)] outline-none transition-colors focus:border-[var(--accent-primary)]";

/** A vertical form field: label (with optional right adornment) above a control. */
function AlertField({
  label,
  right,
  className,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-[7px]", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-[var(--fg-secondary)]">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

/** Native select styled to match the design, with a custom chevron. */
function AlertSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        className={cn(controlClass, "cursor-pointer appearance-none pr-9")}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-[var(--fg-tertiary)]" />
    </div>
  );
}

/** Uppercase mono section caption (TARGET / CONDITION). */
function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10.5px] tracking-[0.08em] text-[var(--fg-tertiary)] uppercase">
      {children}
    </span>
  );
}

/** Severity pill shown on the "When" field. */
function SeverityChip({ critical }: { critical: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10.5px]",
        critical ? "bg-red-500/10 text-red-500" : "bg-amber-400/10 text-amber-400",
      )}
    >
      <span className={cn("size-1.5 rounded-full", critical ? "bg-red-500" : "bg-amber-400")} />
      {critical ? "critical" : "warning"}
    </span>
  );
}

const COND_VERBS: Record<AlertCondType, string> = {
  podRestarts: "restarting too often",
  crashLoop: "crash-looping",
  oomKilled: "OOM-killed",
  pendingTooLong: "stuck pending",
  notReady: "not ready",
  deploymentDegraded: "degraded",
  metricThreshold: "over its resource threshold",
};

/** Empty-state "Try" chips. Each hands its phrasing to a fresh chat thread — the
 *  agent turns the sentence into a saved alert rule (systemPrompt's ```alert
 *  block), which also covers conditions the structured form can't express yet
 *  (e.g. node memory). Mirrors the "just ask in chat" copy. */
const ALERT_SUGGESTIONS = [
  {
    icon: Repeat,
    label: "Pod restarts > 3× / 5 min",
    prompt: "Alert me when any pod restarts more than 3 times in 5 minutes.",
  },
  {
    icon: Cpu,
    label: "Node memory > 90%",
    prompt: "Alert me when a node's memory usage goes above 90%.",
    preset: "nodeMemory",
  },
  {
    icon: CircleX,
    label: "Any deployment fails",
    prompt: "Alert me when any deployment fails to roll out.",
  },
] as const;

type AlertKind = "Deployment" | "StatefulSet" | "DaemonSet";
type AlertCondType =
  | "podRestarts"
  | "crashLoop"
  | "oomKilled"
  | "pendingTooLong"
  | "notReady"
  | "deploymentDegraded"
  | "metricThreshold";

const COND_LABELS: Record<AlertCondType, string> = {
  podRestarts: "Restarts spike",
  crashLoop: "Crash-looping",
  oomKilled: "OOM-killed",
  pendingTooLong: "Stuck pending",
  notReady: "Not ready",
  deploymentDegraded: "Deployment degraded",
  metricThreshold: "Resource usage",
};

const DEGRADED_SCOPES: AlertScope[] = ["cluster", "namespace", "workload"];

// --- Alert row descriptors (Pencil frame "Alerts rows (improved)") ------------

type Severity = "critical" | "warning";

/** Icon + short badge + severity for a rule's condition, driving the row tile
 *  and the leading condition pill. */
function conditionMeta(c: AlertCondition): { Icon: LucideIcon; badge: string; sev: Severity } {
  switch (c.type) {
    case "oomKilled":
      return { Icon: Flame, badge: "OOMKilled", sev: "critical" };
    case "crashLoop":
      return { Icon: Repeat, badge: "CrashLoop", sev: "critical" };
    case "deploymentDegraded":
      return { Icon: CircleX, badge: "Degraded", sev: "critical" };
    case "podRestarts":
      return { Icon: RotateCcw, badge: "Restarts", sev: "warning" };
    case "pendingTooLong":
      return { Icon: Clock, badge: "Pending", sev: "warning" };
    case "notReady":
      return { Icon: CircleAlert, badge: "Not ready", sev: "warning" };
    case "metricThreshold": {
      const m = c.metric === "cpuPercent" ? "CPU" : "Mem";
      const op = c.comparator === "above" ? ">" : "<";
      return { Icon: Cpu, badge: `${m} ${op}${c.threshold}%`, sev: "warning" };
    }
  }
}

/** Icon + compact label for a rule's target scope (the second meta chip). */
function scopeMeta(t: AlertTarget): { Icon: LucideIcon; label: string } {
  switch (t.scope) {
    case "cluster":
      return { Icon: Globe, label: "cluster-wide" };
    case "namespace":
      return { Icon: Box, label: `namespace: ${t.namespace ?? "?"}` };
    case "workload":
      return { Icon: Box, label: `${t.kind ?? "workload"} ${t.name ?? ""}`.trim() };
    case "pod":
      return { Icon: Box, label: `pod ${t.name ?? ""}`.trim() };
    case "database":
      return { Icon: Database, label: `db ${t.name ?? ""}`.trim() };
    case "node":
      return { Icon: Server, label: t.name ? `node ${t.name}` : "all nodes" };
  }
}

/** Hairline meta chip: small icon + mono label (scope, channel). */
function MetaChip({ Icon, children }: { Icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px] rounded border border-[var(--border-subtle)] bg-white/[0.04] px-2 py-0.5">
      <Icon className="size-[11px] shrink-0 text-[var(--fg-tertiary)]" />
      <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{children}</span>
    </span>
  );
}

export function AlertsCard() {
  const { d, ns, working, run } = useAssistantCtx();

  const backendsQuery = useQuery({ queryKey: ["metrics-backends"], queryFn: fetchBackends });
  const hasBackend = (backendsQuery.data?.length ?? 0) > 0;

  const [open, setOpen] = useState(false);
  // Rule id being edited (dialog is in edit mode) or null for a fresh alert.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scope, setScope] = useState<AlertScope>("workload");
  const [namespace, setNamespace] = useState("default");
  const [kind, setKind] = useState<AlertKind>("Deployment");
  const [name, setName] = useState("");
  const [condType, setCondType] = useState<AlertCondType>("crashLoop");
  const [threshold, setThreshold] = useState(3);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [minutes, setMinutes] = useState(5);
  const [cooldown, setCooldown] = useState(0);
  const [label, setLabel] = useState("");
  const [metric, setMetric] = useState<"cpuPercent" | "memoryPercent">("memoryPercent");
  const [comparator, setComparator] = useState<"above" | "below">("above");
  const [metricPct, setMetricPct] = useState(90);
  const [nodeName, setNodeName] = useState(""); // "" = all nodes

  const needsNamespace = scope !== "cluster";
  const needsName = scope === "workload" || scope === "pod" || scope === "database";
  const allowsDegraded = DEGRADED_SCOPES.includes(scope);

  // Reset the form to defaults and open it for a brand-new alert.
  function startCreate() {
    setEditingId(null);
    setScope("workload");
    setNamespace("default");
    setKind("Deployment");
    setName("");
    setCondType("crashLoop");
    setThreshold(3);
    setWindowMinutes(60);
    setMinutes(5);
    setCooldown(0);
    setLabel("");
    setMetric("memoryPercent");
    setComparator("above");
    setMetricPct(90);
    setNodeName("");
    setOpen(true);
  }

  // Prefill the form from an existing rule and open it in edit mode. Saving
  // reuses the rule id (server replaces in place), preserving its fire history.
  function startEdit(rule: AlertRule) {
    const t = rule.target;
    const c = rule.condition;
    setEditingId(rule.id);
    setCondType(c.type);
    setScope(t.scope);
    setNamespace(t.namespace ?? "default");
    setKind(t.kind ?? "Deployment");
    setName(t.name ?? "");
    setCooldown(rule.cooldownMinutes);
    setLabel(rule.text);
    if (c.type === "podRestarts") {
      setThreshold(c.threshold);
      setWindowMinutes(c.windowMinutes);
    } else if (c.type === "pendingTooLong" || c.type === "notReady" || c.type === "deploymentDegraded") {
      setMinutes(c.minutes);
    } else if (c.type === "metricThreshold") {
      setMetric(c.metric);
      setComparator(c.comparator);
      setMetricPct(c.threshold);
      setMinutes(c.minutes);
      setNodeName(t.name ?? "");
    }
    setOpen(true);
  }

  function handleScopeChange(newScope: AlertScope) {
    setScope(newScope);
    if (condType === "deploymentDegraded" && !DEGRADED_SCOPES.includes(newScope)) {
      setCondType("crashLoop");
    }
  }

  function handleCondChange(next: AlertCondType) {
    setCondType(next);
    if (next === "metricThreshold") setScope("node");
    else if (scope === "node") setScope("workload");
  }

  function defaultLabel() {
    const verb: Record<AlertCondType, string> = {
      podRestarts: "restart spikes",
      crashLoop: "crash-looping",
      oomKilled: "OOM kills",
      pendingTooLong: "stuck pending",
      notReady: "not ready",
      deploymentDegraded: "degraded",
      metricThreshold: `${metric === "cpuPercent" ? "CPU" : "memory"} ${comparator} ${metricPct}%`,
    };
    if (condType === "metricThreshold") {
      return `${nodeName || "node"} ${verb.metricThreshold}`;
    }
    const subject =
      scope === "cluster" ? "cluster" : scope === "namespace" ? namespace : name || scope;
    return `${subject} ${verb[condType]}`;
  }

  const valid = useMemo(() => {
    if (condType === "metricThreshold") return metricPct > 0 && metricPct <= 100 && minutes >= 0;
    return (
      (!needsNamespace || namespace.trim() !== "") &&
      (!needsName || name.trim() !== "") &&
      (condType !== "podRestarts" || (threshold > 0 && windowMinutes > 0)) &&
      (condType !== "pendingTooLong" || minutes >= 0) &&
      (condType !== "notReady" || minutes >= 0) &&
      (condType !== "deploymentDegraded" || minutes >= 0)
    );
  }, [needsNamespace, needsName, namespace, name, condType, threshold, windowMinutes, minutes, metricPct]);

  // Persist the assembled alert. `editingId` (when set) reuses the rule id so the
  // server replaces in place; otherwise a fresh rule is created.
  function save(alert: SuggestedAlert) {
    run({ action: "saveAlert", namespace: ns, alert, ...(editingId ? { alertId: editingId } : {}) }, () => {
      setOpen(false);
      setName("");
      setLabel("");
      setEditingId(null);
    });
  }

  function create() {
    if (condType === "metricThreshold") {
      const target: AlertTarget = { scope: "node" };
      if (nodeName.trim()) target.name = nodeName.trim();
      const condition: AlertCondition = {
        type: "metricThreshold",
        metric,
        comparator,
        threshold: Number(metricPct),
        minutes: Number(minutes),
      };
      const text = label.trim() || defaultLabel();
      const alert: SuggestedAlert = {
        label: `Alert: ${text}`,
        text,
        target,
        condition,
        ...(cooldown > 0 ? { cooldownMinutes: Number(cooldown) } : {}),
      };
      save(alert);
      return;
    }

    const target: AlertTarget = { scope };
    if (needsNamespace) target.namespace = namespace.trim();
    if (needsName) target.name = name.trim();
    if (scope === "workload") target.kind = kind;

    let condition: AlertCondition;
    if (condType === "podRestarts") {
      condition = {
        type: "podRestarts",
        threshold: Number(threshold),
        windowMinutes: Number(windowMinutes),
      };
    } else if (
      condType === "pendingTooLong" ||
      condType === "notReady" ||
      condType === "deploymentDegraded"
    ) {
      condition = { type: condType, minutes: Number(minutes) };
    } else {
      condition = { type: condType };
    }

    const text = label.trim() || defaultLabel();
    const alert: SuggestedAlert = {
      label: `Alert: ${text}`,
      text,
      target,
      condition,
      ...(cooldown > 0 ? { cooldownMinutes: Number(cooldown) } : {}),
    };

    save(alert);
  }

  const namePlaceholder =
    scope === "pod"
      ? "pod name"
      : scope === "database"
        ? "CNPG cluster name"
        : "deployment name";

  // Live preview sentence + severity, mirroring the Pencil frame.
  const critical = condType === "crashLoop" || condType === "oomKilled";
  const subjectLabel =
    scope === "workload"
      ? kind
      : scope === "cluster"
        ? "cluster"
        : scope === "namespace"
          ? "resource"
          : scope;

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[22px]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-base font-semibold text-[var(--fg-primary)]">Alerts</p>
          <p className="text-[13px] text-[var(--fg-tertiary)]">
            Get notified when the cluster does something you care about.
          </p>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--accent-primary)] bg-[var(--accent-dim)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-primary)] transition-colors hover:border-[var(--accent-hover)] hover:text-[var(--accent-hover)]"
        >
          <Plus className="size-[15px]" />
          New alert
        </button>
      </div>

      {d.alertRules.length === 0 ? (
        <div className="mt-4 flex flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <div className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-white/5">
              <Bell className="size-[17px] text-[var(--fg-secondary)]" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-semibold text-[var(--fg-primary)]">No alerts yet</p>
              <p className="text-[13px] text-[var(--fg-secondary)]">
                Add one below, or just ask in chat and the agent will wire it up.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--fg-tertiary)]">
              Try
            </span>
            {ALERT_SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => {
                  if ("preset" in s && s.preset === "nodeMemory" && hasBackend) {
                    setEditingId(null);
                    handleCondChange("metricThreshold");
                    setMetric("memoryPercent");
                    setComparator("above");
                    setMetricPct(90);
                    setMinutes(10);
                    setNodeName("");
                    setOpen(true);
                  } else {
                    handoffToChat(s.prompt, { newThread: true });
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[13px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--fg-primary)]"
              >
                <s.icon className="size-3.5 text-[var(--accent-primary)]" />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {d.alertRules.map((rule) => {
            const { Icon, badge, sev } = conditionMeta(rule.condition);
            const scopeChip = scopeMeta(rule.target);
            const fired = d.alertLastFiredAt[rule.id];
            const hasWebhook = d.webhookURL.trim() !== "";
            const critical = sev === "critical";
            return (
              <div
                key={rule.id}
                className={cn(
                  "flex items-center gap-3.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-[13px]",
                  !rule.enabled && "opacity-[0.55]",
                )}
              >
                {/* Condition tile */}
                <div
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-[9px]",
                    critical ? "bg-red-500/10" : "bg-amber-400/10",
                  )}
                >
                  <Icon className={cn("size-[17px]", critical ? "text-red-500" : "text-amber-400")} />
                </div>

                {/* Title + meta */}
                <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
                  <p className="truncate text-[14.5px] font-semibold text-[var(--fg-primary)]">{rule.text}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-2 py-0.5 font-mono text-[11px] font-semibold",
                        critical ? "bg-red-500/10 text-red-500" : "bg-amber-400/10 text-amber-400",
                      )}
                    >
                      {badge}
                    </span>
                    <MetaChip Icon={scopeChip.Icon}>{scopeChip.label}</MetaChip>
                    {hasWebhook && <MetaChip Icon={Bell}>Webhook</MetaChip>}
                    <span className="inline-flex items-center gap-[5px]">
                      <History className="size-[11px] shrink-0 text-[var(--fg-tertiary)]" />
                      <span className="text-[11.5px] text-[var(--fg-tertiary)]">
                        {fired ? `${relativeTime(fired)} ago` : "never"}
                      </span>
                    </span>
                    {!rule.enabled && (
                      <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-[10.5px] tracking-[0.03em] text-[var(--fg-tertiary)]">
                        Disabled
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={rule.enabled ? "Disable alert" : "Enable alert"}
                    disabled={working}
                    onClick={() =>
                      run({
                        action: "toggleAlert",
                        namespace: ns,
                        alertId: rule.id,
                        alertEnabled: !rule.enabled,
                      })
                    }
                    className={cn(
                      "inline-flex h-[22px] w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      rule.enabled ? "bg-emerald-500" : "bg-white/10",
                    )}
                  >
                    <span
                      className={cn(
                        "size-[18px] rounded-full transition-transform",
                        rule.enabled ? "translate-x-[14px] bg-white" : "translate-x-0 bg-[var(--fg-tertiary)]",
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label="Edit alert"
                    disabled={working}
                    onClick={() => startEdit(rule)}
                    className="rounded-md p-[7px] text-[var(--fg-tertiary)] transition-colors hover:bg-white/[0.06] hover:text-[var(--fg-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Pencil className="size-[15px]" />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete alert"
                    disabled={working}
                    onClick={() => run({ action: "deleteAlert", namespace: ns, alertId: rule.id })}
                    className="rounded-md p-[7px] text-[var(--fg-tertiary)] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Trash2 className="size-[15px]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New alert dialog — Pencil frame "New alert modal (improved)" */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setEditingId(null);
        }}
      >
        <DialogContent className="max-w-[720px]">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-6 pt-[22px] pb-[18px]">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent-dim)]">
                <Bell className="size-[18px] text-[var(--accent-primary)]" />
              </div>
              <div className="flex flex-col gap-[3px]">
                <DialogTitle className="text-xl font-bold text-[var(--fg-primary)]">
                  {editingId ? "Edit alert" : "New alert"}
                </DialogTitle>
                <DialogDescription className="text-[13px] text-[var(--fg-tertiary)]">
                  Get notified when a resource hits a condition.
                </DialogDescription>
              </div>
            </div>
            <DialogClose className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-[var(--fg-secondary)] transition-colors hover:bg-white/[0.08]">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>

          {/* Body */}
          <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-6">
            {/* Chat hint */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                handoffToChat(
                  "Text me if a pod in default restarts more than 3 times in 5 minutes.",
                  { newThread: true },
                );
              }}
              className="flex w-full items-center gap-2.5 rounded-md border border-[var(--accent-primary)]/25 bg-[var(--accent-primary)]/[0.08] px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--accent-primary)]/[0.12]"
            >
              <Sparkles className="size-[15px] shrink-0 text-[var(--accent-primary)]" />
              <span className="text-[13px] text-[var(--fg-secondary)]">
                Prefer chat? Try{" "}
                <span className="text-[var(--accent-primary)] italic">
                  "text me if a pod in default restarts &gt; 3× in 5 min"
                </span>
              </span>
            </button>

            {/* Target */}
            <Caption>Target</Caption>
            <div className="flex flex-col gap-4">
              <div className="flex gap-4">
                <AlertField label="Watch" className="flex-1">
                  {condType === "metricThreshold" ? (
                    <AlertSelect value={nodeName} onChange={(e) => setNodeName(e.target.value)}>
                      <option value="">All nodes</option>
                      {d.allNodes.map((n) => (
                        <option key={n.name} value={n.hostname}>
                          {n.name}
                        </option>
                      ))}
                    </AlertSelect>
                  ) : (
                    <AlertSelect
                      value={scope}
                      onChange={(e) => handleScopeChange(e.target.value as AlertScope)}
                    >
                      <option value="cluster">Cluster</option>
                      <option value="namespace">Namespace</option>
                      <option value="workload">Workload</option>
                      <option value="pod">Pod</option>
                      <option value="database">Database</option>
                    </AlertSelect>
                  )}
                </AlertField>
                {scope === "workload" && (
                  <AlertField label="Kind" className="flex-1">
                    <AlertSelect value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
                      <option value="Deployment">Deployment</option>
                      <option value="StatefulSet">StatefulSet</option>
                      <option value="DaemonSet">DaemonSet</option>
                    </AlertSelect>
                  </AlertField>
                )}
              </div>

              {condType !== "metricThreshold" && (needsNamespace || needsName) && (
                <div className="flex gap-4">
                  {needsNamespace && (
                    <AlertField label="Namespace" className="flex-1">
                      <AlertSelect value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                        {d.allNamespaceNames.length > 0 ? (
                          d.allNamespaceNames.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))
                        ) : (
                          <option value={namespace}>{namespace}</option>
                        )}
                      </AlertSelect>
                    </AlertField>
                  )}
                  {needsName && (
                    <AlertField label="Name" className="flex-1">
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={namePlaceholder}
                        className={controlClass}
                      />
                    </AlertField>
                  )}
                </div>
              )}
            </div>

            {/* Condition */}
            <Caption>Condition</Caption>
            <div className="flex flex-col gap-4">
              <AlertField label="When" right={<SeverityChip critical={critical} />}>
                <AlertSelect
                  value={condType}
                  onChange={(e) => handleCondChange(e.target.value as AlertCondType)}
                >
                  {(Object.keys(COND_LABELS) as AlertCondType[])
                    .filter((c) => c !== "deploymentDegraded" || allowsDegraded)
                    .filter((c) => c !== "metricThreshold" || hasBackend)
                    .map((c) => (
                      <option key={c} value={c}>
                        {COND_LABELS[c]}
                      </option>
                    ))}
                </AlertSelect>
              </AlertField>

              {condType === "podRestarts" && (
                <AlertField label="Threshold / window">
                  <div className="flex items-center gap-2.5 text-sm text-[var(--fg-secondary)]">
                    <input
                      type="number"
                      min={1}
                      value={threshold}
                      onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
                      className={cn(controlClass, "w-20 font-mono")}
                    />
                    <span>times in</span>
                    <input
                      type="number"
                      min={1}
                      value={windowMinutes}
                      onChange={(e) => setWindowMinutes(Math.max(1, Number(e.target.value) || 1))}
                      className={cn(controlClass, "w-20 font-mono")}
                    />
                    <span>min</span>
                  </div>
                </AlertField>
              )}

              {(condType === "pendingTooLong" ||
                condType === "notReady" ||
                condType === "deploymentDegraded") && (
                <AlertField label="For (minutes)">
                  <input
                    type="number"
                    min={0}
                    value={minutes}
                    onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                    className={cn(controlClass, "font-mono")}
                  />
                </AlertField>
              )}

              {condType === "metricThreshold" && (
                <>
                  <AlertField label="Metric">
                    <AlertSelect
                      value={metric}
                      onChange={(e) => setMetric(e.target.value as "cpuPercent" | "memoryPercent")}
                    >
                      <option value="memoryPercent">Memory %</option>
                      <option value="cpuPercent">CPU %</option>
                    </AlertSelect>
                  </AlertField>
                  <AlertField label="Threshold">
                    <div className="flex items-center gap-2.5 text-sm text-[var(--fg-secondary)]">
                      <AlertSelect
                        value={comparator}
                        onChange={(e) => setComparator(e.target.value as "above" | "below")}
                      >
                        <option value="above">above</option>
                        <option value="below">below</option>
                      </AlertSelect>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={metricPct}
                        onChange={(e) =>
                          setMetricPct(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                        }
                        className={cn(controlClass, "w-20 font-mono")}
                      />
                      <span>%</span>
                    </div>
                  </AlertField>
                  <AlertField label="For (minutes)">
                    <input
                      type="number"
                      min={0}
                      value={minutes}
                      onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                      className={cn(controlClass, "font-mono")}
                    />
                  </AlertField>
                </>
              )}

              <div className="flex items-end gap-4">
                <AlertField label="Cooldown (min)">
                  <div className="flex items-center gap-2.5">
                    <div className="flex w-[120px] items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-[11px]">
                      <input
                        type="number"
                        min={0}
                        value={cooldown}
                        onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))}
                        className="w-full bg-transparent font-mono text-sm text-[var(--fg-primary)] outline-none [appearance:textfield]"
                      />
                      <span className="font-mono text-xs text-[var(--fg-tertiary)]">min</span>
                    </div>
                    <span className="text-[12.5px] whitespace-nowrap text-[var(--fg-tertiary)]">
                      0 = default
                    </span>
                  </div>
                </AlertField>
                <AlertField
                  label="Label"
                  className="flex-1"
                  right={
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-[var(--fg-tertiary)]">
                      <WandSparkles className="size-2.5" />
                      auto
                    </span>
                  }
                >
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={defaultLabel()}
                    className={controlClass}
                  />
                </AlertField>
              </div>
            </div>

            {/* Live preview */}
            <div className="flex items-center gap-2.5 rounded-md border border-[var(--accent-primary)]/30 bg-[var(--accent-primary)]/[0.08] px-3.5 py-3">
              <BellRing className="size-4 shrink-0 text-[var(--accent-primary)]" />
              <p className="text-[13px] leading-snug text-[var(--fg-secondary)]">
                Alert me when {scope === "cluster" ? "the " : "a "}
                <span className="font-semibold text-[var(--fg-primary)]">{subjectLabel}</span>
                {needsName && name.trim() !== "" ? (
                  <>
                    {" "}
                    named <span className="font-semibold text-[var(--fg-primary)]">{name}</span>
                  </>
                ) : null}
                {needsNamespace && scope !== "node" ? (
                  <>
                    {" "}
                    in <span className="font-semibold text-[var(--fg-primary)]">{namespace}</span>
                  </>
                ) : null}
                {" is "}
                <span className="font-semibold text-[var(--accent-primary)]">
                  {COND_VERBS[condType]}
                </span>
                .
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-6 pt-4 pb-5">
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--fg-tertiary)]">
              <Send className="size-[13px]" />
              Delivered to your notification channels.
            </div>
            <div className="flex items-center gap-2.5">
              <DialogClose className="rounded-md border border-[var(--border-strong)] px-5 py-[11px] text-sm font-semibold text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]">
                Cancel
              </DialogClose>
              <button
                type="button"
                onClick={create}
                disabled={working || !valid}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent-primary)] px-[22px] py-[11px] text-sm font-bold text-[var(--fg-inverse)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <BellPlus className="size-[15px]" />
                {editingId ? "Save changes" : "Create alert"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
