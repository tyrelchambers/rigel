import { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faCalendar } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { useCluster, filterByNamespace } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { viewYaml } from "@/store/yamlViewer";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ListRow } from "@/panels/components/ListRow";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { PanelSearch } from "@/panels/components/PanelSearch";
import { PanelSelect } from "@/panels/components/PanelSelect";
import { PanelSort, applySort } from "@/panels/components/PanelSort";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { MetaCard } from "@/panels/components/MetaCard";
import type { ActionBlock } from "@/lib/api";
import type { Challenge, ChallengeNode } from "@/panels/certificates/types";
import { relativeAge } from "@/panels/pods/podDisplay";
import {
  challengeNode,
  matchesChallengeSearch,
  matchesAcmeState,
  acmeStateVariant,
  challengeSortOptions,
} from "./acmeChain";

const CHALLENGES_KIND = "challenges.acme.cert-manager.io";

export default function ChallengesPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [sortValue, setSortValue] = useState("namespace");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);

  useEffect(() => {
    subscribe(CHALLENGES_KIND, "*");
    return () => unsubscribe(CHALLENGES_KIND, "*");
  }, []);

  const allRows = useMemo(() => {
    const challenges = filterByNamespace(
      resources[CHALLENGES_KIND] as Record<string, Challenge> | undefined,
      namespaceFilter,
    );
    return challenges.map(challengeNode);
  }, [resources, namespaceFilter]);

  const sortOptions = useMemo(() => challengeSortOptions(), []);

  const filtered = useMemo(() => {
    const matched = allRows.filter(
      (n) =>
        matchesChallengeSearch(n, search) &&
        (typeFilter === "all" || n.type === typeFilter) &&
        matchesAcmeState(n.state, stateFilter),
    );
    return applySort(matched, sortOptions.find((o) => o.value === sortValue), sortDir);
  }, [allRows, search, typeFilter, stateFilter, sortOptions, sortValue, sortDir]);

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function handleDelete(node: ChallengeNode) {
    setPendingAction({
      kind: "deleteResource",
      resourceKind: "challenge",
      name: node.name,
      namespace: node.namespace,
      destructive: true,
      label: `Delete challenge ${node.name}`,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Challenges" subtitle="ACME validation" count={filtered.length} loading={isLoading}>
        <PanelSearch
          value={search}
          onValueChange={setSearch}
          placeholder="Search challenges…"
          className="w-56"
        />
        <PanelSelect value={typeFilter} onValueChange={setTypeFilter} ariaLabel="Filter by type" className="max-w-36">
          <option value="all">All types</option>
          <option value="HTTP-01">HTTP-01</option>
          <option value="DNS-01">DNS-01</option>
        </PanelSelect>
        <PanelSelect value={stateFilter} onValueChange={setStateFilter} ariaLabel="Filter by state" className="max-w-44">
          <option value="all">All states</option>
          <option value="active">Active</option>
          <option value="failed">Failed</option>
          <option value="valid">Valid</option>
        </PanelSelect>
        <PanelSort
          options={sortOptions}
          value={sortValue}
          onValueChange={setSortValue}
          direction={sortDir}
          onDirectionChange={setSortDir}
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
        {error && (
          <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}

        <div className="flex flex-col gap-0.5 px-3 py-2">
          {filtered.map((node) => {
            const isOpen = expanded.has(node.uid);
            const showReason = !matchesAcmeState(node.state, "valid") && node.reason;

            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => viewYaml("challenge", node.name, node.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(node.uid)}>{isOpen ? "Collapse" : "Expand"}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => handleDelete(node)}>Delete…</ContextMenuItem>
              </>
            );

            return (
              <ListRow
                key={node.uid}
                rowKey={node.uid}
                isOpen={isOpen}
                onToggle={() => toggleExpand(node.uid)}
                contextMenu={rowMenu}
                expandedContent={<ChallengeDetail node={node} />}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(node.uid)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {node.name}
                </button>

                <span className="shrink-0 whitespace-nowrap rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-px font-mono text-3xs text-[var(--fg-tertiary)]">
                  {node.namespace ?? "—"}
                </span>

                <StatusBadge label={node.type} variant="neutral" />

                <StatusBadge label={node.state} variant={acmeStateVariant(node.state)} />

                {showReason && (
                  <span
                    className="min-w-0 flex-1 truncate text-3xs text-muted-foreground"
                    title={node.reason}
                  >
                    {node.reason}
                  </span>
                )}

                {!showReason && <span className="flex-1" />}

                <span
                  className="min-w-0 max-w-52 shrink truncate font-mono text-3xs text-[var(--fg-tertiary)]"
                  title={node.dnsName}
                >
                  {node.dnsName}
                </span>

                <span className="shrink-0 whitespace-nowrap font-mono text-3xs text-[var(--fg-tertiary)]">
                  {relativeAge(node.createdAt)}
                </span>
              </ListRow>
            );
          })}
        </div>

        {!isLoading && allRows.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No ACME challenges in flight — cert-manager may not be installed or nothing is being validated.
          </p>
        )}
        {!isLoading && allRows.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">No challenges match your filters</p>
        )}
      </div>

      <ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
    </div>
  );
}

function ChallengeDetail({ node }: { node: ChallengeNode }) {
  return (
    <div className="flex gap-3">
      <MetaCard label="STATE">
        <div className="flex flex-col gap-2">
          <StatusBadge label={node.state} variant={acmeStateVariant(node.state)} />
          {node.reason && (
            <span className="text-xs text-[var(--fg-secondary)]">{node.reason}</span>
          )}
        </div>
      </MetaCard>

      <MetaCard label="DNS NAME">
        <div className="flex items-center gap-[7px]">
          <FontAwesomeIcon icon={faGlobe} className="size-[13px] text-[var(--fg-tertiary)]" />
          <span className="font-mono text-xs text-[var(--fg-secondary)]">{node.dnsName}</span>
          {node.wildcard && <StatusBadge label="Wildcard" variant="neutral" />}
        </div>
      </MetaCard>

      <MetaCard label="TOKEN">
        <span className="break-all font-mono text-xs text-[var(--fg-secondary)]">{node.token}</span>
      </MetaCard>

      <MetaCard label="PRESENTED / PROCESSING">
        <div className="flex items-center gap-2">
          <StatusBadge label={node.presented ? "Yes" : "No"} variant={node.presented ? "healthy" : "neutral"} />
          <StatusBadge label={node.processing ? "Yes" : "No"} variant={node.processing ? "pending" : "neutral"} />
        </div>
      </MetaCard>

      <MetaCard label="AGE">
        <div className="flex items-center gap-[7px]">
          <FontAwesomeIcon icon={faCalendar} className="size-[13px] text-[var(--fg-tertiary)]" />
          <span className="text-sm text-[var(--fg-secondary)]">{relativeAge(node.createdAt)}</span>
        </div>
      </MetaCard>
    </div>
  );
}
