import { useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  HardDrive,
  Server,
  Package,
  ArrowRight,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type {
  PersistentVolumeClaim,
  PersistentVolume,
  StorageClass,
  StorageKind,
} from "./types";
import {
  abbreviateAccessModes,
  storagePhaseColor,
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
// DEFERRED ACTIONS (docs/parity/storage.md §4). This is a READ-ONLY panel.
// The following are intentionally NOT implemented and must NOT be added
// without a new feature spec + infra:
//   - View YAML (needs a server YAML endpoint + viewer UI). Row context-menu
//     items are deferred stubs only.
//   - Delete PVC / Delete PV mutations (need ConfirmSheet wiring + server
//     action routes — reuse the pods/nodes ConfirmSheet pattern later). The
//     action-block shapes the future mutations will emit are recorded here:
//       Delete PVC → {"kind":"deleteResource","name":<pvc>,"namespace":<ns>,
//                     "resourceKind":"pvc"}  →  kubectl delete pvc <name> -n <ns>
//       Delete PV  → {"kind":"deleteResource","name":<pv>,"resourceKind":"pv"}
//                     →  kubectl delete pv <name>
//   - Edit / Create / port-forward / Ask Claude handoff.
// No action blocks are emitted by this panel.
// ---------------------------------------------------------------------------

const KIND_TABS: { kind: StorageKind; label: string }[] = [
  { kind: "pvcs", label: "Claims" },
  { kind: "pvs", label: "Volumes" },
  { kind: "storageclasses", label: "Classes" },
];

/** Small muted chip used for storageClass / reclaimPolicy / namespace / etc. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
      {children}
    </span>
  );
}

/** Status-colored phase pill. */
function PhaseBadge({ phase }: { phase: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${storagePhaseColor(phase)}`}
    >
      {phase}
    </span>
  );
}

export default function StoragePanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [activeKind, setActiveKind] = useState<StorageKind>("pvcs");
  const [search, setSearch] = useState("");

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

  const counts: Record<StorageKind, { total: number; shown: number }> = {
    pvcs: { total: allPVCs.length, shown: filteredPVCs.length },
    pvs: { total: allPVs.length, shown: filteredPVs.length },
    storageclasses: { total: allSCs.length, shown: filteredSCs.length },
  };
  const { total, shown } = counts[activeKind];
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Storage</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {countLabel}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="ml-auto w-[200px] max-w-[200px] rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Kind toggle bar */}
      <div className="flex items-center gap-1">
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => setActiveKind(t.kind)}
            aria-pressed={activeKind === t.kind}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
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
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Main list — blank scrollable area when empty (no "no results" copy). */}
      <div className="space-y-1.5">
        {activeKind === "pvcs" &&
          filteredPVCs.map((pvc) => <PVCCard key={pvc.metadata.uid ?? pvc.metadata.name} pvc={pvc} />)}
        {activeKind === "pvs" &&
          filteredPVs.map((pv) => <PVCard key={pv.metadata.uid ?? pv.metadata.name} pv={pv} />)}
        {activeKind === "storageclasses" &&
          filteredSCs.map((sc) => <SCCard key={sc.metadata.uid ?? sc.metadata.name} sc={sc} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CardShell({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
      <span className="shrink-0 text-primary">{icon}</span>
      {children}
    </div>
  );
}

function PVCCard({ pvc }: { pvc: PersistentVolumeClaim }) {
  const phase = pvcPhase(pvc);
  const modes = abbreviateAccessModes(pvcAccessModes(pvc));
  const storageClass = pvc.spec?.storageClassName;
  const capacity = pvcCapacity(pvc);
  return (
    <CardShell icon={<HardDrive className="size-4" />}>
      <span className="truncate font-mono font-semibold" title={pvc.metadata.name}>
        {pvc.metadata.name}
      </span>
      <Chip>{pvc.metadata.namespace ?? "—"}</Chip>
      <PhaseBadge phase={phase} />
      {modes.length > 0 && (
        <span className="font-mono text-xs text-muted-foreground">{modes.join(",")}</span>
      )}
      {storageClass && <Chip>{storageClass}</Chip>}
      <span className="ml-auto min-w-[48px] text-right font-mono text-sm">{capacity}</span>
    </CardShell>
  );
}

function PVCard({ pv }: { pv: PersistentVolume }) {
  const phase = pvPhase(pv);
  const claim = claimRef(pv);
  const reclaim = pv.spec?.persistentVolumeReclaimPolicy ?? "—";
  const storageClass = pv.spec?.storageClassName;
  const capacity = pvCapacity(pv);
  return (
    <CardShell icon={<Server className="size-4" />}>
      <span className="truncate font-mono font-semibold" title={pv.metadata.name}>
        {pv.metadata.name}
      </span>
      <PhaseBadge phase={phase} />
      {claim && (
        <span
          className="flex items-center gap-0.5 truncate font-mono text-xs text-muted-foreground"
          title={claim}
        >
          <ArrowRight className="size-3" />
          {claim}
        </span>
      )}
      <Chip>{reclaim}</Chip>
      {storageClass && <Chip>{storageClass}</Chip>}
      <span className="ml-auto min-w-[48px] text-right font-mono text-sm">{capacity}</span>
    </CardShell>
  );
}

function SCCard({ sc }: { sc: StorageClass }) {
  const isDefault = isDefaultStorageClass(sc);
  const bindingMode = sc.volumeBindingMode;
  const reclaim = sc.reclaimPolicy;
  const provisioner = sc.provisioner ?? "—";
  return (
    <CardShell icon={<Package className="size-4" />}>
      <span className="truncate font-mono font-semibold" title={sc.metadata.name}>
        {sc.metadata.name}
      </span>
      {isDefault && (
        <span className="inline-block rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-mono text-green-600 dark:text-green-400">
          default
        </span>
      )}
      {bindingMode && <Chip>{bindingMode}</Chip>}
      {reclaim && <Chip>{reclaim}</Chip>}
      <span
        className="ml-auto max-w-[220px] truncate text-right font-mono text-xs text-muted-foreground"
        title={provisioner}
      >
        {provisioner}
      </span>
    </CardShell>
  );
}
