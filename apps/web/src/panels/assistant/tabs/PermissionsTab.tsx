// PermissionsTab — Simple/Advanced RBAC editor. Stages edits to an in-memory
// RbacPolicy, reviews the diff, and applies it as a ClusterRole via setRbac.
// Scope: Apply (active cluster), Save to all clusters, or Copy to a subset —
// each confirmed through a dialog that shows the diff and names the cluster set.
import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TabBar, Tab } from "@/components/ui/Tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useContexts, useInstalledContexts } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { usePermissions } from "../permissions/usePermissions";
import { SimpleView } from "../permissions/SimpleView";
import { AdvancedView } from "../permissions/AdvancedView";
import { ReviewDialog } from "../permissions/ReviewDialog";
import { CopyToClustersDialog } from "../permissions/CopyToClustersDialog";

type PermissionsView = "simple" | "advanced";
type PendingApply = { contexts: string[]; label: string };

export function PermissionsTab() {
  const { ns } = useAssistantCtx();
  const [view, setView] = useState<PermissionsView>("simple");
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const { data: contexts } = useContexts();
  const { data: installed } = useInstalledContexts(ns);
  const perms = usePermissions(ns);

  const activeContextName = contexts?.find((c) => c.active)?.name ?? ns;
  const installedNames = (installed ?? []).map((c) => c.name);
  const hasOthers = installedNames.some((n) => n !== activeContextName);
  const noChanges = perms.diff.count === 0;

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <p className="text-sm font-semibold">Permissions</p>
          <p className="text-xs text-muted-foreground">
            What this cluster&apos;s assistant is allowed to do. Saved as a ClusterRole and live on
            the next API call — no restart.
          </p>
        </div>
        <TabBar value={view} onValueChange={(v) => setView(v as PermissionsView)}>
          <Tab value="simple">Simple</Tab>
          <Tab value="advanced">Advanced</Tab>
        </TabBar>
      </div>

      {perms.drift && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <span className="text-xs text-amber-300">
            This cluster&apos;s live permissions differ from your saved policy.
          </span>
          <Button
            variant="outline"
            disabled={perms.applying}
            onClick={() => perms.reapply([activeContextName])}
          >
            Re-apply
          </Button>
        </div>
      )}

      {view === "simple" ? (
        <SimpleView staged={perms.staged} onToggleCapability={perms.toggleCapability} disabled={perms.applying} />
      ) : (
        <AdvancedView staged={perms.staged} onToggleCell={perms.toggleCell} disabled={perms.applying} />
      )}

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
        <span className={cn("text-xs font-medium text-amber-400", noChanges && "invisible")}>
          {perms.diff.count} change{perms.diff.count === 1 ? "" : "s"} pending
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <Button
              disabled={noChanges || perms.applying}
              onClick={() =>
                setPending({ contexts: [activeContextName], label: `Active cluster · ${activeContextName}` })
              }
            >
              {perms.applying ? "Applying…" : "Apply"}
            </Button>
            {hasOthers ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="More apply options"
                  disabled={perms.applying}
                  className="ml-1 inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-2 text-[var(--fg-secondary)] outline-none disabled:opacity-40"
                >
                  <FontAwesomeIcon icon={faChevronDown} className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={noChanges}
                    onClick={() =>
                      setPending({
                        contexts: installedNames,
                        label: `All installed clusters (${installedNames.length})`,
                      })
                    }
                  >
                    Save to all clusters ({installedNames.length})
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCopyOpen(true)}>
                    Copy to clusters…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <TooltipProvider delay={200}>
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    aria-label="More apply options"
                    aria-disabled
                    className="ml-1 inline-flex cursor-not-allowed items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-2 text-[var(--fg-secondary)] opacity-40 outline-none"
                  >
                    <FontAwesomeIcon icon={faChevronDown} className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Save to all / copy needs another cluster with the assistant installed.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </div>

      {perms.applyError && pending === null && !copyOpen && (
        <p className="font-mono text-2xs text-[var(--status-failed)]">{perms.applyError.message}</p>
      )}

      <ReviewDialog
        open={pending !== null}
        onOpenChange={() => setPending(null)}
        applied={perms.applied}
        staged={perms.staged}
        targetLabel={pending?.label ?? ""}
        confirming={perms.applying}
        error={perms.applyError?.message}
        onConfirm={() => pending && perms.apply(pending.contexts, () => setPending(null))}
      />

      <CopyToClustersDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        clusters={installed ?? []}
        applied={perms.applied}
        staged={perms.staged}
        confirming={perms.applying}
        error={perms.applyError?.message}
        onConfirm={(picked) => perms.apply(picked, () => setCopyOpen(false))}
      />
    </div>
  );
}
