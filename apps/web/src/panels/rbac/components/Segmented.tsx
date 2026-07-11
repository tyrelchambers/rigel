interface Props<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Segmented<T extends string>({ options, value, onChange, disabled, ariaLabel, className }: Props<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex shrink-0 gap-[2px] rounded-[6px] border p-[3px] ${disabled ? "opacity-60" : ""} ${className ?? ""}`}
      style={{ background: "#0C0D0F", borderColor: "#26272B" }}
    >
      {options.map((o) => {
        const selected = o === value;
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o)}
            className="rounded-[4px] px-[14px] py-[6px] text-xs whitespace-nowrap outline-none"
            style={
              selected
                ? { background: "#FFFFFF14", color: "#FFFFFF", fontWeight: 600 }
                : { background: "transparent", color: "#A1A1AA" }
            }
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
