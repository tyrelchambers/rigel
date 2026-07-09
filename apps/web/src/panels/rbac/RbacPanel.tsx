import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { filterByNamespace, useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import { handoffToChat } from "@/lib/chatHandoff";
import { PanelHeader } from "@/panels/components/PanelHeader";
import { buildRbacAccessPrompt } from "@/panels/components/chatHandoffPrompts";
import type { ActionBlock } from "@/lib/api";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { editYaml } from "@/store/yamlViewer";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { buildDeleteAction } from "./rbacActions";
import type {
  ClusterRole,
  ClusterRoleBinding,
  Grant,
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
import { RoleEditor, type RoleTarget } from "./components/RoleEditor";
import { BindingEditor, type BindingTarget } from "./components/BindingEditor";

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
  const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
  const [roleEditor, setRoleEditor] = useState<{ target: RoleTarget | null } | null>(null);
  const [bindingEditor, setBindingEditor] = useState<{ target: BindingTarget | null } | null>(null);

  useEffect(() => {
    // Subjects are derived from bindings, so ServiceAccounts aren't watched here
    // (an unbound SA has no access to analyze).
    subscribe("roles", "*");
    subscribe("rolebindings", "*");
    subscribe("clusterroles", "*");
    subscribe("clusterrolebindings", "*");
    return () => {
      unsubscribe("roles", "*");
      unsubscribe("rolebindings", "*");
      unsubscribe("clusterroles", "*");
      unsubscribe("clusterrolebindings", "*");
    };
  }, []);

  const roles = useMemo(
    () => sortByNamespaceName(filterByNamespace(resources["roles"] as Record<string, Role>, namespaceFilter)),
    [resources, namespaceFilter],
  );
  const clusterRoles = useMemo(
    () => sortByName(values<ClusterRole>(resources["clusterroles"] as Record<string, ClusterRole>)),
    [resources],
  );
  const roleBindings = useMemo(
    () => filterByNamespace(resources["rolebindings"] as Record<string, RoleBinding>, namespaceFilter),
    [resources, namespaceFilter],
  );
  const clusterRoleBindings = useMemo(
    () => values<ClusterRoleBinding>(resources["clusterrolebindings"] as Record<string, ClusterRoleBinding>),
    [resources],
  );

  // Scope filters which bindings/roles are ENUMERATED (listed + counted). Rule
  // RESOLUTION always uses the full role pools (roles/clusterRoles), because a
  // namespaced RoleBinding can reference a ClusterRole — emptying the cluster
  // role pool under "namespaced" scope would hide those rules and under-report
  // danger. So `listRoles`/`listClusterRoles` drive the Roles list only.
  const scopedRB = scope === "cluster" ? [] : roleBindings;
  const scopedCRB = scope === "namespaced" ? [] : clusterRoleBindings;
  const listRoles = scope === "cluster" ? [] : roles;
  const listClusterRoles = scope === "namespaced" ? [] : clusterRoles;

  const counts = useMemo(
    () => rbacCounts(scopedRB, scopedCRB, listRoles, listClusterRoles, roles, clusterRoles),
    [scopedRB, scopedCRB, listRoles, listClusterRoles, roles, clusterRoles],
  );

  const subjects = useMemo(
    () =>
      collectSubjects(scopedRB, scopedCRB, roles, clusterRoles).filter((s) =>
        matchesSearch([s.name, s.kind, s.namespace], search),
      ),
    [scopedRB, scopedCRB, roles, clusterRoles, search],
  );

  const roleItems: RoleItem[] = useMemo(() => {
    const rItems: RoleItem[] = listRoles.map((r) => ({
      key: `Role ${r.metadata.namespace ?? ""} ${r.metadata.name}`,
      kind: "Role",
      name: r.metadata.name,
      namespace: r.metadata.namespace,
      dangerous: grantRisk(r.rules) === "dangerous",
    }));
    const cItems: RoleItem[] = listClusterRoles.map((r) => ({
      key: `ClusterRole  ${r.metadata.name}`,
      kind: "ClusterRole",
      name: r.metadata.name,
      dangerous: grantRisk(r.rules) === "dangerous",
    }));
    return [...rItems, ...cItems].filter((r) => matchesSearch([r.name, r.kind, r.namespace], search));
  }, [listRoles, listClusterRoles, search]);

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
        ? effectiveGrants(selectedSubject.key, scopedRB, scopedCRB, roles, clusterRoles)
        : [],
    [selectedSubject, scopedRB, scopedCRB, roles, clusterRoles],
  );

  const roleRules = selectedRole
    ? resolveRoleRules(
        { kind: selectedRole.kind, name: selectedRole.name },
        selectedRole.namespace,
        roles,
        clusterRoles,
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
    handoffToChat(buildRbacAccessPrompt(s));
  }

  function deleteRoleItem(r: RoleItem) {
    setPendingAction(
      buildDeleteAction(r.kind === "ClusterRole" ? "clusterrole" : "role", r.name, r.namespace),
    );
  }
  function editRoleYaml(r: RoleItem) {
    editYaml(r.kind === "ClusterRole" ? "clusterrole" : "role", r.name, r.namespace);
  }
  function bindingResourceKind(g: Grant) {
    return g.bindingKind === "RoleBinding" ? ("rolebinding" as const) : ("clusterrolebinding" as const);
  }
  function bindingNamespace(g: Grant) {
    return g.scope.kind === "Namespaced" ? g.scope.namespace : undefined;
  }
  function deleteBinding(g: Grant) {
    setPendingAction(buildDeleteAction(bindingResourceKind(g), g.bindingName, bindingNamespace(g)));
  }
  function editBindingYaml(g: Grant) {
    editYaml(bindingResourceKind(g), g.bindingName, bindingNamespace(g));
  }
  function openRoleEditor(r: RoleItem) {
    const pool = r.kind === "ClusterRole" ? clusterRoles : roles;
    const obj = pool.find(
      (x) => x.metadata.name === r.name && (r.kind === "ClusterRole" || x.metadata.namespace === r.namespace),
    );
    setRoleEditor({
      target: {
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        labels: obj?.metadata.labels,
        annotations: obj?.metadata.annotations,
        rules: obj?.rules ?? [],
      },
    });
  }
  function openBindingEditor(g: Grant, focusSubjects = false) {
    const pool = g.bindingKind === "RoleBinding" ? roleBindings : clusterRoleBindings;
    const ns = g.scope.kind === "Namespaced" ? g.scope.namespace : undefined;
    const obj = pool.find(
      (x) => x.metadata.name === g.bindingName && (g.bindingKind === "ClusterRoleBinding" || x.metadata.namespace === ns),
    );
    setBindingEditor({
      target: {
        kind: g.bindingKind,
        name: g.bindingName,
        namespace: ns,
        labels: obj?.metadata.labels,
        annotations: obj?.metadata.annotations,
        roleRef: obj?.roleRef ?? g.roleRef,
        subjects: obj?.subjects ?? [],
        focusSubjects,
      },
    });
  }
  function newObject(kind: "Role" | "ClusterRole" | "RoleBinding" | "ClusterRoleBinding") {
    if (kind === "Role" || kind === "ClusterRole") {
      setRoleEditor({ target: { kind, name: "", namespace: "default", rules: [] } });
    } else {
      setBindingEditor({
        target: { kind, name: "", namespace: "default", roleRef: { kind: "Role", name: "" }, subjects: [] },
      });
    }
  }
  function applyFromEditor(result: { yaml: string; label: string }) {
    setRoleEditor(null);
    setBindingEditor(null);
    setPendingAction({ kind: "applyManifest", label: result.label, manifest: result.yaml });
  }

  const empty = view === "subjects" ? subjects.length === 0 : roleItems.length === 0;

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="RBAC" subtitle="Who can do what, to what" loading={isLoading}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by subject, role, or resource…"
          className="w-64 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-sm text-[var(--fg-primary)] outline-none placeholder:text-[var(--fg-tertiary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="New RBAC object"
            className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-3 py-1.5 text-sm text-[var(--fg-primary)] hover:bg-white/[0.04]"
          >
            <Plus className="size-[14px]" /> New
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => newObject("Role")}>Role</DropdownMenuItem>
            <DropdownMenuItem onClick={() => newObject("ClusterRole")}>ClusterRole</DropdownMenuItem>
            <DropdownMenuItem onClick={() => newObject("RoleBinding")}>RoleBinding</DropdownMenuItem>
            <DropdownMenuItem onClick={() => newObject("ClusterRoleBinding")}>ClusterRoleBinding</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <RbacStatusStrip counts={counts} scope={scope} onScopeChange={setScope} />

        {error && (
          <pre className="rounded-[var(--radius-md)] bg-[var(--status-failed)]/10 px-4 py-2 font-[var(--font-mono)] text-xs whitespace-pre-wrap break-all text-[var(--status-failed)]">
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
              <SubjectDetail
                subject={selectedSubject}
                grants={grants}
                onAsk={askAboutSubject}
                onEditBinding={(g) => openBindingEditor(g)}
                onAddSubject={(g) => openBindingEditor(g, true)}
                onEditBindingYaml={editBindingYaml}
                onDeleteBinding={deleteBinding}
              />
            ) : view === "roles" && selectedRole ? (
              <RoleDetail
                roleName={selectedRole.name}
                roleKind={selectedRole.kind}
                roleNamespace={selectedRole.namespace}
                rules={roleRules}
                boundSubjects={boundSubjects}
                onEdit={() => openRoleEditor(selectedRole)}
                onEditYaml={() => editRoleYaml(selectedRole)}
                onDelete={() => deleteRoleItem(selectedRole)}
              />
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmSheet
        action={pendingAction}
        open={!!pendingAction}
        onClose={() => setPendingAction(null)}
      />

      {roleEditor && (
        <RoleEditor
          target={roleEditor.target}
          open
          onClose={() => setRoleEditor(null)}
          onApply={applyFromEditor}
          onEditYaml={
            roleEditor.target
              ? () => {
                  const t = roleEditor.target!;
                  setRoleEditor(null);
                  editYaml(t.kind === "ClusterRole" ? "clusterrole" : "role", t.name, t.namespace);
                }
              : undefined
          }
        />
      )}

      {bindingEditor && (
        <BindingEditor
          target={bindingEditor.target}
          open
          roleOptions={[
            ...roles.map((r) => ({ kind: "Role" as const, name: r.metadata.name, namespace: r.metadata.namespace })),
            ...clusterRoles.map((r) => ({ kind: "ClusterRole" as const, name: r.metadata.name })),
          ]}
          onClose={() => setBindingEditor(null)}
          onApply={applyFromEditor}
          onEditYaml={
            bindingEditor.target && bindingEditor.target.name
              ? () => {
                  const t = bindingEditor.target!;
                  setBindingEditor(null);
                  editYaml(t.kind === "RoleBinding" ? "rolebinding" : "clusterrolebinding", t.name, t.namespace);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
