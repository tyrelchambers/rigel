import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus } from "lucide-react";

interface Props {
  label: string;
  tokens: string[];
  onChange: (tokens: string[]) => void;
  danger?: (t: string) => boolean;
  placeholder?: string;
  /** Known values to offer as a filtered dropdown while typing. Free-typed
   *  values (e.g. "*" or unregistered CRDs) are still accepted. */
  suggestions?: string[];
}

const MAX_SUGGESTIONS = 8;

/** A labelled removable-chip list with an add input, optionally offering
 *  suggestions from a known set (still free-typable). */
export function TokenInput({ label, tokens, onChange, danger, placeholder, suggestions }: Props) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  function add(value?: string) {
    const v = (value ?? draft).trim();
    if (v && !tokens.includes(v)) onChange([...tokens, v]);
    setDraft("");
  }

  const filteredSuggestions = useMemo(() => {
    if (!suggestions?.length) return [];
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((s) => !tokens.includes(s))
      .filter((s) => !q || s.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [suggestions, tokens, draft]);

  const showDropdown = open && filteredSuggestions.length > 0;

  useLayoutEffect(() => {
    if (!showDropdown) return;
    function updatePosition() {
      const el = wrapperRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 160) });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [showDropdown]);

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
          ref={wrapperRef}
          className="relative flex items-center gap-[4px] rounded-[5px] border px-[8px] py-[3px]"
          style={{ borderColor: "#26272B" }}
        >
          <Plus className="size-[11px]" style={{ color: "#6B6B73" }} />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            onBlur={() => {
              add();
              setOpen(false);
            }}
            placeholder={placeholder ?? "add"}
            aria-label={`Add ${label}`}
            className="w-14 bg-transparent font-[var(--font-mono)] text-[12px] text-white outline-none placeholder:text-[#6B6B73]"
          />
          {showDropdown && rect &&
            createPortal(
              <div
                className="fixed z-[100] max-h-[180px] overflow-y-auto rounded-[6px] border py-[4px] shadow-lg"
                style={{ top: rect.top, left: rect.left, minWidth: rect.width, background: "#0C0D0F", borderColor: "#26272B" }}
              >
                {filteredSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      add(s);
                      inputRef.current?.focus();
                    }}
                    className="block w-full whitespace-nowrap px-[10px] py-[5px] text-left font-[var(--font-mono)] text-[12px] hover:bg-white/[0.06]"
                    style={{ color: "#D4D4D8" }}
                  >
                    {s}
                  </button>
                ))}
              </div>,
              document.body,
            )}
        </span>
      </div>
    </div>
  );
}
