// AuditRow — a single row in the audit log, with expand/collapse and revert.

import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantAuditEntry } from "@helmsman/k8s";
import { auditEntryId } from "@helmsman/k8s";
import { useAssistantCtx } from "./AssistantContext";
import {
  outcomeGlyph,
  outcomeColorClass,
  relativeTime,
  auditCanExpand,
} from "./display";

export function AuditRow({ e }: { e: AssistantAuditEntry }) {
  const { expanded, toggleExpanded, run, ns, openRevert, d, working } = useAssistantCtx();
  const id = auditEntryId(e);
  const isOpen = expanded.has(id);
  const canExpand = auditCanExpand(e.detail, e.analysis);
  const backup = e.backupRef ? d.backupYAML(e.backupRef) : undefined;

  return (
    <div
      className="rounded-md border p-2"
      onContextMenu={(ev) => {
        ev.preventDefault();
        run({ action: "silence", namespace: ns, fingerprint: e.fingerprint });
      }}
    >
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => canExpand && toggleExpanded(id)}
        disabled={!canExpand}
      >
        <span className={outcomeColorClass(e.outcome)}>{outcomeGlyph(e.outcome)}</span>
        <span className="truncate font-mono text-sm font-medium">{e.incident}</span>
        <span className="ml-auto flex items-center gap-2">
          {canExpand &&
            (isOpen ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            ))}
          <span className="font-mono text-[9px] uppercase text-muted-foreground">{e.tier}</span>
          <span
            className="font-mono text-[10px] text-muted-foreground"
            title={e.at}
          >
            {relativeTime(e.at)}
          </span>
        </span>
      </button>
      {e.proposal && <p className="mt-1 text-sm text-muted-foreground">{e.proposal}</p>}
      {e.command && (
        <p className="select-text font-mono text-[10px] text-muted-foreground">{e.command}</p>
      )}
      {e.detail && (
        <p
          className={`select-text font-mono text-[10px] text-muted-foreground ${
            isOpen ? "whitespace-pre-wrap" : "line-clamp-3"
          }`}
        >
          {e.detail}
        </p>
      )}
      {isOpen && e.analysis && (
        <div className="mt-1 border-t pt-1">
          <p className="font-mono text-[9px] uppercase text-muted-foreground">
            Rigel's analysis
          </p>
          <p className="select-text whitespace-pre-wrap text-xs text-muted-foreground">
            {e.analysis}
          </p>
        </div>
      )}
      {backup && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1"
          disabled={working}
          onClick={() => openRevert(backup, e.proposal ?? e.incident)}
        >
          <Undo2 className="size-3.5" /> Revert
        </Button>
      )}
    </div>
  );
}
