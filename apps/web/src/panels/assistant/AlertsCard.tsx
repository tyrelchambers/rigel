// AlertsCard — alert rules list + New Alert dialog for the Rules tab.

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAssistantCtx } from "./AssistantContext";
import { Card, Field, inputClass } from "./components/primitives";
import { alertRuleSummary, type SuggestedAlert, type AlertTarget, type AlertCondition } from "@/lib/alerts";
import type { AlertScope } from "@helmsman/k8s";

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
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Alerts</p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          + New alert
        </Button>
      </div>

      {d.alertRules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No alerts yet. Click <strong>+ New alert</strong>, or ask in chat —{" "}
          <em>"text me if any pod in default restarts more than 3 times in 5 minutes"</em>.
        </p>
      ) : (
        <div className="space-y-2">
          {d.alertRules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-start justify-between gap-2 rounded-md border p-2 ${
                rule.enabled ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{rule.text}</span>
                <span className="text-sm text-muted-foreground">
                  {" "}
                  — {alertRuleSummary(rule)}
                </span>
                {!rule.enabled && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    disabled
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
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
                  variant="ghost"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New alert</DialogTitle>
            <DialogDescription>
              Get notified when a resource hits a condition. Or just ask in chat —{" "}
              <em>"text me if…"</em>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Field label="Watch">
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
              <Field label="Kind">
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
              <Field label="Namespace">
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
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={namePlaceholder}
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="When">
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
              <Field label="Threshold / window">
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
              <Field label="For (minutes)">
                <input
                  type="number"
                  min={0}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Number(e.target.value) || 0))}
                  className={inputClass}
                />
              </Field>
            )}

            <Field label="Cooldown (min)">
              <div className="flex flex-1 flex-col gap-0.5">
                <input
                  type="number"
                  min={0}
                  value={cooldown}
                  onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))}
                  className={inputClass}
                />
                <span className="text-xs text-muted-foreground">0 = default</span>
              </div>
            </Field>

            <Field label="Label">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={defaultLabel()}
                className={inputClass}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={working || !valid}>
              Create alert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
