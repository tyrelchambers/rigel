import { differenceInMinutes, parseISO } from "date-fns";
import type { Issue, IssueFix, IssueInput, IssueSubject, RawObject } from "../types";
import { subjectKey } from "../types";

const RESTART_STORM_THRESHOLD = 10;

const INIT_STUCK_MINUTES = 15;

const CRASH_LOOP_REASON = "CrashLoopBackOff";

const IMAGE_PULL_REASONS = new Set(["ImagePullBackOff", "ErrImagePull"]);

const OOM_KILLED_REASON = "OOMKilled";

const INIT_FAILURE_REASONS = new Set([CRASH_LOOP_REASON, ...IMAGE_PULL_REASONS]);

const SIDECAR_RESTART_POLICY = "Always";

const APP_CONTAINER_NOUN = "Container";

const INIT_CONTAINER_NOUN = "Init container";

const ROLLOUT_IN_FLIGHT_REASON = "ReplicaSetUpdated";

const PRESSURE_CAUSES: Record<string, string> = {
  MemoryPressure: "Node under memory pressure",
  DiskPressure: "Node under disk pressure",
  PIDPressure: "Node under process ID pressure",
};

type PodRule = (pod: RawObject, input: IssueInput, now: Date) => Issue | undefined;

interface ContainerEntry {
  status: RawObject;
  init: boolean;
}

function subjectOf(kind: string, o: RawObject): IssueSubject {
  return {
    kind,
    namespace: typeof o.metadata?.namespace === "string" ? o.metadata.namespace : "",
    name: typeof o.metadata?.name === "string" ? o.metadata.name : "",
  };
}

function conditionOf(o: RawObject, type: string): RawObject | undefined {
  const conditions = o.status?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  return (conditions as RawObject[]).find((c) => c?.type === type);
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function containerStatuses(pod: RawObject): RawObject[] {
  const statuses = pod.status?.containerStatuses;
  return Array.isArray(statuses) ? (statuses as RawObject[]) : [];
}

function initContainerStatuses(pod: RawObject): RawObject[] {
  const statuses = pod.status?.initContainerStatuses;
  return Array.isArray(statuses) ? (statuses as RawObject[]) : [];
}

function allContainers(pod: RawObject): ContainerEntry[] {
  return [
    ...containerStatuses(pod).map((status) => ({ status, init: false })),
    ...initContainerStatuses(pod).map((status) => ({ status, init: true })),
  ];
}

function containerNoun(init: boolean): string {
  return init ? INIT_CONTAINER_NOUN : APP_CONTAINER_NOUN;
}

function containerLabel(entry: ContainerEntry, subject: IssueSubject): string {
  return `${containerNoun(entry.init)} "${entry.status.name}" in pod ${subject.namespace}/${subject.name}`;
}

function podStartTime(pod: RawObject): string | undefined {
  return textOf(pod.status?.startTime);
}

function isNativeSidecar(pod: RawObject, name: unknown): boolean {
  const specs = pod.spec?.initContainers;
  if (!Array.isArray(specs)) return false;
  const spec = (specs as RawObject[]).find((c) => c?.name === name);
  return spec?.restartPolicy === SIDECAR_RESTART_POLICY;
}

function restartRolloutFix(kind: string, name: string, namespace: string): IssueFix {
  return {
    label: "Restart rollout",
    destructive: false,
    command: ["rollout", "restart", `${kind}/${name}`, "-n", namespace],
  };
}

function deleteFix(label: string, kind: string, name: string, namespace: string): IssueFix {
  return { label, destructive: true, command: ["delete", kind, name, "-n", namespace] };
}

function deploymentOwner(pod: RawObject, input: IssueInput): string | undefined {
  const owners = pod.metadata?.ownerReferences;
  if (!Array.isArray(owners)) return undefined;
  const namespace = subjectOf("Pod", pod).namespace;
  const deployments = input.deployments ?? [];
  for (const owner of owners as RawObject[]) {
    const ownerName = textOf(owner?.name);
    if (!ownerName) continue;
    if (owner.kind === "Deployment") {
      if (deployments.some((d) => subjectKey(subjectOf("Deployment", d)) === `${namespace}/${ownerName}`)) {
        return ownerName;
      }
      continue;
    }
    if (owner.kind !== "ReplicaSet") continue;
    const cut = ownerName.lastIndexOf("-");
    if (cut <= 0) continue;
    const base = ownerName.slice(0, cut);
    if (deployments.some((d) => subjectKey(subjectOf("Deployment", d)) === `${namespace}/${base}`)) {
      return base;
    }
  }
  return undefined;
}

function crashLoopBackOff(pod: RawObject, input: IssueInput): Issue | undefined {
  const entry = allContainers(pod).find(
    (c) => c.status.state?.waiting?.reason === CRASH_LOOP_REASON,
  );
  if (!entry) return undefined;
  const subject = subjectOf("Pod", pod);
  const deployment = deploymentOwner(pod, input);
  return {
    fingerprint: "",
    rule: "crashLoopBackOff",
    title: "Crash loop",
    category: "runtime",
    severity: "critical",
    subject,
    cause: `${containerNoun(entry.init)} is restarting in a crash loop`,
    whatsWrong: `${containerLabel(entry, subject)} keeps exiting, so Kubernetes is backing off before each restart.`,
    nextStep: entry.init
      ? "Read the init container logs for the exit reason and fix the dependency or command it runs before the pod can start."
      : "Read the container logs for the exit reason and fix the crash before restarting the workload.",
    evidence: textOf(entry.status.state?.waiting?.message),
    onsetAt: podStartTime(pod),
    related: [],
    fix: deployment ? restartRolloutFix("deployment", deployment, subject.namespace) : undefined,
    source: "cluster",
  };
}

function imagePullBackOff(pod: RawObject): Issue | undefined {
  const entry = allContainers(pod).find((c) =>
    IMAGE_PULL_REASONS.has(c.status.state?.waiting?.reason),
  );
  if (!entry) return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "imagePullBackOff",
    title: "Image pull failing",
    category: "runtime",
    severity: "critical",
    subject,
    cause: `${containerNoun(entry.init)} image cannot be pulled`,
    whatsWrong: `${containerLabel(entry, subject)} cannot pull its image, so the pod never starts.`,
    nextStep: entry.init
      ? "Confirm the init container image name and tag exist and that the pull secret grants access to the registry."
      : "Confirm the image name and tag exist and that the pull secret grants access to the registry.",
    evidence: textOf(entry.status.state?.waiting?.message),
    onsetAt: podStartTime(pod),
    related: [],
    source: "cluster",
  };
}

function oomKilled(pod: RawObject): Issue | undefined {
  const entry = allContainers(pod).find(
    (c) =>
      c.status.lastState?.terminated?.reason === OOM_KILLED_REASON ||
      c.status.state?.terminated?.reason === OOM_KILLED_REASON,
  );
  if (!entry) return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "oomKilled",
    title: "Out of memory",
    category: "runtime",
    severity: "critical",
    subject,
    cause: `${containerNoun(entry.init)} killed for exceeding its memory limit`,
    whatsWrong: `${containerLabel(entry, subject)} was killed for using more memory than its limit allows.`,
    nextStep: entry.init
      ? "Raise the init container memory limit or reduce how much memory its startup work holds."
      : "Raise the container memory limit or reduce how much memory the workload holds.",
    evidence: OOM_KILLED_REASON,
    onsetAt: podStartTime(pod),
    related: [],
    source: "cluster",
  };
}

function initContainerStuck(pod: RawObject, _input: IssueInput, now: Date): Issue | undefined {
  if (pod.status?.phase !== "Pending") return undefined;
  const startTime = podStartTime(pod);
  const stalled = initContainerStatuses(pod).filter((cs) => {
    if (cs.ready !== false) return false;
    if (isNativeSidecar(pod, cs.name)) return false;
    if (cs.state?.running) return true;
    const waiting = textOf(cs.state?.waiting?.reason);
    return waiting !== undefined && !INIT_FAILURE_REASONS.has(waiting);
  });
  for (const status of stalled) {
    const onsetAt = textOf(status.state?.running?.startedAt) ?? startTime;
    if (!onsetAt) continue;
    const initializingMinutes = differenceInMinutes(now, parseISO(onsetAt));
    if (Number.isNaN(initializingMinutes) || initializingMinutes <= INIT_STUCK_MINUTES) continue;
    const subject = subjectOf("Pod", pod);
    return {
      fingerprint: "",
      rule: "initContainerStuck",
      title: "Init container not finishing",
      category: "runtime",
      severity: "warning",
      subject,
      cause: "Init container has not finished",
      whatsWrong: `${containerLabel({ status, init: true }, subject)} has not finished after more than ${INIT_STUCK_MINUTES} minutes, so none of the pod's own containers have started yet.`,
      nextStep: "Find what this init container waits for and bring that dependency back, since the pod stays Pending until it answers.",
      onsetAt,
      related: [],
      source: "cluster",
    };
  }
  return undefined;
}

function podUnschedulable(pod: RawObject): Issue | undefined {
  const condition = conditionOf(pod, "PodScheduled");
  if (condition?.status !== "False" || condition?.reason !== "Unschedulable") return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "podUnschedulable",
    title: "Pod cannot be scheduled",
    category: "scheduling",
    severity: "critical",
    subject,
    cause: "No node satisfies the pod's scheduling requirements",
    whatsWrong: `Pod ${subject.namespace}/${subject.name} cannot be placed because no node satisfies its resource requests and placement rules.`,
    nextStep: "Free capacity on a node or relax the pod's requests, node selector and tolerations.",
    evidence: textOf(condition.message),
    onsetAt: textOf(condition.lastTransitionTime) ?? podStartTime(pod),
    related: [],
    source: "cluster",
  };
}

function podEvicted(pod: RawObject): Issue | undefined {
  if (pod.status?.phase !== "Failed" || pod.status?.reason !== "Evicted") return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "podEvicted",
    title: "Pod evicted",
    category: "scheduling",
    severity: "warning",
    subject,
    cause: "Pod evicted from its node",
    whatsWrong: `Pod ${subject.namespace}/${subject.name} was evicted from its node and is no longer running.`,
    nextStep: "Delete the evicted pod and relieve the node resource pressure that caused the eviction.",
    evidence: textOf(pod.status?.message),
    onsetAt: podStartTime(pod),
    related: [],
    fix: deleteFix("Delete pod", "pod", subject.name, subject.namespace),
    source: "cluster",
  };
}

function podFailed(pod: RawObject): Issue | undefined {
  if (pod.status?.phase !== "Failed") return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "podFailed",
    title: "Pod failed",
    category: "runtime",
    severity: "warning",
    subject,
    cause: "Pod ended in the Failed phase",
    whatsWrong: `Pod ${subject.namespace}/${subject.name} ended in the Failed phase and will not run again.`,
    nextStep: "Inspect the pod's termination reason, then delete the pod once you have what you need.",
    evidence: textOf(pod.status?.message),
    onsetAt: podStartTime(pod),
    related: [],
    fix: deleteFix("Delete pod", "pod", subject.name, subject.namespace),
    source: "cluster",
  };
}

function restartStorm(pod: RawObject): Issue | undefined {
  if (pod.status?.phase !== "Running") return undefined;
  const restarts = containerStatuses(pod).reduce(
    (total, cs) => total + (typeof cs.restartCount === "number" ? cs.restartCount : 0),
    0,
  );
  if (restarts <= RESTART_STORM_THRESHOLD) return undefined;
  const subject = subjectOf("Pod", pod);
  return {
    fingerprint: "",
    rule: "restartStorm",
    title: "Restart storm",
    category: "runtime",
    severity: "warning",
    subject,
    cause: "Containers restarting repeatedly",
    whatsWrong: `Pod ${subject.namespace}/${subject.name} has restarted ${restarts} times, so a container keeps ending and being replaced.`,
    nextStep: "Read the container logs and exit codes to find what keeps ending the process.",
    onsetAt: podStartTime(pod),
    related: [],
    source: "cluster",
  };
}

const POD_RULES: PodRule[] = [
  crashLoopBackOff,
  imagePullBackOff,
  oomKilled,
  podUnschedulable,
  initContainerStuck,
  podEvicted,
  podFailed,
  restartStorm,
];

function podIssues(input: IssueInput, now: Date): Issue[] {
  const issues: Issue[] = [];
  const alreadyFlagged = new Set<string>();
  for (const rule of POD_RULES) {
    for (const pod of input.pods ?? []) {
      const key = subjectKey(subjectOf("Pod", pod));
      if (alreadyFlagged.has(key)) continue;
      const issue = rule(pod, input, now);
      if (!issue) continue;
      alreadyFlagged.add(key);
      issues.push(issue);
    }
  }
  return issues;
}

function degradedReplicaSetIssue(
  o: RawObject,
  kind: "Deployment" | "StatefulSet",
): Issue | undefined {
  const desired = o.spec?.replicas;
  if (typeof desired !== "number" || desired <= 0) return undefined;
  const ready = typeof o.status?.readyReplicas === "number" ? o.status.readyReplicas : 0;
  if (ready >= desired) return undefined;
  if (kind === "Deployment") {
    const progressing = conditionOf(o, "Progressing");
    if (progressing?.status === "True" && progressing.reason === ROLLOUT_IN_FLIGHT_REASON) {
      return undefined;
    }
  } else {
    const currentRevision = textOf(o.status?.currentRevision);
    const updateRevision = textOf(o.status?.updateRevision);
    if (currentRevision && updateRevision && currentRevision !== updateRevision) {
      return undefined;
    }
  }
  const subject = subjectOf(kind, o);
  const available = conditionOf(o, "Available");
  const unavailable = available?.status === "False" ? available : undefined;
  const resource = kind.toLowerCase();
  return {
    fingerprint: "",
    rule: kind === "Deployment" ? "degradedDeployment" : "degradedStatefulSet",
    title: `${kind} degraded`,
    category: "runtime",
    severity: "critical",
    subject,
    cause: "Fewer replicas ready than desired",
    whatsWrong: `${kind} ${subject.namespace}/${subject.name} has ${ready} of ${desired} replicas ready, so it is serving with reduced capacity.`,
    nextStep: "Check the pods behind this workload for the reason they are not becoming ready.",
    evidence: unavailable ? textOf(unavailable.message) : undefined,
    onsetAt: unavailable ? textOf(unavailable.lastTransitionTime) : undefined,
    related: [],
    fix: restartRolloutFix(resource, subject.name, subject.namespace),
    source: "cluster",
  };
}

function zeroReplicas(o: RawObject): Issue | undefined {
  if (o.spec?.replicas !== 0) return undefined;
  const subject = subjectOf("Deployment", o);
  return {
    fingerprint: "",
    rule: "zeroReplicas",
    title: "Scaled to zero",
    category: "runtime",
    severity: "warning",
    subject,
    cause: "Deployment scaled to zero replicas",
    whatsWrong: `Deployment ${subject.namespace}/${subject.name} is scaled to zero replicas, so nothing is serving it.`,
    nextStep: "Scale the deployment back up if it is meant to be running.",
    related: [],
    fix: {
      label: "Scale to 1",
      destructive: false,
      command: ["scale", `deployment/${subject.name}`, "--replicas=1", "-n", subject.namespace],
    },
    source: "cluster",
  };
}

function degradedDaemonSet(o: RawObject): Issue | undefined {
  const unavailable = o.status?.numberUnavailable;
  if (typeof unavailable !== "number" || unavailable <= 0) return undefined;
  const subject = subjectOf("DaemonSet", o);
  return {
    fingerprint: "",
    rule: "degradedDaemonSet",
    title: "DaemonSet degraded",
    category: "runtime",
    severity: "warning",
    subject,
    cause: "DaemonSet pods unavailable",
    whatsWrong: `DaemonSet ${subject.namespace}/${subject.name} has ${unavailable} pods unavailable, so some nodes are not running it.`,
    nextStep: "Check the daemon set pods on the affected nodes for why they are not ready.",
    related: [],
    fix: restartRolloutFix("daemonset", subject.name, subject.namespace),
    source: "cluster",
  };
}

function jobBackoffLimitExceeded(o: RawObject): Issue | undefined {
  const failed = conditionOf(o, "Failed");
  if (failed?.reason !== "BackoffLimitExceeded") return undefined;
  const subject = subjectOf("Job", o);
  return {
    fingerprint: "",
    rule: "jobBackoffLimitExceeded",
    title: "Job failed",
    category: "runtime",
    severity: "warning",
    subject,
    cause: "Job exceeded its backoff limit",
    whatsWrong: `Job ${subject.namespace}/${subject.name} gave up after its pods failed more times than the backoff limit allows.`,
    nextStep: "Fix what makes the job's pods fail, then delete and recreate the job.",
    evidence: textOf(failed.message),
    onsetAt: textOf(failed.lastTransitionTime),
    related: [],
    fix: deleteFix("Delete job", "job", subject.name, subject.namespace),
    source: "cluster",
  };
}

function nodeNotReady(o: RawObject): Issue | undefined {
  const ready = conditionOf(o, "Ready");
  if (!ready || ready.status === "True") return undefined;
  const subject = subjectOf("Node", o);
  return {
    fingerprint: "",
    rule: "nodeNotReady",
    title: "Node not ready",
    category: "scheduling",
    severity: "critical",
    subject,
    cause: "Node is not ready",
    whatsWrong: `Node ${subject.name} reports its Ready condition as ${ready.status}, so the workloads on it are not running normally.`,
    nextStep: "Check the kubelet on that node and its network path to the API server.",
    evidence: textOf(ready.message),
    onsetAt: textOf(ready.lastTransitionTime),
    related: [],
    source: "cluster",
  };
}

function nodePressure(o: RawObject): Issue[] {
  const subject = subjectOf("Node", o);
  const issues: Issue[] = [];
  for (const [type, cause] of Object.entries(PRESSURE_CAUSES)) {
    const condition = conditionOf(o, type);
    if (condition?.status !== "True") continue;
    issues.push({
      fingerprint: "",
      rule: "nodePressure",
      title: "Node under pressure",
      category: "scheduling",
      severity: "warning",
      subject,
      cause,
      whatsWrong: `Node ${subject.name} reports ${type}, so the kubelet may start evicting pods from it.`,
      nextStep: "Free resources on the node or move workloads off it before the kubelet evicts them.",
      evidence: textOf(condition.message),
      onsetAt: textOf(condition.lastTransitionTime),
      related: [],
      source: "cluster",
    });
  }
  return issues;
}

function collect<T>(items: RawObject[] | undefined, rule: (o: RawObject) => T | undefined): T[] {
  const out: T[] = [];
  for (const item of items ?? []) {
    const result = rule(item);
    if (result) out.push(result);
  }
  return out;
}

/** Runtime and scheduling issues over raw kubectl JSON. Pure: no client, no IO. */
export function runtimeRules(input: IssueInput, now: Date = new Date()): Issue[] {
  return [
    ...podIssues(input, now),
    ...collect(input.deployments, (d) => degradedReplicaSetIssue(d, "Deployment")),
    ...collect(input.deployments, zeroReplicas),
    ...collect(input.statefulsets, (s) => degradedReplicaSetIssue(s, "StatefulSet")),
    ...collect(input.daemonsets, degradedDaemonSet),
    ...collect(input.jobs, jobBackoffLimitExceeded),
    ...collect(input.nodes, nodeNotReady),
    ...(input.nodes ?? []).flatMap(nodePressure),
  ];
}
