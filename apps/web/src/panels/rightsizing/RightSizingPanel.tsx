import { useMemo, useState } from "react";
import {
  Hourglass,
  Gauge,
  Copy,
  MessageSquare,
  Check,
  Database,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { handoffToChat } from "@/lib/chatHandoff";
import { Button } from "@/components/ui/button";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { PanelHeader } from "@/panels/components/PanelHeader";
import type { StatusBadgeVariant } from "@/panels/components/StatusBadge";
import type { ActionBlock } from "@/lib/api";
import {
  formatCpuCores,
  formatMemBytes,
  matchesSearch,
  sortWorkloads,
  suggestionQuantities,
  suggestionYaml,
  verdictStyle,
  MIN_HOURS,
} from "./displayHelper";
import type {
  RightSizingResult,
  SortMode,
  Verdict,
  WorkloadKind,
  WorkloadRightSizing,
} from "./types";
import { MetricsInstallDialog } from "./MetricsInstallDialog";
import {
  choiceSelectValue,
  backendValue,
  type BackendChoice,
} from "./backendChoice";
import { useRightSizing, type UsageBackend } from "./useRightSizing";
import type { InstalledBackend } from "@helmsman/k8s";

const KIND_BADGE: Record<WorkloadKind, string> = {
  deployment: "DEP",
  statefulset: "STS",
  daemonset: "DS",
};

/** kubectl workload-kind string for the setResources action block. */
const KIND_KUBECTL: Record<WorkloadKind, string> = {
  deployment: "deployment",
  statefulset: "statefulset",
  daemonset: "daemonset",
};

const SORT_PILLS: Array<{ mode: SortMode; label: string }> = [
  { mode: "needs-attention", label: "Needs attention" },
  { mode: "wasteful", label: "Most wasteful" },
  { mode: "name", label: "Name" },
];

/** Map a verdict to the StatusBadge variant. */
function verdictBadgeVariant(v: Verdict): StatusBadgeVariant {
  switch (v) {
    case "ok":
      return "healthy";
    case "overProvisioned":
      return "pending";
    case "atRisk":
    case "unset":
      return "error";
    case "insufficientData":
      return "neutral";
  }
}

/** Short human label for the verdict badge. */
function verdictLabel(v: Verdict): string {
  switch (v) {
    case "ok":
      return "OK";
    case "overProvisioned":
      return "Over-provisioned";
    case "atRisk":
      return "At risk";
    case "unset":
      return "Unset";
    case "insufficientData":
      return "Gathering data";
  }
}

export default function RightSizingPanel() {
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("needs-attention");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

  // Shared right-sizing pipeline (also feeds the Overview "Reclaimable" card).
  const { workloads, usage, detecting, usingBackend, noBackend, backends, choice, setChoice, reload } = useRightSizing();

  // Source picker options: detected backends ∪ the current explicit choice (so a
  // just-installed backend not yet in the detected list still appears).
  const sourceOptions = useMemo<UsageBackend[]>(() => {
    const out = [...backends];
    if (
      choice.kind === "prometheus" &&
      !out.some((b) => b.namespace === choice.namespace && b.service === choice.service && b.port === choice.port)
    ) {
      out.push({ flavor: choice.flavor, namespace: choice.namespace, service: choice.service, port: choice.port });
    }
    return out;
  }, [backends, choice]);

  const selectValue = choiceSelectValue(choice, usage?.backend ?? null);

  function pickSource(value: string) {
    const b = sourceOptions.find((o) => backendValue(o) === value);
    if (b) {
      const c: BackendChoice = { kind: "prometheus", namespace: b.namespace, service: b.service, port: b.port, flavor: b.flavor };
      setChoice(c); // persists the choice
    }
  }

  function handleInstall(backend: InstalledBackend, yaml: string) {
    // Persist the choice optimistically, then route the apply through ConfirmSheet.
    const c: BackendChoice = { kind: "prometheus", namespace: backend.namespace, service: backend.service, port: backend.port, flavor: backend.flavor };
    setChoice(c); // persists the choice
    setInstallOpen(false);
    setPendingAction({
      kind: "applyManifest",
      manifest: yaml,
      label: `Install ${backend.flavor} metrics backend`,
      name: backend.service,
      namespace: backend.namespace,
    });
  }

  // Scope to the selected namespace. The shared store also holds cross-namespace
  // workloads (e.g. the chat pane keeps a deployments "*" watch alive), so we
  // filter here as a safeguard — matching the Swift panel's `filtered`.
  const inNamespace = useMemo(
    () => workloads.filter((w) => namespaceFilter == null || w.namespace === namespaceFilter),
    [workloads, namespaceFilter],
  );

  const filtered = useMemo(
    () => sortWorkloads(inNamespace.filter((w) => matchesSearch(w, search)), sortMode),
    [inNamespace, search, sortMode],
  );

  // A backend is connected but hasn't scraped ~24h yet → every row reads
  // "Gathering data"; show a banner explaining the wait.
  const isWarmingUp =
    usingBackend &&
    inNamespace.length > 0 &&
    inNamespace.every((w) =>
      w.containers.every((c) => c.hoursCovered < MIN_HOURS),
    );
  const maxHours = inNamespace.reduce(
    (m, w) => Math.max(m, ...w.containers.map((c) => c.hoursCovered), 0),
    0,
  );
  const loading = detecting;
  const sourceLabel = usage?.backend
    ? `${usage.backend.flavor} · ${usage.backend.namespace}/${usage.backend.service}`
    : "";

  function toggle(w: WorkloadRightSizing) {
    const k = `${w.namespace}/${w.name}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // --- Container actions ----------------------------------------------------

  function apply(w: WorkloadRightSizing, c: RightSizingResult) {
    const { requests, limits } = suggestionQuantities(c);
    setPendingAction({
      kind: "setResources",
      name: w.name,
      namespace: w.namespace,
      container: c.container,
      resourceKind: KIND_KUBECTL[w.kind],
      requests,
      limits,
      label: `Right-size ${w.name}/${c.container}`,
    });
  }

  function askClaude(w: WorkloadRightSizing, c: RightSizingResult) {
    const style = verdictStyle(c.verdict);
    handoffToChat(
      `Review right-sizing for ${w.kind} ${w.name} (container ${c.container}) in namespace ${w.namespace}. ` +
        `Current verdict: ${style.label}. ${c.rationale}`,
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Right-sizing"
        subtitle="Resource recommendations"
        count={filtered.length}
        loading={loading}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or namespace…"
          className="w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Control bar — sort pills */}
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2"
        style={{ borderBottom: "1px solid #26272B", background: "var(--surface-elevated)" }}
      >
        {SORT_PILLS.map((p) => (
          <button
            key={p.mode}
            type="button"
            className="whitespace-nowrap"
            onClick={() => setSortMode(p.mode)}
            style={
              sortMode === p.mode
                ? {
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--surface-sunken)",
                    background: "var(--accent-primary)",
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "none",
                  }
                : {
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--fg-tertiary)",
                    background: "var(--surface-sunken)",
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid #34353A",
                  }
            }
          >
            {p.label}
          </button>
        ))}
        <span className="flex-1" />
        {sourceOptions.length > 0 && (
          <>
            <span className="whitespace-nowrap" style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: "var(--fg-tertiary)" }}>
              Source
            </span>
            <select
              value={selectValue}
              onChange={(e) => pickSource(e.target.value)}
              title="Right-sizing data source"
              className="max-w-[240px] rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
              style={{ fontFamily: "ui-monospace, monospace" }}
            >
              {sourceOptions.map((b) => (
                <option key={backendValue(b)} value={backendValue(b)}>
                  {b.flavor} · {b.service}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          onClick={() => setInstallOpen(true)}
          className="whitespace-nowrap rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          Set up…
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-3 py-2">
        {/* Detecting / loading the backend — keeps the panel from flashing an
            empty or no-backend state before the first query resolves. */}
        {loading && (
          <div
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            style={{ color: "var(--fg-tertiary)" }}
          >
            <Hourglass className="size-4 shrink-0 animate-pulse" style={{ color: "var(--accent-primary)" }} />
            Loading usage history…
          </div>
        )}

        {/* No metrics backend → prompt to install one (no in-browser fallback). */}
        {noBackend && (
          <div className="flex flex-col items-center gap-3 py-12 text-center" style={{ color: "var(--fg-tertiary)" }}>
            <Database className="size-8" style={{ color: "var(--accent-primary)" }} />
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--fg-secondary)" }}>
                No metrics backend connected
              </p>
              <p className="mx-auto mt-1 max-w-md" style={{ fontSize: 11 }}>
                Right-sizing reads 30 days of usage from a Prometheus or VictoriaMetrics store.
                Install a lightweight one in a click — it scrapes container usage and keeps the history.
              </p>
            </div>
            <Button onClick={() => setInstallOpen(true)}>
              <Database className="size-3.5" />
              Set up a metrics backend
            </Button>
          </div>
        )}

        {/* Backend connected but still scraping its first ~24h. */}
        {usingBackend && isWarmingUp && (
          <div
            className="flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            style={{ background: "rgba(56, 189, 248,0.08)", border: "1px solid rgba(56, 189, 248,0.2)" }}
          >
            <Hourglass className="mt-0.5 size-4 shrink-0" style={{ color: "var(--accent-primary)" }} />
            <div>
              <div className="font-medium" style={{ color: "#d4b8f0", fontSize: 12 }}>
                Collecting usage history — recommendations need ~{MIN_HOURS}h of data
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-tertiary)", marginTop: 1 }}>
                Reading from {sourceLabel}, which scrapes continuously. So far: {maxHours}h of{" "}
                {MIN_HOURS}h. Verdicts appear automatically once there's enough.
              </div>
            </div>
          </div>
        )}

        {/* No workloads to analyze (backend present, not warming). */}
        {usingBackend && !isWarmingUp && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center" style={{ color: "var(--fg-tertiary)" }}>
            <Gauge className="size-8" />
            <p className="text-sm font-medium">No workloads to analyze</p>
            <p style={{ fontSize: 11 }}>Nothing matches the current namespace or search.</p>
          </div>
        )}

        {/* Workload rows */}
        {usingBackend && filtered.map((w) => {
          const k = `${w.namespace}/${w.name}`;
          const isOpen = expanded.has(k);
          // Per-container actions (Apply/Ask Claude) live in the expanded detail;
          // a single-container workload can route Ask Claude straight from the row.
          const soleContainer = w.containers.length === 1 ? w.containers[0] : null;
          const rowMenu = (
            <>
              {soleContainer && (
                <>
                  <ContextMenuItem onClick={() => askClaude(w, soleContainer)}>
                    Ask Claude
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => toggle(w)}>
                {isOpen ? "Collapse" : "Details…"}
              </ContextMenuItem>
            </>
          );

          return (
            <ListRow
              key={k}
              rowKey={k}
              isOpen={isOpen}
              onToggle={() => toggle(w)}
              contextMenu={rowMenu}
              expandedContent={
                <div className="space-y-2">
                  {w.containers.map((c) => (
                    <ContainerDetail
                      key={c.container}
                      workload={w}
                      result={c}
                      onApply={() => apply(w, c)}
                      onAskClaude={() => askClaude(w, c)}
                    />
                  ))}
                </div>
              }
            >
              {/* Workload name — mono */}
              <button
                type="button"
                onClick={() => toggle(w)}
                className="shrink-0 font-mono text-xs font-medium leading-none hover:underline"
                style={{ color: "#E4E4E7" }}
              >
                {w.name}
              </button>

              {/* Namespace chip */}
              <span
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 10,
                  color: "var(--fg-tertiary)",
                  background: "var(--surface-sunken)",
                  padding: "1px 5px",
                  borderRadius: 4,
                  border: "1px solid #26272B",
                  whiteSpace: "nowrap",
                }}
              >
                {w.namespace}
              </span>

              {/* Kind pill — purple accent */}
              <TagPill label={KIND_BADGE[w.kind]} title={w.kind} />

              {/* Spacer */}
              <span className="flex-1" />

              {/* Reclaim hint */}
              {w.reclaimableMemBytes > 0 && (
                <span
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 10,
                    color: "var(--status-pending)",
                    whiteSpace: "nowrap",
                  }}
                >
                  reclaim ~{formatMemBytes(w.reclaimableMemBytes)}
                </span>
              )}

              {/* Verdict StatusBadge */}
              <StatusBadge
                label={verdictLabel(w.worst)}
                variant={verdictBadgeVariant(w.worst)}
              />
            </ListRow>
          );
        })}
      </div>
      </div>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => {
          setPendingAction(null);
          // Re-detect + re-query after any apply (e.g. a metrics-backend install).
          reload();
        }}
      />
      <MetricsInstallDialog open={installOpen} onOpenChange={setInstallOpen} onInstall={handleInstall} />
    </div>
  );
}

/** Per-container detail: verdict, rationale, suggestion table, actions. */
function ContainerDetail({
  workload,
  result,
  onApply,
  onAskClaude,
}: {
  workload: WorkloadRightSizing;
  result: RightSizingResult;
  onApply: () => void;
  onAskClaude: () => void;
}) {
  const insufficient = result.verdict === "insufficientData";
  const hasSuggestion = !insufficient;
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard?.writeText(suggestionYaml(result));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const fmtCpu = (v?: number) => (v == null ? "(unset)" : formatCpuCores(v));
  const fmtMem = (v?: number) => (v == null ? "(unset)" : formatMemBytes(v));

  return (
    <div
      className="rounded-md p-3"
      style={{ background: "var(--surface-primary)", border: "1px solid #34353A" }}
    >
      {/* Container header */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium" style={{ color: "#E4E4E7" }}>
          {result.container}
        </span>
        <StatusBadge
          label={verdictLabel(result.verdict)}
          variant={verdictBadgeVariant(result.verdict)}
        />
        <span
          className="ml-auto font-mono"
          style={{ fontSize: 10, color: "var(--fg-tertiary)", whiteSpace: "nowrap" }}
        >
          {insufficient
            ? `${result.hoursCovered}h/${MIN_HOURS}h`
            : `${result.hoursCovered}h history`}
        </span>
      </div>

      {/* Rationale */}
      <p className="mt-1" style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>
        {result.rationale}
      </p>

      {/* Resource table: current → recommended, observed */}
      {hasSuggestion && (
        <div
          className="mt-2 grid items-center gap-x-3 gap-y-1"
          style={{
            gridTemplateColumns: "auto 1fr auto 1fr 1.4fr",
            fontSize: 11,
          }}
        >
          {/* Column headers */}
          <span />
          <span style={{ color: "var(--fg-tertiary)", fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            req / limit
          </span>
          <span />
          <span style={{ color: "var(--fg-tertiary)", fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            recommended
          </span>
          <span style={{ color: "var(--fg-tertiary)", fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            observed
          </span>

          {/* CPU row */}
          <span style={{ fontWeight: 600, color: "var(--fg-tertiary)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em" }}>CPU</span>
          <span className="font-mono" style={{ color: "var(--fg-secondary)" }}>
            {fmtCpu(result.cpuRequest)} / {fmtCpu(result.cpuLimit)}
          </span>
          <span style={{ color: "var(--fg-tertiary)" }}>→</span>
          <span className="font-mono font-medium" style={{ color: "var(--accent-primary)" }}>
            {fmtCpu(result.suggestedCpuRequest)} / {fmtCpu(result.suggestedCpuLimit)}
          </span>
          <span className="font-mono" style={{ color: "var(--fg-tertiary)" }}>
            peak {formatCpuCores(result.cpuPeak)} · typ {formatCpuCores(result.cpuTypical)}
          </span>

          {/* MEM row */}
          <span style={{ fontWeight: 600, color: "var(--fg-tertiary)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em" }}>MEM</span>
          <span className="font-mono" style={{ color: "var(--fg-secondary)" }}>
            {fmtMem(result.memRequest)} / {fmtMem(result.memLimit)}
          </span>
          <span style={{ color: "var(--fg-tertiary)" }}>→</span>
          <span className="font-mono font-medium" style={{ color: "var(--accent-primary)" }}>
            {fmtMem(result.suggestedMemRequest)} / {fmtMem(result.suggestedMemLimit)}
          </span>
          <span className="font-mono" style={{ color: "var(--fg-tertiary)" }}>
            peak {formatMemBytes(result.memPeak)} · typ {formatMemBytes(result.memTypical)}
          </span>
        </div>
      )}

      {/* Actions */}
      {hasSuggestion && (
        <div className="mt-3 flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={copy} title="Copy YAML snippet">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onAskClaude} title="Discuss in chat">
            <MessageSquare className="size-3.5" />
            Ask Claude
          </Button>
          <Button variant="default" size="sm" onClick={onApply} title="Apply suggested resources">
            Apply
          </Button>
        </div>
      )}
      {/* workload kind hint kept available for downstream tooling */}
      <span className="sr-only">{workload.kind}</span>
    </div>
  );
}
