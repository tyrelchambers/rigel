import { useState } from "react";
import { Copy, RefreshCw, KeyRound, Check } from "lucide-react";
import { generateSecret, type SecretFieldSpec } from "@rigel/catalog";
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

  return (
    <div className="wiz-step">
      <div className="wiz-note">
        <KeyRound aria-hidden />
        <span>
          This app needs a value for each field below. Strong random values are pre-filled — keep
          them, regenerate, or type your own. Nothing is applied until you continue.
        </span>
      </div>

      <div className="wiz-fields">
        {specs.map((s) => {
          const required = s.required ?? true;
          const isRandom = s.kind === "random";
          return (
            <div key={s.key} className="wiz-field-card">
              <div className="wiz-field-head">
                <label className="wiz-field-label" htmlFor={`secret-${s.key}`}>
                  {s.label}
                  {required && <span className="req">*</span>}
                </label>
                <span className={`wiz-field-kind${isRandom ? " generated" : ""}`}>
                  {isRandom ? "generated" : "required"}
                </span>
              </div>
              {s.description && <p className="wiz-field-desc">{s.description}</p>}
              <div className="wiz-input-group">
                <input
                  id={`secret-${s.key}`}
                  className="wiz-input"
                  value={values[s.key] ?? ""}
                  onChange={(e) => set(s.key, e.target.value)}
                  placeholder={isRandom ? "(generated)" : "enter a value…"}
                />
                {isRandom && (
                  <button
                    type="button"
                    className="wiz-icon-btn"
                    aria-label="Regenerate"
                    title="Regenerate"
                    onClick={() => set(s.key, generateSecret(s.length ?? 32, s.format ?? "alphanumeric"))}
                  >
                    <RefreshCw />
                  </button>
                )}
                <button
                  type="button"
                  className="wiz-icon-btn"
                  aria-label="Copy"
                  title="Copy"
                  onClick={() => {
                    navigator.clipboard?.writeText(values[s.key] ?? "");
                    setCopied(s.key);
                    setTimeout(() => setCopied(null), 1200);
                  }}
                >
                  {copied === s.key ? <Check className="text-[#10B981]" /> : <Copy />}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="wiz-footer">
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
