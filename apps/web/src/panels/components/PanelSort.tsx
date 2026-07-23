import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUp, faArrowDown } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { PanelSelect } from "./PanelSelect";

export interface SortOption<T> {
  value: string;
  label: string;
  compare: (a: T, b: T) => number;
}

export interface PanelSortProps<T> {
  options: SortOption<T>[];
  value: string;
  onValueChange: (v: string) => void;
  direction: "asc" | "desc";
  onDirectionChange: (d: "asc" | "desc") => void;
}

export function applySort<T>(
  items: T[],
  option: SortOption<T> | undefined,
  direction: "asc" | "desc",
): T[] {
  if (!option) return items;
  const sorted = [...items].sort(option.compare);
  return direction === "desc" ? sorted.reverse() : sorted;
}

export function PanelSort<T>({
  options,
  value,
  onValueChange,
  direction,
  onDirectionChange,
}: PanelSortProps<T>) {
  return (
    <div className="flex items-stretch gap-1">
      <PanelSelect value={value} onValueChange={onValueChange} ariaLabel="Sort by" className="max-w-44">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            Sort: {o.label}
          </option>
        ))}
      </PanelSelect>
      <button
        type="button"
        aria-label="Sort direction"
        title={direction === "asc" ? "Ascending" : "Descending"}
        onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
        className="flex w-9 items-center justify-center rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-foreground outline-none hover:bg-[var(--surface-elevated)] focus:ring-2 focus:ring-ring/50"
      >
        <FontAwesomeIcon icon={direction === "asc" ? faArrowUp : faArrowDown} className="text-xs" />
      </button>
    </div>
  );
}
