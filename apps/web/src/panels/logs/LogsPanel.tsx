import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  WrapText,
  HeartOff,
  Play,
  Pause,
  Trash2,
  X,
  ArrowDown,
  AlignLeft,
  Sparkles,
  Regex,
  CircleAlert,
  History,
  Download,
  Copy,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import {
  subscribe,
  unsubscribe,
  sendLogsStart,
  sendLogsStop,
  onLogLine,
  type LogStreamMessage,
} from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { LoadingState } from "@/panels/components/LoadingState";
import { NamespaceSelector } from "@/shell/NamespaceBar";
import { type LogKind, LOG_KINDS, type SidebarItem, buildSidebarItems } from "./logTargets";
import {
  type LogLine,
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
  podColor,
  lineContext,
  streamStats,
  buildLogText,
  MAX_LINES,
} from "./logDisplay";

export default function LogsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

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
    const ns = namespaceFilter ?? "*";
    subscribe(logKind, ns);
    return () => unsubscribe(logKind, ns);
  }, [namespaceFilter, logKind]);

  const items = useMemo(
    () => buildSidebarItems(resources, logKind, sidebarSearch),
    [resources, logKind, sidebarSearch],
  );
  const selectedKey = selectedItem?.key ?? null;

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
    estimateSize: () => 18,
    overscan: 24,
    getItemKey: (i) => filtered[i].id,
  });

  // Single-pod streams hide the 150px pod column. Memoized: distinctPods walks
  // the whole buffer, and the bare body would re-run it on every render (incl.
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

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3"
          style={{ height: 42, background: "var(--surface-elevated)" }}
        >
          <h2 className="text-sm font-semibold">Sources</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
            {items.length}
          </span>
        </div>
        {/* Namespace filter — drives the shared store namespaceFilter that scopes
            the per-kind watch (the sidebar list narrows to the chosen namespace). */}
        <div className="shrink-0 border-b px-3 py-2">
          <NamespaceSelector />
        </div>
        <div className="flex shrink-0 border-b text-xs">
          {LOG_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => { sendLogsStop(); setLines([]); setLogKind(kind); setSelectedItem(null); }}
              aria-pressed={logKind === kind}
              className={`flex-1 py-1.5 ${logKind === kind ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="shrink-0 border-b px-2 py-1.5">
          <input
            type="text"
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            placeholder="Search…"
            aria-label="Search sources"
            className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex-1 overflow-auto">
          {isLoading && items.length === 0 ? (
            <LoadingState message="Loading…" />
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No sources</p>
          ) : (
            <ul>
              {items.map((it) => (
                <li key={it.key}>
                  <button
                    type="button"
                    onClick={() => selectItem(it)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left hover:bg-muted ${
                      it.key === selectedKey ? "bg-muted" : ""
                    }`}
                    style={{ borderLeftColor: podColor(it.name) }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs font-medium">{it.name}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">{it.namespace}</div>
                    </div>
                    <span className={`font-mono text-[10px] ${it.unhealthy ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                      {it.statusText}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Stream pane */}
      <section className="flex min-w-0 flex-1 flex-col">
        {!selectedItem ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <AlignLeft className="size-8" />
            <p className="text-sm font-medium">Pick a source to tail its logs</p>
            <p className="text-xs">
              Click any item on the left to open a live log stream here.
            </p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div
              className="flex shrink-0 items-center gap-2 border-b px-3"
              style={{ height: 42, background: "var(--surface-elevated)" }}
            >
              <span
                className="inline-block size-3 shrink-0 rounded-full"
                style={{ backgroundColor: podColor(selectedItem.name) }}
              />
              <span className="font-mono text-sm font-semibold">{selectedItem.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {selectedItem.namespace}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Close log stream"
                title="Close"
                onClick={closeStream}
              >
                <X />
              </Button>
            </div>

            {/* Toolbar — two rows: "view" (filter/scan/stats/actions) over
                "scope" (container/pods/tail/since/previous), so 15 controls have
                room to breathe instead of crowding one line. */}
            <div className="flex flex-col gap-2 border-b px-3 py-2">
              {/* Row 1 — filter, scan toggles, stats, view actions */}
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-7 w-72 items-center gap-1.5 rounded-md border px-2.5 focus-within:ring-2 focus-within:ring-ring ${
                    query.error ? "border-destructive ring-1 ring-destructive" : ""
                  }`}
                  style={{ background: "var(--surface-sunken)" }}
                >
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter logs…"
                    className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground"
                    aria-label="Filter logs"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => setFilter("")}
                      aria-label="Clear filter"
                      title="Clear filter"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <Button
                  variant={useRegex ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label="Use regular expression"
                  aria-pressed={useRegex}
                  title="Regex filter"
                  onClick={() => setUseRegex((r) => !r)}
                >
                  <Regex />
                </Button>
                <Button
                  variant={errorsOnly ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label="Errors only"
                  aria-pressed={errorsOnly}
                  title="Show only error / fatal / panic lines"
                  onClick={() => setErrorsOnly((e) => !e)}
                >
                  <CircleAlert />
                </Button>

                {/* Stats — fixed, never wraps. One always-mounted status region
                    announces regex errors; the line count is ambient (not aria-live). */}
                {query.error ? (
                  <span className="ml-1 font-mono text-[10px] text-destructive" role="status">invalid pattern</span>
                ) : (
                  <span className="ml-1 flex items-center gap-2 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground" role="status">
                    <span>{filtered.length.toLocaleString()} / {stats.total.toLocaleString()} lines</span>
                    {stats.errors > 0 && <span className="text-red-600 dark:text-red-400">{stats.errors.toLocaleString()} err</span>}
                    {stats.total >= MAX_LINES && <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">buffer full</span>}
                    {droppedWhilePaused > 0 && <span className="text-amber-700 dark:text-amber-400">paused · {droppedWhilePaused.toLocaleString()} dropped</span>}
                  </span>
                )}

                {/* View actions — right aligned, grouped (view toggles · export). */}
                <div className="ml-auto flex items-center gap-0.5">
                  <Button
                    variant={wrapLines ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Wrap lines"
                    aria-pressed={wrapLines}
                    title="Wrap lines (⌥⌘W)"
                    onClick={() => setWrapLines((w) => !w)}
                  >
                    <WrapText />
                  </Button>
                  <Button
                    variant={hideProbes ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Hide probes"
                    aria-pressed={hideProbes}
                    title="Hide probe / health-check noise"
                    onClick={() => setHideProbes((h) => !h)}
                  >
                    <HeartOff />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={isPaused ? "Resume" : "Pause"}
                    title={isPaused ? "Resume" : "Pause"}
                    disabled={previous}
                    onClick={() => setIsPaused((p) => { if (p) setDroppedWhilePaused(0); return !p; })}
                  >
                    {isPaused ? <Play /> : <Pause />}
                  </Button>
                  <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                  <Button variant="ghost" size="icon-sm" aria-label="Copy visible logs" title="Copy visible logs" onClick={copyAll}>
                    <Copy />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Download logs" title="Download .log" onClick={downloadAll}>
                    <Download />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Clear" title="Clear" onClick={clear}>
                    <Trash2 />
                  </Button>
                </div>
              </div>

              {/* Row 2 — source scope (container / pod isolation) · stream options. */}
              <div className="flex items-center gap-3 text-[10px]">
                {containers.length > 1 && (
                  <label className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wide text-muted-foreground">Container</span>
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
                      className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
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
                    <span className="shrink-0 uppercase tracking-wide text-muted-foreground">Pods</span>
                    <div className="flex items-center gap-1 overflow-x-auto">
                      {pods.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setIsolatedPod((cur) => (cur === p ? "" : p))}
                          aria-pressed={isolatedPod === p}
                          title={`Isolate ${p}`}
                          className={`max-w-[150px] shrink-0 truncate rounded-full border border-l-2 px-2 py-0.5 font-mono ${
                            isolatedPod === p ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"
                          }`}
                          style={{ borderLeftColor: podColor(p) }}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Stream options — right aligned. */}
                <div className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wide text-muted-foreground">Tail</span>
                    <select
                      value={tailLines}
                      onChange={(e) => reissue({ tailLines: Number(e.target.value) })}
                      aria-label="Tail size"
                      className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value={200}>200</option>
                      <option value={500}>500</option>
                      <option value={1000}>1000</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="uppercase tracking-wide text-muted-foreground">Since</span>
                    <select
                      value={since}
                      onChange={(e) => reissue({ since: e.target.value })}
                      aria-label="Since"
                      className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">All time</option>
                      <option value="5m">5m</option>
                      <option value="1h">1h</option>
                    </select>
                  </label>
                  <Button
                    variant={previous ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Previous (crashed) container logs"
                    aria-pressed={previous}
                    title="Show the previous (crashed) container instance"
                    onClick={() => reissue({ previous: !previous })}
                  >
                    <History />
                  </Button>
                </div>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <pre role="alert" aria-live="assertive" className="border-b bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive whitespace-pre-wrap break-all">
                {error}
              </pre>
            )}
            {previous && (
              <div className="border-b bg-amber-500/10 px-3 py-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400" role="status">
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
                className="absolute inset-0 overflow-auto font-mono text-[11px]"
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
                        const levelClass =
                          level === "error" ? "text-red-600 dark:text-red-400"
                          : level === "warn" ? "text-amber-600 dark:text-amber-400"
                          : "";
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
                            className="group flex min-h-[18px] cursor-pointer items-start gap-2 border-l-2 px-2 py-0.5 hover:bg-muted/50 focus:bg-muted/60 focus:outline-none"
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)`, borderLeftColor: color }}
                          >
                            {!collapsePod && (
                              <span className="w-[150px] shrink-0 truncate" style={{ color }} title={l.sourcePod}>{l.sourcePod}</span>
                            )}
                            <span className="w-[80px] shrink-0 text-muted-foreground">{formatTimestamp(l.timestamp)}</span>
                            <span className={`flex-1 ${wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate"} ${levelClass}`}>
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
                              className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                            >
                              <Sparkles className="size-3.5" />
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

              {/* Jump to latest (only when scrolled up) */}
              {!stickToBottom && (
                <Button
                  size="sm"
                  className="absolute bottom-4 right-4 shadow"
                  onClick={jumpToLatest}
                >
                  <ArrowDown className="mr-1 size-3.5" />
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
