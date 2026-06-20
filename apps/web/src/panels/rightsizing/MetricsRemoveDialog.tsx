// "Remove metrics backend" dialog — the uninstall counterpart of
// MetricsInstallDialog. Re-renders the SAME install manifest for the connected
// backend and lets the user choose WHICH resources to delete (every switch on
// by default). The chosen subset is re-emitted and deleted via
// `kubectl delete -f - --ignore-not-found`. Turn off the Namespace to keep it,
// or the PersistentVolumeClaim to keep the collected history.

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { deleteManifestYaml } from "@/lib/api";
import { listResourceDocs, joinResourceDocs, type ResourceDoc } from "@rigel/catalog";
import { renderMetricsInstallManifest, type MetricsInstallBackend } from "@rigel/k8s";
import type { UsageBackend } from "./useRightSizing";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Rigel-installed backend to remove (service === METRICS_SERVICE_NAME). */
  backend: UsageBackend;
  /** Called after a successful delete, to clear the choice + re-detect. */
  onRemoved: () => void;
}

const keyOf = (r: ResourceDoc) => `${r.kind}/${r.namespace ?? ""}/${r.name}`;

export function MetricsRemoveDialog({ open, onOpenChange, backend, onRemoved }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resources the user turned OFF (to keep). Empty = delete everything (default).
  const [kept, setKept] = useState<Set<string>>(new Set());

  const kind: MetricsInstallBackend = backend.flavor === "VictoriaMetrics" ? "victoriaMetrics" : "prometheus";
  // Render the full set (persistent=true) so the PVC is a togglable row; size is
  // irrelevant to a delete (resources match by kind/name/namespace).
  const yaml = renderMetricsInstallManifest(kind, backend.namespace, true, 1);
  const docs = useMemo(() => listResourceDocs(yaml), [yaml]);

  // Fresh defaults each time the dialog opens (everything selected).
  useEffect(() => {
    if (open) {
      setKept(new Set());
      setError(null);
    }
  }, [open]);

  const isOn = (r: ResourceDoc) => !kept.has(keyOf(r));
  const selected = docs.filter(isOn);

  function toggle(r: ResourceDoc) {
    setKept((prev) => {
      const next = new Set(prev);
      const k = keyOf(r);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Caution: deleting the Namespace cascade-deletes everything inside it — even
  // namespaced resources the user turned off.
  const nsDoc = docs.find((d) => d.kind === "Namespace");
  const deletingNamespace = nsDoc ? isOn(nsDoc) : false;
  const keptInsideNs = docs.some((d) => d.namespace === nsDoc?.name && !isOn(d));
  const cascadeWarning = deletingNamespace && keptInsideNs;

  async function handleRemove() {
    if (selected.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const result = await deleteManifestYaml(joinResourceDocs(selected));
      if (result.code === 0) {
        onRemoved();
        onOpenChange(false);
      } else {
        setError(result.stderr || result.stdout || `exit ${result.code}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Remove metrics backend" maxWidth="!max-w-xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose what to delete from the <span className="font-medium text-foreground">{backend.flavor}</span> backend
          in <span className="font-mono text-foreground">{backend.namespace}</span>. Everything is selected by default,
          turn off the namespace to keep it, or the volume to keep the collected history.
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Delete {selected.length} of {docs.length} resources
          </span>
          <ul
            className="max-h-64 space-y-0.5 overflow-auto rounded-lg p-1.5 text-xs"
            style={{ background: "#08080A", border: "1px solid #26272B" }}
          >
            {docs.map((r) => {
              const on = isOn(r);
              return (
                <li
                  key={keyOf(r)}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 font-mono"
                  style={{ opacity: on ? 1 : 0.45 }}
                >
                  <Switch checked={on} onCheckedChange={() => toggle(r)} />
                  <span className="shrink-0 font-semibold" style={{ color: on ? "var(--destructive)" : "var(--fg-tertiary)" }}>
                    {r.kind}
                  </span>
                  <span className="truncate text-foreground/90">{r.name || "—"}</span>
                  {r.namespace && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{r.namespace}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {cascadeWarning && (
          <p className="rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(245,158,11,0.1)", color: "#f59e0b" }}>
            Deleting the namespace also removes everything inside it, including the resources you turned off.
          </p>
        )}

        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </div>

      {/* Footer — full-bleed hairline, breaking out of the Modal body padding. */}
      <div className="-mx-6 -mb-7 mt-6 flex items-center justify-end gap-2 border-t border-white/[0.07] px-6 py-3.5">
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={handleRemove} disabled={pending || selected.length === 0}>
          <Trash2 className="size-3.5" />
          {pending ? "Removing…" : `Remove ${selected.length} resource${selected.length === 1 ? "" : "s"}`}
        </Button>
      </div>
    </Modal>
  );
}
