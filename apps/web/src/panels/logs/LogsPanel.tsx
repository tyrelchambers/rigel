import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { Deployment } from "../deployments/types";
import {
  type LogLine,
  toLogLine,
  appendLines,
  filterLines,
  buildLogQuery,
  detectLevel,
  splitHighlight,
  distinctPods,
  sortByTimestamp,
  formatTimestamp,
  podColor,
  deploymentColor,
  deploymentKey,
  sortDeployments,
  replicaText,
  replicasUnhealthy,
  labelSelector,
  lineContext,
} from "./logDisplay";

export default function LogsPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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

  // Refs so the WS callback and scroll handlers read live values without
  // re-subscribing on every state change.
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  const stickRef = useRef(stickToBottom);
  stickRef.current = stickToBottom;
  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<LogLine[]>(lines);
  linesRef.current = lines;
  // The log line last right-clicked — read by the single shared context menu
  // (one menu for the whole list, so we don't mount 5000 ContextMenu roots).
  const ctxLineRef = useRef<LogLine | null>(null);

  // Subscribe to the deployments watch for the sidebar list. Pods are streamed
  // implicitly via the kubectl logs label selector (not watched here).
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("deployments", ns);
    return () => unsubscribe("deployments", ns);
  }, [namespaceFilter]);

  const deployments = useMemo(
    () =>
      sortDeployments(
        Object.values((resources["deployments"] ?? {}) as Record<string, Deployment>),
      ),
    [resources],
  );

  const selected = useMemo(
    () => deployments.find((d) => deploymentKey(d) === selectedKey) ?? null,
    [deployments, selectedKey],
  );

  // Inbound log lines: append (unless paused) and append errors to the banner.
  useEffect(() => {
    const off = onLogLine((m: LogStreamMessage) => {
      if (m.type === "logs.error") {
        setError(m.message ?? "log stream failed");
        return;
      }
      if (isPausedRef.current) return; // process continues; we just drop the line
      if (typeof m.line !== "string") return;
      const line = toLogLine(m.line);
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
    () => sortByTimestamp(filterLines(lines, { hideProbes, errorsOnly, query })),
    [lines, hideProbes, errorsOnly, query],
  );
  const collapsePod = distinctPods(lines).length <= 1;
  // Auto-follow: when stuck to the bottom, jam to the latest line BEFORE paint
  // (useLayoutEffect) so the view doesn't flash mid-scroll. `overflow-anchor:
  // none` on the scroller stops the browser from shifting scrollTop when sorted
  // lines insert mid-list, which would otherwise trip onScroll → unstick.
  useLayoutEffect(() => {
    if (stickRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered]);

  // --- Actions --------------------------------------------------------------

  const selectDeployment = useCallback((d: Deployment) => {
    const key = deploymentKey(d);
    sendLogsStop(); // cancel any previous stream
    setLines([]);
    setExpandedLines(new Set());
    setError(null);
    setSelectedKey(key);
    setStickToBottom(true);

    const selector = labelSelector(d);
    if (!selector) {
      setError("deployment has no spec.selector.matchLabels");
      return;
    }
    sendLogsStart([{ namespace: d.metadata.namespace ?? "default", labelSelector: selector }], 200);
  }, []);

  const closeStream = useCallback(() => {
    sendLogsStop();
    setSelectedKey(null);
    setLines([]);
    setExpandedLines(new Set());
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setExpandedLines(new Set());
  }, []);

  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);

  // Disable auto-scroll once the user scrolls up; re-enable at the bottom.
  const onScroll = useCallback(() => {
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

  // Ask Claude about a line: hand the line + 5 before/after (11 total) to chat.
  const askClaude = useCallback(
    (line: LogLine) => {
      const ctx = lineContext(linesRef.current, line.id);
      const ns = selected?.metadata.namespace ?? "default";
      const name = selected?.metadata.name ?? "deployment";
      const block = ctx
        .map((l) => `${l.sourcePod} ${formatTimestamp(l.timestamp)} ${l.text}`.trim())
        .join("\n");
      handoffToChat(
        `Investigate this log line from deployment ${name} in namespace ${ns}:\n\n${line.text}\n\nSurrounding context:\n${block}`,
      );
    },
    [selected],
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
          <h2 className="text-sm font-semibold">Deployments</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
            {deployments.length}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {isLoading && deployments.length === 0 ? (
            <LoadingState message="Loading deployments…" />
          ) : deployments.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No deployments</p>
          ) : (
            <ul>
              {deployments.map((d) => {
                const k = deploymentKey(d);
                const ns = d.metadata.namespace ?? "default";
                const accent = deploymentColor(ns, d.metadata.name);
                const isSel = k === selectedKey;
                return (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => selectDeployment(d)}
                      className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left hover:bg-muted ${
                        isSel ? "bg-muted" : ""
                      }`}
                      style={{ borderLeftColor: accent }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs font-medium">
                          {d.metadata.name}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {ns}
                        </div>
                      </div>
                      <span
                        className={`font-mono text-[10px] ${
                          replicasUnhealthy(d)
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground"
                        }`}
                      >
                        {replicaText(d)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Stream pane */}
      <section className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <AlignLeft className="size-8" />
            <p className="text-sm font-medium">Pick a deployment to tail its logs</p>
            <p className="text-xs">
              Click any deployment on the left to open a live log stream here.
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
                style={{ backgroundColor: deploymentColor(selected.metadata.namespace ?? "default", selected.metadata.name) }}
              />
              <span className="font-mono text-sm font-semibold">{selected.metadata.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {selected.metadata.namespace ?? "default"}
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

            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <div
                className={`flex w-64 items-center gap-1.5 rounded-md border px-2 focus-within:ring-2 focus-within:ring-ring ${
                  query.error ? "border-destructive ring-1 ring-destructive" : ""
                }`}
                style={{ background: "var(--surface-sunken)", height: 28 }}
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
              {query.error ? (
                <span className="font-mono text-[10px] text-destructive" role="status">invalid pattern</span>
              ) : (
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground" aria-live="polite">
                  {filtered.length.toLocaleString()} / {lines.length.toLocaleString()} lines
                </span>
              )}
              <Button
                variant={wrapLines ? "secondary" : "ghost"}
                size="icon-sm"
                className="ml-auto"
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
                onClick={() => setIsPaused((p) => !p)}
              >
                {isPaused ? <Play /> : <Pause />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear"
                title="Clear"
                onClick={clear}
              >
                <Trash2 />
              </Button>
            </div>

            {/* Error banner */}
            {error && (
              <pre className="border-b bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive whitespace-pre-wrap break-all">
                {error}
              </pre>
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
                {filtered.map((l) => {
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
                      key={l.id}
                      onClick={() => toggleExpand(l.id)}
                      onContextMenu={() => { ctxLineRef.current = l; }}
                      className="group flex min-h-[18px] cursor-default items-start gap-2 border-l-2 px-2 py-0.5 hover:bg-muted/50"
                      style={{ borderLeftColor: color }}
                    >
                      {!collapsePod && (
                        <span
                          className="w-[150px] shrink-0 truncate"
                          style={{ color }}
                          title={l.sourcePod}
                        >
                          {l.sourcePod}
                        </span>
                      )}
                      <span className="w-[80px] shrink-0 text-muted-foreground">
                        {formatTimestamp(l.timestamp)}
                      </span>
                      <span
                        className={`flex-1 ${
                          wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate"
                        } ${levelClass}`}
                      >
                        {segments.map((seg, i) =>
                          seg.mark ? (
                            <mark key={i} className="rounded-sm bg-yellow-300/70 text-black dark:bg-yellow-400/80">
                              {seg.text}
                            </mark>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          ),
                        )}
                      </span>
                      {/* Ask Claude — revealed on row hover. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          askClaude(l);
                        }}
                        aria-label="Ask Claude about this line"
                        title="Ask Claude about this line"
                        className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                      >
                        <Sparkles className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
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
