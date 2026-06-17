// "Set up a metrics backend" dialog — ports Swift's MetricsInstallSheet.
// Configure VictoriaMetrics/Prometheus + storage, preview the manifest, then
// install. The apply itself goes through the shared ConfirmSheet (applyManifest)
// owned by the panel, so the exact `kubectl apply -f -` is shown before it runs.

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  renderMetricsInstallManifest,
  resultingBackend,
  namespaceValid,
  type MetricsInstallBackend,
  type InstalledBackend,
} from "@helmsman/k8s";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand the rendered manifest + resulting backend to the panel to apply. */
  onInstall: (backend: InstalledBackend, yaml: string) => void;
}

const BACKENDS: Array<{ id: MetricsInstallBackend; title: string; note: string }> = [
  { id: "victoriaMetrics", title: "VictoriaMetrics", note: "Single-node — lightest footprint (~tens of MB)." },
  { id: "prometheus", title: "Prometheus", note: "Bare Prometheus — familiar, a few hundred MB." },
];

export function MetricsInstallDialog({ open, onOpenChange, onInstall }: Props) {
  const [backend, setBackend] = useState<MetricsInstallBackend>("victoriaMetrics");
  const [namespace, setNamespace] = useState("helmsman-metrics");
  const [persistent, setPersistent] = useState(true);
  const [sizeGiB, setSizeGiB] = useState(5);

  const ns = namespace.trim();
  const valid = namespaceValid(ns);
  const yaml = renderMetricsInstallManifest(backend, ns || "helmsman-metrics", persistent, sizeGiB);
  const note = BACKENDS.find((b) => b.id === backend)?.note ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Set up a metrics backend</DialogTitle>
          <DialogDescription>
            Installs a lightweight, PromQL-compatible store that scrapes container usage continuously,
            so right-sizing has real history that survives reloads. Both options speak the same query API.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Backend */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Backend</span>
            <div className="flex gap-2">
              {BACKENDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBackend(b.id)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    backend === b.id ? "border-primary bg-primary/10 text-foreground" : "hover:bg-muted"
                  }`}
                >
                  {b.title}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">{note}</span>
          </div>

          {/* Namespace */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Namespace</span>
            <input
              type="text"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className={`w-56 rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring ${
                valid ? "" : "border-destructive"
              }`}
            />
            {!valid && <span className="text-[11px] text-destructive">Invalid namespace</span>}
          </div>

          {/* Storage */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Storage</span>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
              Persist to a PersistentVolume (survives pod restarts)
            </label>
            {persistent ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Size
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={sizeGiB}
                  onChange={(e) => setSizeGiB(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  className="w-20 rounded-md border bg-background px-2 py-1 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                Gi
              </label>
            ) : (
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-amber-500">
                Ephemeral storage: history resets if the backend pod restarts.
              </span>
            )}
          </div>

          {/* Manifest preview */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Manifest (applied with kubectl apply -f -)
            </span>
            <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              {yaml}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => onInstall(resultingBackend(backend, ns), yaml)}
          >
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
