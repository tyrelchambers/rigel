import { useState } from "react";
import { Download, ChevronUp, ChevronDown, Timer, Code } from "lucide-react";
import type { ClusterAddon, AddonField } from "@rigel/catalog";
import { buildHelmValues } from "@rigel/catalog";
import { Dialog, DialogContent, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NamespaceField } from "@/components/NamespaceField";
import { cn } from "@/lib/utils";
import { useInstallHelm } from "@/panels/catalog/installApi";
import { useInstallMetricsServer } from "@/lib/api";
import { pluginIcon } from "./pluginIcon";
import { intervalToCron, cronToInterval, humanEvery, SCHEDULE_PRESETS, INTERVAL_MAX, type IntervalUnit } from "./schedule";

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
  if (field.type === "interval") {
    return <IntervalField label={field.label} verb={field.summaryVerb ?? "Runs"} value={String(value)} onChange={onChange} />;
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
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} className={INPUT_CLS} />
      )}
      {field.help && <span className="text-2xs text-[var(--fg-tertiary)]">{field.help}</span>}
    </label>
  );
}

/**
 * Cron-free schedule picker: an "Every N minutes/hours/days" control (number
 * with steppers + unit select), quick-pick preset pills, and a helper line
 * summarizing the cadence with a mono cron readout. Value is a cron string.
 */
function IntervalField({ label, verb, value, onChange }: {
  label: string; verb: string; value: string; onChange: (cron: string) => void;
}) {
  const { amount, unit } = cronToInterval(value);
  const setAmount = (n: number) => onChange(intervalToCron(n, unit));

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-semibold text-[var(--fg-primary)]">{label}</span>

      <div className="flex items-center gap-2.5">
        <span className="text-sm text-[var(--fg-secondary)]">Every</span>

        <div className="flex h-10 w-[104px] items-center overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
          <input
            type="number"
            min={1}
            max={INTERVAL_MAX[unit]}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="Schedule interval amount"
            className="w-full min-w-0 bg-transparent px-3 font-mono text-[15px] font-medium text-[var(--fg-primary)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <div className="flex h-full w-7 flex-col border-l border-[var(--border-subtle)]">
            <button type="button" aria-label="Increase interval" onClick={() => setAmount(amount + 1)} className="flex flex-1 items-center justify-center text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]">
              <ChevronUp className="size-3" />
            </button>
            <div className="h-px bg-[var(--border-subtle)]" />
            <button type="button" aria-label="Decrease interval" onClick={() => setAmount(amount - 1)} className="flex flex-1 items-center justify-center text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]">
              <ChevronDown className="size-3" />
            </button>
          </div>
        </div>

        <div className="relative h-10 w-[138px]">
          <select
            value={unit}
            onChange={(e) => onChange(intervalToCron(amount, e.target.value as IntervalUnit))}
            aria-label="Schedule interval unit"
            className="h-full w-full appearance-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] pr-9 pl-3 text-sm text-[var(--fg-primary)] outline-none focus:ring-2 focus:ring-ring/50"
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-[var(--fg-tertiary)]" />
        </div>
      </div>

      <div className="flex flex-wrap gap-[7px]">
        {SCHEDULE_PRESETS.map((p) => {
          const active = p.cron === value;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.cron)}
              className={cn(
                "rounded-[4px] border px-3 py-[5px] font-mono text-xs",
                active
                  ? "border-[var(--accent-primary)] bg-[var(--accent-dim)] font-semibold text-[var(--accent-primary)]"
                  : "border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Timer className="size-[13px] shrink-0 text-[var(--fg-tertiary)]" aria-hidden />
        <span className="text-xs text-[var(--fg-tertiary)]">{verb} {humanEvery(amount, unit)}.</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--border-subtle)] bg-white/[0.03] px-2 py-0.5" title="Cron expression">
          <Code className="size-[11px] text-[var(--fg-tertiary)]" aria-hidden />
          <span className="font-mono text-2xs text-[var(--fg-tertiary)]">{value}</span>
        </span>
      </div>
    </div>
  );
}
