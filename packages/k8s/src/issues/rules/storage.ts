import { parseQuantity } from "../../quantity";
import type { Issue, IssueInput, IssueSubject, RawObject } from "../types";
import { nameIndex, refKey } from "./references";

const CPU_RESOURCE_SUFFIX = "cpu";
const CLUSTER_SCOPED_NAMESPACE = "";

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function subjectOf(kind: string, o: RawObject): IssueSubject {
  return {
    kind,
    namespace: textOf(o.metadata?.namespace) ?? "",
    name: textOf(o.metadata?.name) ?? "",
  };
}

function quantityType(resource: string): "cpu" | "memory" {
  return resource.endsWith(CPU_RESOURCE_SUFFIX) ? "cpu" : "memory";
}

function pvcUnbound(claim: RawObject): Issue | undefined {
  if (claim.status?.phase !== "Pending") return undefined;
  const subject = subjectOf("PersistentVolumeClaim", claim);
  return {
    fingerprint: "",
    rule: "pvcUnbound",
    title: "Volume claim unbound",
    category: "storage",
    severity: "critical",
    subject,
    cause: "Claim is still waiting for a volume",
    whatsWrong: `PersistentVolumeClaim ${subject.namespace}/${subject.name} is still Pending, so every pod that mounts it stays stuck waiting for storage.`,
    nextStep: "Check that a provisioner or a matching PersistentVolume can satisfy the claim's size and access mode.",
    onsetAt: textOf(claim.metadata?.creationTimestamp),
    related: [],
    source: "cluster",
  };
}

function pvcMissingStorageClass(
  claim: RawObject,
  classes: Map<string, RawObject>,
): Issue | undefined {
  const className = textOf(claim.spec?.storageClassName);
  if (!className) return undefined;
  if (classes.has(refKey(CLUSTER_SCOPED_NAMESPACE, className))) return undefined;
  const subject = subjectOf("PersistentVolumeClaim", claim);
  return {
    fingerprint: "",
    rule: "pvcMissingStorageClass",
    title: "Missing storage class",
    category: "storage",
    severity: "critical",
    subject,
    cause: "Requested StorageClass does not exist",
    whatsWrong: `PersistentVolumeClaim ${subject.namespace}/${subject.name} asks for StorageClass "${className}", which does not exist in this cluster, so nothing can provision it.`,
    nextStep: "Create that StorageClass or change the claim to one the cluster already offers.",
    related: [
      { kind: "StorageClass", namespace: CLUSTER_SCOPED_NAMESPACE, name: className },
    ],
    source: "cluster",
  };
}

function pvFailed(volume: RawObject): Issue | undefined {
  if (volume.status?.phase !== "Failed") return undefined;
  const subject = subjectOf("PersistentVolume", volume);
  return {
    fingerprint: "",
    rule: "pvFailed",
    title: "Volume failed",
    category: "storage",
    severity: "critical",
    subject,
    cause: "Volume reclaim failed",
    whatsWrong: `PersistentVolume ${subject.name} is in the Failed phase, so its backing storage was not reclaimed and cannot be reused.`,
    nextStep: "Read the volume's failure message, clear the backing storage by hand, then delete the volume.",
    evidence: textOf(volume.status?.message),
    related: [],
    source: "cluster",
  };
}

function pvReleased(volume: RawObject): Issue | undefined {
  if (volume.status?.phase !== "Released") return undefined;
  const subject = subjectOf("PersistentVolume", volume);
  return {
    fingerprint: "",
    rule: "pvReleased",
    title: "Volume released",
    category: "storage",
    severity: "info",
    subject,
    cause: "Volume released but not reclaimed",
    whatsWrong: `PersistentVolume ${subject.name} lost its claim and is sitting in the Released phase, so its capacity is held but unused.`,
    nextStep: "Delete the volume once you no longer need its data, or clear it and make it available again.",
    evidence: textOf(volume.status?.message),
    related: [],
    source: "cluster",
  };
}

function exhaustedResources(quota: RawObject): string[] {
  const hard = quota.status?.hard;
  const used = quota.status?.used;
  if (!hard || !used) return [];
  const out: string[] = [];
  for (const [resource, limit] of Object.entries(hard as Record<string, unknown>)) {
    const limitText = textOf(limit);
    const usedText = textOf((used as Record<string, unknown>)[resource]);
    if (!limitText || !usedText) continue;
    const type = quantityType(resource);
    if (parseQuantity(usedText, type) >= parseQuantity(limitText, type)) out.push(resource);
  }
  return out;
}

function resourceQuotaExhausted(quota: RawObject): Issue | undefined {
  const exhausted = exhaustedResources(quota);
  if (exhausted.length === 0) return undefined;
  const subject = subjectOf("ResourceQuota", quota);
  return {
    fingerprint: "",
    rule: "resourceQuotaExhausted",
    title: "Resource quota exhausted",
    category: "scheduling",
    severity: "warning",
    subject,
    cause: "Quota is fully consumed",
    whatsWrong: `ResourceQuota ${subject.namespace}/${subject.name} has used all of its ${exhausted.join(", ")} allowance, so further requests for it in that namespace are rejected.`,
    nextStep: `Raise the quota for ${exhausted.join(", ")} or free what the namespace already holds.`,
    related: [],
    source: "cluster",
  };
}

function collect<T>(items: RawObject[] | undefined, rule: (o: RawObject) => T | undefined): T[] {
  const out: T[] = [];
  for (const item of items ?? []) {
    const result = rule(item);
    if (result) out.push(result);
  }
  return out;
}

/** Storage and capacity issues over raw kubectl JSON. Pure: no client, no IO. */
export function storageRules(input: IssueInput): Issue[] {
  const classes = nameIndex(input.storageclasses);
  return [
    ...collect(input.persistentvolumeclaims, pvcUnbound),
    ...(classes
      ? collect(input.persistentvolumeclaims, (c) => pvcMissingStorageClass(c, classes))
      : []),
    ...collect(input.persistentvolumes, pvFailed),
    ...collect(input.persistentvolumes, pvReleased),
    ...collect(input.resourcequotas, resourceQuotaExhausted),
  ];
}
