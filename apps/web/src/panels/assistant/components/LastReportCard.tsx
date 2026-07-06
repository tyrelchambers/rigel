// LastReportCard — the Overview "Last report" card. Renders the agent's
// auto-silenced incidents (parsed from the state's `autoSilenced` fingerprint
// list) as a structured, expandable list whose rows jump to the affected
// resource, plus Copy and Clear actions. Any non-auto-silence report lines are
// shown as plain text.

import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, ChevronDown, Copy } from "lucide-react";
import { parseIncidentFingerprint, type ParsedFingerprint } from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import { useCluster } from "@/store/cluster";
import { cn } from "@/lib/utils";
import { Card } from "./primitives";

const COLLAPSED_COUNT = 4;

// incidentKind → owning panel, focus kind, resource-kind chip, human label, and
// which panel the "Open" button jumps to. loggedError/unhealthyPod live in Pods;
// degradedDeployment in Deployments (mirrors NeedsYouTab.issueTarget).
function targetFor(incidentKind: string): {
  route: string;
  kind: string;
  chip: string;
  what: string;
  panel: string;
} {
  switch (incidentKind) {
    case "degradedDeployment":
      return { route: "/deployments", kind: "deployment", chip: "Deployment", what: "Degraded deployment", panel: "Deployments" };
    case "loggedError":
      return { route: "/pods", kind: "pod", chip: "Pod", what: "Error in pod logs", panel: "Pods" };
    case "unhealthyPod":
      return { route: "/pods", kind: "pod", chip: "Pod", what: "Unhealthy pod", panel: "Pods" };
    default:
      return { route: "/pods", kind: "pod", chip: "Pod", what: incidentKind || "Incident", panel: "Pods" };
  }
}

export function LastReportCard({
  report,
  autoSilenced,
  autoSilencedReasons,
  working,
  onClear,
}: {
  report: string;
  autoSilenced: string[];
  autoSilencedReasons: Record<string, string>;
  working: boolean;
  onClear: () => void;
}) {
  const navigate = useNavigate();
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);
  const [expanded, setExpanded] = useState(false);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Keep the raw fingerprint so we can look up the human reason; fall back to the
  // normalized signature reason for pre-existing state that predates the map.
  const items = autoSilenced
    .map((fp) => {
      const parsed = parseIncidentFingerprint(fp);
      return parsed ? { ...parsed, detail: autoSilencedReasons[fp] || parsed.reason } : null;
    })
    .filter((x): x is ParsedFingerprint & { detail: string } => x !== null);

  // Report lines other than the auto-silence summary (which the list replaces).
  const otherText = report
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("Auto-silenced "))
    .join("\n");

  // Jump to the affected resource: scope its namespace, navigate to the owning
  // panel, and seed that panel's search with the exact name so it's the only row
  // shown (and the focus-request auto-expands it).
  function openResource(it: ParsedFingerprint) {
    const { route, kind } = targetFor(it.incidentKind);
    setNamespaceFilter(it.namespace);
    navigate(route);
    setFocusRequest({ route, kind, key: `${it.namespace}/${it.name}`, search: it.name });
  }

  function copyReport() {
    void navigator.clipboard?.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const shown = expanded ? items : items.slice(0, COLLAPSED_COUNT);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">Last report</p>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={copyReport} disabled={!report}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="sm" disabled={working} onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Auto-silenced{" "}
          <span className="font-semibold text-[var(--fg-primary)]">{items.length}</span> benign
          issue{items.length === 1 ? "" : "s"}
        </p>
      )}

      {otherText && (
        <p className="select-text whitespace-pre-wrap text-sm text-muted-foreground">{otherText}</p>
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
          {shown.map((it, i) => {
            const t = targetFor(it.incidentKind);
            const isOpen = openRow === i;
            return (
              <div key={`${it.namespace}/${it.name}/${i}`} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenRow((cur) => (cur === i ? null : i))}
                  className="group flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.03]"
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 text-[var(--fg-tertiary)] transition-transform",
                      isOpen ? "rotate-0" : "-rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--fg-primary)]">
                    {it.name}
                  </span>
                  {it.detail && (
                    <span className="min-w-0 max-w-[40%] shrink truncate text-2xs text-[var(--fg-tertiary)]">
                      {it.detail}
                    </span>
                  )}
                  <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-2xs text-[var(--fg-secondary)]">
                    {t.chip}
                  </span>
                </button>

                {isOpen && (
                  <div className="space-y-2 border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5">
                    <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-[var(--fg-tertiary)]">What</dt>
                      <dd className="text-[var(--fg-secondary)]">{t.what}, auto-silenced as benign</dd>
                      <dt className="text-[var(--fg-tertiary)]">Reason</dt>
                      <dd className="min-w-0 select-text whitespace-pre-wrap break-words font-mono text-[var(--fg-primary)]">
                        {it.detail || "—"}
                      </dd>
                      <dt className="text-[var(--fg-tertiary)]">Resource</dt>
                      <dd className="min-w-0 select-text break-all font-mono text-[var(--fg-secondary)]">
                        {it.namespace}/{it.name}
                      </dd>
                    </dl>
                    <Button variant="secondary" size="sm" onClick={() => openResource(it)}>
                      Open in {t.panel}
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {items.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-[var(--accent-primary)] hover:underline"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          {expanded ? "Show less" : `Show all ${items.length}`}
        </button>
      )}

      {/* Report present but nothing structured to show (non-auto-silence text
          already handled above): fall back to the raw string. */}
      {items.length === 0 && !otherText && report && (
        <p className="select-text whitespace-pre-wrap text-sm text-muted-foreground">{report}</p>
      )}
    </Card>
  );
}
