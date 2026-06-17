import { useEffect, useMemo, useState } from "react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { ListRow } from "@/panels/components/ListRow";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildHandoffPrompt } from "@/panels/components/chatHandoffPrompts";
import { viewYaml } from "@/store/yamlViewer";
import type {
  ServiceAccount,
  Role,
  ClusterRole,
  RoleBinding,
  ClusterRoleBinding,
  RbacKind,
} from "./types";
import {
  subjectsSummary,
  rulesSummary,
  matchesSearch,
  sortByNamespaceName,
  sortByName,
} from "./rbacDisplay";

// ---------------------------------------------------------------------------
// DEFERRED ACTIONS (docs/parity/rbac.md §5). This is a READ-ONLY panel. The
// following row context-menu items are intentionally NON-FUNCTIONAL stubs and
// must NOT be wired up without a new feature spec + infra:
//   - View YAML (needs a server YAML endpoint + viewer UI).
//   - Delete <kind> (needs ConfirmSheet wiring + server mutation route). When
//     wired, deletions emit `deleteResource` action blocks per
//     docs/parity/contracts.md §1.
// No action blocks are emitted by this panel.
// ---------------------------------------------------------------------------

const KIND_TABS: { kind: RbacKind; label: string }[] = [
  { kind: "serviceaccounts", label: "ServiceAccounts" },
  { kind: "roles", label: "Roles" },
  { kind: "rolebindings", label: "RoleBindings" },
  { kind: "clusterroles", label: "ClusterRoles" },
  { kind: "clusterrolebindings", label: "ClusterRoleBindings" },
];

/** "0 secrets" / "1 secret" / "N secrets" with correct pluralization. */
function secretsLabel(n: number): string {
  return `${n} ${n === 1 ? "secret" : "secrets"}`;
}

/** "0 rules" / "1 rule" / "N rules" with correct pluralization. */
function rulesLabel(n: number): string {
  return `${n} ${n === 1 ? "rule" : "rules"}`;
}

/** roleRef → "<kind>/<name>" with the given default kind, or "—" if absent. */
function roleRefLabel(
  roleRef: { kind?: string; name?: string } | undefined,
  defaultKind: string,
): string {
  if (!roleRef || !roleRef.name) return "—";
  const kind = roleRef.kind ?? defaultKind;
  return `${kind}/${roleRef.name}`;
}

/** Namespace chip — dim bordered monospace pill (namespaced kinds only). */
function NamespaceChip({ namespace }: { namespace: string }) {
  return (
    <span
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
        color: "var(--fg-tertiary)",
        background: "var(--surface-sunken)",
        padding: "1px 5px",
        borderRadius: 4,
        border: "1px solid #26272B",
        whiteSpace: "nowrap",
      }}
    >
      {namespace}
    </span>
  );
}

/** Expanded rules detail shared by Role and ClusterRole rows. */
function RulesDetail({ summary }: { summary: string }) {
  return (
    <pre className="rounded-md bg-muted/30 px-3 py-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
      {summary}
    </pre>
  );
}

/** Expanded subjects/roleRef detail for RoleBinding and ClusterRoleBinding rows. */
function BindingDetail({ roleRef, subjects }: { roleRef: string; subjects: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex gap-3">
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground w-16 shrink-0">
          ROLE REF
        </span>
        <span className="font-mono text-xs text-muted-foreground">{roleRef}</span>
      </div>
      <div className="flex gap-3">
        <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground w-16 shrink-0">
          SUBJECTS
        </span>
        <span className="font-mono text-xs text-muted-foreground">{subjects}</span>
      </div>
    </div>
  );
}

export default function RbacPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [activeKind, setActiveKind] = useState<RbacKind>("serviceaccounts");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Namespace-scoped kinds: re-subscribe when the namespace filter changes.
  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("serviceaccounts", ns);
    subscribe("roles", ns);
    subscribe("rolebindings", ns);
    return () => {
      unsubscribe("serviceaccounts", ns);
      unsubscribe("roles", ns);
      unsubscribe("rolebindings", ns);
    };
  }, [namespaceFilter]);

  // Cluster-scoped kinds: subscribe once with "*" on mount.
  useEffect(() => {
    subscribe("clusterroles", "*");
    subscribe("clusterrolebindings", "*");
    return () => {
      unsubscribe("clusterroles", "*");
      unsubscribe("clusterrolebindings", "*");
    };
  }, []);

  const allServiceAccounts = useMemo(
    () =>
      sortByNamespaceName(
        Object.values(
          (resources["serviceaccounts"] ?? {}) as Record<string, ServiceAccount>,
        ),
      ),
    [resources],
  );
  const allRoles = useMemo(
    () =>
      sortByNamespaceName(
        Object.values((resources["roles"] ?? {}) as Record<string, Role>),
      ),
    [resources],
  );
  const allRoleBindings = useMemo(
    () =>
      sortByNamespaceName(
        Object.values((resources["rolebindings"] ?? {}) as Record<string, RoleBinding>),
      ),
    [resources],
  );
  const allClusterRoles = useMemo(
    () =>
      sortByName(
        Object.values((resources["clusterroles"] ?? {}) as Record<string, ClusterRole>),
      ),
    [resources],
  );
  const allClusterRoleBindings = useMemo(
    () =>
      sortByName(
        Object.values(
          (resources["clusterrolebindings"] ?? {}) as Record<string, ClusterRoleBinding>,
        ),
      ),
    [resources],
  );

  const filteredServiceAccounts = useMemo(
    () =>
      allServiceAccounts.filter((sa) =>
        matchesSearch(
          [
            sa.metadata.name,
            sa.metadata.namespace,
            secretsLabel(sa.secrets?.length ?? 0),
          ],
          search,
        ),
      ),
    [allServiceAccounts, search],
  );
  const filteredRoles = useMemo(
    () =>
      allRoles.filter((r) =>
        matchesSearch(
          [r.metadata.name, r.metadata.namespace, rulesSummary(r.rules)],
          search,
        ),
      ),
    [allRoles, search],
  );
  const filteredRoleBindings = useMemo(
    () =>
      allRoleBindings.filter((rb) =>
        matchesSearch(
          [
            rb.metadata.name,
            rb.metadata.namespace,
            rb.roleRef?.name,
            subjectsSummary(rb.subjects),
          ],
          search,
        ),
      ),
    [allRoleBindings, search],
  );
  const filteredClusterRoles = useMemo(
    () =>
      allClusterRoles.filter((cr) =>
        matchesSearch([cr.metadata.name, rulesSummary(cr.rules)], search),
      ),
    [allClusterRoles, search],
  );
  const filteredClusterRoleBindings = useMemo(
    () =>
      allClusterRoleBindings.filter((crb) =>
        matchesSearch(
          [crb.metadata.name, crb.roleRef?.name, subjectsSummary(crb.subjects)],
          search,
        ),
      ),
    [allClusterRoleBindings, search],
  );

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function rowKey(meta: { uid?: string; name: string; namespace?: string }): string {
    return meta.uid ?? `${meta.namespace ?? ""}/${meta.name}`;
  }

  function askClaude(kind: string, name: string, namespace: string | undefined, topic: "Errors" | "Logs" | "Explain") {
    handoffToChat(buildHandoffPrompt(kind, name, namespace, topic));
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="RBAC" subtitle="Roles & bindings" loading={isLoading}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </PanelHeader>

      <div className="flex-1 overflow-auto">
      {/* Kind toggle pills */}
      <div
        className="flex items-center gap-1 overflow-x-auto px-4 py-2"
        style={{ borderBottom: "1px solid #26272B" }}
      >
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => setActiveKind(t.kind)}
            aria-pressed={activeKind === t.kind}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeKind === t.kind
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <pre className="bg-destructive/10 px-4 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Row list */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        {/* ServiceAccounts */}
        {activeKind === "serviceaccounts" &&
          filteredServiceAccounts.map((sa) => {
            const k = rowKey(sa.metadata);
            const isOpen = expanded.has(k);
            const count = sa.secrets?.length ?? 0;
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("serviceaccount", sa.metadata.name, sa.metadata.namespace)}>View YAML…</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {sa.metadata.name}
                </button>

                {sa.metadata.namespace && (
                  <NamespaceChip namespace={sa.metadata.namespace} />
                )}

                <StatusBadge label={secretsLabel(count)} variant="neutral" />

                <span className="flex-1" />

                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("serviceaccount", sa.metadata.name, sa.metadata.namespace, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {/* Roles */}
        {activeKind === "roles" &&
          filteredRoles.map((r) => {
            const k = rowKey(r.metadata);
            const isOpen = expanded.has(k);
            const count = r.rules?.length ?? 0;
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("role", r.metadata.name, r.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("role", r.metadata.name, r.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("role", r.metadata.name, r.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("role", r.metadata.name, r.metadata.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={<RulesDetail summary={rulesSummary(r.rules)} />}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {r.metadata.name}
                </button>

                {r.metadata.namespace && (
                  <NamespaceChip namespace={r.metadata.namespace} />
                )}

                <StatusBadge label={rulesLabel(count)} variant="neutral" />

                <span className="flex-1" />

                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("role", r.metadata.name, r.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("role", r.metadata.name, r.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("role", r.metadata.name, r.metadata.namespace, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {/* RoleBindings */}
        {activeKind === "rolebindings" &&
          filteredRoleBindings.map((rb) => {
            const k = rowKey(rb.metadata);
            const isOpen = expanded.has(k);
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("rolebinding", rb.metadata.name, rb.metadata.namespace)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={
                  <BindingDetail
                    roleRef={roleRefLabel(rb.roleRef, "Role")}
                    subjects={subjectsSummary(rb.subjects)}
                  />
                }
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {rb.metadata.name}
                </button>

                {rb.metadata.namespace && (
                  <NamespaceChip namespace={rb.metadata.namespace} />
                )}

                <StatusBadge label={roleRefLabel(rb.roleRef, "Role")} variant="neutral" />

                <span className="flex-1" />

                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("rolebinding", rb.metadata.name, rb.metadata.namespace, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {/* ClusterRoles */}
        {activeKind === "clusterroles" &&
          filteredClusterRoles.map((cr) => {
            const k = rowKey(cr.metadata);
            const isOpen = expanded.has(k);
            const count = cr.rules?.length ?? 0;
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("clusterrole", cr.metadata.name, undefined, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("clusterrole", cr.metadata.name, undefined, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("clusterrole", cr.metadata.name, undefined, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("clusterrole", cr.metadata.name)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={<RulesDetail summary={rulesSummary(cr.rules)} />}
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {cr.metadata.name}
                </button>

                {/* ClusterRoles are cluster-scoped — no namespace chip */}

                <StatusBadge label={rulesLabel(count)} variant="neutral" />

                <span className="flex-1" />

                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("clusterrole", cr.metadata.name, undefined, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("clusterrole", cr.metadata.name, undefined, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("clusterrole", cr.metadata.name, undefined, "Explain"); }}
                />
              </ListRow>
            );
          })}

        {/* ClusterRoleBindings */}
        {activeKind === "clusterrolebindings" &&
          filteredClusterRoleBindings.map((crb) => {
            const k = rowKey(crb.metadata);
            const isOpen = expanded.has(k);
            const rowMenu = (
              <>
                <ContextMenuItem onClick={() => askClaude("clusterrolebinding", crb.metadata.name, undefined, "Errors")}>Ask Claude: Errors</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("clusterrolebinding", crb.metadata.name, undefined, "Logs")}>Ask Claude: Logs</ContextMenuItem>
                <ContextMenuItem onClick={() => askClaude("clusterrolebinding", crb.metadata.name, undefined, "Explain")}>Ask Claude: Explain</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => viewYaml("clusterrolebinding", crb.metadata.name)}>View YAML…</ContextMenuItem>
                <ContextMenuItem onClick={() => toggleExpand(k)}>{isOpen ? "Collapse" : "Details…"}</ContextMenuItem>
              </>
            );
            return (
              <ListRow
                key={k}
                rowKey={k}
                isOpen={isOpen}
                onToggle={() => toggleExpand(k)}
                contextMenu={rowMenu}
                expandedContent={
                  <BindingDetail
                    roleRef={roleRefLabel(crb.roleRef, "ClusterRole")}
                    subjects={subjectsSummary(crb.subjects)}
                  />
                }
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(k)}
                  className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
                >
                  {crb.metadata.name}
                </button>

                {/* ClusterRoleBindings are cluster-scoped — no namespace chip */}

                <StatusBadge label={roleRefLabel(crb.roleRef, "ClusterRole")} variant="neutral" />

                <span className="flex-1" />

                <ActionButtonStrip
                  onErrors={(e) => { e.stopPropagation(); askClaude("clusterrolebinding", crb.metadata.name, undefined, "Errors"); }}
                  onLogs={(e) => { e.stopPropagation(); askClaude("clusterrolebinding", crb.metadata.name, undefined, "Logs"); }}
                  onExplain={(e) => { e.stopPropagation(); askClaude("clusterrolebinding", crb.metadata.name, undefined, "Explain"); }}
                />
              </ListRow>
            );
          })}
      </div>

      {/* Empty states */}
      {!isLoading && activeKind === "serviceaccounts" && allServiceAccounts.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No service accounts found</p>
      )}
      {!isLoading && activeKind === "roles" && allRoles.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No roles found</p>
      )}
      {!isLoading && activeKind === "rolebindings" && allRoleBindings.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No role bindings found</p>
      )}
      {!isLoading && activeKind === "clusterroles" && allClusterRoles.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No cluster roles found</p>
      )}
      {!isLoading && activeKind === "clusterrolebindings" && allClusterRoleBindings.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted-foreground">No cluster role bindings found</p>
      )}
      </div>
    </div>
  );
}
