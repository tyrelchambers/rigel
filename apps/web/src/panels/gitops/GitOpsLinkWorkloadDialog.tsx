// Pick a workload to link to a deployment (lists those not already on it).
// Built to Pencil frame "Link workload modal (improved)": search + select a
// workload from a bordered list panel, then confirm with "Link workload".
import { useMemo, useState } from "react";
import { Box, Check, ChevronDown, GitBranch, Link2, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ActionBlock } from "@/lib/api";
import type { Deployment } from "@/panels/deployments/types";
import { buildLinkAction, linkedSourceName, type WorkloadRef } from "./linkSource";
import type { DeploymentRef } from "./gitopsLogic";

const keyOf = (w: Deployment) => `${w.metadata.namespace ?? "default"}/${w.metadata.name}`;

export function LinkWorkloadDialog({
  target,
  workloads,
  onPick,
  onClose,
}: {
  target: DeploymentRef;
  workloads: Deployment[];
  onPick: (a: ActionBlock) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      workloads
        .filter((w) => linkedSourceName(w) !== target.dep.name)
        .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
    [workloads, target.dep.name],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (w) =>
        w.metadata.name.toLowerCase().includes(q) ||
        (w.metadata.namespace ?? "").toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const selected = candidates.find((w) => keyOf(w) === selectedKey) ?? null;

  function handleLink() {
    if (!selected) return;
    const ref: WorkloadRef = {
      name: selected.metadata.name,
      namespace: selected.metadata.namespace ?? "default",
      kind: "deployment",
    };
    onPick(buildLinkAction(ref, target.dep));
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[600px]">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-[22px] pt-5 pb-4">
          <div className="flex gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent-dim)]">
              <Link2 className="size-[18px] text-[var(--accent-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-[19px] font-bold text-[var(--fg-primary)]">
                  Link a workload to
                </DialogTitle>
                <span className="inline-flex items-center gap-1.5 rounded bg-[var(--accent-primary)]/[0.12] px-2 py-0.5">
                  <Box className="size-3 text-[var(--accent-soft)]" />
                  <span className="font-mono text-[13px] font-medium text-[var(--accent-soft)]">
                    {target.dep.name}
                  </span>
                </span>
              </div>
              <DialogDescription className="max-w-[430px] text-[13px] leading-[1.45] text-[var(--fg-tertiary)]">
                The workload is tagged with this deployment so the AI has context and can open
                fix-PRs.
              </DialogDescription>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-[var(--fg-secondary)] transition-colors hover:bg-white/[0.08]"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[22px] pt-4 pb-[18px]">
          {/* Search */}
          <div className="flex items-center gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3.5 py-[11px]">
            <Search className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search workloads…"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
            />
          </div>

          {/* List panel */}
          <div className="flex flex-col overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3.5 py-2">
              <span className="font-mono text-[10.5px] tracking-[0.08em] text-[var(--fg-tertiary)] uppercase">
                Workloads
              </span>
              <span className="font-mono text-[10.5px] text-[var(--fg-tertiary)]">
                {candidates.length} total
              </span>
            </div>

            <div className="flex h-[300px] flex-col gap-0.5 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-1 py-8 text-center text-sm text-[var(--fg-tertiary)]">
                  {candidates.length === 0
                    ? "No workloads available to link."
                    : "No workloads match your search."}
                </p>
              ) : (
                filtered.map((w) => {
                  const key = keyOf(w);
                  const isSel = key === selectedKey;
                  const already = linkedSourceName(w);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      onDoubleClick={handleLink}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded border px-3 py-2.5 text-left transition-colors",
                        isSel
                          ? "border-[var(--accent-primary)]/35 bg-[var(--accent-dim)]"
                          : "border-transparent hover:bg-white/[0.04]",
                      )}
                    >
                      <GitBranch
                        className={cn(
                          "size-[15px] shrink-0",
                          isSel ? "text-[var(--accent-primary)]" : "text-[var(--fg-secondary)]",
                        )}
                      />
                      <span className="truncate text-sm font-semibold text-[var(--fg-primary)]">
                        {w.metadata.name}
                      </span>
                      <span className="font-mono text-xs text-[var(--fg-tertiary)]">
                        {w.metadata.namespace ?? "default"}
                      </span>
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        {already && (
                          <span className="font-mono text-[10px] text-[var(--fg-tertiary)]">
                            re-point from {already}
                          </span>
                        )}
                        {isSel && <Check className="size-4 text-[var(--accent-primary)]" />}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3.5 py-2">
              <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">
                Showing {filtered.length} of {candidates.length}
              </span>
              {filtered.length > 8 && (
                <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--fg-tertiary)]">
                  Scroll for more
                  <ChevronDown className="size-3" />
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-[22px] pt-4 pb-5">
          {selected ? (
            <div className="flex items-center gap-1.5">
              <Check className="size-3.5 text-[var(--accent-primary)]" />
              <span className="text-[12.5px] text-[var(--fg-secondary)]">
                {selected.metadata.name} selected
              </span>
            </div>
          ) : (
            <span className="text-[12.5px] text-[var(--fg-tertiary)]">
              Select a workload to link
            </span>
          )}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--border-strong)] px-5 py-[11px] text-sm font-semibold text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleLink}
              disabled={!selected}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--accent-primary)] px-[22px] py-[11px] text-sm font-bold text-[var(--fg-inverse)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Link2 className="size-[15px]" />
              Link workload
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
