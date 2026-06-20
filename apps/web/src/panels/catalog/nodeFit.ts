/**
 * NodeFit — capacity-fit logic for catalog apps.
 *
 * Pure TypeScript port of `Sources/Rigel/Catalog/NodeFit.swift`.
 * No side effects. Inputs: a CatalogApp + snapshots of nodes and pods.
 *
 * Disk: the web has no kubelet Summary API, so `usedDiskBytes` is always
 * undefined and disk headroom is omitted from `headroomScore`. `freeDiskBytes`
 * falls back to `allocatableDiskBytes` (ephemeral-storage from allocatable).
 * This matches Swift's fallback path exactly.
 */

import { parseCpuCores, parseBytes, isReady } from "@/panels/nodes/nodeDisplay";
import type { Node } from "@/panels/nodes/types";
import type { Pod } from "@/panels/pods/types";
import type { CatalogApp } from "@rigel/catalog";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NodeFitEntry {
  node: Node;
  freeCPU: number;
  freeMemoryBytes: number;
  allocatableCPU: number;
  allocatableMemoryBytes: number;
  freeDiskBytes: number;
  allocatableDiskBytes: number;
  /** Always undefined on the web — no kubelet Summary API. */
  usedDiskBytes?: number;
  canHost: boolean;
  tainted: boolean;
  cordoned: boolean;
  /** canHost && !tainted && !cordoned */
  eligible: boolean;
  /**
   * 0–1 average headroom fraction across measurable resources (CPU + memory;
   * disk only when usedDiskBytes is known — it won't be on the web). Used to
   * sort eligible nodes. Clamped ≥ 0.
   */
  headroomScore: number;
}

export type FitDot = "green" | "yellow" | "red";

export interface FitResult {
  /**
   * One entry per node. Eligible nodes first, sorted by headroomScore desc.
   * Ineligible nodes follow, sorted by node name asc.
   */
  perNode: NodeFitEntry[];
  /** First eligible node, or null when nothing fits. */
  recommended: NodeFitEntry | null;
  /** True when at least one eligible node was found. */
  anyFits: boolean;
  /**
   * Cluster-wide categorical fit indicator for the catalog card dot.
   * green  = recommended.headroomScore >= 0.5
   * yellow = recommended exists but headroomScore < 0.5
   * red    = no recommended node
   */
  dot: FitDot;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute per-node fit for a catalog app against current cluster state.
 * Pure — no network calls, no side effects.
 */
export function nodeFit(app: CatalogApp, nodes: Node[], pods: Pod[]): FitResult {
  const appCPU = parseCpuCores(app.requirements.cpuRequest);
  const appMem = parseBytes(app.requirements.memoryRequest);
  // 0 when the app declares no storage (stateless).
  const appDisk =
    app.requirements.storageGiB != null && app.requirements.storageGiB > 0
      ? app.requirements.storageGiB * 1024 * 1024 * 1024
      : 0;

  // Pre-aggregate pod resource requests by node name.
  // Skip terminal pods (Succeeded / Failed) so a completed Job doesn't make
  // a node look saturated — mirrors Swift exactly.
  const cpuUsedByNode: Record<string, number> = {};
  const memUsedByNode: Record<string, number> = {};

  for (const pod of pods) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue;
    const phase = pod.status?.phase ?? "";
    if (phase === "Succeeded" || phase === "Failed") continue;
    for (const container of pod.spec?.containers ?? []) {
      const cpuReq = container.resources?.requests?.["cpu"];
      const memReq = container.resources?.requests?.["memory"];
      if (cpuReq) cpuUsedByNode[nodeName] = (cpuUsedByNode[nodeName] ?? 0) + parseCpuCores(cpuReq);
      if (memReq) memUsedByNode[nodeName] = (memUsedByNode[nodeName] ?? 0) + parseBytes(memReq);
    }
  }

  const fits: NodeFitEntry[] = nodes.map((node) => {
    const name = node.metadata.name;
    const allocCPU = parseCpuCores(node.status?.allocatable?.["cpu"]);
    const allocMem = parseBytes(node.status?.allocatable?.["memory"]);
    const freeCPU = Math.max(0, allocCPU - (cpuUsedByNode[name] ?? 0));
    const freeMem = Math.max(0, allocMem - (memUsedByNode[name] ?? 0));

    // Disk: no Summary API on web → freeDisk = allocDisk (fallback path)
    const allocDisk = parseBytes(node.status?.allocatable?.["ephemeral-storage"]);
    const freeDisk = allocDisk; // usedDiskBytes always undefined on web

    // diskFits: skip gating when node has no ephemeral-storage declared
    // (allocDisk=0) or when the app requests no storage (appDisk=0).
    const diskFits = allocDisk <= 0 || appDisk <= 0 || freeDisk >= appDisk;

    // tainted = any taint with effect NoSchedule or NoExecute
    const tainted = (node.spec?.taints ?? []).some(
      (t) => t.effect === "NoSchedule" || t.effect === "NoExecute",
    );
    const cordoned = node.spec?.unschedulable === true;

    const canHost = freeCPU >= appCPU && freeMem >= appMem && diskFits && isReady(node);

    const eligible = canHost && !tainted && !cordoned;

    // headroomScore: average of measurable ratios, clamped ≥ 0
    const ratios: number[] = [];
    if (allocCPU > 0) ratios.push(Math.max(0, freeCPU / allocCPU));
    if (allocMem > 0) ratios.push(Math.max(0, freeMem / allocMem));
    // disk skipped — usedDiskBytes is always undefined on the web
    const headroomScore = ratios.length === 0 ? 0 : ratios.reduce((a, b) => a + b, 0) / ratios.length;

    return {
      node,
      freeCPU,
      freeMemoryBytes: freeMem,
      allocatableCPU: allocCPU,
      allocatableMemoryBytes: allocMem,
      freeDiskBytes: freeDisk,
      allocatableDiskBytes: allocDisk,
      usedDiskBytes: undefined,
      canHost,
      tainted,
      cordoned,
      eligible,
      headroomScore,
    };
  });

  // Sort: eligible first by headroomScore desc; ineligible after by node name asc
  const eligibleEntries = fits
    .filter((e) => e.eligible)
    .sort((a, b) => b.headroomScore - a.headroomScore);
  const ineligibleEntries = fits
    .filter((e) => !e.eligible)
    .sort((a, b) => a.node.metadata.name.localeCompare(b.node.metadata.name));

  const perNode = [...eligibleEntries, ...ineligibleEntries];
  const recommended = eligibleEntries[0] ?? null;

  const dot: FitDot = recommended == null ? "red" : recommended.headroomScore >= 0.5 ? "green" : "yellow";

  return { perNode, recommended, anyFits: recommended !== null, dot };
}
