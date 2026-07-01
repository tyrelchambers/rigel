// AlertsCard — alert rules list + New Alert dialog for the Rules tab.
// Built to Pencil frame "Assistant — Rules (improved)" (Alerts card).

import { useMemo, useState } from "react";
import { Bell, CircleX, Cpu, Plus, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { handoffToChat } from "@/lib/chatHandoff";
import { useAssistantCtx } from "./AssistantContext";
import { Field, inputClass } from "./components/primitives";
import { alertRuleSummary, type SuggestedAlert, type AlertTarget, type AlertCondition } from "@/lib/alerts";
import type { AlertScope } from "@rigel/k8s";

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
  | "deploymentDegraded";

const COND_LABELS: Record<AlertCondType, string> = {
  podRestarts: "Restarts spike",
  crashLoop: "Crash-looping",
  oomKilled: "OOM-killed",
  pendingTooLong: "Stuck pending",
  notReady: "Not ready",
  deploymentDegraded: "Deployment degraded",
};

const DEGRADED_SCOPES: AlertScope[] = ["cluster", "namespace", "workload"];

export function AlertsCard() {
  const { d, ns, working, run } = useAssistantCtx();

  const [open, setOpen] = useState(false);
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

  const needsNamespace = scope !== "cluster";
  const needsName = scope === "workload" || scope === "pod" || scope === "database";
  const allowsDegraded = DEGRADED_SCOPES.includes(scope);

  function handleScopeChange(newScope: AlertScope) {
    setScope(newScope);
    if (condType === "deploymentDegraded" && !DEGRADED_SCOPES.includes(newScope)) {
      setCondType("crashLoop");
    }
  }

  function defaultLabel() {
    const verb: Record<AlertCondType, string> = {
      podRestarts: "restart spikes",
      crashLoop: "crash-looping",
      oomKilled: "OOM kills",
      pendingTooLong: "stuck pending",
      notReady: "not ready",
      deploymentDegraded: "degraded",
    };
    const subject =
      scope === "cluster" ? "cluster" : scope === "namespace" ? namespace : name || scope;
    return `${subject} ${verb[condType]}`;
  }

  const valid = useMemo(
    () =>
      (!needsNamespace || namespace.trim() !== "") &&
      (!needsName || name.trim() !== "") &&
      (condType !== "podRestarts" || (threshold > 0 && windowMinutes > 0)) &&
      (condType !== "pendingTooLong" || minutes >= 0) &&
      (condType !== "notReady" || minutes >= 0) &&
      (condType !== "deploymentDegraded" || minutes >= 0),
    [needsNamespace, needsName, namespace, name, condType, threshold, windowMinutes, minutes],
  );

  function create() {
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

    run({ action: "saveAlert", namespace: ns, alert }, () => {
      setOpen(false);
      setName("");
      setLabel("");
    });
  }

  const namePlaceholder =
    scope === "pod"
      ? "pod name"
      : scope === "database"
        ? "CNPG cluster name"
        : "deployment name";

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
          onClick={() => setOpen(true)}
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
                onClick={() => handoffToChat(s.prompt, { newThread: true })}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-[13px] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--fg-primary)]"
              >
                <s.icon className="size-3.5 text-[var(--accent-primary)]" />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {d.alertRules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-start justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 ${
                rule.enabled ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-[var(--fg-primary)]">{rule.text}</span>
                <span className="text-sm text-[var(--fg-tertiary)]"> {alertRuleSummary(rule)}</span>
                {!rule.enabled && (
                  <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-tertiary)]">
                    disabled
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="muted"
                  size="sm"
                  disabled={working}
                  onClick={() =>
                    run({
                      action: "toggleAlert",
                      namespace: ns,
                      alertId: rule.id,
                      alertEnabled: !rule.enabled,
                    })
                  }
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="muted"
                  size="sm"
                  disabled={working}
                  onClick={() =>
                    run({ action: "deleteAlert", namespace: ns, alertId: rule.id })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New alert dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New alert</DialogTitle>
            <DialogDescription>
              Get notified when a resource hits a condition. Or just ask in chat —{" "}
              <em>"text me if…"</em>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Field label="Watch" labelWidth="w-auto">
              <select
                value={scope}
                onChange={(e) => handleScopeChange(e.target.value as AlertScope)}
                className={inputClass}
              >
                <option value="cluster">Cluster</option>
                <option value="namespace">Namespace</option>
                <option value="workload">Workload</option>
                <option value="pod">Pod</option>
                <option value="database">Database</option>
              </select>
            </Field>

            {scope === "workload" && (
              <Field label="Kind" labelWidth="w-auto">
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as AlertKind)}
                  className={inputClass}
                >
                  <option value="Deployment">Deployment</option>
                  <option value="StatefulSet">StatefulSet</option>
                  <option value="DaemonSet">DaemonSet</option>
                </select>
              </Field>
            )}

            {needsNamespace && (
              <Field label="Namespace" labelWidth="w-auto">
                <select
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className={inputClass}
                >
                  {d.allNamespaceNames.length > 0 ? (
                    d.allNamespaceNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))
                  ) : (
                    <option value={namespace}>{namespace}</option>
                  )}
                </select>
              </Field>
            )}

            {needsName && (
              <Field label="Name" labelWidth="w-auto">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={namePlaceholder}
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="When" labelWidth="w-auto">
              <select
                value={condType}
                onChange={(e) => setCondType(e.target.value as AlertCondType)}
                className={inputClass}
              >
                {(Object.keys(COND_LABELS) as AlertCondType[])
                  .filter((c) => c !== "deploymentDegraded" || allowsDegraded)
                  .map((c) => (
                    <option key={c} value={c}>
                      {COND_LABELS[c]}
                    </option>
                  ))}
              </select>
            </Field>

            {condType === "podRestarts" && (
              <Field label="Threshold / window" labelWidth="w-auto">
                <div className="flex flex-1 items-center gap-2 text-sm">
                  <input
                    type="number"
                    min={1}
                    value={threshold}
                    onChange={(e) => setThreshold(Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-muted-foreground">times in</span>
                  <input
                    type="number"
                    min={1}
                    value={windowMinutes}
                    onChange={(e) =>
                      setWindowMinutes(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="w-16 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-muted-foreground">min</span>
                </div>
              </Field>
            )}

            {(condType === "pendingTooLong" ||
              condType === "notReady" ||
              condType === "deploymentDegraded") && (
              <Field label="For (minutes)" labelWidth="w-auto">
                <input
                  type="number"
                  min={0}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="Cooldown (min)" labelWidth="w-auto">
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={cooldown}
                  onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-xs text-muted-foreground">0 = default</span>
              </div>
            </Field>

            <Field label="Label" labelWidth="w-auto">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={defaultLabel()}
                className={inputClass}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="muted" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={working || !valid}>
              Create alert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
