import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { viewYaml } from "@/store/yamlViewer";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { useFocusRow } from "@/panels/components/useFocusRow";
import type {
  PersistentVolumeClaim,
  PersistentVolume,
  StorageClass,
  StorageKind,
} from "./types";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";
import {
  abbreviateAccessModes,
  isDefaultStorageClass,
  claimRef,
  pvcPhase,
  pvcAccessModes,
  pvcCapacity,
  pvPhase,
  pvCapacity,
  matchesPVC,
  matchesPV,
  matchesStorageClass,
  sortPVCs,
  sortPVs,
  sortStorageClasses,
} from "./storageDisplay";

// ---------------------------------------------------------------------------
// READ-ONLY panel. No action blocks are emitted; all chat handoffs use
// handoffToChat. Mutations (delete PVC/PV) are deferred per spec.
// ---------------------------------------------------------------------------

const KIND_TABS: { kind: StorageKind; label: string }[] = [
  { kind: "pvcs", label: "Claims" },
  { kind: "pvs", label: "Volumes" },
  { kind: "storageclasses", label: "Classes" },
];

/** Map a storage phase to a StatusBadge variant. */
function phaseVariant(phase: string): StatusBadgeVariant {
  switch (phase) {
    case "Bound":
    case "Available":
      return "healthy";
    case "Pending":
      return "pending";
    case "Lost":
    case "Failed":
      return "error";
    default:
      return "neutral";
  }
}

export default function StoragePanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [activeKind, setActiveKind] = useState<StorageKind>("pvcs");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // PVCs are namespace-scoped: re-subscribe when the namespace filter changes.
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("persistentvolumeclaims", ns);
    return () => unsubscribe("persistentvolumeclaims", ns);
  }, [namespaceFilter]);

  // PVs and StorageClasses are cluster-scoped: subscribe once with "*".
  useEffect(() => {
    subscribe("persistentvolumes", "*");
    subscribe("storageclasses", "*");
    return () => {
      unsubscribe("persistentvolumes", "*");
      unsubscribe("storageclasses", "*");
    };
  }, []);

  const allPVCs = useMemo(
    () =>
      sortPVCs(
        Object.values(
          (resources["persistentvolumeclaims"] ?? {}) as Record<string, PersistentVolumeClaim>,
        ),
      ),
    [resources],
  );
  const allPVs = useMemo(
    () =>
      sortPVs(
        Object.values((resources["persistentvolumes"] ?? {}) as Record<string, PersistentVolume>),
      ),
    [resources],
  );
  const allSCs = useMemo(
    () =>
      sortStorageClasses(
        Object.values((resources["storageclasses"] ?? {}) as Record<string, StorageClass>),
      ),
    [resources],
  );

  const filteredPVCs = useMemo(
    () => allPVCs.filter((p) => matchesPVC(p, search)),
    [allPVCs, search],
  );
  const filteredPVs = useMemo(
    () => allPVs.filter((p) => matchesPV(p, search)),
    [allPVs, search],
  );
  const filteredSCs = useMemo(
    () => allSCs.filter((s) => matchesStorageClass(s, search)),
    [allSCs, search],
  );

  useFocusRow("persistentvolumeclaim", allPVCs, (pvc) => pvc.metadata.uid ?? pvc.metadata.name, (k) => setExpanded((prev) => new Set(prev).add(k)));

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function askClaude(kind: string, name: string, namespace: string | undefined, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt(kind, name, namespace, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Storage"
        subtitle="Claims · Volumes · Classes"
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Kind toggle pills */}
      <div className="flex items-center gap-1 px-4 py-2" style={{ borderBottom: "1px solid #26272B" }}>
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => setActiveKind(t.kind)}
            aria-pressed={activeKind === t.kind}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeKind === t.kind
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Row list */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {activeKind === "pvcs" &&
          filteredPVCs.map((pvc) => {
            const k = pvc.metadata.uid ?? pvc.metadata.name;
            const isOpen = expanded.has(k);
            const phase = pvcPhase(pvc);
            const modes = abbreviateAccessModes(pvcAccessModes(pvc));
            const capacity = pvcCapacity(pvc);
            const storageClass = pvc.spec?.storageClassName;
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={<PVCDetail pvc={pvc} />}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {pvc.metadata.name}
                </button>

                {/* Namespace chip */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-tertiary)",
                    background: "var(--surface-sunken)",
                    padding: "1px 5px",
                    borderRadius: 4,
                    border: "1px solid #26272B",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pvc.metadata.namespace ?? "—"}
                </span>

                {/* Phase badge */}
                <StatusBadge label={phase} variant={phaseVariant(phase)} />

                {/* Capacity — dim */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-secondary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {capacity}
                </span>

                {/* Access modes — dim */}
                {modes.length > 0 && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {modes.join(",")}
                  </span>
                )}

                {/* StorageClass — TagPill */}
                {storageClass && <TagPill label={storageClass} />}

                {/* Spacer */}
                <span className="flex-1" />

                {/* Action strip */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("persistentvolumeclaim", pvc.metadata.name, pvc.metadata.namespace, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {activeKind === "pvs" &&
          filteredPVs.map((pv) => {
            const k = pv.metadata.uid ?? pv.metadata.name;
            const isOpen = expanded.has(k);
            const phase = pvPhase(pv);
            const capacity = pvCapacity(pv);
            const reclaim = pv.spec?.persistentVolumeReclaimPolicy;
            const storageClass = pv.spec?.storageClassName;
            const claim = claimRef(pv);
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("persistentvolume", pv.metadata.name, undefined, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("persistentvolume", pv.metadata.name, undefined, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("persistentvolume", pv.metadata.name, undefined, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("persistentvolume", pv.metadata.name)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={<PVDetail pv={pv} />}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {pv.metadata.name}
                </button>

                {/* Phase badge */}
                <StatusBadge label={phase} variant={phaseVariant(phase)} />

                {/* Capacity — dim */}
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-secondary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {capacity}
                </span>

                {/* Reclaim policy — dim */}
                {reclaim && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {reclaim}
                  </span>
                )}

                {/* StorageClass — TagPill */}
                {storageClass && <TagPill label={storageClass} />}

                {/* ClaimRef — dim */}
                {claim && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      flexShrink: 1,
                    }}
                    title={claim}
                  >
                    {claim}
                  </span>
                )}

                {/* Spacer */}
                <span className="flex-1" />

                {/* Action strip */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("persistentvolume", pv.metadata.name, undefined, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("persistentvolume", pv.metadata.name, undefined, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("persistentvolume", pv.metadata.name, undefined, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {activeKind === "storageclasses" &&
          filteredSCs.map((sc) => {
            const k = sc.metadata.uid ?? sc.metadata.name;
            const isOpen = expanded.has(k);
            const isDefault = isDefaultStorageClass(sc);
            const provisioner = sc.provisioner;
            const reclaim = sc.reclaimPolicy;
            const bindingMode = sc.volumeBindingMode;
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("storageclass", sc.metadata.name, undefined, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("storageclass", sc.metadata.name, undefined, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("storageclass", sc.metadata.name, undefined, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("storageclass", sc.metadata.name)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={<SCDetail sc={sc} />}
              >
                {/* Name */}
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {sc.metadata.name}
                </button>

                {/* Default tag pill */}
                {isDefault && <TagPill label="default" />}

                {/* Provisioner — dim, truncated */}
                {provisioner && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      flexShrink: 1,
                    }}
                    title={provisioner}
                  >
                    {provisioner}
                  </span>
                )}

                {/* Reclaim policy — dim */}
                {reclaim && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {reclaim}
                  </span>
                )}

                {/* Volume binding mode — dim */}
                {bindingMode && (
                  <span
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 10,
                      color: "var(--fg-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {bindingMode}
                  </span>
                )}

                {/* Spacer */}
                <span className="flex-1" />

                {/* Action strip */}
                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("storageclass", sc.metadata.name, undefined, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("storageclass", sc.metadata.name, undefined, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("storageclass", sc.metadata.name, undefined, "Explain"); }}
                />
              </ListRow>
            );
          })}
      </div>

      {/* Empty states */}
      {!isLoading && activeKind === "pvcs" && allPVCs.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No persistent volume claims found</p>
      )}
      {!isLoading && activeKind === "pvs" && allPVs.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No persistent volumes found</p>
      )}
      {!isLoading && activeKind === "storageclasses" && allSCs.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No storage classes found</p>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded details
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground w-20 shrink-0">
        {label}
      </span>
      <div className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">{children}</div>
    </div>
  );
}

function PVCDetail({ pvc }: { pvc: PersistentVolumeClaim }) {
  const phase = pvcPhase(pvc);
  const modes = pvcAccessModes(pvc);
  const capacity = pvcCapacity(pvc);
  const storageClass = pvc.spec?.storageClassName;
  const volumeName = pvc.spec?.volumeName;

  return (
    <div className="space-y-1.5">
      <DetailRow label="PHASE">{phase}</DetailRow>
      <DetailRow label="CAPACITY">{capacity}</DetailRow>
      {modes.length > 0 && (
        <DetailRow label="ACCESS">{modes.join(", ")}</DetailRow>
      )}
      {storageClass && <DetailRow label="CLASS">{storageClass}</DetailRow>}
      {volumeName && <DetailRow label="VOLUME">{volumeName}</DetailRow>}
    </div>
  );
}

function PVDetail({ pv }: { pv: PersistentVolume }) {
  const phase = pvPhase(pv);
  const capacity = pvCapacity(pv);
  const reclaim = pv.spec?.persistentVolumeReclaimPolicy;
  const storageClass = pv.spec?.storageClassName;
  const claim = claimRef(pv);
  const modes = pv.spec?.accessModes ?? [];

  return (
    <div className="space-y-1.5">
      <DetailRow label="PHASE">{phase}</DetailRow>
      <DetailRow label="CAPACITY">{capacity}</DetailRow>
      {modes.length > 0 && (
        <DetailRow label="ACCESS">{modes.join(", ")}</DetailRow>
      )}
      {reclaim && <DetailRow label="RECLAIM">{reclaim}</DetailRow>}
      {storageClass && <DetailRow label="CLASS">{storageClass}</DetailRow>}
      {claim && <DetailRow label="CLAIM">{claim}</DetailRow>}
    </div>
  );
}

function SCDetail({ sc }: { sc: StorageClass }) {
  const isDefault = isDefaultStorageClass(sc);
  const provisioner = sc.provisioner;
  const reclaim = sc.reclaimPolicy;
  const bindingMode = sc.volumeBindingMode;
  const allowExpansion = sc.allowVolumeExpansion;

  return (
    <div className="space-y-1.5">
      {provisioner && <DetailRow label="PROVISIONER">{provisioner}</DetailRow>}
      {reclaim && <DetailRow label="RECLAIM">{reclaim}</DetailRow>}
      {bindingMode && <DetailRow label="BINDING">{bindingMode}</DetailRow>}
      <DetailRow label="DEFAULT">{isDefault ? "yes" : "no"}</DetailRow>
      {allowExpansion !== undefined && (
        <DetailRow label="EXPANDABLE">{allowExpansion ? "yes" : "no"}</DetailRow>
      )}
    </div>
  );
}
