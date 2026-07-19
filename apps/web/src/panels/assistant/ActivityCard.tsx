// ActivityCard — a rich audit entry card for the Activity tab.
// Built to Pencil frame "Assistant — Activity (improved)" (list card). Maps the
// AssistantAuditEntry fields onto the design: status icon (outcome), incident
// title, severity pill (tier), relative time, action (proposal), a command box
// with copy, a result/detail line, an "AI ANALYSIS" block, and Revert.

import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faChevronDown,
  faCircleCheck,
  faCircleXmark,
  faClock,
  faCopy,
  faSparkles,
  faTriangleExclamation,
  faArrowRotateLeft,
} from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { AssistantAuditEntry } from "@rigel/k8s";
import { auditEntryId } from "@rigel/k8s";
import { cn } from "@/lib/utils";
import { useAssistantCtx } from "./AssistantContext";
import { auditCanExpand, relativeTime } from "./display";
import { ActorBadge } from "./components/ActorBadge";

/** Status glyph derived from the audit outcome. */
function StatusIcon({ outcome }: { outcome: string }) {
  if (outcome === "success")
    return <FontAwesomeIcon icon={faCircleCheck} className="size-[18px] shrink-0 text-emerald-500" />;
  if (outcome === "failure") return <FontAwesomeIcon icon={faCircleXmark} className="size-[18px] shrink-0 text-red-500" />;
  if (outcome === "queued") return <FontAwesomeIcon icon={faClock} className="size-[18px] shrink-0 text-amber-500" />;
  return <FontAwesomeIcon icon={faTriangleExclamation} className="size-[17px] shrink-0 text-amber-500" />;
}

/** Copy-to-clipboard button with a brief confirmation. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-secondary)]"
      title="Copy command"
    >
      {copied ? (
        <FontAwesomeIcon icon={faCheck} className="size-3.5 text-emerald-500" />
      ) : (
        <FontAwesomeIcon icon={faCopy} className="size-3.5" />
      )}
      <span className="sr-only">Copy command</span>
    </button>
  );
}

export function ActivityCard({ e }: { e: AssistantAuditEntry }) {
  const { expanded, toggleExpanded, openRevert, run, ns, d, working } = useAssistantCtx();
  const id = auditEntryId(e);
  const isOpen = expanded.has(id);
  const canExpand = auditCanExpand(e.detail, e.analysis);
  const backup = e.backupRef ? d.backupYAML(e.backupRef) : undefined;

  return (
    <div
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[18px]"
      onContextMenu={(ev) => {
        ev.preventDefault();
        run({ action: "silence", namespace: ns, fingerprint: e.fingerprint });
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusIcon outcome={e.outcome} />
          <span className="truncate font-mono text-sm font-semibold text-[var(--fg-primary)]">
            {e.incident}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ActorBadge actor={e.actor} />
          {e.tier && (
            <span className="inline-flex items-center gap-1.5 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-3xs tracking-[0.03em] text-[var(--fg-tertiary)] uppercase">
              <span className="size-1.5 rounded-full bg-[var(--fg-tertiary)]" />
              {e.tier}
            </span>
          )}
          <span className="font-mono text-xs text-[var(--fg-tertiary)]" title={e.at}>
            {relativeTime(e.at)}
          </span>
          {canExpand && (
            <button
              type="button"
              onClick={() => toggleExpanded(id)}
              className="text-[var(--fg-tertiary)] transition-colors hover:text-[var(--fg-secondary)]"
            >
              <FontAwesomeIcon icon={faChevronDown} className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
              <span className="sr-only">{isOpen ? "Collapse" : "Expand"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {(e.proposal || e.command || e.detail || e.analysis || backup) && (
        <div className="mt-3 flex flex-col gap-3">
          {e.proposal && (
            <p className="text-sm font-medium text-[var(--fg-primary)]">{e.proposal}</p>
          )}

          {e.command && (
            <div className="flex items-center gap-2.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2">
              <span className="shrink-0 font-mono text-xs font-semibold text-[var(--accent-primary)]">
                $
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--fg-secondary)]">
                {e.command}
              </code>
              <CopyButton text={e.command} />
            </div>
          )}

          {e.detail && (
            <p
              className={cn(
                "font-mono text-xs text-[var(--fg-secondary)]",
                isOpen ? "whitespace-pre-wrap" : "line-clamp-2",
              )}
            >
              {e.detail}
            </p>
          )}

          {e.analysis && (
            <div className="flex flex-col gap-2">
              <span className="inline-flex w-fit items-center gap-1.5 rounded bg-[var(--accent-primary)]/[0.08] px-2 py-0.5 font-mono text-3xs tracking-[0.05em] text-[var(--accent-primary)] uppercase">
                <FontAwesomeIcon icon={faSparkles} className="size-2.5" />
                AI analysis
              </span>
              <p
                className={cn(
                  "text-xs leading-[1.55] text-[var(--fg-secondary)]",
                  !isOpen && "line-clamp-3",
                )}
              >
                {e.analysis}
              </p>
            </div>
          )}

          {canExpand && !isOpen && (
            <button
              type="button"
              onClick={() => toggleExpanded(id)}
              className="w-fit text-xs font-medium text-[var(--accent-primary)] hover:underline"
            >
              Show more
            </button>
          )}

          {backup && (
            <button
              type="button"
              disabled={working}
              onClick={() => openRevert(backup, e.proposal ?? e.incident)}
              className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)] disabled:opacity-50"
            >
              <FontAwesomeIcon icon={faArrowRotateLeft} className="size-3.5" />
              Revert
            </button>
          )}
        </div>
      )}
    </div>
  );
}
