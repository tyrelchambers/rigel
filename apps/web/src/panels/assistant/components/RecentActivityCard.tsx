// RecentActivityCard — Overview "Recent activity" row, built to the Pencil frame
// "Recent activity (redesign)": a status glyph + namespace badge + name +
// coloured condition pill + severity + time header, expanding to an AI-analysis
// block, a terminal log viewer, and a resolution row (auto-cleared vs needs-you)
// with an Open/Review action.

import { useState } from "react";
import { useNavigate } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRight,
  faChevronDown,
  faChevronRight,
  faCircleCheck,
  faCircleXmark,
  faSparkles,
  faTriangleExclamation,
  faWrench,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import { parseIncidentFingerprint, type AssistantAuditEntry } from "@rigel/k8s";
import { useCluster } from "@/store/cluster";
import { cn } from "@/lib/utils";
import { remarkAlerts } from "@/lib/remarkAlerts";
import { CodeBlock } from "@/panels/chat/CodeBlock";
import { ChatBlockquote } from "@/panels/chat/Callout";
import { useAssistantCtx } from "../AssistantContext";
import { relativeTime, auditCanExpand } from "../display";
import { ActorBadge } from "./ActorBadge";

function targetFor(incidentKind: string) {
  switch (incidentKind) {
    case "degradedDeployment":
      return { route: "/deployments", kind: "deployment", panel: "Deployments", label: "Degraded" };
    case "loggedError":
      return { route: "/pods", kind: "pod", panel: "Pods", label: "Error burst" };
    case "unhealthyPod":
      return { route: "/pods", kind: "pod", panel: "Pods", label: "Unhealthy" };
    default:
      return { route: "/pods", kind: "pod", panel: "Pods", label: incidentKind || "Incident" };
  }
}

/** Status glyph + tint for the header/resolution, derived from the outcome. */
function statusMeta(outcome: string): { icon: IconDefinition; cls: string } {
  switch (outcome) {
    case "success":
    case "skipped":
      return { icon: faCircleCheck, cls: "text-[var(--status-running)]" };
    case "failure":
      return { icon: faCircleXmark, cls: "text-[var(--status-failed)]" };
    default:
      return { icon: faTriangleExclamation, cls: "text-[#E2B33E]" };
  }
}

/** Condition pill tone: red for crashing/fatal signatures, amber otherwise. */
function conditionTone(label: string): string {
  return /crash|oom|fatal|panic|backoff/i.test(label)
    ? "bg-[#FF6B6B]/12 text-[#FF8A8A]"
    : "bg-[#E2B33E]/12 text-[#E2B33E]";
}

export function RecentActivityCard({ e }: { e: AssistantAuditEntry }) {
  const { run, ns, setTab } = useAssistantCtx();
  const navigate = useNavigate();
  const setNamespaceFilter = useCluster((s) => s.setNamespaceFilter);
  const setFocusRequest = useCluster((s) => s.setFocusRequest);
  const [open, setOpen] = useState(false);

  const parsed = parseIncidentFingerprint(e.fingerprint);
  const t = targetFor(parsed?.incidentKind ?? "");
  const name = parsed?.name ?? e.incident;
  const condition =
    parsed?.incidentKind === "loggedError" ? "Error burst" : parsed?.reason || t.label;
  const status = statusMeta(e.outcome);
  const canExpand = auditCanExpand(e.detail, e.analysis);
  // The synopsis is the model's markdown analysis (verdict fences, callouts,
  // code), rendered through the same pipeline as the Rigel chat.
  const synopsis = e.analysis || e.detail || "";
  const preview =
    (synopsis || e.proposal || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("```"))
      ?.replace(/\*\*/g, "")
      .replace(/^[#>\-\s]+/, "") ?? "";
  const queued = e.outcome === "queued";

  function openResource() {
    if (!parsed) return;
    setNamespaceFilter(parsed.namespace);
    navigate(t.route);
    setFocusRequest({
      route: t.route,
      kind: t.kind,
      key: `${parsed.namespace}/${parsed.name}`,
      search: parsed.name,
    });
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)]"
      onContextMenu={(ev) => {
        ev.preventDefault();
        run({ action: "silence", namespace: ns, fingerprint: e.fingerprint });
      }}
    >
      {/* Header */}
      <button
        type="button"
        disabled={!canExpand}
        aria-expanded={open}
        onClick={() => canExpand && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3.5 py-3 text-left",
          canExpand && "hover:bg-white/[0.02]",
          open && "border-b border-[var(--border-subtle)]",
        )}
      >
        {canExpand ? (
          <FontAwesomeIcon
            icon={faChevronDown}
            className={cn(
              "size-3.5 shrink-0 text-[var(--fg-tertiary)] transition-transform",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
        ) : (
          <FontAwesomeIcon icon={faChevronRight} className="size-3.5 shrink-0 text-transparent" />
        )}
        <FontAwesomeIcon icon={status.icon} className={cn("size-3.5 shrink-0", status.cls)} />
        {parsed && (
          <span className="shrink-0 rounded border border-[var(--border-subtle)] bg-white/[0.04] px-2 py-0.5 font-mono text-xs text-[var(--fg-tertiary)]">
            {parsed.namespace}
          </span>
        )}
        <span className="shrink-0 font-mono text-sm font-semibold text-[var(--fg-primary)]">
          {name}
        </span>
        <span
          className={cn("shrink-0 rounded px-2 py-0.5 font-mono text-2xs font-medium", conditionTone(condition))}
        >
          {condition}
        </span>
        {!open && preview && (
          <span className="min-w-0 flex-1 truncate text-2xs text-[var(--fg-tertiary)]">{preview}</span>
        )}
        {(open || !preview) && <span className="flex-1" />}
        <ActorBadge actor={e.actor} />
        {e.tier && (
          <span className="flex shrink-0 items-center gap-1.5 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-3xs uppercase tracking-[0.5px] text-[var(--fg-tertiary)]">
            <span className="size-1 rounded-full bg-[var(--fg-tertiary)]" />
            {e.tier}
          </span>
        )}
        <span className="shrink-0 font-mono text-xs text-[var(--fg-tertiary)]" title={e.at}>
          {relativeTime(e.at)}
        </span>
      </button>

      {/* Body */}
      {open && canExpand && (
        <div className="flex flex-col gap-3.5 p-3.5">
          {synopsis && (
            <div className="flex flex-col gap-2">
              <span className="inline-flex w-fit items-center gap-1.5 rounded bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] px-2 py-0.5 font-mono text-3xs uppercase tracking-[0.5px] text-[var(--accent-primary)]">
                <FontAwesomeIcon icon={faSparkles} className="size-3" />
                AI analysis
              </span>
              <div className="chat-md select-text">
                <Markdown
                  remarkPlugins={[remarkGfm, remarkAlerts]}
                  components={{ pre: CodeBlock, blockquote: ChatBlockquote }}
                >
                  {synopsis}
                </Markdown>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <FontAwesomeIcon icon={status.icon} className={cn("size-3.5 shrink-0", status.cls)} />
              <span className="min-w-0 text-xs text-[var(--fg-secondary)]">
                {queued
                  ? `Needs you${e.proposal ? `: ${e.proposal}` : ""}`
                  : e.outcome === "failure"
                    ? "Action failed"
                    : e.proposal || "Auto-cleared, no action needed."}
              </span>
            </div>
            {queued ? (
              <button
                type="button"
                onClick={() => setTab("needs")}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--accent-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary)]"
              >
                <FontAwesomeIcon icon={faWrench} className="size-3.5" />
                Review fix
              </button>
            ) : parsed ? (
              <button
                type="button"
                onClick={openResource}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--fg-primary)] hover:bg-white/[0.03]"
              >
                Open in {t.panel}
                <FontAwesomeIcon icon={faArrowRight} className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
