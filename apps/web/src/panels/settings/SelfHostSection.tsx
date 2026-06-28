// Self-host defaults section for the Settings page.
//
// Stores per-kubectl-context localStorage values fed into the catalog install
// wizard. No kubectl runs here.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  loadSelfHostDefaults,
  saveSelfHostDefaults,
  EMPTY_SELF_HOST_DEFAULTS,
  type SelfHostDefaults,
} from "./useSettings";

// The kubectl context keys the self-host localStorage. The server resolves the
// active context; absent a context endpoint we bucket under "default" so the
// round-trip is still isolated and stable.
function useKubectlContext(): string {
  return "default";
}

export function SelfHostSection() {
  const context = useKubectlContext();
  const [fields, setFields] = useState<SelfHostDefaults>(EMPTY_SELF_HOST_DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setFields(loadSelfHostDefaults(context));
    setSaved(false);
  }, [context]);

  function update(key: keyof SelfHostDefaults, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    setSaved(false); // editing resets the saved checkmark
  }

  function save() {
    saveSelfHostDefaults(context, fields);
    setFields(loadSelfHostDefaults(context)); // reflect the trimmed values
    setSaved(true);
  }

  const rows: Array<{ key: keyof SelfHostDefaults; label: string; placeholder: string }> = [
    { key: "ingressDomain", label: "Ingress domain", placeholder: "apps.example.com" },
    { key: "imagePullSecret", label: "Image pull secret", placeholder: "(none)" },
    { key: "redirectMiddleware", label: "Redirect middleware", placeholder: "(none)" },
    { key: "edgeIP", label: "Edge IP", placeholder: "(optional)" },
  ];

  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[var(--border-subtle)] bg-card p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-foreground">Self-hosted app defaults</h2>
        <span className="rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[11px] text-[var(--fg-tertiary)]">
          context: {context}
        </span>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Defaults the catalog install wizard fills in for new self-hosted apps. Stored on this machine
        per cluster context — nothing is written to the cluster.
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        {rows.map(({ key, label, placeholder }) => (
          <label key={key} className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <input
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-foreground outline-none placeholder:text-[var(--fg-tertiary)] focus:border-primary"
              placeholder={placeholder}
              value={fields[key]}
              onChange={(e) => update(key, e.target.value)}
            />
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-[var(--fg-tertiary)]">Saved on this machine only.</span>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-[var(--status-running)]">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <Button size="sm" onClick={save}>
            Save defaults
          </Button>
        </div>
      </div>
    </div>
  );
}
