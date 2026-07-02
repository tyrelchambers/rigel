import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { SectionLabel } from "@/panels/components/MetaCard";
import { CircleArrowUp, FileCode, Lock, Trash2, Undo2 } from "lucide-react";
import { buildHelmRollbackArgs, buildHelmUninstallArgs, type HelmRelease, type HelmRevision } from "@rigel/k8s/src/helm";
import { releasesFromSecretsMap, releaseStatusTone, formatTimestamp, type StatusTone } from "./releases";
import { useHelmRollback, useHelmUninstall } from "./helmApi";
import { HelmConfirmModal } from "./HelmConfirmModal";

type Pending =
  | { op: "rollback"; release: HelmRelease; revision: number }
  | { op: "uninstall"; release: HelmRelease }
  | null;

export function ReleasesView({ onUpgrade }: { onUpgrade: (r: HelmRelease) => void }) {
  const secrets = useCluster((s) => s.resources["secrets"]);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const [selected, setSelected] = useState<string | null>(null);
  const [rev, setRev] = useState<HelmRevision | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const rollback = useHelmRollback();
  const uninstall = useHelmUninstall();

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("secrets", ns);
    return () => unsubscribe("secrets", ns);
  }, [namespaceFilter]);

  const releases = useMemo(
    () => releasesFromSecretsMap(secrets ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
    [secrets],
  );
  const current = releases.find((r) => `${r.namespace}/${r.name}` === selected) ?? null;
  const shownRev = rev ?? current?.revisions[0] ?? null;

  const command = !pending
    ? []
    : pending.op === "rollback"
      ? buildHelmRollbackArgs(pending.release.name, pending.revision, pending.release.namespace, null)
      : buildHelmUninstallArgs(pending.release.name, pending.release.namespace, null);

  function runPending() {
    if (!pending) return;
    setError(null);
    const onErr = (e: Error) => setError(e.message);
    const onOk = (r: { code: number; stderr: string }) => (r.code === 0 ? setPending(null) : setError(r.stderr || `exit ${r.code}`));
    if (pending.op === "rollback") {
      rollback.mutate({ release: pending.release.name, revision: pending.revision, namespace: pending.release.namespace }, { onSuccess: onOk, onError: onErr });
    } else {
      uninstall.mutate({ release: pending.release.name, namespace: pending.release.namespace }, { onSuccess: onOk, onError: onErr });
    }
  }

  return (
    <div className="flex h-full flex-col">
      {releases.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Helm releases found.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {releases.map((r) => (
              <ReleaseCard
                key={`${r.namespace}/${r.name}`}
                release={r}
                onClick={() => { setSelected(`${r.namespace}/${r.name}`); setRev(null); }}
              />
            ))}
          </div>
        </div>
      )}

      <Dialog
        open={current != null}
        onOpenChange={(o) => { if (!o) { setSelected(null); setRev(null); } }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{current?.name ?? "Release"}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {current && (
              <ReleaseDetail
                release={current}
                shownRev={shownRev}
                onSelectRev={setRev}
                onUpgrade={() => { onUpgrade(current); setSelected(null); }}
                onUninstall={() => { setPending({ op: "uninstall", release: current }); setError(null); }}
                onRollback={(revision) => { setPending({ op: "rollback", release: current, revision }); setError(null); }}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <HelmConfirmModal
        open={pending != null}
        onOpenChange={(o) => { if (!o) { setPending(null); setError(null); } }}
        title={pending?.op === "uninstall" ? `Uninstall ${pending.release.name}?` : "Roll back release?"}
        command={command}
        running={rollback.isPending || uninstall.isPending}
        error={error}
        onConfirm={runPending}
      />
    </div>
  );
}

const TONE: Record<StatusTone, string> = {
  green: "#34D399",
  yellow: "#FBBF24",
  red: "#F87171",
  neutral: "#8C8C95",
};

/** A colored status dot + label pill for a Helm release status. */
function StatusBadge({ status, className }: { status: string; className?: string }) {
  const color = TONE[releaseStatusTone(status)];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", className)}
      style={{ background: "rgba(255,255,255,0.05)", color }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  );
}

/** A release card: name + status, chart·version, namespace chip + current revision. */
function ReleaseCard({ release, onClick }: { release: HelmRelease; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-1.5 rounded-lg border p-3 text-left hover:bg-white/[0.04]"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">{release.name}</span>
        <StatusBadge status={release.status} className="ml-auto shrink-0" />
      </div>
      <div className="truncate text-xs text-muted-foreground">{release.chartName} · {release.chartVersion}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate rounded bg-white/[0.05] px-1.5 py-0.5 font-mono">{release.namespace}</span>
        <span className="ml-auto shrink-0">rev {release.currentRevision}</span>
      </div>
    </button>
  );
}

/** A sunken meta cell: a small uppercase mono label above its value. Sits in a
 *  responsive `auto-fit` grid so the cells wrap instead of overlapping. */
function MetaField({ label, mono = true, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border px-3.5 py-2.5 border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
      <span className="font-mono text-[10px] uppercase tracking-[0.6px] text-[var(--fg-tertiary)]">{label}</span>
      <span className={cn("truncate text-[13px] text-[var(--fg-primary)]", mono && "font-mono")}>{children}</span>
    </div>
  );
}

/** The release detail body shown inside the dialog: a responsive header (title +
 *  actions that wrap instead of overlapping), a wrapping meta grid, then the
 *  full-width revision history with the read-only current values below it. */
function ReleaseDetail({
  release,
  shownRev,
  onSelectRev,
  onUpgrade,
  onUninstall,
  onRollback,
}: {
  release: HelmRelease;
  shownRev: HelmRevision | null;
  onSelectRev: (rv: HelmRevision) => void;
  onUpgrade: () => void;
  onUninstall: () => void;
  onRollback: (revision: number) => void;
}) {
  const [showManifest, setShowManifest] = useState(false);
  const dot = TONE[releaseStatusTone(release.status)];
  // The greatest revision below the current one, i.e. the Rollback target.
  const previousRevision = release.revisions
    .map((r) => r.revision)
    .filter((n) => n < release.currentRevision)
    .sort((a, b) => b - a)[0];

  return (
    <div className="flex flex-col gap-4">
      {/* Header: title block and actions wrap onto separate lines when narrow. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: dot }} />
            <span className="min-w-0 truncate text-lg font-bold text-[var(--fg-primary)]">{release.name}</span>
            <StatusBadge status={release.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--fg-tertiary)]">
            <span className="rounded bg-white/[0.04] px-2 py-0.5 font-mono text-[var(--fg-secondary)]">{release.namespace}</span>
            <span className="font-mono">{release.chartName} {release.chartVersion}</span>
            <span className="font-mono">· rev {release.currentRevision}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" onClick={onUpgrade}><CircleArrowUp />Upgrade</Button>
          <Button
            size="sm"
            variant="outline"
            disabled={previousRevision == null}
            onClick={() => previousRevision != null && onRollback(previousRevision)}
          >
            <Undo2 />Rollback
          </Button>
          <Button size="sm" variant={showManifest ? "muted" : "outline"} onClick={() => setShowManifest((v) => !v)}>
            <FileCode />Manifest
          </Button>
          <Button size="sm" variant="destructive" onClick={onUninstall}><Trash2 />Uninstall</Button>
        </div>
      </div>

      {/* Meta grid: auto-fit cells wrap to new rows rather than overlapping. */}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <MetaField label="Chart">{release.chartName}</MetaField>
        <MetaField label="Chart version">{shownRev?.chartVersion ?? release.chartVersion}</MetaField>
        <MetaField label="App version">{shownRev?.appVersion ?? release.appVersion ?? "—"}</MetaField>
        <MetaField label="Revision">{shownRev?.revision ?? release.currentRevision}</MetaField>
        <MetaField label="Updated" mono={false}>{formatTimestamp(shownRev?.updated ?? release.updated)}</MetaField>
      </div>

      {/* Revision history, full width. */}
      <section className="flex flex-col gap-2">
        <SectionLabel>Revision history · {release.revisions.length}</SectionLabel>
        <div className="flex flex-col gap-1.5">
          {release.revisions.map((rv) => {
            const selected = shownRev?.revision === rv.revision;
            const tone = TONE[releaseStatusTone(rv.status)];
            return (
              <div
                key={rv.revision}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => onSelectRev(rv)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectRev(rv);
                  }
                }}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs hover:bg-white/[0.03]"
                style={
                  selected
                    ? { background: "var(--accent-dim)", borderColor: "rgba(56,189,248,0.35)" }
                    : { borderColor: "var(--border-subtle)" }
                }
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
                  <span className="font-mono text-[var(--fg-primary)]">rev {rv.revision}</span>
                  <span className="font-mono" style={{ color: tone }}>{rv.status}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="font-mono text-[var(--fg-tertiary)]">{formatTimestamp(rv.updated)}</span>
                  {rv.revision !== release.currentRevision && (
                    <button
                      type="button"
                      aria-label={`Roll back to revision ${rv.revision}`}
                      className="text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
                      onClick={(e) => { e.stopPropagation(); onRollback(rv.revision); }}
                    >
                      <Undo2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Current values, below the history, in the Monaco editor. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Current values</SectionLabel>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-tertiary)]">
            <Lock className="size-3" />read-only
          </span>
        </div>
        <div className="overflow-hidden rounded-md border border-[var(--border-subtle)]">
          <YamlEditor value={toYaml(shownRev?.config)} readOnly height="300px" schema={null} />
        </div>
      </section>

      {showManifest && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Manifest</SectionLabel>
          <div className="overflow-hidden rounded-md border border-[var(--border-subtle)]">
            <YamlEditor value={shownRev?.manifest ?? ""} readOnly height="360px" schema={null} />
          </div>
        </section>
      )}
    </div>
  );
}

/** Render a values object as YAML for read-only display (JSON is valid YAML). */
function toYaml(config: unknown): string {
  if (config == null || (typeof config === "object" && Object.keys(config as object).length === 0)) return "# (no user-set values)";
  return JSON.stringify(config, null, 2);
}
