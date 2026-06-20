// "Set up a metrics backend" dialog — ports Swift's MetricsInstallSheet.
// Configure VictoriaMetrics/Prometheus + storage, preview the manifest, then
// install. The apply itself goes through the shared ConfirmSheet (applyManifest)
// owned by the panel, so the exact `kubectl apply -f -` is shown before it runs.

import { useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { YamlEditor } from "@/components/YamlEditorLazy";
import { useCluster } from "@/store/cluster";
import {
  renderMetricsInstallManifest,
  resultingBackend,
  namespaceValid,
  type MetricsInstallBackend,
  type InstalledBackend,
} from "@rigel/k8s";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hand the rendered manifest + resulting backend to the panel to apply. */
  onInstall: (backend: InstalledBackend, yaml: string) => void;
}

const BACKENDS: Array<{ id: MetricsInstallBackend; title: string; note: string }> = [
  { id: "victoriaMetrics", title: "VictoriaMetrics", note: "Single-node, lightest footprint (~tens of MB)." },
  { id: "prometheus", title: "Prometheus", note: "Bare Prometheus, familiar, a few hundred MB." },
];

/** Small uppercase section label, shared by every block in the dialog. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** Elevated config card, matching the app's card surface (NodesPanel etc.). */
function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2.5 rounded-lg p-4"
      style={{ background: "var(--surface-elevated)", border: "1px solid #26272B" }}
    >
      {children}
    </div>
  );
}

export function MetricsInstallDialog({ open, onOpenChange, onInstall }: Props) {
  const [backend, setBackend] = useState<MetricsInstallBackend>("victoriaMetrics");
  const [namespace, setNamespace] = useState("rigel-metrics");
  const [persistent, setPersistent] = useState(true);
  const [sizeGiB, setSizeGiB] = useState(5);

  // Live namespaces from the cluster store (the panel's NamespaceSelector owns
  // the watch). Drives the combobox list; the field stays editable so a brand
  // new namespace (the rigel-metrics default) can still be typed and created.
  const resources = useCluster((s) => s.resources);
  const allNamespaces = Object.keys(resources["namespaces"] ?? {}).sort((a, b) => a.localeCompare(b));

  const ns = namespace.trim();
  const valid = namespaceValid(ns);
  const yaml = renderMetricsInstallManifest(backend, ns || "rigel-metrics", persistent, sizeGiB);
  const note = BACKENDS.find((b) => b.id === backend)?.note ?? "";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Set up a metrics backend" maxWidth="!max-w-3xl">
      <div className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Installs a lightweight, PromQL-compatible store that scrapes container usage continuously,
          so right-sizing has real history that survives reloads. Both options speak the same query API.
        </p>

        {/* Backend */}
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBackend(b.id)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  backend === b.id ? "border-primary bg-primary/10 text-foreground" : "hover:bg-white/[0.05]"
                }`}
              >
                {b.title}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">{note}</span>
        </div>

        {/* Config cards: namespace + storage */}
        <div className="grid grid-cols-2 gap-3">
          {/* Namespace */}
          <Card>
            <SectionLabel>Namespace</SectionLabel>
            <input
              type="text"
              list="metrics-ns-options"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              spellCheck={false}
              className={`w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring ${
                valid ? "" : "border-destructive"
              }`}
            />
            <datalist id="metrics-ns-options">
              {allNamespaces.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {valid ? (
              <span className="text-[11px] text-muted-foreground">
                Pick an existing namespace or type a new one to create.
              </span>
            ) : (
              <span className="text-[11px] text-destructive">Invalid namespace.</span>
            )}
          </Card>

          {/* Storage */}
          <Card>
            <SectionLabel>Storage</SectionLabel>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm">
              <Switch checked={persistent} onCheckedChange={setPersistent} />
              Persist to a PersistentVolume
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
              <span className="font-mono text-[11px] text-amber-500">
                Ephemeral storage: history resets if the backend pod restarts.
              </span>
            )}
          </Card>
        </div>

        {/* Manifest preview — read-only Monaco for proper YAML highlighting. */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Manifest</SectionLabel>
          <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--border-strong)" }}>
            <YamlEditor value={yaml} readOnly schema={null} height="260px" />
          </div>
        </div>
      </div>

      {/* Footer — full-bleed hairline, breaking out of the Modal body padding. */}
      <div className="-mx-6 -mb-7 mt-6 flex items-center justify-end gap-2 border-t border-white/[0.07] px-6 py-3.5">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={!valid} onClick={() => onInstall(resultingBackend(backend, ns), yaml)}>
          Install
        </Button>
      </div>
    </Modal>
  );
}
