// PermissionsTab — Simple/Advanced RBAC editor. Stages edits to an in-memory
// RbacPolicy, reviews the diff, and applies it as a ClusterRole via setRbac.
// Scope: Apply (active cluster), Save to all clusters, or Copy to a subset.
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TabBar, Tab } from "@/components/ui/Tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useContexts, useInstalledContexts } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { usePermissions } from "../permissions/usePermissions";
import { SimpleView } from "../permissions/SimpleView";
import { AdvancedView } from "../permissions/AdvancedView";
import { ReviewDialog } from "../permissions/ReviewDialog";
import { CopyToClustersDialog } from "../permissions/CopyToClustersDialog";

type PermissionsView = "simple" | "advanced";

export function PermissionsTab() {
  const { ns } = useAssistantCtx();
  const [view, setView] = useState<PermissionsView>("simple");
  const [reviewOpen, setReviewOpen] = useState(false);
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
          <span className="text-[12.5px] text-amber-300">
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
          <Button variant="ghost" disabled={noChanges} onClick={() => setReviewOpen(true)}>
            Review changes
          </Button>
          <div className="flex items-center">
            <Button disabled={noChanges || perms.applying} onClick={() => perms.apply([activeContextName])}>
              {perms.applying ? "Applying…" : "Apply"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="More apply options"
                disabled={perms.applying || !hasOthers}
                className="ml-1 inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-2 text-[var(--fg-secondary)] outline-none disabled:opacity-40"
              >
                <ChevronDown className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={noChanges}
                  onClick={() => perms.apply(installedNames)}
                >
                  Save to all clusters ({installedNames.length})
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCopyOpen(true)}>
                  Copy to clusters…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {perms.applyError && !reviewOpen && !copyOpen && (
        <p className="font-mono text-[11px] text-[var(--status-failed)]">{perms.applyError.message}</p>
      )}

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        applied={perms.applied}
        staged={perms.staged}
        targetLabel={`Active cluster · ${activeContextName}`}
        confirming={perms.applying}
        error={perms.applyError?.message}
        onConfirm={() => perms.apply([activeContextName], () => setReviewOpen(false))}
      />

      <CopyToClustersDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        clusters={installed ?? []}
        confirming={perms.applying}
        error={perms.applyError?.message}
        onConfirm={(picked) => perms.apply(picked, () => setCopyOpen(false))}
      />
    </div>
  );
}
