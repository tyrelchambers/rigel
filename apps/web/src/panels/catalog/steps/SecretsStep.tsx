import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { generateSecret, type SecretFieldSpec } from "@helmsman/catalog";
import { Button } from "@/components/ui/button";

/**
 * Step 3 — Secrets. One field per placeholder. User fields gate Continue;
 * random fields are pre-filled and regenerable. (docs/parity/catalog.md §"Step 3")
 */
export function SecretsStep({
  specs,
  values,
  setValues,
  canContinue,
  onContinue,
  onBack,
}: {
  specs: SecretFieldSpec[];
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  canContinue: boolean;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const set = (key: string, value: string) => setValues({ ...values, [key]: value });
  const fieldClass =
    "w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        This install needs the following values. Required fields must be filled before you
        continue.
      </p>
      {specs.map((s) => {
        const required = s.required ?? true;
        return (
          <div key={s.key} className="space-y-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              {s.label}
              {required && <span className="text-destructive">*</span>}
            </label>
            {s.description && <p className="text-xs text-muted-foreground/80">{s.description}</p>}
            <div className="flex items-center gap-1">
              <input
                className={fieldClass}
                value={values[s.key] ?? ""}
                onChange={(e) => set(s.key, e.target.value)}
                placeholder={s.kind === "random" ? "(generated)" : ""}
              />
              {s.kind === "random" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Regenerate"
                  onClick={() => set(s.key, generateSecret(s.length ?? 32, s.format ?? "alphanumeric"))}
                >
                  <RefreshCw />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy"
                onClick={() => {
                  navigator.clipboard?.writeText(values[s.key] ?? "");
                  setCopied(s.key);
                  setTimeout(() => setCopied(null), 1200);
                }}
              >
                <Copy />
              </Button>
            </div>
            {copied === s.key && <span className="text-xs text-muted-foreground">copied</span>}
          </div>
        );
      })}
      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={!canContinue} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
