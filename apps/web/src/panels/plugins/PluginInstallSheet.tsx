import { useState } from "react";
import type { ClusterAddon, AddonField } from "@rigel/catalog";
import { buildHelmValues } from "@rigel/catalog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NamespaceField } from "@/components/NamespaceField";
import { useInstallHelm } from "@/panels/catalog/installApi";
import { useInstallMetricsServer } from "@/lib/api";

function defaults(addon: ClusterAddon): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of addon.fields) out[f.key] = f.default;
  return out;
}

/** Field-collection dialog that installs a single add-on via the right executor. */
export function PluginInstallSheet({ addon, open, onClose, onDone }: {
  addon: ClusterAddon;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => defaults(addon));
  const helm = useInstallHelm();
  const metrics = useInstallMetricsServer();
  const pending = helm.isPending || metrics.isPending;
  const error = (helm.error ?? metrics.error)?.message ?? null;

  function set(key: string, v: string | boolean) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function install() {
    if (addon.install.mode === "metricsServer") {
      metrics.mutate(
        { kubeletInsecureTls: values.kubeletInsecureTls === true },
        { onSuccess: () => { onDone(); onClose(); } },
      );
      return;
    }
    const namespace = typeof values.namespace === "string" && values.namespace ? values.namespace : addon.install.namespace;
    helm.mutate(
      {
        repoName: addon.install.repoName,
        repoURL: addon.install.repoURL,
        chart: addon.install.chart,
        version: addon.install.version ?? null,
        releaseName: addon.install.releaseName,
        namespace,
        values: buildHelmValues(addon, values),
      },
      { onSuccess: () => { onDone(); onClose(); } },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Install ${addon.name}`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {addon.fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
          {error && <p role="alert" className="text-2xs text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={install} disabled={pending}>{pending ? "Installing…" : "Install"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ field, value, onChange }: { field: AddonField; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const cls = "h-8 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50";
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--fg-secondary)]">{field.label}</span>
      {field.type === "toggle" ? (
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="size-4" />
      ) : field.type === "select" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.type === "namespace" ? (
        <NamespaceField value={String(value)} onChange={onChange} />
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} className={cls} />
      )}
      {field.help && <span className="text-2xs text-[var(--fg-tertiary)]">{field.help}</span>}
    </label>
  );
}
