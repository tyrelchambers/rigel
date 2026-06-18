import { useEffect, useState } from "react";
import type { KVRow, Secret, ConfigMap } from "@helmsman/k8s";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { EnvRefEditor } from "./EnvRefEditor";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { KeyValueEditor } from "../components/KeyValueEditor";
import { BatchConfirmSheet, type BatchConfirmItem } from "@/components/BatchConfirmSheet";
import { executeAction, type ActionBlock } from "@/lib/api";
import type { Deployment } from "./types";
import {
  editModelFor,
  diffDeployment,
  type DeploymentEdit,
} from "./deploymentDisplay";

// ---------------------------------------------------------------------------
// DeploymentEditor — inline config editor for a Deployment. Edits replicas,
// per-container image, CPU/memory requests+limits, and plain-value environment
// variables in a guided form (shadcn Sheet, same pattern as IngressEditor /
// ConfigMapEditor). On "Review changes" it diffs the form against the live spec
// (`diffDeployment`) into discrete ActionBlocks (scale / setImage / setResources
// / setEnv) and hands them to BatchConfirmSheet, which previews the exact kubectl
// command for each before running them sequentially via `executeAction` (mirrors
// ChatPane's executeBatch). The watch auto-refreshes the panel after apply.
//
// Env rows are keyed by STABLE ids (`EnvEdit.id`, seeded from the var name) so a
// keystroke doesn't regenerate the row and steal input focus.
// `kubectl set resources` cannot REMOVE a request/limit, so a cleared resource
// field is treated as "no change" (handled in `diffDeployment`).
// ---------------------------------------------------------------------------

const fieldInput =
  "flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-ring";

export interface DeploymentEditorProps {
  target: Deployment | null;
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}

export function DeploymentEditor({ target, open, onClose, onApplied }: DeploymentEditorProps) {
  const [model, setModel] = useState<DeploymentEdit | null>(null);
  const [pendingActions, setPendingActions] = useState<ActionBlock[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const ns = target?.metadata.namespace ?? "default";
  const resources = useCluster((s) => s.resources);

  // While open, watch secrets + configmaps in the deployment's namespace so the
  // ref pickers list real resources. Unsubscribed on close.
  // `ns` already captures everything we need from `target` (its namespace), so
  // keying on `ns` (a string) avoids a re-subscribe whenever `target`'s identity
  // changes for the same deployment. `open` gates whether a target exists.
  useEffect(() => {
    if (!open) return;
    subscribe("secrets", ns);
    subscribe("configmaps", ns);
    return () => {
      unsubscribe("secrets", ns);
      unsubscribe("configmaps", ns);
    };
  }, [open, ns]);

  const secrets = (Object.values((resources["secrets"] ?? {}) as Record<string, Secret>))
    .filter((s) => (s.metadata.namespace ?? "default") === ns);
  const configMaps = (Object.values((resources["configmaps"] ?? {}) as Record<string, ConfigMap>))
    .filter((c) => (c.metadata.namespace ?? "default") === ns);

  // (Re)seed the form each time the sheet opens on a target.
  useEffect(() => {
    if (!open || !target) return;
    setModel(editModelFor(target));
    setPendingActions(null);
    setBusy(false);
    setServerError(null);
  }, [open, target]);

  function updateContainer(idx: number, patch: Partial<DeploymentEdit["containers"][number]>) {
    setModel((m) => (m ? { ...m, containers: m.containers.map((c, i) => (i === idx ? { ...c, ...patch } : c)) } : m));
  }

  function review() {
    if (!target || !model) return;
    const actions = diffDeployment(target, model);
    if (actions.length === 0) {
      onClose();
      return;
    }
    setServerError(null);
    setPendingActions(actions);
  }

  // Run the confirmed batch sequentially, stopping at the first failure (mirrors
  // ChatPane's executeBatch — minus the chat-session feedback).
  async function applyBatch(items: BatchConfirmItem[]) {
    setPendingActions(null);
    setBusy(true);
    setServerError(null);
    try {
      for (const { action, commandString } of items) {
        let result: { code: number; stdout: string; stderr: string };
        try {
          const resp = await executeAction(action);
          result = "code" in resp ? resp : { code: 1, stdout: "", stderr: "unexpected response" };
        } catch (e) {
          result = { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
        }
        if (result.code !== 0) {
          throw new Error(`${commandString}\n${result.stderr || result.stdout || "kubectl failed"}`);
        }
      }
      onApplied?.();
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[92vh] overflow-auto">
          <SheetHeader>
            <SheetTitle>Edit {target?.metadata.name}</SheetTitle>
            <SheetDescription>
              Changes are applied as kubectl commands you review and confirm next. A cleared resource field is left unchanged.
            </SheetDescription>
          </SheetHeader>

          {model && (
            <div className="space-y-4 px-4 py-2">
              <label className="flex items-center gap-2 text-sm">
                <span className="w-24 text-muted-foreground">Replicas</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={model.replicas}
                  onChange={(e) => setModel({ ...model, replicas: Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))) })}
                  className="w-24 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  aria-label="Replicas"
                />
              </label>

              {model.containers.map((c, ci) => (
                <div key={c.name} className="space-y-2 rounded-md border p-3">
                  <div className="font-mono text-xs font-medium text-primary">{c.name}</div>

                  <label className="flex items-center gap-2 text-xs">
                    <span className="w-20 text-muted-foreground">Image</span>
                    <input
                      value={c.image}
                      onChange={(e) => updateContainer(ci, { image: e.target.value })}
                      className={fieldInput}
                      aria-label="Image"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    {(["cpuReq", "cpuLim", "memReq", "memLim"] as const).map((field) => (
                      <label key={field} className="flex items-center gap-2 text-xs">
                        <span className="w-16 text-muted-foreground">
                          {field === "cpuReq" ? "CPU req" : field === "cpuLim" ? "CPU lim" : field === "memReq" ? "Mem req" : "Mem lim"}
                        </span>
                        <input
                          value={c[field]}
                          onChange={(e) => updateContainer(ci, { [field]: e.target.value })}
                          placeholder={field.startsWith("cpu") ? "e.g. 250m" : "e.g. 256Mi"}
                          className={fieldInput}
                          aria-label={field}
                        />
                      </label>
                    ))}
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Environment</div>
                    <KeyValueEditor
                      rows={c.env}
                      onRowsChange={(rows: KVRow[]) => updateContainer(ci, { env: rows })}
                      keyPlaceholder="ENV_NAME"
                    />
                    <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From Secret / ConfigMap</div>
                    <EnvRefEditor
                      rows={c.envRefs}
                      secrets={secrets}
                      configMaps={configMaps}
                      onChange={(rows) => updateContainer(ci, { envRefs: rows })}
                    />
                    {c.otherRefKeys.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {c.otherRefKeys.map((k) => (
                          <div key={k} className="flex items-center gap-2 rounded border border-dashed px-2 py-1 text-[11px] font-mono text-muted-foreground">
                            <span>{k}</span>
                            <span className="ml-1 text-[10px] uppercase tracking-wide">from ref · read-only</span>
                            <button
                              type="button"
                              className="ml-auto text-destructive hover:underline"
                              onClick={() => updateContainer(ci, { otherRefKeys: c.otherRefKeys.filter((x) => x !== k) })}
                            >
                              remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {serverError && (
            <pre className="mx-4 rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
              {serverError}
            </pre>
          )}

          <SheetFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={review} disabled={busy || !model}>{busy ? "Applying…" : "Review changes"}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <BatchConfirmSheet
        actions={pendingActions ?? []}
        open={!!pendingActions}
        onClose={() => setPendingActions(null)}
        onConfirm={applyBatch}
      />
    </>
  );
}
