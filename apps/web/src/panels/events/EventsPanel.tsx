import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { cn } from "@/lib/utils";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { viewYaml } from "@/store/yamlViewer";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Trash2 } from "lucide-react";
import type { EventBucket, EventTypeFilter, K8sEvent } from "./types";
import {
  absoluteWhen,
  eventBuckets,
  matchesSearch,
  matchesTypeFilter,
  relativeAge,
  sortEvents,
  when,
} from "./eventsDisplay";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";

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

/** Map event type to a StatusBadge variant. */
function eventVariant(type: string | null | undefined): StatusBadgeVariant {
  if (type === "Warning") return "error";
  return "neutral";
}

/**
 * Local time range covering one timeline bucket, e.g. "2:15 - 2:16 PM".
 * `start` is epoch ms; each bucket spans 60s. Drops the meridiem on the start
 * time when both ends share it, so the range reads cleanly.
 */
function bucketTimeRange(start: number): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const from = new Date(start).toLocaleTimeString(undefined, opts);
  const to = new Date(start + 60_000).toLocaleTimeString(undefined, opts);
  // "2:15 PM" + "2:16 PM" → "2:15 - 2:16 PM" when both share the meridiem.
  // Split on any whitespace: ICU emits a narrow no-break space (U+202F)
  // before the meridiem in many locales, not a plain space.
  const fromParts = from.split(/\s/);
  const toParts = to.split(/\s/);
  if (fromParts.length === 2 && toParts.length === 2 && fromParts[1] === toParts[1]) {
    return `${fromParts[0]} - ${to}`;
  }
  return `${from} - ${to}`;
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

export default function EventsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const clearKind = useCluster((s) => s.clearKind);

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

  // All events from the store, sorted newest-first.
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
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Events"
        subtitle="Cluster activity stream"
        count={filtered.length}
        loading={isLoading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {/*
          Clears the LOCAL view only. Kubernetes events are ephemeral and
          re-stream from the server watch, so this does not delete Event objects
          server-side; the next snapshot/delta may repopulate the list.
        */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={allEvents.length === 0}
          onClick={() => clearKind("events")}
        >
          <Trash2 className="size-3.5" /> Clear
        </Button>
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Filter bar */}
      <div
        className="flex items-center gap-2 px-4 py-2"
        style={{ borderBottom: "1px solid #26272B" }}
      >
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
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Timeline ribbon — 1h span, 60 stacked warning/normal buckets */}
      <div className="px-3 pt-2 pb-1">
        <EventTimeline buckets={buckets} />
      </div>

      {/* Row list — compact, no per-row chat strip */}
      <div className="flex flex-col gap-0.5 px-3 py-1">
        {filtered.map((event) => {
          const k = event.metadata.uid;
          const isOpen = expanded.has(k);
          const ts = when(event);
          const age = relativeAge(ts);
          const tooltip = absoluteWhen(ts) ?? undefined;
          const count = event.count ?? 0;
          const reason = event.reason ?? "—";
          const message = event.message ?? "—";
          const objLabel = involvedObjectLabel(event);

          const rowMenu = (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() =>
                  viewYaml("event", event.metadata.name, event.metadata.namespace)
                }
              >
                View YAML…
              </ContextMenuItem>
              <ContextMenuItem onClick={() => toggleExpand(k)}>
                {isOpen ? "Collapse" : "Details…"}
              </ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggleExpand(k)}
              contextMenu={rowMenu}
              expandedContent={
                <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words">
                  {message}
                </div>
              }
            >
              {/* Type badge — Warning→error, Normal/other→neutral */}
              <StatusBadge
                label={event.type ?? "—"}
                variant={eventVariant(event.type)}
              />

              {/* Reason — monospace */}
              <span
                className="shrink-0 font-mono text-xs font-medium leading-none text-foreground"
                style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={reason}
              >
                {reason}
              </span>

              {/* Involved object — dim */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  flexShrink: 1,
                }}
                title={objLabel}
              >
                {objLabel}
              </span>

              {/* Message — truncated in collapsed state */}
              {!isOpen && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--fg-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flexShrink: 2,
                  }}
                  title={message}
                >
                  {message}
                </span>
              )}

              <span className="flex-1" />

              {/* Count "×N" when > 1 — right-aligned */}
              {count > 1 && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--status-pending)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  ×{count}
                </span>
              )}

              {/* Age — right-aligned */}
              <span
                title={tooltip}
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {age}
              </span>
            </ListRow>
          );
        })}
      </div>

      {/* Empty state — header/filter/timeline still render above */}
      {!isLoading && filtered.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No events found</p>
      )}
      </div>
    </div>
  );
}

/** Stacked warning(red)/normal(green) histogram over the 1-hour window. */
function EventTimeline({ buckets }: { buckets: EventBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.warnings + b.normal));
  return (
    <div className="flex h-12 items-stretch gap-px rounded-md border bg-muted/30 p-1">
      {buckets.map((b) => (
        <TimelineBar key={b.index} bucket={b} max={max} />
      ))}
    </div>
  );
}

/**
 * One timeline bar. Empty buckets are inert (no popover, no pointer). Buckets
 * with events become a Popover trigger that reveals a compact detail card on
 * hover (Base UI `openOnHover`), showing the bucket's local time range and the
 * warning/normal/total counts.
 */
function TimelineBar({ bucket, max }: { bucket: EventBucket; max: number }) {
  const total = bucket.warnings + bucket.normal;
  const warnPct = (bucket.warnings / max) * 100;
  const normPct = (bucket.normal / max) * 100;

  const stack = (
    <>
      <div className="bg-green-600" style={{ height: `${normPct}%` }} />
      <div className="bg-red-600" style={{ height: `${warnPct}%` }} />
    </>
  );

  // Empty bucket → plain, non-interactive column.
  if (total === 0) {
    return <div className="flex h-full flex-1 flex-col justify-end">{stack}</div>;
  }

  return (
    <Popover>
      {/*
        The bar div is the trigger. `nativeButton={false}` since the rendered
        element is a <div>, not a <button>. `openOnHover` reveals the detail on
        hover with a short delay; click still works as a fallback.
      */}
      <PopoverTrigger
        nativeButton={false}
        openOnHover
        delay={120}
        render={
          <div className="flex h-full flex-1 cursor-pointer flex-col justify-end rounded-[1px] outline-none transition-colors hover:bg-foreground/10 data-[popup-open]:bg-foreground/15" />
        }
      >
        {stack}
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto min-w-44 gap-1.5 p-2.5">
        <PopoverHeader>
          <PopoverTitle className="text-xs">{bucketTimeRange(bucket.start)}</PopoverTitle>
          <PopoverDescription className="text-[11px]">
            {total} event{total === 1 ? "" : "s"} this minute
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-0.5 font-mono text-[11px]">
          <span className="text-red-600">{bucket.warnings} warning{bucket.warnings === 1 ? "" : "s"}</span>
          <span className="text-green-600">{bucket.normal} normal</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
