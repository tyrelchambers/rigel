import { Plus, Minus, FileLock2 } from "lucide-react";
import type { KVRow } from "@rigel/k8s";
import { blankRow } from "@rigel/k8s";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// KeyValueEditor — shared key/value row editor for the ConfigMap + Secret
// create/edit forms (docs/parity/configmap-secret-edit.md). Each row is a key
// input + a multi-line value textarea, with add/remove controls. Mirrors the
// Swift `ConfigMapEditorSheet`/`SecretEditorSheet` data-block layouts.
//
// `readonlyKeyNames` pins canonical keys (typed Secrets) so their key inputs are
// read-only and rows can't be removed. Binary rows (`row.binary`) render their
// value read-only as `<binary, N bytes>` and cannot be re-encoded.
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-md border bg-background px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed";

export interface KeyValueEditorProps {
  rows: KVRow[];
  onRowsChange: (rows: KVRow[]) => void;
  /** Key names whose key input is read-only and whose row cannot be removed. */
  readonlyKeyNames?: string[];
  /** Hide the add/remove controls (fixed canonical layout, e.g. typed secrets). */
  fixedRows?: boolean;
  /** Placeholder for the key input. */
  keyPlaceholder?: string;
  /** Mask value inputs (secret values). Multi-line is disabled when masked. */
  maskValues?: boolean;
}

export function KeyValueEditor({
  rows,
  onRowsChange,
  readonlyKeyNames = [],
  fixedRows = false,
  keyPlaceholder = "key (e.g. app.conf)",
  maskValues = false,
}: KeyValueEditorProps) {
  const readonlyKeys = new Set(readonlyKeyNames);

  function update(idx: number, patch: Partial<KVRow>) {
    onRowsChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    onRowsChange([...rows, blankRow()]);
  }
  function removeRow(idx: number) {
    onRowsChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      {rows.map((r, idx) => {
        const keyReadonly = readonlyKeys.has(r.key);
        const isBinary = r.binary != null;
        const canRemove = !fixedRows && !keyReadonly && rows.length > 1;
        return (
          <div key={r.id} className="rounded-md border bg-background/40 p-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={r.key}
                placeholder={keyPlaceholder}
                disabled={keyReadonly}
                onChange={(e) => update(idx, { key: e.target.value })}
                className={inputClass}
                aria-label="key"
              />
              {canRemove && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${r.key || "row"}`}
                  onClick={() => removeRow(idx)}
                >
                  <Minus className="size-4 text-destructive" aria-hidden />
                </Button>
              )}
            </div>

            {isBinary ? (
              <p className="mt-1.5 flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs font-mono text-muted-foreground/70">
                <FileLock2 className="size-3.5" aria-hidden />
                {`<binary, ${r.binary!.bytes} bytes>`}
                <span className="ml-auto text-[10px] uppercase tracking-wide">read-only</span>
              </p>
            ) : maskValues ? (
              <input
                type="password"
                value={r.value}
                placeholder="value"
                onChange={(e) => update(idx, { value: e.target.value })}
                className={`${inputClass} mt-1.5`}
                aria-label="value"
              />
            ) : (
              <textarea
                value={r.value}
                placeholder="value"
                rows={Math.min(8, Math.max(2, r.value.split("\n").length))}
                onChange={(e) => update(idx, { value: e.target.value })}
                className={`${inputClass} mt-1.5 max-h-[200px] resize-y`}
                aria-label="value"
              />
            )}
          </div>
        );
      })}

      {!fixedRows && (
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="size-3.5" aria-hidden /> Add key
        </Button>
      )}
    </div>
  );
}
