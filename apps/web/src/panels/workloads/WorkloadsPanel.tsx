import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { useFocusRow } from "@/panels/components/useFocusRow";
import type { ActionBlock } from "@/lib/api";
import type { StatefulSet, DaemonSet, Job, CronJob, WorkloadKind, WorkloadTopic } from "./types";
import {
  jobPhase,
  statefulSetDesired,
  generateTriggerJobName,
  matchesSearch,
  sortWorkloads,
  kindLabel,
} from "./workloadsDisplay";
import { StatefulSetRow } from "./StatefulSetRow";
import { DaemonSetRow } from "./DaemonSetRow";
import { JobRow } from "./JobRow";
import { CronJobRow } from "./CronJobRow";
import { WorkloadScaleDialog } from "./WorkloadScaleDialog";

const KINDS: WorkloadKind[] = ["statefulsets", "daemonsets", "jobs", "cronjobs"];

const PILL_LABEL: Record<WorkloadKind, string> = {
  statefulsets: "StatefulSets",
  daemonsets: "DaemonSets",
  jobs: "Jobs",
  cronjobs: "CronJobs",
};

export default function WorkloadsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [activeKind, setActiveKind] = useState<WorkloadKind>("statefulsets");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scaleTarget, setScaleTarget] = useState<StatefulSet | null>(null);
  const [scaleValue, setScaleValue] = useState("1");

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("statefulsets", ns);
    subscribe("daemonsets", ns);
    subscribe("jobs", ns);
    subscribe("cronjobs", ns);
    return () => {
      unsubscribe("statefulsets", ns);
      unsubscribe("daemonsets", ns);
      unsubscribe("jobs", ns);
      unsubscribe("cronjobs", ns);
    };
  }, [namespaceFilter]);

  const statefulSets = useMemo(
    () => sortWorkloads(Object.values((resources["statefulsets"] ?? {}) as Record<string, StatefulSet>)),
    [resources],
  );
  const daemonSets = useMemo(
    () => sortWorkloads(Object.values((resources["daemonsets"] ?? {}) as Record<string, DaemonSet>)),
    [resources],
  );
  const jobs = useMemo(
    () => sortWorkloads(Object.values((resources["jobs"] ?? {}) as Record<string, Job>)),
    [resources],
  );
  const cronJobs = useMemo(
    () => sortWorkloads(Object.values((resources["cronjobs"] ?? {}) as Record<string, CronJob>)),
    [resources],
  );

  const counts: Record<WorkloadKind, number> = {
    statefulsets: statefulSets.length,
    daemonsets: daemonSets.length,
    jobs: jobs.length,
    cronjobs: cronJobs.length,
  };

  useFocusRow("statefulset", statefulSets, (s) => rowKey(s.metadata.name, s.metadata.namespace, s.metadata.uid), (k) => setExpanded((prev) => new Set(prev).add(k)));
  useFocusRow("daemonset", daemonSets, (d) => rowKey(d.metadata.name, d.metadata.namespace, d.metadata.uid), (k) => setExpanded((prev) => new Set(prev).add(k)));

  const filteredStatefulSets = useMemo(
    () => statefulSets.filter((s) => matchesSearch(s.metadata.name, s.metadata.namespace, [], search)),
    [statefulSets, search],
  );
  const filteredDaemonSets = useMemo(
    () => daemonSets.filter((d) => matchesSearch(d.metadata.name, d.metadata.namespace, [], search)),
    [daemonSets, search],
  );
  const filteredJobs = useMemo(
    () => jobs.filter((j) => matchesSearch(j.metadata.name, j.metadata.namespace, [jobPhase(j)], search)),
    [jobs, search],
  );
  const filteredCronJobs = useMemo(
    () => cronJobs.filter((c) =>
      matchesSearch(c.metadata.name, c.metadata.namespace, [c.spec?.schedule], search),
    ),
    [cronJobs, search],
  );

  const totalForActive = counts[activeKind];
  const filteredCount =
    activeKind === "statefulsets"
      ? filteredStatefulSets.length
      : activeKind === "daemonsets"
        ? filteredDaemonSets.length
        : activeKind === "jobs"
          ? filteredJobs.length
          : filteredCronJobs.length;

  // --- Expand/collapse -------------------------------------------------------

  function rowKey(name: string, namespace?: string, uid?: string): string {
    return uid || `${namespace ?? ""}/${name}`;
  }

  function toggleExpand(k: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Chat handoff ----------------------------------------------------------

  function askClaude(kind: string, name: string, namespace: string | undefined, topic: WorkloadTopic) {
    handoffToChat(buildHandoffPrompt(kind, name, namespace, topic));
  }

  // --- Action builders (mirror docs/parity/workloads.md §4) -----------------

  function restartStatefulSet(s: StatefulSet) {
    setPendingAction({
      kind: "restart",
      name: s.metadata.name,
      namespace: s.metadata.namespace ?? "default",
      resourceKind: "statefulset",
      label: `Restart statefulset ${s.metadata.name}`,
    });
  }

  function deleteStatefulSet(s: StatefulSet) {
    setPendingAction({
      kind: "deleteWorkload",
      name: s.metadata.name,
      namespace: s.metadata.namespace ?? "default",
      resourceKind: "statefulset",
      destructive: true,
      label: `Delete statefulset ${s.metadata.name}`,
    });
  }

  function openScale(s: StatefulSet) {
    setScaleValue(String(statefulSetDesired(s)));
    setScaleTarget(s);
  }

  function confirmScale() {
    if (!scaleTarget) return;
    const n = Math.max(0, Math.min(50, Math.floor(Number(scaleValue) || 0)));
    setPendingAction({
      kind: "scale",
      name: scaleTarget.metadata.name,
      namespace: scaleTarget.metadata.namespace ?? "default",
      resourceKind: "statefulset",
      replicas: n,
      label: `Scale ${scaleTarget.metadata.name} to ${n} replicas`,
    });
    setScaleTarget(null);
  }

  function restartDaemonSet(d: DaemonSet) {
    setPendingAction({
      kind: "restart",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      resourceKind: "daemonset",
      label: `Restart daemonset ${d.metadata.name}`,
    });
  }

  function deleteDaemonSet(d: DaemonSet) {
    setPendingAction({
      kind: "deleteWorkload",
      name: d.metadata.name,
      namespace: d.metadata.namespace ?? "default",
      resourceKind: "daemonset",
      destructive: true,
      label: `Delete daemonset ${d.metadata.name}`,
    });
  }

  function deleteJob(j: Job) {
    setPendingAction({
      kind: "deleteWorkload",
      name: j.metadata.name,
      namespace: j.metadata.namespace ?? "default",
      resourceKind: "job",
      destructive: true,
      label: `Delete job ${j.metadata.name}`,
    });
  }

  function triggerCronJob(c: CronJob) {
    const jobName = generateTriggerJobName(c.metadata.name);
    setPendingAction({
      kind: "triggerCronJob",
      name: c.metadata.name,
      namespace: c.metadata.namespace ?? "default",
      pod: jobName,
      label: `Trigger ${c.metadata.name}`,
    });
  }

  function suspendCronJob(c: CronJob) {
    setPendingAction({
      kind: "suspendCronJob",
      name: c.metadata.name,
      namespace: c.metadata.namespace ?? "default",
      label: `Suspend cronjob ${c.metadata.name}`,
    });
  }

  function resumeCronJob(c: CronJob) {
    setPendingAction({
      kind: "resumeCronJob",
      name: c.metadata.name,
      namespace: c.metadata.namespace ?? "default",
      label: `Resume cronjob ${c.metadata.name}`,
    });
  }

  function deleteCronJob(c: CronJob) {
    setPendingAction({
      kind: "deleteWorkload",
      name: c.metadata.name,
      namespace: c.metadata.namespace ?? "default",
      resourceKind: "cronjob",
      destructive: true,
      label: `Delete cronjob ${c.metadata.name}`,
    });
  }

  const scaleN = Math.max(0, Math.min(50, Math.floor(Number(scaleValue) || 0)));
  const label = kindLabel(activeKind);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Workloads"
        subtitle="StatefulSets · DaemonSets · Jobs"
        count={filteredCount}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${label}…`}
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Kind toggle pills */}
      <div
        className="flex items-center gap-1 px-4 py-2"
        style={{ borderBottom: "1px solid #26272B" }}
      >
        {KINDS.map((k) => {
          const isActive = k === activeKind;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setActiveKind(k)}
              aria-pressed={isActive}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: isActive ? "var(--accent-primary)" : "var(--border-subtle)",
                color: isActive ? "var(--fg-inverse)" : "var(--fg-tertiary)",
                border: "1px solid",
                borderColor: isActive ? "var(--accent-primary)" : "var(--border-strong)",
              }}
            >
              {PILL_LABEL[k]}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: isActive ? "rgba(10,10,10,0.7)" : "var(--fg-tertiary)",
                  background: isActive ? "rgba(255,255,255,0.15)" : "var(--surface-sunken)",
                  padding: "0 4px",
                  borderRadius: 3,
                }}
              >
                {counts[k]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Row lists — one per kind, mutually exclusive */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {/* StatefulSets */}
        {activeKind === "statefulsets" &&
          filteredStatefulSets.map((s) => {
            const k = rowKey(s.metadata.name, s.metadata.namespace, s.metadata.uid);
            return (
              <StatefulSetRow
                key={k}
                s={s}
                k={k}
                isOpen={expanded.has(k)}
                toggleExpand={toggleExpand}
                askClaude={askClaude}
                restartStatefulSet={restartStatefulSet}
                openScale={openScale}
                deleteStatefulSet={deleteStatefulSet}
              />
            );
          })}

        {/* DaemonSets */}
        {activeKind === "daemonsets" &&
          filteredDaemonSets.map((d) => {
            const k = rowKey(d.metadata.name, d.metadata.namespace, d.metadata.uid);
            return (
              <DaemonSetRow
                key={k}
                d={d}
                k={k}
                isOpen={expanded.has(k)}
                toggleExpand={toggleExpand}
                askClaude={askClaude}
                restartDaemonSet={restartDaemonSet}
                deleteDaemonSet={deleteDaemonSet}
              />
            );
          })}

        {/* Jobs */}
        {activeKind === "jobs" &&
          filteredJobs.map((j) => {
            const k = rowKey(j.metadata.name, j.metadata.namespace, j.metadata.uid);
            return (
              <JobRow
                key={k}
                j={j}
                k={k}
                isOpen={expanded.has(k)}
                toggleExpand={toggleExpand}
                askClaude={askClaude}
                deleteJob={deleteJob}
              />
            );
          })}

        {/* CronJobs */}
        {activeKind === "cronjobs" &&
          filteredCronJobs.map((c) => {
            const k = rowKey(c.metadata.name, c.metadata.namespace, c.metadata.uid);
            return (
              <CronJobRow
                key={k}
                c={c}
                k={k}
                isOpen={expanded.has(k)}
                toggleExpand={toggleExpand}
                askClaude={askClaude}
                triggerCronJob={triggerCronJob}
                suspendCronJob={suspendCronJob}
                resumeCronJob={resumeCronJob}
                deleteCronJob={deleteCronJob}
              />
            );
          })}
      </div>

      {/* Empty / filtered-to-zero states */}
      {!isLoading && totalForActive === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No {label} found</p>
      )}
      {!isLoading && totalForActive > 0 && filteredCount === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No {label} match search</p>
      )}
      </div>

      {/* Scale prompt (StatefulSet) */}
      <WorkloadScaleDialog
        target={scaleTarget}
        value={scaleValue}
        onValueChange={setScaleValue}
        onConfirm={confirmScale}
        onClose={() => setScaleTarget(null)}
        scaleN={scaleN}
      />

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
