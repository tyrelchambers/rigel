import { useState } from "react";
import { X, Plus } from "lucide-react";

interface Props {
  label: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  danger?: (t: string) => boolean;
  placeholder?: string;
}

/** A labelled removable-chip list with an add input. */
export function TokenInput({ label, tokens, onChange, danger, placeholder }: Props) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (v && !tokens.includes(v)) onChange([...tokens, v]);
    setDraft("");
  }
  return (
    <div className="flex w-full items-start gap-[10px]">
      <span className="w-[78px] shrink-0 pt-1.5 font-[var(--font-mono)] text-[9.5px] tracking-[0.6px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-[6px]">
        {tokens.map((t) => (
          <span
            key={t}
            className={`flex items-center gap-[5px] rounded-[var(--radius-sm)] border bg-[var(--surface-elevated)] px-[7px] py-[3px] font-[var(--font-mono)] text-[11px] ${
              danger?.(t)
                ? "border-[var(--status-failed)]/25 text-[var(--status-failed)]"
                : "border-[var(--border-subtle)] text-[var(--fg-secondary)]"
            }`}
          >
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tokens.filter((x) => x !== t))}>
              <X className="size-[10px] text-[var(--fg-tertiary)]" />
            </button>
          </span>
        ))}
        <span className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-[7px] py-[3px]">
          <Plus className="size-[10px] text-[var(--fg-tertiary)]" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
            placeholder={placeholder ?? "add"}
            aria-label={`Add ${label}`}
            className="w-16 bg-transparent font-[var(--font-mono)] text-[11px] text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
          />
        </span>
      </div>
    </div>
  );
}
