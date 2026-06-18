import { Plus, Minus } from "lucide-react";
import type { Secret, ConfigMap } from "@helmsman/k8s";
import { Button } from "@/components/ui/button";
import type { EnvRefEdit } from "./deploymentDisplay";

// ---------------------------------------------------------------------------
// EnvRefEditor — per-container editor for env vars sourced from a Secret or
// ConfigMap key (valueFrom.{secretKeyRef|configMapKeyRef}). Each row: env name,
// source toggle, resource picker (live from the namespace), and key picker
// (keys read from the chosen resource's `data`). Mirrors Rancher's
// "Add Variable → From Resource". Rows are keyed by stable ids so a keystroke
// doesn't steal focus. Diffed by `diffDeployment` into a `setEnvRef` patch.
// ---------------------------------------------------------------------------

const inputClass =
  "rounded-md border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-ring";
const selectClass =
  "rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

let refSeq = 0;
function blankRef(): EnvRefEdit {
  return { id: `ref-${refSeq++}`, name: "", source: "secret", resourceName: "", key: "" };
}

export interface EnvRefEditorProps {
  rows: EnvRefEdit[];
  secrets: Secret[];
  configMaps: ConfigMap[];
  onChange: (rows: EnvRefEdit[]) => void;
}

export function EnvRefEditor({ rows, secrets, configMaps, onChange }: EnvRefEditorProps) {
  function update(idx: number, patch: Partial<EnvRefEdit>) {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function resourcesFor(source: EnvRefEdit["source"]) {
    return source === "configMap" ? configMaps : secrets;
  }
  function keysFor(row: EnvRefEdit): string[] {
    const r = resourcesFor(row.source).find((x) => x.metadata.name === row.resourceName);
    return r?.data ? Object.keys(r.data).sort() : [];
  }

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background/40 p-2">
          <input
            value={row.name}
            placeholder="ENV_NAME"
            onChange={(e) => update(idx, { name: e.target.value })}
            className={`${inputClass} min-w-[120px] flex-1`}
            aria-label="env name"
          />
          <select
            value={row.source}
            onChange={(e) => update(idx, { source: e.target.value as EnvRefEdit["source"], resourceName: "", key: "" })}
            className={selectClass}
            aria-label="source"
          >
            <option value="secret">Secret</option>
            <option value="configMap">ConfigMap</option>
          </select>
          <select
            value={row.resourceName}
            onChange={(e) => update(idx, { resourceName: e.target.value, key: "" })}
            className={selectClass}
            aria-label="resource"
          >
            <option value="">— select —</option>
            {resourcesFor(row.source).map((r) => (
              <option key={r.metadata.name} value={r.metadata.name}>{r.metadata.name}</option>
            ))}
          </select>
          <select
            value={row.key}
            onChange={(e) => update(idx, { key: e.target.value })}
            className={selectClass}
            aria-label="key"
            disabled={!row.resourceName}
          >
            <option value="">— key —</option>
            {keysFor(row).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${row.name || "reference"}`}
            onClick={() => onChange(rows.filter((_, i) => i !== idx))}
          >
            <Minus className="size-4 text-destructive" aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, blankRef()])}>
        <Plus className="size-3.5" aria-hidden /> Add reference
      </Button>
    </div>
  );
}
