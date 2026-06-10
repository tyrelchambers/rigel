import { useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  RefreshCw,
  MoveVertical,
  Trash2,
  Play,
  Pause,
  Zap,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import type { ActionBlock } from "@/lib/api";
import type { StatefulSet, DaemonSet, Job, CronJob, WorkloadKind } from "./types";
import {
  relativeAge,
  readyFraction,
  statefulSetReady,
  statefulSetDesired,
  daemonSetReady,
  daemonSetDesired,
  jobPhase,
  jobCompletionsLabel,
  lastScheduleAgo,
  cronJobActiveCount,
  isCronJobSuspended,
  generateTriggerJobName,
  matchesSearch,
  sortWorkloads,
  kindLabel,
} from "./workloadsDisplay";

const KINDS: WorkloadKind[] = ["statefulsets", "daemonsets", "jobs", "cronjobs"];

const PILL_LABEL: Record<WorkloadKind, string> = {
  statefulsets: "StatefulSets",
  daemonsets: "DaemonSets",
  jobs: "Jobs",
  cronjobs: "CronJobs",
};

/** Map job phase to StatusBadge variant. */
function jobPhaseVariant(phase: string): "healthy" | "error" | "pending" | "neutral" {
  switch (phase) {
    case "Complete":
    case "Running":
      return "healthy";
    case "Failed":
      return "error";
    default:
      return "pending";
  }
}

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

  function askClaude(kind: string, name: string, namespace: string | undefined, topic: "Errors" | "Logs" | "Explain") {
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
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid #1A1A1A", background: "#141417" }}
      >
        <div className="flex flex-col gap-0">
          <span className="text-sm font-semibold leading-tight">Workloads</span>
          <span style={{ fontSize: 11, color: "#6B6B73" }}>StatefulSets · DaemonSets · Jobs</span>
        </div>
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#6B6B73",
            background: "#1A1A1A",
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          {filteredCount}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${label}…`}
          className="ml-auto w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Kind toggle pills */}
      <div
        className="flex items-center gap-1 px-4 py-2"
        style={{ borderBottom: "1px solid #1A1A1A" }}
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
                background: isActive ? "#A855F7" : "#1A1A1A",
                color: isActive ? "#fff" : "#6B6B73",
                border: "1px solid",
                borderColor: isActive ? "#A855F7" : "#2A2A2A",
              }}
            >
              {PILL_LABEL[k]}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: isActive ? "rgba(255,255,255,0.7)" : "#6B6B73",
                  background: isActive ? "rgba(255,255,255,0.15)" : "#050505",
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
            const isOpen = expanded.has(k);
            const ready = statefulSetReady(s);
            const desired = statefulSetDesired(s);
            const allReady = ready === desired;

            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline"
                  style={{ color: allReady ? "#10B981" : "#EF4444" }}
                >
                  {s.metadata.name}
                </button>

                {/* Namespace chip */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    background: "#050505",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid #1A1A1A",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.metadata.namespace ?? "default"}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Age */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {relativeAge(s.metadata.creationTimestamp)}
                </span>

                {/* Ready badge */}
                <StatusBadge
                  label={readyFraction(ready, desired)}
                  variant={allReady ? "healthy" : "error"}
                  title={`Ready: ${ready}/${desired}`}
                />

                {/* Actions */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Explain"); }}
                  extra={[
                    {
                      label: "Restart",
                      Icon: RefreshCw,
                      onClick: (e) => { e.stopPropagation(); restartStatefulSet(s); },
                    },
                    {
                      label: "Scale",
                      Icon: MoveVertical,
                      onClick: (e) => { e.stopPropagation(); openScale(s); },
                    },
                    {
                      label: "Delete",
                      Icon: Trash2,
                      onClick: (e) => { e.stopPropagation(); deleteStatefulSet(s); },
                      destructive: true,
                    },
                  ]}
                />
              </ListRow>
            );
          })}

        {/* DaemonSets */}
        {activeKind === "daemonsets" &&
          filteredDaemonSets.map((d) => {
            const k = rowKey(d.metadata.name, d.metadata.namespace, d.metadata.uid);
            const isOpen = expanded.has(k);
            const ready = daemonSetReady(d);
            const desired = daemonSetDesired(d);
            const allReady = ready === desired;

            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline"
                  style={{ color: allReady ? "#10B981" : "#EF4444" }}
                >
                  {d.metadata.name}
                </button>

                {/* Namespace chip */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    background: "#050505",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid #1A1A1A",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.metadata.namespace ?? "default"}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Age */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {relativeAge(d.metadata.creationTimestamp)}
                </span>

                {/* Ready badge */}
                <StatusBadge
                  label={readyFraction(ready, desired)}
                  variant={allReady ? "healthy" : "error"}
                  title={`Ready: ${ready}/${desired}`}
                />

                {/* Actions */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Explain"); }}
                  extra={[
                    {
                      label: "Restart",
                      Icon: RefreshCw,
                      onClick: (e) => { e.stopPropagation(); restartDaemonSet(d); },
                    },
                    {
                      label: "Delete",
                      Icon: Trash2,
                      onClick: (e) => { e.stopPropagation(); deleteDaemonSet(d); },
                      destructive: true,
                    },
                  ]}
                />
              </ListRow>
            );
          })}

        {/* Jobs */}
        {activeKind === "jobs" &&
          filteredJobs.map((j) => {
            const k = rowKey(j.metadata.name, j.metadata.namespace, j.metadata.uid);
            const isOpen = expanded.has(k);
            const phase = jobPhase(j);

            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {j.metadata.name}
                </button>

                {/* Namespace chip */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    background: "#050505",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid #1A1A1A",
                    whiteSpace: "nowrap",
                  }}
                >
                  {j.metadata.namespace ?? "default"}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Age */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {relativeAge(j.metadata.creationTimestamp)}
                </span>

                {/* Completions */}
                <StatusBadge
                  label={jobCompletionsLabel(j)}
                  variant="neutral"
                  title={`Completions: ${jobCompletionsLabel(j)}`}
                />

                {/* Phase badge */}
                <StatusBadge
                  label={phase}
                  variant={jobPhaseVariant(phase)}
                />

                {/* Actions */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Explain"); }}
                  extra={[
                    {
                      label: "Delete",
                      Icon: Trash2,
                      onClick: (e) => { e.stopPropagation(); deleteJob(j); },
                      destructive: true,
                    },
                  ]}
                />
              </ListRow>
            );
          })}

        {/* CronJobs */}
        {activeKind === "cronjobs" &&
          filteredCronJobs.map((c) => {
            const k = rowKey(c.metadata.name, c.metadata.namespace, c.metadata.uid);
            const isOpen = expanded.has(k);
            const suspended = isCronJobSuspended(c);
            const active = cronJobActiveCount(c);
            const lastSched = lastScheduleAgo(c);

            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {c.metadata.name}
                </button>

                {/* Namespace chip */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "#6B6B73",
                    background: "#050505",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid #1A1A1A",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.metadata.namespace ?? "default"}
                </span>

                {/* Schedule — purple TagPill */}
                {c.spec?.schedule && <TagPill label={c.spec.schedule} title="Schedule" />}

                {/* Spacer */}
                <span className="flex-1" />

                {/* Last schedule */}
                {lastSched && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "#6B6B73",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                    title="Last scheduled"
                  >
                    {lastSched}
                  </span>
                )}

                {/* Active count */}
                {active > 0 && (
                  <StatusBadge
                    label={`${active} active`}
                    variant="healthy"
                    title={`${active} active job(s)`}
                  />
                )}

                {/* Suspended badge */}
                {suspended && (
                  <StatusBadge
                    label="Suspended"
                    variant="pending"
                  />
                )}

                {/* Actions */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Explain"); }}
                  extra={[
                    {
                      label: "Trigger",
                      Icon: Zap,
                      onClick: (e) => { e.stopPropagation(); triggerCronJob(c); },
                    },
                    ...(suspended
                      ? [
                          {
                            label: "Resume",
                            Icon: Play,
                            onClick: (e: React.MouseEvent) => { e.stopPropagation(); resumeCronJob(c); },
                          },
                        ]
                      : [
                          {
                            label: "Suspend",
                            Icon: Pause,
                            onClick: (e: React.MouseEvent) => { e.stopPropagation(); suspendCronJob(c); },
                          },
                        ]),
                    {
                      label: "Delete",
                      Icon: Trash2,
                      onClick: (e) => { e.stopPropagation(); deleteCronJob(c); },
                      destructive: true,
                    },
                  ]}
                />
              </ListRow>
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

      {/* Scale prompt (StatefulSet) */}
      <Dialog open={!!scaleTarget} onOpenChange={(o) => { if (!o) setScaleTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scale {scaleTarget?.metadata.name}</DialogTitle>
            <DialogDescription>Enter replica count (0–50).</DialogDescription>
          </DialogHeader>
          <input
            type="number"
            min={0}
            max={50}
            value={scaleValue}
            onChange={(e) => setScaleValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmScale(); }}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            aria-label="Replica count"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setScaleTarget(null)}>Cancel</Button>
            <Button onClick={confirmScale}>Scale to {scaleN}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}
