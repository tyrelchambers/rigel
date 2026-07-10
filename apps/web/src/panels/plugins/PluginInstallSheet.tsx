import { useState } from "react";
import { Download } from "lucide-react";
import type { ClusterAddon, AddonField } from "@rigel/catalog";
import { buildHelmValues } from "@rigel/catalog";
import { Dialog, DialogContent, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NamespaceField } from "@/components/NamespaceField";
import { useInstallHelm } from "@/panels/catalog/installApi";
import { useInstallMetricsServer } from "@/lib/api";
import { pluginIcon } from "./pluginIcon";
import { intervalToCron, cronToInterval, INTERVAL_MAX, type IntervalUnit } from "./schedule";

const INPUT_CLS = "h-8 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50";

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
  const Icon = pluginIcon(addon);

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
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogIcon
            background={false}
            className="size-[34px] rounded-lg bg-[var(--accent-dim)] text-[var(--accent-primary)] ring-1 ring-[color-mix(in_srgb,var(--accent-primary)_40%,transparent)]"
          >
            <Icon className="size-[18px]" />
          </DialogIcon>
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle>{`Install ${addon.name}`}</DialogTitle>
            <span className="font-mono text-2xs tracking-[0.5px] text-[var(--fg-tertiary)]">
              {addon.group} · cluster add-on
            </span>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[18px]">
          {addon.fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
          {error && <p role="alert" className="text-2xs text-[var(--status-failed)]">{error}</p>}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={install} disabled={pending}>
            {pending ? "Installing…" : <><Download className="size-4" /> Install</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ field, value, onChange }: { field: AddonField; value: string | boolean; onChange: (v: string | boolean) => void }) {
  if (field.type === "toggle") {
    return (
      <div className="flex items-center justify-between gap-3.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-[var(--fg-primary)]">{field.label}</span>
          {field.help && <span className="text-2xs text-[var(--fg-tertiary)]">{field.help}</span>}
        </div>
        <Switch checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--fg-secondary)]">{field.label}</span>
      {field.type === "select" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} className={INPUT_CLS}>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.type === "namespace" ? (
        <NamespaceField value={String(value)} onChange={onChange} />
      ) : field.type === "interval" ? (
        <IntervalField value={String(value)} onChange={onChange} />
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} className={INPUT_CLS} />
      )}
      {field.help && <span className="text-2xs text-[var(--fg-tertiary)]">{field.help}</span>}
    </label>
  );
}

/** "Every [N] [minutes/hours/days]" — edits a cron string without exposing cron. */
function IntervalField({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const { amount, unit } = cronToInterval(value);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--fg-tertiary)]">Every</span>
      <input
        type="number"
        min={1}
        max={INTERVAL_MAX[unit]}
        value={amount}
        onChange={(e) => onChange(intervalToCron(Number(e.target.value), unit))}
        className={`${INPUT_CLS} w-16 text-center`}
        aria-label="Schedule interval amount"
      />
      <select
        value={unit}
        onChange={(e) => onChange(intervalToCron(amount, e.target.value as IntervalUnit))}
        className={INPUT_CLS}
        aria-label="Schedule interval unit"
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </select>
    </div>
  );
}
