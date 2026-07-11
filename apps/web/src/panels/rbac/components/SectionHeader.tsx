interface Props {
  label: string;
  count?: number;
}

export function SectionHeader({ label, count }: Props) {
  return (
    <div className="flex items-center gap-[10px]">
      <span
        className="font-[var(--font-mono)] text-[11px] font-medium tracking-[1px] uppercase"
        style={{ color: "#6B6B73" }}
      >
        {label}
      </span>
      {count != null && (
        <span className="font-[var(--font-mono)] text-[12px] font-semibold" style={{ color: "#A1A1AA" }}>
          {count}
        </span>
      )}
      <div className="h-px flex-1" style={{ background: "#26272B" }} />
    </div>
  );
}
