import { useState } from "react";
import { SiGithub } from "react-icons/si";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCodePullRequest, faXmark, faRotate, faRobot, faComment } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { formatDistanceToNow } from "date-fns";
import { findByDeployment } from "@rigel/k8s";
import {
  useChatPullRequests,
  useDismissPullRequest,
  useGitSources,
  usePrStatus,
  type PrState,
} from "@/panels/gitops/gitApi";
import { SyncDialog } from "@/panels/gitops/SyncDialog";
import type { DeploymentRef } from "@/panels/gitops/gitopsLogic";
import { useAssistant } from "@/panels/assistant/useAssistant";
import { mergePrRows, type PrOrigin, type PrRowModel } from "./pendingPrs";
import { cn } from "@/lib/utils";

const STATE_TINT: Record<PrState | "failed", string> = {
  open: "text-amber-500",
  merged: "text-purple-500",
  closed: "text-muted-foreground",
  failed: "text-[var(--status-failed)]",
};

const ORIGIN = {
  chat: { label: "Chat", icon: faComment },
  agent: { label: "Agent", icon: faRobot },
} satisfies Record<PrOrigin, { label: string; icon: typeof faRobot }>;

/** Every PR Rigel opened — from chat and from the in-cluster agent — with a sync once merged. */
export function PendingPrsCard() {
  const { data: chatPrs } = useChatPullRequests();
  const { pullRequests: agentPrs } = useAssistant("default");
  const [syncTarget, setSyncTarget] = useState<DeploymentRef | null>(null);
  const rows = mergePrRows(chatPrs ?? [], agentPrs ?? []);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-[30px] items-center justify-center rounded-[9px] bg-white/8">
            <FontAwesomeIcon icon={faCodePullRequest} className="size-4 text-[var(--fg-primary)]" />
          </span>
          <span className="text-base font-bold text-[var(--fg-primary)]">Pending PRs</span>
        </div>
        <span className="font-mono text-2xs text-[var(--fg-tertiary)]">
          {rows.length} opened by Rigel
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        rows.map((row, i) => (
          <PrRow key={row.key} row={row} last={i === rows.length - 1} onSync={setSyncTarget} />
        ))
      )}

      {syncTarget && <SyncDialog target={syncTarget} onClose={() => setSyncTarget(null)} />}
    </div>
  );
}

function PrRow({
  row,
  last,
  onSync,
}: {
  row: PrRowModel;
  last: boolean;
  onSync: (target: DeploymentRef) => void;
}) {
  const { data: status } = usePrStatus(row.prUrl);
  const { data: sources } = useGitSources();
  const dismiss = useDismissPullRequest();
  const found = findByDeployment(sources ?? [], row.source);
  const origin = ORIGIN[row.origin];
  const shown = status?.state ?? row.fallbackState;
  const age = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3.5 py-3",
        !last && "border-b border-[var(--border-subtle)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SiGithub aria-hidden className={cn("size-4 shrink-0", shown ? STATE_TINT[shown] : "text-muted-foreground")} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {row.prUrl ? (
              <a
                href={row.prUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate text-[13.5px] font-semibold text-[var(--fg-primary)] hover:underline"
              >
                {row.repoSlug}
                {row.number ? ` #${row.number}` : ""}
              </a>
            ) : (
              <span className="truncate text-[13.5px] font-semibold text-[var(--fg-primary)]">{row.repoSlug}</span>
            )}
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-3xs tracking-[0.03em] text-[var(--fg-tertiary)] uppercase">
              <FontAwesomeIcon icon={origin.icon} className="size-2.5" />
              {origin.label}
            </span>
          </div>
          <span className="truncate font-mono text-2xs text-[var(--fg-tertiary)]">
            {row.title} · {shown ?? "checking…"} · {age}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {status?.state === "merged" && (
          <button
            type="button"
            disabled={!found}
            onClick={() => found && onSync({ repo: found.repo, dep: found.dep })}
            title={found ? undefined : "This deployment is no longer linked to a repo"}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-1.5 text-xs text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] disabled:opacity-40"
          >
            <FontAwesomeIcon icon={faRotate} className="size-3" /> Sync now
          </button>
        )}
        {row.dismissId && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss.mutate(row.dismissId!)}
            disabled={dismiss.isPending}
            className="inline-flex size-6 items-center justify-center rounded-md text-[var(--fg-tertiary)] hover:text-[var(--fg-primary)]"
          >
            <FontAwesomeIcon icon={faXmark} className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2.5 p-8 text-center">
      <span className="inline-flex size-[46px] items-center justify-center rounded-full bg-[#38BDF826]">
        <FontAwesomeIcon icon={faCodePullRequest} className="size-[22px] text-[var(--accent-primary)]" />
      </span>
      <span className="text-[15px] font-semibold text-[var(--fg-primary)]">No open pull requests</span>
      <p className="m-0 max-w-[320px] text-[12.5px] text-[var(--fg-secondary)]">
        Fixes Rigel opens as pull requests — from chat or from the in-cluster
        agent — show up here, so you can track them and sync once they merge.
      </p>
    </div>
  );
}
