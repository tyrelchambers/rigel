import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faMagnifyingGlass,
  faAlignLeft,
  faHeartCrack,
  faPause,
  faTrashCan,
  faXmark,
  faArrowDown,
  faScroll,
  faSparkles,
  faAsterisk,
  faCircleExclamation,
  faClockRotateLeft,
  faDownload,
  faCopy,
  faBoxesStacked,
  faCube,
  faArrowsRotate,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCluster, filterByNamespace } from "@/store/cluster";
import {
  subscribe,
  unsubscribe,
  sendLogsStart,
  sendLogsStop,
  onLogLine,
  type LogStreamMessage,
} from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TabBar, Tab } from "@/components/ui/Tabs";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { LoadingState } from "@/panels/components/LoadingState";
import { type LogKind, type HealthState, type RawObj, LOG_KINDS, type SidebarItem, buildSidebarItems } from "./logTargets";
import {
  type LogLine,
  type LogLevel,
  toLogLine,
  appendLines,
  filterLines,
  buildLogQuery,
  detectLevel,
  splitHighlight,
  distinctPods,
  distinctContainers,
  sortByTimestamp,
  formatTimestamp,
  shortPodId,
  podColor,
  lineContext,
  streamStats,
  buildLogText,
  MAX_LINES,
} from "./logDisplay";

// An incoming focusRequest kind (singular) → the sidebar LogKind to open it under.
const FOCUS_LOG_KIND: Record<string, LogKind> = {
  pod: "pods",
  deployment: "deployments",
  statefulset: "statefulsets",
  daemonset: "daemonsets",
};

// Status-bar / pill accents keyed on a source's coarse run state.
const HEALTH: Record<HealthState, { label: string; color: string }> = {
  running: { label: "Running", color: "var(--status-running)" },
  degraded: { label: "Degraded", color: "var(--status-pending)" },
  stopped: { label: "Stopped", color: "var(--border-strong)" },
};

// Tinted pill classes for the source-row ready badge, by run state.
const HEALTH_PILL: Record<HealthState, string> = {
  running: "bg-[color-mix(in_oklab,var(--status-running)_14%,transparent)] text-[var(--status-running)]",
  degraded: "bg-[color-mix(in_oklab,var(--status-pending)_16%,transparent)] text-[var(--status-pending)]",
  stopped: "bg-white/[0.05] text-[var(--fg-tertiary)]",
};

// Per-line level chip: fixed-width badge fill + label + message text tint.
function levelBadge(level: LogLevel | null): { label: string; badge: string; text: string } {
  switch (level) {
    case "error":
      return { label: "ERROR", badge: "bg-[color-mix(in_oklab,var(--status-failed)_16%,transparent)] text-[#F87171]", text: "text-[#F87171]" };
    case "warn":
      return { label: "WARN", badge: "bg-[color-mix(in_oklab,var(--status-pending)_16%,transparent)] text-[#FBBF24]", text: "text-[#FBBF24]" };
    case "info":
      return { label: "INFO", badge: "bg-[var(--accent-dim)] text-[#7DD3FC]", text: "text-[var(--fg-secondary)]" };
    case "debug":
      return { label: "DEBUG", badge: "bg-white/[0.05] text-[var(--fg-tertiary)]", text: "text-[var(--fg-secondary)]" };
    default:
      return { label: "LOG", badge: "bg-white/[0.05] text-[var(--fg-tertiary)]", text: "text-[var(--fg-secondary)]" };
  }
}

export default function LogsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);
  const focusRequest = useCluster((s) => s.focusRequest);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);

  const [logKind, setLogKind] = useState<LogKind>("deployments");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<SidebarItem | null>(null);
  const [isolatedPod, setIsolatedPod] = useState("");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [hideProbes, setHideProbes] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [expandedLines, setExpandedLines] = useState<Set<string>>(new Set());
  const [selectedContainer, setSelectedContainer] = useState("");
  const [tailLines, setTailLines] = useState(200);
  const [since, setSince] = useState("");
  const [previous, setPrevious] = useState(false);
  const [droppedWhilePaused, setDroppedWhilePaused] = useState(0);
  const [pendingSource, setPendingSource] = useState<{ namespace: string; name: string } | null>(null);

  // Refs so the WS callback and scroll handlers read live values without
  // re-subscribing on every state change.
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  const stickRef = useRef(stickToBottom);
  stickRef.current = stickToBottom;
  const scrollRef = useRef<HTMLDivElement>(null);
  // True for the one scroll event our own scrollToIndex() triggers, so onScroll
  // doesn't misread a mid-commit geometry and spuriously unstick auto-follow.
  const programmaticScrollRef = useRef(false);
  const linesRef = useRef<LogLine[]>(lines);
  linesRef.current = lines;
  // The log line last right-clicked — read by the single shared context menu
  // (one menu for the whole list, so we don't mount 5000 ContextMenu roots).
  const ctxLineRef = useRef<LogLine | null>(null);

  // Subscribe to the active kind watch for the sidebar list.
  useEffect(() => {
    subscribe(logKind, "*");
    return () => unsubscribe(logKind, "*");
  }, [logKind]);

  const scopedItems = useMemo(
    () => filterByNamespace<RawObj>(resources[logKind] as Record<string, RawObj> | undefined, namespaceFilter),
    [resources, namespaceFilter, logKind],
  );
  const items = useMemo(
    () => buildSidebarItems(scopedItems, logKind, sidebarSearch),
    [scopedItems, logKind, sidebarSearch],
  );
  const total = scopedItems.length;
  const selectedKey = selectedItem?.key ?? null;
  const KindIcon = logKind === "pods" ? faCube : faBoxesStacked;

  // Inbound log lines: append (unless paused) and append errors to the banner.
  useEffect(() => {
    const off = onLogLine((m: LogStreamMessage) => {
      if (m.type === "logs.error") {
        setError(m.message ?? "log stream failed");
        return;
      }
      if (isPausedRef.current) { setDroppedWhilePaused((d) => d + 1); return; } // process continues; we just drop the line
      if (typeof m.line !== "string") return;
      const line = toLogLine(m.line, m.container);
      setLines((prev) => appendLines(prev, [line]));
    });
    return off;
  }, []);

  // Terminate the kubectl process when navigating away (panel unmount).
  useEffect(() => {
    return () => {
      sendLogsStop();
    };
  }, []);

  // Auto-scroll to the bottom when new lines arrive and the user is at bottom.
  const query = useMemo(() => buildLogQuery(filter, useRegex), [filter, useRegex]);
  const filtered = useMemo(
    () => sortByTimestamp(filterLines(lines, { hideProbes, errorsOnly, query, container: selectedContainer, pod: isolatedPod })),
    [lines, hideProbes, errorsOnly, query, selectedContainer, isolatedPod],
  );
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 24,
    getItemKey: (i) => filtered[i].id,
  });

  // Single-pod streams hide the pod column. Memoized: distinctPods walks the
  // whole buffer, and the bare body would re-run it on every render (incl.
  // scroll-driven stickToBottom updates).
  const pods = useMemo(() => distinctPods(lines), [lines]);
  const collapsePod = pods.length <= 1;
  const containers = useMemo(() => distinctContainers(lines), [lines]);
  // Auto-follow: when stuck to the bottom, jam to the latest line BEFORE paint
  // (useLayoutEffect) so the view doesn't flash mid-scroll. `overflow-anchor:
  // none` on the scroller stops the browser from shifting scrollTop when sorted
  // lines insert mid-list, which would otherwise trip onScroll → unstick.
  useLayoutEffect(() => {
    if (stickRef.current && filtered.length > 0) {
      programmaticScrollRef.current = true;
      rowVirtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
    }
  }, [filtered, rowVirtualizer]);

  // --- Actions --------------------------------------------------------------

  // (Re)issue the kubectl-logs stream for a SidebarItem with the current options.
  // `previous` is a one-shot (no -f) dump of the crashed container; in that mode
  // the selected container (if any) is passed to the server as -c.
  const startStream = useCallback(
    (item: SidebarItem, o: { previous: boolean; since: string; tailLines: number; container: string }) => {
      if (!item.selector && !item.pod) {
        setError("no label selector or pod to tail");
        return;
      }
      sendLogsStop();
      setLines([]);
      setDroppedWhilePaused(0);
      setExpandedLines(new Set());
      setError(null);
      setStickToBottom(true);
      sendLogsStart(
        [{
          namespace: item.namespace,
          labelSelector: item.selector ?? undefined,
          pod: item.pod ?? undefined,
          previous: o.previous,
          since: o.since || undefined,
          container: o.previous && o.container ? o.container : undefined,
        }],
        o.tailLines,
      );
    },
    [],
  );

  const selectItem = useCallback((item: SidebarItem) => {
    setSelectedItem(item);
    setSelectedContainer("");
    setPrevious(false);
    setIsolatedPod("");
    startStream(item, { previous: false, since, tailLines, container: "" });
  }, [startStream, since, tailLines]);

  const closeStream = useCallback(() => {
    sendLogsStop();
    setSelectedItem(null);
    setLines([]);
    setExpandedLines(new Set());
    setError(null);
  }, []);

  // Switch the sidebar kind: stop the current stream, drop the buffer, deselect.
  const changeKind = useCallback((kind: LogKind) => {
    sendLogsStop();
    setLines([]);
    setLogKind(kind);
    setSelectedItem(null);
  }, []);

  // Force a fresh snapshot of the source list (re-subscribe the active watch).
  const refreshSources = useCallback(() => {
    unsubscribe(logKind, "*");
    subscribe(logKind, "*");
  }, [logKind]);

  // Consume a "View Logs" focus request (Deployment/pod row → this panel): switch
  // to its kind and remember the target; a name search would hide it, so clear.
  useEffect(() => {
    if (focusRequest?.route !== "/logs") return;
    const kind = FOCUS_LOG_KIND[focusRequest.kind];
    if (!kind) return;
    const slash = focusRequest.key.indexOf("/");
    const namespace = slash >= 0 ? focusRequest.key.slice(0, slash) : "default";
    const name = slash >= 0 ? focusRequest.key.slice(slash + 1) : focusRequest.key;
    if (logKind !== kind) changeKind(kind);
    setSidebarSearch("");
    setPendingSource({ namespace, name });
    setFocusRequest(null);
  }, [focusRequest, logKind, changeKind, setFocusRequest]);

  // Once the watch delivers the target row, select it — starts streaming immediately
  // with no further clicks (container defaults to all, still switchable).
  useEffect(() => {
    if (!pendingSource) return;
    const item = items.find((i) => i.key === `${pendingSource.namespace}/${pendingSource.name}`);
    if (item) {
      selectItem(item);
      setPendingSource(null);
    }
  }, [pendingSource, items, selectItem]);

  const togglePause = useCallback(() => {
    setIsPaused((p) => { if (p) setDroppedWhilePaused(0); return !p; });
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setExpandedLines(new Set());
    setDroppedWhilePaused(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    if (filtered.length > 0) {
      programmaticScrollRef.current = true;
      rowVirtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
    }
  }, [filtered.length, rowVirtualizer]);

  // Disable auto-scroll once the user scrolls up; re-enable at the bottom. Skip
  // the scroll event our own scrollToIndex() fired (its geometry can read as
  // not-quite-bottom mid-commit and would otherwise unstick auto-follow).
  const onScroll = useCallback(() => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setStickToBottom(atBottom);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const stats = useMemo(() => streamStats(lines), [lines]);

  const copyAll = useCallback(() => {
    void navigator.clipboard.writeText(buildLogText(filtered));
  }, [filtered]);

  const downloadAll = useCallback(() => {
    const name = selectedItem ? `${selectedItem.namespace}-${selectedItem.name}` : "logs";
    const blob = new Blob([buildLogText(filtered)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, selectedItem]);

  function reissue(next: { tailLines?: number; since?: string; previous?: boolean; container?: string }) {
    // Compute the effective next values BEFORE setState (async) so the re-issued
    // stream uses the intended values, not the stale render-scope ones.
    const t = next.tailLines ?? tailLines;
    const s = next.since ?? since;
    const p = next.previous ?? previous;
    const c = next.container ?? selectedContainer;
    if (next.tailLines !== undefined) setTailLines(next.tailLines);
    if (next.since !== undefined) setSince(next.since);
    if (next.previous !== undefined) setPrevious(next.previous);
    if (next.container !== undefined) setSelectedContainer(next.container);
    if (selectedItem) startStream(selectedItem, { previous: p, since: s, tailLines: t, container: c });
  }

  // Ask Claude about a line: hand the line + 5 before/after (11 total) to chat.
  const askClaude = useCallback(
    (line: LogLine) => {
      const ctx = lineContext(linesRef.current, line.id);
      const ns = selectedItem?.namespace ?? "default";
      const name = selectedItem?.name ?? "source";
      const block = ctx
        .map((l) => `${l.sourcePod} ${formatTimestamp(l.timestamp)} ${l.text}`.trim())
        .join("\n");
      handoffToChat(
        `Investigate this log line from ${name} in namespace ${ns}:\n\n${line.text}\n\nSurrounding context:\n${block}`,
      );
    },
    [selectedItem],
  );

  // ⌥⌘W toggles wrap lines (only meaningful while a stream is open).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && e.metaKey && (e.key === "w" || e.key === "W" || e.code === "KeyW")) {
        e.preventDefault();
        setWrapLines((w) => !w);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const following = !isPaused && !previous;
  const podCount = pods.length;

  return (
    <div className="flex h-full bg-[var(--surface-sunken)]">
      {/* Sources panel */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-card">
        <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--border-subtle)] px-4 pt-4 pb-3">
          <div className="flex items-center gap-[9px]">
            <h2 className="font-heading text-lg leading-[1.1] font-semibold tracking-[-0.3px] text-foreground">Sources</h2>
            <span className="rounded-[4px] border border-[var(--border-subtle)] bg-white/5 px-[9px] py-[2px] font-mono text-xs font-semibold text-muted-foreground">
              {total}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Refresh sources"
              title="Refresh"
              onClick={refreshSources}
            >
              <FontAwesomeIcon icon={faArrowsRotate} />
            </Button>
          </div>
          <TabBar value={logKind} onValueChange={(v) => changeKind(v as LogKind)} className="flex w-full">
            {LOG_KINDS.map(({ kind, label }) => (
              <Tab key={kind} value={kind} className="flex-1 justify-center">{label}</Tab>
            ))}
          </TabBar>
          <PanelSearch
            value={sidebarSearch}
            onValueChange={setSidebarSearch}
            placeholder="Search sources…"
            className="w-full"
            ariaLabel="Search sources"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
          {isLoading && items.length === 0 ? (
            <LoadingState message="Loading…" />
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No sources</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {items.map((it) => {
                const selected = it.key === selectedKey;
                return (
                  <li key={it.key}>
                    <button
                      type="button"
                      onClick={() => selectItem(it)}
                      aria-pressed={selected}
                      className={cn(
                        "flex h-12 w-full items-center overflow-hidden rounded-[4px] border text-left transition-colors",
                        selected
                          ? "border-[color-mix(in_oklab,var(--accent-primary)_35%,transparent)] bg-[var(--accent-dim)]"
                          : "border-transparent hover:bg-white/[0.04]",
                      )}
                    >
                      <span
                        className="h-full w-[3px] shrink-0"
                        style={{ background: HEALTH[it.healthState].color }}
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-[11px] px-3 py-[9px]">
                        <FontAwesomeIcon icon={KindIcon} className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" aria-hidden />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[13px] font-semibold text-foreground">{it.name}</span>
                          <span className="truncate font-mono text-[11px] text-[var(--fg-tertiary)]">{it.namespace}</span>
                        </span>
                        <span className={cn("shrink-0 rounded-[4px] px-2 py-0.5 font-mono text-xs font-semibold", HEALTH_PILL[it.healthState])}>
                          {it.statusText}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-3.5 py-2.5">
          <span className="font-mono text-2xs text-[var(--fg-tertiary)]">Showing {items.length} of {total}</span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: "var(--status-running)" }} aria-hidden />
            <span className="text-2xs text-[var(--fg-tertiary)]">Live</span>
          </span>
        </div>
      </aside>

      {/* Log viewer */}
      <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface-sunken)]">
        {!selectedItem ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="rounded-full border border-[var(--border-subtle)] bg-white/[0.03] p-3">
              <FontAwesomeIcon icon={faScroll} className="size-6 text-[var(--fg-tertiary)]" />
            </div>
            <p className="text-sm font-medium text-foreground">Pick a source to tail its logs</p>
            <p className="text-xs text-[var(--fg-tertiary)]">Choose any workload or pod on the left to open a live log stream.</p>
          </div>
        ) : (
          <>
            {/* Toolbar — identity on the left, follow/filter/actions on the right. */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] bg-card px-5 py-3">
              <div className="flex min-w-0 items-center gap-[11px]">
                <FontAwesomeIcon icon={KindIcon} className="size-[18px] shrink-0 text-[var(--accent-primary)]" aria-hidden />
                <span className="truncate font-heading text-base font-bold text-foreground">{selectedItem.name}</span>
                <span className="shrink-0 rounded-[4px] border border-[var(--border-subtle)] bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-[var(--fg-tertiary)]">
                  {selectedItem.namespace}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs font-semibold"
                  style={{
                    background: "color-mix(in oklab, " + HEALTH[selectedItem.healthState].color + " 12%, transparent)",
                    color: HEALTH[selectedItem.healthState].color,
                  }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: HEALTH[selectedItem.healthState].color }} aria-hidden />
                  {HEALTH[selectedItem.healthState].label}
                </span>
                <span className="shrink-0 whitespace-nowrap font-mono text-xs text-[var(--fg-tertiary)]">
                  {[selectedItem.pod === null ? selectedItem.statusText : null, podCount > 0 ? `${podCount} ${podCount === 1 ? "pod" : "pods"}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={togglePause}
                  disabled={previous}
                  aria-pressed={following}
                  title={following ? "Following live output — click to pause" : "Paused — click to follow"}
                  className={cn(
                    "flex items-center gap-[7px] rounded-[6px] border px-3 py-[7px] text-[13px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45",
                    following
                      ? "border-[color-mix(in_oklab,var(--status-running)_40%,transparent)] bg-[color-mix(in_oklab,var(--status-running)_12%,transparent)] text-[var(--status-running)]"
                      : "border-[var(--border-strong)] text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]",
                  )}
                >
                  {following
                    ? <span className="size-1.5 rounded-full bg-[var(--status-running)]" aria-hidden />
                    : <FontAwesomeIcon icon={faPause} className="size-3.5" aria-hidden />}
                  {following ? "Following" : "Paused"}
                </button>

                <div
                  className={cn(
                    "flex h-8 w-[220px] items-center gap-2 rounded-[6px] border px-2.5 focus-within:ring-2 focus-within:ring-ring/50",
                    query.error ? "border-destructive ring-1 ring-destructive" : "border-[var(--border-subtle)]",
                  )}
                  style={{ background: "var(--surface-sunken)" }}
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter logs…"
                    className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-[var(--fg-tertiary)]"
                    aria-label="Filter logs"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => setFilter("")}
                      aria-label="Clear filter"
                      title="Clear filter"
                      className="shrink-0 text-[var(--fg-tertiary)] hover:text-foreground"
                    >
                      <FontAwesomeIcon icon={faXmark} className="size-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-0.5">
                  <Button variant={useRegex ? "subtle" : "outline"} size="icon-sm" aria-label="Use regular expression" aria-pressed={useRegex} title="Regex filter" onClick={() => setUseRegex((r) => !r)}>
                    <FontAwesomeIcon icon={faAsterisk} />
                  </Button>
                  <Button variant={errorsOnly ? "subtle" : "outline"} size="icon-sm" aria-label="Errors only" aria-pressed={errorsOnly} title="Show only error / fatal / panic lines" onClick={() => setErrorsOnly((e) => !e)}>
                    <FontAwesomeIcon icon={faCircleExclamation} />
                  </Button>
                  <Button variant={wrapLines ? "subtle" : "outline"} size="icon-sm" aria-label="Wrap lines" aria-pressed={wrapLines} title="Wrap lines (⌥⌘W)" onClick={() => setWrapLines((w) => !w)}>
                    <FontAwesomeIcon icon={faAlignLeft} />
                  </Button>
                  <Button variant={hideProbes ? "subtle" : "outline"} size="icon-sm" aria-label="Hide probes" aria-pressed={hideProbes} title="Hide probe / health-check noise" onClick={() => setHideProbes((h) => !h)}>
                    <FontAwesomeIcon icon={faHeartCrack} />
                  </Button>
                  <span className="mx-1 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />
                  <Button variant="outline" size="icon-sm" aria-label="Copy visible logs" title="Copy visible logs" onClick={copyAll}>
                    <FontAwesomeIcon icon={faCopy} />
                  </Button>
                  <Button variant="outline" size="icon-sm" aria-label="Download logs" title="Download .log" onClick={downloadAll}>
                    <FontAwesomeIcon icon={faDownload} />
                  </Button>
                  <Button variant="outline" size="icon-sm" aria-label="Clear" title="Clear buffer" onClick={clear}>
                    <FontAwesomeIcon icon={faTrashCan} />
                  </Button>
                  <span className="mx-1 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />
                  <Button variant="ghost" size="icon-sm" aria-label="Close log stream" title="Close" onClick={closeStream}>
                    <FontAwesomeIcon icon={faXmark} />
                  </Button>
                </div>
              </div>
            </div>

            {/* Scope row — container / pod isolation · stream options. */}
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] bg-card px-5 py-2 text-2xs">
              {containers.length > 1 && (
                <label className="flex items-center gap-1.5">
                  <span className="uppercase tracking-wide text-[var(--fg-tertiary)]">Container</span>
                  <select
                    value={selectedContainer}
                    onChange={(e) => {
                      const v = e.target.value;
                      // Live: client-side filter. Previous mode: the prior-instance
                      // dump was fetched per-container (-c), so re-issue to fetch the
                      // newly-picked container instead of filtering an empty buffer.
                      if (previous) reissue({ container: v });
                      else setSelectedContainer(v);
                    }}
                    aria-label="Filter by container"
                    className="h-7 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                  >
                    <option value="">All</option>
                    {containers.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
              {pods.length > 1 && (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 uppercase tracking-wide text-[var(--fg-tertiary)]">Pods</span>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {pods.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setIsolatedPod((cur) => (cur === p ? "" : p))}
                        aria-pressed={isolatedPod === p}
                        title={`Isolate ${p}`}
                        className={cn(
                          "max-w-[150px] shrink-0 truncate rounded-full border border-l-2 px-2 py-0.5 font-mono",
                          isolatedPod === p
                            ? "border-[color-mix(in_oklab,var(--accent-primary)_40%,transparent)] bg-[var(--accent-dim)] text-foreground"
                            : "border-[var(--border-subtle)] text-[var(--fg-tertiary)] hover:text-foreground",
                        )}
                        style={{ borderLeftColor: podColor(p) }}
                      >
                        {shortPodId(p)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Stats — right aligned, alongside the stream options. */}
              <div className="ml-auto flex items-center gap-3">
                {query.error ? (
                  <span className="font-mono text-2xs text-destructive" role="status">invalid pattern</span>
                ) : (
                  <span className="flex items-center gap-2 whitespace-nowrap font-mono text-2xs tabular-nums text-[var(--fg-tertiary)]" role="status">
                    <span>{filtered.length.toLocaleString()} / {stats.total.toLocaleString()} lines</span>
                    {stats.errors > 0 && <span className="text-[#F87171]">{stats.errors.toLocaleString()} err</span>}
                    {stats.total >= MAX_LINES && <span className="rounded-[4px] bg-[color-mix(in_oklab,var(--status-pending)_16%,transparent)] px-1 text-[var(--status-pending)]">buffer full</span>}
                    {droppedWhilePaused > 0 && <span className="text-[var(--status-pending)]">paused · {droppedWhilePaused.toLocaleString()} dropped</span>}
                  </span>
                )}
                <span className="h-4 w-px bg-[var(--border-subtle)]" aria-hidden />
                <label className="flex items-center gap-1.5">
                  <span className="uppercase tracking-wide text-[var(--fg-tertiary)]">Tail</span>
                  <select
                    value={tailLines}
                    onChange={(e) => reissue({ tailLines: Number(e.target.value) })}
                    aria-label="Tail size"
                    className="h-7 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                  >
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="uppercase tracking-wide text-[var(--fg-tertiary)]">Since</span>
                  <select
                    value={since}
                    onChange={(e) => reissue({ since: e.target.value })}
                    aria-label="Since"
                    className="h-7 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/50"
                  >
                    <option value="">All time</option>
                    <option value="5m">5m</option>
                    <option value="1h">1h</option>
                  </select>
                </label>
                <Button
                  variant={previous ? "subtle" : "outline"}
                  size="icon-sm"
                  aria-label="Previous (crashed) container logs"
                  aria-pressed={previous}
                  title="Show the previous (crashed) container instance"
                  onClick={() => reissue({ previous: !previous })}
                >
                  <FontAwesomeIcon icon={faClockRotateLeft} />
                </Button>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <pre role="alert" aria-live="assertive" className="border-b border-[var(--border-subtle)] bg-destructive/10 px-5 py-2 font-mono text-xs whitespace-pre-wrap break-all text-destructive">
                {error}
              </pre>
            )}
            {previous && (
              <div className="border-b border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--status-pending)_10%,transparent)] px-5 py-1.5 font-mono text-2xs text-[var(--status-pending)]" role="status">
                previous instance · not live — showing the crashed container's last logs
              </div>
            )}

            {/* Log scroll area. The scroller is absolutely positioned so its
                height resolves against the flex parent's *used* height — a plain
                h-full/100% does not resolve against a flex-grow-sized parent here
                and collapses to content height (breaking scroll). */}
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="absolute inset-0 overflow-auto py-2 font-mono text-xs"
                style={{ overflowAnchor: "none" }}
              >
                {/* Connecting / waiting state — selected but no lines yet */}
                {lines.length === 0 && !error && (
                  <LoadingState message="Waiting for log output…" />
                )}
                {/* One context menu for the whole list; each line records itself
                    on right-click via ctxLineRef (avoids a menu per line). */}
                <ContextMenu>
                  <ContextMenuTrigger>
                    <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                      {rowVirtualizer.getVirtualItems().map((vi) => {
                        const l = filtered[vi.index];
                        const expanded = expandedLines.has(l.id);
                        const color = podColor(l.sourcePod);
                        const level = detectLevel(l.text);
                        const badge = levelBadge(level);
                        const segments = splitHighlight(l.text, query.ranges(l.text));
                        return (
                          <div
                            key={vi.key}
                            data-index={vi.index}
                            ref={rowVirtualizer.measureElement}
                            role="button"
                            tabIndex={0}
                            aria-expanded={expanded}
                            onClick={() => toggleExpand(l.id)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(l.id); } }}
                            onContextMenu={() => { ctxLineRef.current = l; }}
                            className={cn(
                              "group flex min-h-[22px] cursor-pointer items-start gap-3 px-5 py-[3px] focus:bg-white/[0.06] focus:outline-none",
                              vi.index % 2 === 0 ? "hover:bg-white/[0.03]" : "bg-white/[0.02] hover:bg-white/[0.04]",
                            )}
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                          >
                            <span className="w-[92px] shrink-0 select-none tabular-nums text-[var(--fg-tertiary)]">{formatTimestamp(l.timestamp, true)}</span>
                            <span className={cn("flex h-[15px] w-[52px] shrink-0 items-center justify-center rounded-[4px] text-[10.5px] leading-none font-semibold tracking-[0.4px]", badge.badge)}>
                              {badge.label}
                            </span>
                            {!collapsePod && (
                              <span className="w-[64px] shrink-0 truncate" style={{ color }} title={l.sourcePod}>{shortPodId(l.sourcePod)}</span>
                            )}
                            <span className={cn("min-w-0 flex-1 text-[12.5px] leading-[1.45]", wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate", badge.text)}>
                              {segments.map((seg, i) =>
                                seg.mark ? (
                                  <mark key={i} className="rounded-sm bg-yellow-300/70 text-black dark:bg-yellow-400/80">{seg.text}</mark>
                                ) : (
                                  <span key={i}>{seg.text}</span>
                                ),
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); askClaude(l); }}
                              aria-label="Ask Claude about this line"
                              title="Ask Claude about this line"
                              className="shrink-0 text-[var(--fg-tertiary)] opacity-0 hover:text-foreground group-hover:opacity-100"
                            >
                              <FontAwesomeIcon icon={faSparkles} className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => { const l = ctxLineRef.current; if (l) askClaude(l); }}>
                      Ask Claude about this line
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => { const l = ctxLineRef.current; if (l) void navigator.clipboard.writeText(l.text); }}>
                      Copy line
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            </div>

            {/* Stream footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-card px-5 py-2.5">
              <span className="flex items-center gap-2 font-mono text-xs text-[var(--fg-tertiary)]">
                <span
                  className="size-[7px] rounded-full"
                  style={{ background: following ? "var(--status-running)" : "var(--fg-tertiary)" }}
                  aria-hidden
                />
                {following ? "Streaming live" : previous ? "Previous instance" : "Paused"}
                {" · "}
                {stats.total.toLocaleString()} lines
                {podCount > 0 && ` · ${podCount} ${podCount === 1 ? "pod" : "pods"}`}
              </span>
              {!stickToBottom && (
                <Button variant="outline" size="sm" onClick={jumpToLatest}>
                  <FontAwesomeIcon icon={faArrowDown} className="mr-1 size-3.5" />
                  Jump to latest
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
