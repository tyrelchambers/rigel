import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { EventBucket, EventTypeFilter, K8sEvent } from "./types";
import {
  absoluteWhen,
  eventBuckets,
  matchesSearch,
  matchesTypeFilter,
  relativeAge,
  sortEvents,
  typeColorClass,
  when,
} from "./eventsDisplay";

// ---------------------------------------------------------------------------
// DEFERRED (docs/parity/events.md). This is a READ-ONLY, presentation-only
// panel. The following are intentionally NOT implemented and must NOT be added
// without a new feature spec + infra:
//   - "Ask Claude about this event" context menu (needs an event-diagnostics
//     context builder — separate handoff spec).
//   - Timeline drilldown (the ribbon is display-only).
//   - Any mutation (events are read-only; no edit/delete/create).
//   - Client-side persistence (events are ephemeral, ~1h K8s TTL).
// ---------------------------------------------------------------------------

const TIMELINE_SPAN_SECONDS = 3600;
const TIMELINE_BUCKETS = 60;

const FILTERS: EventTypeFilter[] = ["All", "Warning", "Normal"];

/** Active-pill background/text per filter. Inactive pills share a muted look. */
function filterPillClass(filter: EventTypeFilter, active: boolean): string {
  if (!active) {
    return "bg-muted text-muted-foreground border border-border";
  }
  switch (filter) {
    case "Warning":
      return "bg-red-600 text-white border border-red-600";
    case "Normal":
      return "bg-green-600 text-white border border-green-600";
    default:
      return "bg-secondary text-secondary-foreground border border-secondary";
  }
}

export default function EventsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  // Initial filter state is "Warning" per the Swift EventsViewModel.
  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>("Warning");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Subscribe to the events watch for the active namespace (or all). `null`
  // namespace → "*" (all namespaces).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("events", ns);
    return () => unsubscribe("events", ns);
  }, [namespaceFilter]);

  // All events from the store, sorted newest-first. The store keys events by
  // metadata.name (unique); we read the values and dedupe/sort here.
  const allEvents = useMemo(
    () => sortEvents(Object.values((resources["events"] ?? {}) as Record<string, K8sEvent>)),
    [resources],
  );

  // Namespace scope: when a specific namespace is active, drop events whose
  // involvedObject is in another namespace. `null` (all namespaces) keeps all.
  const scoped = useMemo(() => {
    if (namespaceFilter == null) return allEvents;
    return allEvents.filter((e) => e.involvedObject?.namespace === namespaceFilter);
  }, [allEvents, namespaceFilter]);

  // The timeline ribbon reflects the namespace scope but NOT the type filter or
  // search, so it always shows the full warning/normal mix in the window.
  const buckets = useMemo(
    () => eventBuckets(scoped, Date.now(), TIMELINE_SPAN_SECONDS, TIMELINE_BUCKETS),
    [scoped],
  );

  // List rows: namespace scope + type filter + search.
  const filtered = useMemo(
    () =>
      scoped.filter(
        (e) => matchesTypeFilter(e, typeFilter) && matchesSearch(e, search),
      ),
    [scoped, typeFilter, search],
  );

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Events</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {filtered.length}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events…"
          className="ml-auto w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setTypeFilter(f)}
            className={cn(
              "rounded px-2 py-[3px] font-mono text-[10px] font-medium",
              filterPillClass(f, typeFilter === f),
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Error banner — below filter bar, above timeline/list */}
      {error && (
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Timeline ribbon — 1h span, 60 stacked warning/normal buckets */}
      <EventTimeline buckets={buckets} />

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[64px]">Age</TableHead>
            <TableHead className="w-[56px]">Count</TableHead>
            <TableHead className="w-[80px]">Type</TableHead>
            <TableHead className="w-[150px]">Reason</TableHead>
            <TableHead className="w-[220px]">Involved Object</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((event) => (
            <EventRow
              key={event.metadata.uid}
              event={event}
              expanded={expanded.has(event.metadata.uid)}
              onToggle={() => toggleExpand(event.metadata.uid)}
            />
          ))}
        </TableBody>
      </Table>

      {/* Empty state — header/filter/timeline still render above */}
      {!isLoading && filtered.length === 0 && (
        <p className="px-2 py-4 text-sm text-muted-foreground">No events found</p>
      )}
    </div>
  );
}

/** A single event row. Age column stacks relative age + "×N" count below it. */
function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: K8sEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ts = when(event);
  const age = relativeAge(ts);
  const tooltip = absoluteWhen(ts) ?? undefined;
  const count = event.count ?? 0;
  const message = event.message ?? "—";

  return (
    <TableRow className="align-top">
      {/* Age */}
      <TableCell className="h-[70px] font-mono text-muted-foreground">
        <span title={tooltip}>{age}</span>
      </TableCell>

      {/* Count — "×N" only when count > 1, muted/secondary */}
      <TableCell className="font-mono text-xs text-muted-foreground">
        {count > 1 ? <span className="font-semibold">×{count}</span> : null}
      </TableCell>

      {/* Type badge */}
      <TableCell>
        {event.type == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase",
              typeColorClass(event.type),
            )}
          >
            {event.type}
          </span>
        )}
      </TableCell>

      {/* Reason */}
      <TableCell className="max-w-[150px] truncate font-mono">
        {event.reason ?? <span className="text-muted-foreground">—</span>}
      </TableCell>

      {/* Involved object */}
      <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
        {involvedObjectLabel(event)}
      </TableCell>

      {/* Message — click toggles single-line ↔ multi-line */}
      <TableCell
        onClick={onToggle}
        className={cn(
          "cursor-pointer select-text font-mono",
          expanded ? "whitespace-pre-wrap break-words" : "max-w-0 truncate",
        )}
        title={expanded ? undefined : "Click to expand"}
      >
        {message}
      </TableCell>
    </TableRow>
  );
}

/** "kind/name" or "kind/name · namespace"; "—" if no name. */
function involvedObjectLabel(event: K8sEvent): string {
  const io = event.involvedObject;
  const name = io?.name ?? "";
  if (name === "") return "—";
  const kind = io?.kind ?? "";
  const base = kind ? `${kind}/${name}` : name;
  const ns = io?.namespace;
  return ns ? `${base} · ${ns}` : base;
}

/** Stacked warning(red)/normal(green) histogram over the 1-hour window. */
function EventTimeline({ buckets }: { buckets: EventBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.warnings + b.normal));
  return (
    <div className="flex h-12 items-end gap-px rounded-md border bg-muted/30 p-1">
      {buckets.map((b) => {
        const total = b.warnings + b.normal;
        const warnPct = (b.warnings / max) * 100;
        const normPct = (b.normal / max) * 100;
        return (
          <div
            key={b.index}
            className="flex flex-1 flex-col justify-end"
            title={
              total > 0
                ? `${b.warnings} warning, ${b.normal} normal`
                : undefined
            }
          >
            <div className="bg-green-600" style={{ height: `${normPct}%` }} />
            <div className="bg-red-600" style={{ height: `${warnPct}%` }} />
          </div>
        );
      })}
    </div>
  );
}
