import { SectionCard } from "./SectionCard";

interface MetaChipsProps {
  title: string;
  entries?: Record<string, string> | null;
}

/**
 * A titled card of key/value chips for k8s labels or annotations. Long values
 * (e.g. `last-applied-configuration`) truncate, with the full `key: value` in
 * the title tooltip. Renders nothing when there are no entries.
 */
export function MetaChips({ title, entries }: MetaChipsProps) {
  const items = Object.entries(entries ?? {});
  if (items.length === 0) return null;
  return (
    <SectionCard title={title} count={items.length}>
      <div className="flex flex-wrap gap-1.5">
        {items.map(([k, v]) => {
          const text = v ? `${k}: ${v}` : k;
          return (
            <span
              key={k}
              title={text}
              className="max-w-full truncate rounded px-2 py-1 font-mono text-[11px] text-muted-foreground"
              style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </SectionCard>
  );
}
