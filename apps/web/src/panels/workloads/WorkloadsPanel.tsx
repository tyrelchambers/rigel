import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import type { ActionBlock } from "@/lib/api";
import type { StatefulSet, DaemonSet, Job, CronJob, WorkloadKind } from "./types";
import {
  relativeAge,
  readyFraction,
  readyColorClass,
  statefulSetReady,
  statefulSetDesired,
  daemonSetReady,
  daemonSetDesired,
  jobPhase,
  jobPhaseColorClass,
  jobDuration,
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

export default function WorkloadsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [activeKind, setActiveKind] = useState<WorkloadKind>("statefulsets");
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [scaleTarget, setScaleTarget] = useState<StatefulSet | null>(null);
  const [scaleValue, setScaleValue] = useState("1");

  // Subscribe to all four watches for the active namespace (or all). Four
  // subscribe calls on mount; four unsubscribe on unmount/namespace change.
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
    () =>
      sortWorkloads(
        Object.values((resources["statefulsets"] ?? {}) as Record<string, StatefulSet>),
      ),
    [resources],
  );
  const daemonSets = useMemo(
    () =>
      sortWorkloads(Object.values((resources["daemonsets"] ?? {}) as Record<string, DaemonSet>)),
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

  // --- Per-kind filtered lists --------------------------------------------
  const filteredStatefulSets = useMemo(
    () => statefulSets.filter((s) => matchesSearch(s.metadata.name, s.metadata.namespace, [], search)),
    [statefulSets, search],
  );
  const filteredDaemonSets = useMemo(
    () => daemonSets.filter((d) => matchesSearch(d.metadata.name, d.metadata.namespace, [], search)),
    [daemonSets, search],
  );
  const filteredJobs = useMemo(
    () =>
      jobs.filter((j) => matchesSearch(j.metadata.name, j.metadata.namespace, [jobPhase(j)], search)),
    [jobs, search],
  );
  const filteredCronJobs = useMemo(
    () =>
      cronJobs.filter((c) =>
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

  // --- Action builders (mirror docs/parity/workloads.md §4) ---------------

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
    // Generate the job name at click time so the confirm sheet shows the exact
    // name that will be created.
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
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Workloads</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
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
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Kind toggle bar */}
      <div className="flex items-center gap-1">
        {KINDS.map((k) => {
          const isActive = k === activeKind;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setActiveKind(k)}
              aria-pressed={isActive}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {PILL_LABEL[k]}
              <span
                className={`rounded-full px-1.5 text-[10px] font-mono ${
                  isActive ? "bg-primary-foreground/20" : "bg-background/60"
                }`}
              >
                {counts[k]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Tables (one per kind, mutually exclusive) */}
      {activeKind === "statefulsets" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Ready</TableHead>
              <TableHead>Age</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredStatefulSets.map((s) => {
              const ready = statefulSetReady(s);
              const desired = statefulSetDesired(s);
              return (
                <TableRow key={s.metadata.uid || `${s.metadata.namespace}/${s.metadata.name}`}>
                  <TableCell className="font-mono">{s.metadata.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {s.metadata.namespace ?? "default"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-mono ${readyColorClass(ready, desired)}`}
                    >
                      {readyFraction(ready, desired)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(s.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="StatefulSet actions" title="Actions" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => restartStatefulSet(s)}>Restart…</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openScale(s)}>Scale…</DropdownMenuItem>
                        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => deleteStatefulSet(s)}>
                          Delete StatefulSet
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {activeKind === "daemonsets" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Ready</TableHead>
              <TableHead>Age</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredDaemonSets.map((d) => {
              const ready = daemonSetReady(d);
              const desired = daemonSetDesired(d);
              return (
                <TableRow key={d.metadata.uid || `${d.metadata.namespace}/${d.metadata.name}`}>
                  <TableCell className="font-mono">{d.metadata.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {d.metadata.namespace ?? "default"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-mono ${readyColorClass(ready, desired)}`}
                    >
                      {readyFraction(ready, desired)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(d.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="DaemonSet actions" title="Actions" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => restartDaemonSet(d)}>Restart…</DropdownMenuItem>
                        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => deleteDaemonSet(d)}>
                          Delete DaemonSet
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {activeKind === "jobs" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Completions</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Age</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredJobs.map((j) => {
              const phase = jobPhase(j);
              const duration = jobDuration(j);
              return (
                <TableRow key={j.metadata.uid || `${j.metadata.namespace}/${j.metadata.name}`}>
                  <TableCell className="font-mono">{j.metadata.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {j.metadata.namespace ?? "default"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${jobPhaseColorClass(phase)}`}
                    >
                      {phase}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {jobCompletionsLabel(j)}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {duration ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(j.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="Job actions" title="Actions" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => deleteJob(j)}>
                          Delete Job
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {activeKind === "cronjobs" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Last Schedule</TableHead>
              <TableHead>Age</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredCronJobs.map((c) => {
              const suspended = isCronJobSuspended(c);
              const active = cronJobActiveCount(c);
              const lastSched = lastScheduleAgo(c);
              return (
                <TableRow key={c.metadata.uid || `${c.metadata.namespace}/${c.metadata.name}`}>
                  <TableCell className="font-mono">{c.metadata.name}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {c.metadata.namespace ?? "default"}
                  </TableCell>
                  <TableCell>
                    <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary">
                      {c.spec?.schedule ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {suspended && (
                        <span className="inline-block rounded-full bg-yellow-500/15 px-2 py-0.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
                          Suspended
                        </span>
                      )}
                      {active > 0 && (
                        <span className="font-mono text-xs text-muted-foreground">{active} active</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {lastSched ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {relativeAge(c.metadata.creationTimestamp)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="CronJob actions" title="Actions" />}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => triggerCronJob(c)}>Trigger now…</DropdownMenuItem>
                        {!suspended && (
                          <DropdownMenuItem onClick={() => suspendCronJob(c)}>Suspend…</DropdownMenuItem>
                        )}
                        {suspended && (
                          <DropdownMenuItem onClick={() => resumeCronJob(c)}>Resume…</DropdownMenuItem>
                        )}
                        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => deleteCronJob(c)}>
                          Delete CronJob
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Empty / filtered-to-zero states */}
      {!isLoading && totalForActive === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No {label} found</p>
      )}
      {!isLoading && totalForActive > 0 && filteredCount === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No {label} match search</p>
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
