import { useEffect, useMemo, useState } from "react";
import {
  LoaderCircle,
  UserCircle,
  Lock,
  Link as LinkIcon,
  ShieldCheck,
  Link2,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
} from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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
//     docs/parity/contracts.md §1:
//       Delete ServiceAccount → {"kind":"deleteResource","name":<n>,"namespace":<ns>,
//         "resourceKind":"serviceaccount","label":"Delete ServiceAccount <n>"}
//         → kubectl delete serviceaccount <name> -n <ns>
//       Delete Role → {... "resourceKind":"role" ...}
//         → kubectl delete role <name> -n <ns>
//       Delete RoleBinding → {... "resourceKind":"rolebinding" ...}
//         → kubectl delete rolebinding <name> -n <ns>
//       Delete ClusterRole → {"kind":"deleteResource","name":<n>,
//         "resourceKind":"clusterrole","label":"Delete ClusterRole <n>"}
//         → kubectl delete clusterrole <name>
//       Delete ClusterRoleBinding → {... "resourceKind":"clusterrolebinding" ...}
//         → kubectl delete clusterrolebinding <name>
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

/** Small muted chip used for namespace badges. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
      {children}
    </span>
  );
}

/** Deferred context-menu stub shared across every card. */
function RowMenu({ kindLabel }: { kindLabel: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground">
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled>View YAML… (soon)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Delete {kindLabel}… (soon)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

  const counts: Record<RbacKind, { total: number; shown: number }> = {
    serviceaccounts: {
      total: allServiceAccounts.length,
      shown: filteredServiceAccounts.length,
    },
    roles: { total: allRoles.length, shown: filteredRoles.length },
    rolebindings: { total: allRoleBindings.length, shown: filteredRoleBindings.length },
    clusterroles: { total: allClusterRoles.length, shown: filteredClusterRoles.length },
    clusterrolebindings: {
      total: allClusterRoleBindings.length,
      shown: filteredClusterRoleBindings.length,
    },
  };
  const { total, shown } = counts[activeKind];
  const countLabel = search.trim() && shown !== total ? `${shown} / ${total}` : `${total}`;

  function toggleExpand(uid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function cardKey(meta: { uid?: string; name: string; namespace?: string }): string {
    return meta.uid ?? `${meta.namespace ?? ""}/${meta.name}`;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">RBAC</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
          {countLabel}
        </span>
        {isLoading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="loading" />
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="ml-auto w-[200px] max-w-[200px] rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Kind toggle bar */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => setActiveKind(t.kind)}
            aria-pressed={activeKind === t.kind}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium transition-colors ${
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
        <pre className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
          {error}
        </pre>
      )}

      {/* Main list — blank scrollable area when empty (no "no results" copy). */}
      <div className="space-y-1.5">
        {activeKind === "serviceaccounts" &&
          filteredServiceAccounts.map((sa) => (
            <ServiceAccountCard key={cardKey(sa.metadata)} sa={sa} />
          ))}
        {activeKind === "roles" &&
          filteredRoles.map((r) => {
            const key = cardKey(r.metadata);
            return (
              <RoleCard
                key={key}
                role={r}
                isOpen={expanded.has(key)}
                onToggle={() => toggleExpand(key)}
              />
            );
          })}
        {activeKind === "rolebindings" &&
          filteredRoleBindings.map((rb) => (
            <RoleBindingCard key={cardKey(rb.metadata)} rb={rb} />
          ))}
        {activeKind === "clusterroles" &&
          filteredClusterRoles.map((cr) => {
            const key = cardKey(cr.metadata);
            return (
              <ClusterRoleCard
                key={key}
                clusterRole={cr}
                isOpen={expanded.has(key)}
                onToggle={() => toggleExpand(key)}
              />
            );
          })}
        {activeKind === "clusterrolebindings" &&
          filteredClusterRoleBindings.map((crb) => (
            <ClusterRoleBindingCard key={cardKey(crb.metadata)} crb={crb} />
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CardShell({
  icon,
  children,
  menu,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  menu: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
      <span className="shrink-0 text-primary">{icon}</span>
      {children}
      {menu}
    </div>
  );
}

function ServiceAccountCard({ sa }: { sa: ServiceAccount }) {
  const count = sa.secrets?.length ?? 0;
  return (
    <CardShell
      icon={<UserCircle className="size-4" />}
      menu={<RowMenu kindLabel="ServiceAccount" />}
    >
      <span className="truncate font-mono font-semibold" title={sa.metadata.name}>
        {sa.metadata.name}
      </span>
      {sa.metadata.namespace && <Chip>{sa.metadata.namespace}</Chip>}
      <span className="ml-auto min-w-[64px] text-right font-mono text-sm text-muted-foreground">
        {secretsLabel(count)}
      </span>
    </CardShell>
  );
}

/** Expandable rules detail shared by Role and ClusterRole cards. */
function RulesDetail({ summary }: { summary: string }) {
  return (
    <pre className="ml-7 rounded-md bg-muted/30 px-3 py-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
      {summary}
    </pre>
  );
}

function RoleCard({
  role,
  isOpen,
  onToggle,
}: {
  role: Role;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const count = role.rules?.length ?? 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? "Collapse" : "Expand"}
          aria-expanded={isOpen}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <span className="shrink-0 text-primary">
          <Lock className="size-4" />
        </span>
        <span className="truncate font-mono font-semibold" title={role.metadata.name}>
          {role.metadata.name}
        </span>
        {role.metadata.namespace && <Chip>{role.metadata.namespace}</Chip>}
        <span className="ml-auto min-w-[56px] text-right font-mono text-sm text-muted-foreground">
          {rulesLabel(count)}
        </span>
        <RowMenu kindLabel="Role" />
      </div>
      {isOpen && <RulesDetail summary={rulesSummary(role.rules)} />}
    </div>
  );
}

function ClusterRoleCard({
  clusterRole,
  isOpen,
  onToggle,
}: {
  clusterRole: ClusterRole;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const count = clusterRole.rules?.length ?? 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? "Collapse" : "Expand"}
          aria-expanded={isOpen}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <span className="shrink-0 text-primary">
          <ShieldCheck className="size-4" />
        </span>
        <span className="truncate font-mono font-semibold" title={clusterRole.metadata.name}>
          {clusterRole.metadata.name}
        </span>
        <span className="ml-auto min-w-[56px] text-right font-mono text-sm text-muted-foreground">
          {rulesLabel(count)}
        </span>
        <RowMenu kindLabel="ClusterRole" />
      </div>
      {isOpen && <RulesDetail summary={rulesSummary(clusterRole.rules)} />}
    </div>
  );
}

function RoleBindingCard({ rb }: { rb: RoleBinding }) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-card px-3 py-2">
      <span className="mt-0.5 shrink-0 text-primary">
        <LinkIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-3">
          <span className="truncate font-mono font-semibold" title={rb.metadata.name}>
            {rb.metadata.name}
          </span>
          {rb.metadata.namespace && <Chip>{rb.metadata.namespace}</Chip>}
          <span className="ml-auto truncate font-mono text-sm text-muted-foreground">
            {roleRefLabel(rb.roleRef, "Role")}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {subjectsSummary(rb.subjects)}
        </p>
      </div>
      <RowMenu kindLabel="RoleBinding" />
    </div>
  );
}

function ClusterRoleBindingCard({ crb }: { crb: ClusterRoleBinding }) {
  return (
    <div className="flex items-start gap-3 rounded-md border bg-card px-3 py-2">
      <span className="mt-0.5 shrink-0 text-primary">
        <Link2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-3">
          <span className="truncate font-mono font-semibold" title={crb.metadata.name}>
            {crb.metadata.name}
          </span>
          <span className="ml-auto truncate font-mono text-sm text-muted-foreground">
            {roleRefLabel(crb.roleRef, "ClusterRole")}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {subjectsSummary(crb.subjects)}
        </p>
      </div>
      <RowMenu kindLabel="ClusterRoleBinding" />
    </div>
  );
}
