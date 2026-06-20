import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { buildHelmRollbackArgs, buildHelmUninstallArgs, type HelmRelease, type HelmRevision } from "@rigel/k8s/src/helm";
import { releasesFromSecretsMap } from "./releases";
import { useHelmRollback, useHelmUninstall } from "./helmApi";
import { HelmConfirmModal } from "./HelmConfirmModal";

type Pending =
  | { op: "rollback"; release: HelmRelease; revision: number }
  | { op: "uninstall"; release: HelmRelease }
  | null;

export function ReleasesView({ onUpgrade }: { onUpgrade: (r: HelmRelease) => void }) {
  const resources = useCluster((s) => s.resources);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const [selected, setSelected] = useState<string | null>(null);
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
    () => releasesFromSecretsMap(resources["secrets"] ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
    [resources],
  );
  const current = releases.find((r) => `${r.namespace}/${r.name}` === selected) ?? null;
  const [rev, setRev] = useState<HelmRevision | null>(null);
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
    <div className="flex gap-4">
      <ul className="w-64 shrink-0 space-y-1">
        {releases.map((r) => (
          <li key={`${r.namespace}/${r.name}`}>
            <button
              type="button"
              onClick={() => { setSelected(`${r.namespace}/${r.name}`); setRev(null); }}
              className="w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-white/[0.04]"
              style={{ background: selected === `${r.namespace}/${r.name}` ? "rgba(255,255,255,0.06)" : undefined }}
            >
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-muted-foreground">{r.namespace} · {r.chartName} {r.chartVersion} · {r.status}</div>
            </button>
          </li>
        ))}
        {releases.length === 0 && <li className="px-2.5 py-2 text-sm text-muted-foreground">No Helm releases found.</li>}
      </ul>

      {current && (
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">{current.name}</h2>
              <p className="text-xs text-muted-foreground">rev {current.currentRevision} · {current.status} · updated {current.updated ?? "?"}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-white/[0.05]" onClick={() => onUpgrade(current)}>Upgrade</button>
              <button type="button" className="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10" onClick={() => { setPending({ op: "uninstall", release: current }); setError(null); }}>Uninstall</button>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {current.revisions.map((rv) => (
              <button
                key={rv.revision}
                type="button"
                onClick={() => setRev(rv)}
                className="rounded-md border px-2 py-1 text-xs"
                style={{ borderColor: "var(--border-strong)", background: shownRev?.revision === rv.revision ? "rgba(255,255,255,0.06)" : "transparent" }}
              >
                rev {rv.revision} · {rv.status}
                {rv.revision !== current.currentRevision && (
                  <span className="ml-1 cursor-pointer text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); setPending({ op: "rollback", release: current, revision: rv.revision }); setError(null); }}>↺</span>
                )}
              </button>
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
      )}

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

/** Render a values object as YAML for read-only display (JSON is valid YAML). */
function toYaml(config: unknown): string {
  if (config == null || (typeof config === "object" && Object.keys(config as object).length === 0)) return "# (no user-set values)";
  return JSON.stringify(config, null, 2);
}
