// NamespaceMultiSelect — pick one or more namespaces from the cluster's real
// list (fed by the shared WebSocket watch, same source as the NamespaceBar) so
// the user never has to type a namespace by hand. Empty selection means "all".
// Controlled: value (string[]) + onChange.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Check, X, Search } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

export function NamespaceMultiSelect({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Monitor namespaces",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const resources = useCluster((s) => s.resources);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Own the namespaces watch while mounted so the list is populated here too.
  useEffect(() => {
    subscribe("namespaces", "*");
    return () => unsubscribe("namespaces", "*");
  }, []);

  // Options = cluster namespaces unioned with the current selection, so a chosen
  // namespace always appears even if the watch hasn't delivered it yet.
  const options = useMemo(() => {
    const fromCluster = Object.keys(resources["namespaces"] ?? {});
    return Array.from(new Set([...fromCluster, ...value])).sort((a, b) => a.localeCompare(b));
  }, [resources, value]);

  const filtered = query
    ? options.filter((ns) => ns.toLowerCase().includes(query.toLowerCase()))
    : options;

  function toggle(ns: string) {
    onChange(value.includes(ns) ? value.filter((n) => n !== ns) : [...value, ns]);
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      >
        <span className="flex flex-1 flex-wrap items-center gap-1.5">
          {value.length === 0 ? (
            <span className="text-muted-foreground">All namespaces</span>
          ) : (
            value.map((ns) => (
              <span
                key={ns}
                className="inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
              >
                {ns}
                <X
                  className="size-3 text-muted-foreground hover:text-foreground"
                  role="button"
                  aria-label={`Remove ${ns}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!disabled) toggle(ns);
                  }}
                />
              </span>
            ))
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* Click-away overlay */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-lg">
            <div className="flex items-center gap-2 border-b px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter namespaces…"
                aria-label="Filter namespaces"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              <Row label="All namespaces" selected={value.length === 0} onSelect={() => onChange([])} />
              {filtered.map((ns) => (
                <Row key={ns} label={ns} mono selected={value.includes(ns)} onSelect={() => toggle(ns)} />
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-2 text-xs italic text-muted-foreground">No matches</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  selected,
  onSelect,
  mono = false,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <Check className={`size-3.5 shrink-0 ${selected ? "text-primary" : "text-transparent"}`} />
      <span className={`${mono ? "font-mono" : ""} ${selected ? "font-semibold" : ""}`}>{label}</span>
    </button>
  );
}
