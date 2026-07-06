// PermissionsTab — Simple/Advanced RBAC editor. Pencil frames jCXlB (Simple)
// and riSgI (Advanced). Stages edits to an in-memory RbacPolicy, reviews the
// diff, and applies it as a ClusterRole via setRbac.
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
import { useContexts } from "@/lib/api";
import { useAssistantCtx } from "../AssistantContext";
import { usePermissions } from "../permissions/usePermissions";
import { SimpleView } from "../permissions/SimpleView";
import { AdvancedView } from "../permissions/AdvancedView";
import { ReviewDialog } from "../permissions/ReviewDialog";

type PermissionsView = "simple" | "advanced";

export function PermissionsTab() {
  const { ns } = useAssistantCtx();
  const [view, setView] = useState<PermissionsView>("simple");
  const [reviewOpen, setReviewOpen] = useState(false);
  const { data: contexts } = useContexts();
  const perms = usePermissions(ns);

  const activeContextName = contexts?.find((c) => c.active)?.name ?? ns;
  const targetLabel =
    perms.target === "all" ? "all installed clusters" : `Active cluster · ${activeContextName}`;

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

      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--fg-secondary)]">
        <span>Apply to</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Apply to"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-1.5 text-sm font-medium text-[var(--fg-primary)] outline-none"
          >
            {targetLabel}
            <ChevronDown className="size-3.5 text-[var(--fg-tertiary)]" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => perms.setTarget("active")}>
              Active cluster · {activeContextName}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => perms.setTarget("all")}>
              All installed clusters
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {view === "simple" ? (
        <SimpleView
          staged={perms.staged}
          onToggleCapability={perms.toggleCapability}
          disabled={perms.applying}
        />
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
          <Button disabled={noChanges || perms.applying} onClick={() => perms.apply()}>
            {perms.applying ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        applied={perms.applied}
        staged={perms.staged}
        targetLabel={targetLabel}
        confirming={perms.applying}
        onConfirm={() => perms.apply(() => setReviewOpen(false))}
      />
    </div>
  );
}
