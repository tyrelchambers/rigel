// LastReportCard — the Overview "Last report" card. Renders the agent's
// auto-silenced incidents (parsed from the state's `autoSilenced` fingerprint
// list) as a structured, expandable list whose rows jump to the affected
// resource, plus Copy and Clear actions. Any non-auto-silence report lines are
// shown as plain text.

import { useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { parseIncidentFingerprint, type ParsedFingerprint } from "@rigel/k8s";
import { Button } from "@/components/ui/button";
import { useCluster } from "@/store/cluster";
import { cn } from "@/lib/utils";
import { Card } from "./primitives";
import { LogBlock } from "./LogBlock";

const COLLAPSED_COUNT = 4;

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

/** Small white-wash pill used for the kind chip and status tags. */
function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded bg-white/[0.06] px-2 py-0.5 font-mono text-3xs text-[var(--fg-tertiary)]",
        className,
      )}
    >
      {children}
    </span>
  );
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

  const items = autoSilenced
    .map((fp) => {
      const parsed = parseIncidentFingerprint(fp);
      return parsed ? { ...parsed, detail: autoSilencedReasons[fp] || parsed.reason } : null;
    })
    .filter((x): x is ParsedFingerprint & { detail: string } => x !== null);

  const otherText = report
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("Auto-silenced "))
    .join("\n");

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
    <Card className="space-y-4 border-0 bg-transparent px-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="flex size-[30px] items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent-primary)_15%,transparent)]">
            <ShieldCheck className="size-4 text-[var(--accent-primary)]" />
          </div>
          <p className="text-base font-bold text-[var(--fg-primary)]">Last report</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={copyReport} disabled={!report}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="secondary" size="sm" disabled={working} onClick={onClear}>
            <Trash2 className="size-3.5" />
            Clear
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="flex items-center gap-2.5">
          <CircleCheck className="size-4 shrink-0 text-[var(--status-running)]" />
          <p className="text-sm text-muted-foreground">
            Rigel checked{" "}
            <span className="font-semibold text-[var(--fg-primary)]">{items.length}</span> flagged
            issue{items.length === 1 ? "" : "s"} and found nothing that needs your attention
          </p>
        </div>
      )}

      {otherText && (
        <p className="select-text whitespace-pre-wrap text-sm text-muted-foreground">{otherText}</p>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          {shown.map((it, i) => {
            const t = targetFor(it.incidentKind);
            const isOpen = openRow === i;
            return (
              <div
                key={`${it.namespace}/${it.name}/${i}`}
                className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)]"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenRow((cur) => (cur === i ? null : i))}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3.5 py-3 text-left hover:bg-white/[0.02]",
                    isOpen && "border-b border-[var(--border-subtle)]",
                  )}
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 text-[var(--fg-tertiary)] transition-transform",
                      isOpen ? "rotate-0" : "-rotate-90",
                    )}
                  />
                  <ShieldCheck className="size-3.5 shrink-0 text-[var(--fg-tertiary)]" />
                  <span className="shrink-0 font-mono text-sm font-semibold text-[var(--fg-primary)]">
                    {it.name}
                  </span>
                  <Pill className="font-normal text-2xs text-[var(--fg-secondary)]">{t.chip}</Pill>
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-3 p-3.5">
                    {it.detail && (
                      <LogBlock
                        label={`${it.incidentKind === "loggedError" ? "LOG" : t.chip.toUpperCase()} · ${it.name}`}
                        detail={it.detail}
                      />
                    )}
                    <div className="flex">
                      <span className="inline-flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-white/[0.04] px-2 py-1 font-mono text-2xs text-[var(--fg-secondary)]">
                        <Box className="size-3 text-[var(--fg-tertiary)]" />
                        {it.namespace} / {it.name}
                      </span>
                    </div>
                    <div>
                      <Button variant="outline" size="sm" onClick={() => openResource(it)}>
                        Open in {t.panel}
                        <ArrowRight className="size-3.5" />
                      </Button>
                    </div>
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

      {items.length === 0 && !otherText && report && (
        <p className="select-text whitespace-pre-wrap text-sm text-muted-foreground">{report}</p>
      )}
    </Card>
  );
}
