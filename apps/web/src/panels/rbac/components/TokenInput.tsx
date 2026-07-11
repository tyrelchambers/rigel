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
    <div className="flex w-full items-start gap-[7px]">
      <span
        className="w-[96px] shrink-0 pt-[5px] font-[var(--font-mono)] text-[10.5px] tracking-[0.8px] uppercase"
        style={{ color: "#6B6B73" }}
      >
        {label}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-[7px]">
        {tokens.map((t) => {
          const isDanger = danger?.(t) ?? false;
          return (
            <span
              key={t}
              className="flex items-center gap-[5px] rounded-[5px] px-[8px] py-[3px] font-[var(--font-mono)] text-[12px]"
              style={isDanger ? { background: "#F871711A", color: "#F87171" } : { background: "#FFFFFF0D", color: "#D4D4D8" }}
            >
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tokens.filter((x) => x !== t))}>
                <X className="size-[11px]" style={{ color: isDanger ? "#F87171" : "#6B6B73" }} />
              </button>
            </span>
          );
        })}
        <span
          className="flex items-center gap-[4px] rounded-[5px] border px-[8px] py-[3px]"
          style={{ borderColor: "#26272B" }}
        >
          <Plus className="size-[11px]" style={{ color: "#6B6B73" }} />
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
            className="w-14 bg-transparent font-[var(--font-mono)] text-[12px] text-white outline-none placeholder:text-[#6B6B73]"
          />
        </span>
      </div>
    </div>
  );
}
