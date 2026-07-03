import { useEffect, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { NamespaceSelector } from "@/shell/NamespaceBar";
import type {
  ClusterRole,
  ClusterRoleBinding,
  ListSubject,
  Role,
  RoleBinding,
  RbacView,
  ScopeFilter,
} from "./types";
import { sortByName, sortByNamespaceName, matchesSearch } from "./rbacDisplay";
import { grantRisk } from "./risk";
import {
  collectSubjects,
  effectiveGrants,
  rbacCounts,
  resolveRoleRules,
  subjectsForRole,
} from "./access";
import { RbacStatusStrip } from "./components/RbacStatusStrip";
import { RbacList, type RoleItem } from "./components/RbacList";
import { SubjectDetail } from "./components/SubjectDetail";
import { RoleDetail } from "./components/RoleDetail";

function values<T>(rec: Record<string, T> | undefined): T[] {
  return Object.values(rec ?? {});
}

export default function RbacPanel() {
  const resources = useCluster((s) => s.resources);
  const isLoading = useCluster((s) => s.isLoading);
  const error = useCluster((s) => s.error);
  const namespaceFilter = useCluster((s) => s.namespaceFilter);

  const [view, setView] = useState<RbacView>("subjects");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const ns = namespaceFilter ?? "*";
    subscribe("serviceaccounts", ns);
    subscribe("roles", ns);
    subscribe("rolebindings", ns);
    subscribe("clusterroles", "*");
    subscribe("clusterrolebindings", "*");
    return () => {
      unsubscribe("serviceaccounts", ns);
      unsubscribe("roles", ns);
      unsubscribe("rolebindings", ns);
      unsubscribe("clusterroles", "*");
      unsubscribe("clusterrolebindings", "*");
    };
  }, [namespaceFilter]);

  const roles = useMemo(
    () => sortByNamespaceName(values<Role>(resources["roles"] as Record<string, Role>)),
    [resources],
  );
  const clusterRoles = useMemo(
    () => sortByName(values<ClusterRole>(resources["clusterroles"] as Record<string, ClusterRole>)),
    [resources],
  );
  const roleBindings = useMemo(
    () => values<RoleBinding>(resources["rolebindings"] as Record<string, RoleBinding>),
    [resources],
  );
  const clusterRoleBindings = useMemo(
    () => values<ClusterRoleBinding>(resources["clusterrolebindings"] as Record<string, ClusterRoleBinding>),
    [resources],
  );

  // Apply the scope filter to the binding/role pools.
  const scopedRB = scope === "cluster" ? [] : roleBindings;
  const scopedCRB = scope === "namespaced" ? [] : clusterRoleBindings;
  const scopedRoles = scope === "cluster" ? [] : roles;
  const scopedCR = scope === "namespaced" ? [] : clusterRoles;

  const counts = useMemo(
    () => rbacCounts(scopedRB, scopedCRB, scopedRoles, scopedCR),
    [scopedRB, scopedCRB, scopedRoles, scopedCR],
  );

  const subjects = useMemo(
    () =>
      collectSubjects(scopedRB, scopedCRB, scopedRoles, scopedCR).filter((s) =>
        matchesSearch([s.name, s.kind, s.namespace], search),
      ),
    [scopedRB, scopedCRB, scopedRoles, scopedCR, search],
  );

  const roleItems: RoleItem[] = useMemo(() => {
    const rItems: RoleItem[] = scopedRoles.map((r) => ({
      key: `Role ${r.metadata.namespace ?? ""} ${r.metadata.name}`,
      kind: "Role",
      name: r.metadata.name,
      namespace: r.metadata.namespace,
      dangerous: grantRisk(r.rules) === "dangerous",
    }));
    const cItems: RoleItem[] = scopedCR.map((r) => ({
      key: `ClusterRole  ${r.metadata.name}`,
      kind: "ClusterRole",
      name: r.metadata.name,
      dangerous: grantRisk(r.rules) === "dangerous",
    }));
    return [...rItems, ...cItems].filter((r) => matchesSearch([r.name, r.kind, r.namespace], search));
  }, [scopedRoles, scopedCR, search]);

  // Default-select the first item when the view or its list changes.
  const listKeys = view === "subjects" ? subjects.map((s) => s.key) : roleItems.map((r) => r.key);
  useEffect(() => {
    if (selectedKey && listKeys.includes(selectedKey)) return;
    setSelectedKey(listKeys[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, listKeys.join("|")]);

  const selectedSubject = subjects.find((s) => s.key === selectedKey) ?? null;
  const selectedRole = roleItems.find((r) => r.key === selectedKey) ?? null;

  const grants = useMemo(
    () =>
      selectedSubject
        ? effectiveGrants(selectedSubject.key, scopedRB, scopedCRB, scopedRoles, scopedCR)
        : [],
    [selectedSubject, scopedRB, scopedCRB, scopedRoles, scopedCR],
  );

  const roleRules = selectedRole
    ? resolveRoleRules(
        { kind: selectedRole.kind, name: selectedRole.name },
        selectedRole.namespace,
        scopedRoles,
        scopedCR,
      )
    : [];
  const boundSubjects = selectedRole
    ? subjectsForRole(
        { kind: selectedRole.kind, name: selectedRole.name, namespace: selectedRole.namespace },
        scopedRB,
        scopedCRB,
      )
    : [];

  function askAboutSubject(s: ListSubject) {
    const ref = s.namespace ? `${s.namespace}/${s.name}` : s.name;
    handoffToChat(
      `Explain the RBAC access for ${s.kind} "${ref}": which roles is it bound to, what can it do, and is anything over-privileged?`,
    );
  }

  const empty = view === "subjects" ? subjects.length === 0 : roleItems.length === 0;

  return (
    <div className="flex h-full flex-col gap-5 bg-[var(--surface-primary)] p-9">
      <PanelHeader title="RBAC" subtitle="Who can do what, to what" loading={isLoading}>
        <div className="flex items-center gap-[10px]">
          <NamespaceSelector />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by subject, role, or resource…"
            className="w-[300px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-[13px] py-[9px] text-[13px] text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)]"
          />
        </div>
      </PanelHeader>

      <RbacStatusStrip counts={counts} scope={scope} onScopeChange={setScope} />

      {error && (
        <pre className="rounded-[var(--radius-md)] bg-[#EF44441A] px-4 py-2 font-[var(--font-mono)] text-xs whitespace-pre-wrap break-all text-[var(--status-failed)]">
          {error}
        </pre>
      )}

      <div className="flex min-h-0 flex-1 gap-6">
        <RbacList
          view={view}
          onViewChange={setView}
          subjects={subjects}
          roleItems={roleItems}
          selectedKey={selectedKey}
          onSelectSubject={(s) => setSelectedKey(s.key)}
          onSelectRole={(r) => setSelectedKey(r.key)}
        />
        <div className="flex min-w-0 flex-1 overflow-auto">
          {empty ? (
            <p className="text-sm text-[var(--fg-tertiary)]">
              {view === "subjects" ? "No subjects found." : "No roles found."}
            </p>
          ) : view === "subjects" && selectedSubject ? (
            <SubjectDetail subject={selectedSubject} grants={grants} onAsk={askAboutSubject} />
          ) : view === "roles" && selectedRole ? (
            <RoleDetail
              roleName={selectedRole.name}
              roleKind={selectedRole.kind}
              roleNamespace={selectedRole.namespace}
              rules={roleRules}
              boundSubjects={boundSubjects}
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 pt-1">
        <Eye className="size-[13px] text-[var(--fg-tertiary)]" />
        <span className="text-[12px] text-[var(--fg-tertiary)]">
          Read-only view. RBAC is inspected here, not edited.
        </span>
      </div>
    </div>
  );
}
