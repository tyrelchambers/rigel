import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { YamlEditor } from "@/components/YamlEditorLazy";
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

      <Modal
        open={current != null}
        onOpenChange={(o) => { if (!o) { setSelected(null); setRev(null); } }}
        title={current?.name ?? "Release"}
        maxWidth="!max-w-4xl"
      >
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
      </Modal>

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

/** A labeled metadata field: a small uppercase caption above its value. */
function Field({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("text-sm", mono && "font-mono")}>{children}</span>
    </div>
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

/** The release detail body shown inside the dialog: metadata + actions, revision
 *  picker (with rollback), and read-only values + manifest. */
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
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <Field label="Status"><StatusBadge status={release.status} /></Field>
          <Field label="Namespace" mono>{release.namespace}</Field>
          <Field label="Chart">{release.chartName} {release.chartVersion}</Field>
          <Field label="Revision">{release.currentRevision}</Field>
          <Field label="Updated">{formatTimestamp(release.updated)}</Field>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={onUpgrade}>Upgrade</Button>
          <Button className="bg-destructive text-white hover:bg-destructive/90" onClick={onUninstall}>Uninstall</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {release.revisions.map((rv) => (
          <div
            key={rv.revision}
            className="inline-flex items-center rounded-md border text-xs"
            style={{ borderColor: "var(--border-strong)", background: shownRev?.revision === rv.revision ? "rgba(255,255,255,0.06)" : "transparent" }}
          >
            <button type="button" onClick={() => onSelectRev(rv)} className="px-2 py-1">
              rev {rv.revision} · {rv.status}
            </button>
            {rv.revision !== release.currentRevision && (
              <button
                type="button"
                aria-label={`Roll back to revision ${rv.revision}`}
                className="px-1.5 py-1 text-muted-foreground hover:text-foreground"
                onClick={() => onRollback(rv.revision)}
              >
                ↺
              </button>
            )}
          </div>
        ))}
      </div>

      {shownRev && (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Values</div>
            <YamlEditor value={toYaml(shownRev.config)} readOnly height="200px" schema={null} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manifest</div>
            <YamlEditor value={shownRev.manifest ?? ""} readOnly height="320px" schema={null} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Render a values object as YAML for read-only display (JSON is valid YAML). */
function toYaml(config: unknown): string {
  if (config == null || (typeof config === "object" && Object.keys(config as object).length === 0)) return "# (no user-set values)";
  return JSON.stringify(config, null, 2);
}
