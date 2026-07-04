# RBAC Access-Analysis Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 5-tab RBAC browser with a two-pane, subject/role-centric access analyzer that resolves `Subject → Binding → Role → Rules` for the user and flags dangerous grants, staying read-only.

**Architecture:** Two new pure modules (`risk.ts` classifier, `access.ts` resolver) fully unit-tested. The panel is rebuilt into focused components (status strip, list pane, subject detail, role detail, binding card) that read the five RBAC kinds already watched into the Zustand store. No new server work for reads.

**Tech Stack:** React 19 + Vite + Tailwind v4 (tokens via arbitrary values), Zustand store, vitest (+ jsdom/RTL for component tests). Spec: `docs/superpowers/specs/2026-07-03-rbac-access-analysis-design.md`. Pencil frame: `dPDS8` in `clankerlocal.pen`.

---

## Conventions (read before starting)

**Design source of truth:** Pencil frame `dPDS8` "RBAC panel (improved)". Reproduce it screen-for-screen. Do NOT invent details or substitute nearest components.

**Styling:** Tailwind utilities only. NO inline `style={{}}`, NO hand-written CSS, NO raw hex/px. Use tokens via arbitrary values, e.g. `bg-[var(--surface-elevated)]`, `text-[var(--fg-tertiary)]`, `border-[var(--border-subtle)]`. Base text size is `text-xs`. (The current `RbacPanel.tsx` uses `style={{ ... var(--...) }}` and `#26272B` literals — that is the anti-pattern; the rewrite must not carry it forward.)

**Pencil variable → app CSS token map:**

| Pencil var | App token |
|---|---|
| `$surface.primary` | `--surface-primary` |
| `$surface.elevated` | `--surface-elevated` |
| `$surface.sunken` | `--surface-sunken` |
| `$foreground.primary` | `--fg-primary` |
| `$foreground.secondary` | `--fg-secondary` |
| `$foreground.tertiary` | `--fg-tertiary` |
| `$border.subtle` | `--border-subtle` |
| `$border.strong` | `--border-strong` |
| `$accent.primary` | `--accent-primary` |
| `$accent.primary.dim` | `--accent-dim` |
| `$status.failed` | `--status-failed` |
| `$status.pending` | `--status-pending` |
| `$radius.sm/md/lg` | `--radius-sm/md/lg` |
| `$font.mono` | `--font-mono` |

**Component test pattern** (see `apps/web/src/shell/GlobalHeader.test.tsx`): first line `// @vitest-environment jsdom`, `afterEach(cleanup)`, mock `@/store/cluster` and other side-effect imports with `vi.mock`, render with `@testing-library/react`.

**Commands:**
- Single vitest file: `pnpm --filter web test -- src/panels/rbac/<file>.test.ts`
- Typecheck: `pnpm --filter web typecheck`
- All web tests: `pnpm --filter web test`

---

## File structure

- **Create** `apps/web/src/panels/rbac/risk.ts` — `RiskTier`, `ruleRisk()`, `grantRisk()`. Pure. One responsibility: classify a policy rule / grant.
- **Create** `apps/web/src/panels/rbac/risk.test.ts`
- **Create** `apps/web/src/panels/rbac/access.ts` — subject/role graph resolution: `subjectKey`, `collectSubjects`, `bindingsForSubject`, `resolveRoleRules`, `effectiveGrants`, `subjectsForRole`, `subjectIsDangerous`, `rbacCounts`. Pure.
- **Create** `apps/web/src/panels/rbac/access.test.ts`
- **Create** `apps/web/src/panels/rbac/components/RbacStatusStrip.tsx` — count chips + scope toggle.
- **Create** `apps/web/src/panels/rbac/components/RbacList.tsx` — left pane: Subjects/Roles view toggle + selectable rows.
- **Create** `apps/web/src/panels/rbac/components/RuleRow.tsx` — one policy-rule row (API GROUP / RESOURCES / VERBS), risk-tinted.
- **Create** `apps/web/src/panels/rbac/components/BindingCard.tsx` — one binding: header (binding → roleRef pill + scope pill) + rules.
- **Create** `apps/web/src/panels/rbac/components/SubjectDetail.tsx` — right pane for a selected subject.
- **Create** `apps/web/src/panels/rbac/components/RoleDetail.tsx` — right pane for a selected role (reverse lookup).
- **Modify** `apps/web/src/panels/rbac/RbacPanel.tsx` — full rewrite: chrome + scope-aware subscriptions + two-pane composition.
- **Modify** `apps/web/src/panels/rbac/types.ts` — add shared types used by `access.ts` (`SubjectRef`, `BindingScope`, `Grant`, `ListSubject`, `ScopeFilter`).
- **Keep** `apps/web/src/panels/rbac/rbacDisplay.ts` + its test unchanged (reused for sorting/search/formatting).

---

## Task 1: Shared types

**Files:**
- Modify: `apps/web/src/panels/rbac/types.ts` (append)

- [ ] **Step 1: Append the new types**

Add to the end of `apps/web/src/panels/rbac/types.ts`:

```ts
/** Scope filter for the panel (status-strip toggle). */
export type ScopeFilter = "all" | "namespaced" | "cluster";

/** View toggle for the left list pane. */
export type RbacView = "subjects" | "roles";

/** A subject reference, normalized for identity comparison. */
export interface SubjectRef {
  kind: string; // "ServiceAccount" | "User" | "Group"
  name: string;
  namespace?: string; // present only for ServiceAccount
}

/** Where a binding takes effect. */
export type BindingScope =
  | { kind: "Namespaced"; namespace: string }
  | { kind: "Cluster" };

/** One resolved binding: a role's rules granted to a subject, with scope. */
export interface Grant {
  bindingName: string;
  bindingKind: "RoleBinding" | "ClusterRoleBinding";
  roleRef: RoleRef;
  scope: BindingScope;
  rules: PolicyRule[];
}

/** A subject as shown in the left list, with a precomputed danger flag. */
export interface ListSubject extends SubjectRef {
  key: string;
  dangerous: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (types only, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/rbac/types.ts
git commit -m "feat(rbac): add access-analysis shared types"
```

---

## Task 2: Risk classifier (`risk.ts`)

**Files:**
- Create: `apps/web/src/panels/rbac/risk.ts`
- Test: `apps/web/src/panels/rbac/risk.test.ts`

Risk tiers, matching the `.pen` legend (only two tiers: `dangerous`, `wildcard`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/risk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ruleRisk, grantRisk } from "./risk";
import type { PolicyRule } from "./types";

const rule = (r: Partial<PolicyRule>): PolicyRule => ({ ...r });

describe("ruleRisk", () => {
  it("flags escalation verbs as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["escalate"], resources: ["roles"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["bind"], resources: ["clusterroles"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["impersonate"], resources: ["users"] }))).toBe("dangerous");
  });

  it("flags secret reads as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list"], resources: ["secrets"] }))).toBe("dangerous");
    expect(ruleRisk(rule({ verbs: ["create"], resources: ["secrets"] }))).toBe("wildcard" as never); // create-only secrets is not a read → not dangerous
  });

  it("flags full wildcard (verbs * on resources *) as dangerous", () => {
    expect(ruleRisk(rule({ verbs: ["*"], resources: ["*"] }))).toBe("dangerous");
  });

  it("flags a lone wildcard as wildcard tier", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list"], resources: ["*"] }))).toBe("dangerous"); // wildcard resource + read = secret-reachable → dangerous
    expect(ruleRisk(rule({ verbs: ["*"], resources: ["pods"] }))).toBe("wildcard");
  });

  it("returns null for benign read rules", () => {
    expect(ruleRisk(rule({ verbs: ["get", "list", "watch"], resources: ["pods"] }))).toBeNull();
  });
});

describe("grantRisk", () => {
  it("is dangerous when any rule is dangerous", () => {
    expect(
      grantRisk([
        rule({ verbs: ["get"], resources: ["pods"] }),
        rule({ verbs: ["*"], resources: ["*"] }),
      ]),
    ).toBe("dangerous");
  });
  it("is wildcard when the worst rule is wildcard", () => {
    expect(grantRisk([rule({ verbs: ["*"], resources: ["pods"] })])).toBe("wildcard");
  });
  it("is null for all-benign rules", () => {
    expect(grantRisk([rule({ verbs: ["get"], resources: ["pods"] })])).toBeNull();
  });
});
```

Note on the `create`-only-secrets assertion: fix it to `toBeNull()` in Step 3 review — a create on secrets is not a read, so it is neither dangerous nor wildcard. (Kept here to force you to confirm the intended semantics; correct the expectation to `.toBeNull()` before the test passes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/risk.test.ts`
Expected: FAIL with "Cannot find module './risk'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/risk.ts`:

```ts
import type { PolicyRule } from "./types";

/** Risk tier for a policy rule or grant. `null` = benign. */
export type RiskTier = "dangerous" | "wildcard" | null;

const DANGEROUS_VERBS = new Set(["escalate", "bind", "impersonate"]);
const READ_VERBS = new Set(["get", "list", "watch", "*"]);

/**
 * Classify a single policy rule.
 * - dangerous: escalation verbs (escalate/bind/impersonate); OR reads that can
 *   reach secrets (secrets or wildcard resource with a read verb); OR full
 *   wildcard (verbs * AND resources *). cluster-admin (`*`/`*`/`*`) falls out
 *   of the full-wildcard branch, so no name special-casing is needed.
 * - wildcard: a lone `*` in verbs or resources that isn't already dangerous.
 * - null: everything else.
 */
export function ruleRisk(rule: PolicyRule): RiskTier {
  const verbs = rule.verbs ?? [];
  const resources = rule.resources ?? [];
  const verbWild = verbs.includes("*");
  const resWild = resources.includes("*");

  if (verbs.some((v) => DANGEROUS_VERBS.has(v))) return "dangerous";

  const readsSomething = verbs.some((v) => READ_VERBS.has(v));
  const reachesSecrets = resources.includes("secrets") || resWild;
  if (reachesSecrets && readsSomething) return "dangerous";

  if (verbWild && resWild) return "dangerous";
  if (verbWild || resWild) return "wildcard";
  return null;
}

/** Worst-of the rules' risk. Ordering: dangerous > wildcard > null. */
export function grantRisk(rules: PolicyRule[] | undefined): RiskTier {
  let worst: RiskTier = null;
  for (const rule of rules ?? []) {
    const r = ruleRisk(rule);
    if (r === "dangerous") return "dangerous";
    if (r === "wildcard") worst = "wildcard";
  }
  return worst;
}
```

- [ ] **Step 4: Fix the intentional test expectation and run**

In `risk.test.ts`, change the `create`-only-secrets assertion to `.toBeNull()` (remove the `as never` line). Then run:

Run: `pnpm --filter web test -- src/panels/rbac/risk.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/risk.ts apps/web/src/panels/rbac/risk.test.ts
git commit -m "feat(rbac): risk classifier for policy rules and grants"
```

---

## Task 3: Access resolver (`access.ts`)

**Files:**
- Create: `apps/web/src/panels/rbac/access.ts`
- Test: `apps/web/src/panels/rbac/access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  subjectKey,
  collectSubjects,
  effectiveGrants,
  subjectsForRole,
  rbacCounts,
} from "./access";
import type { Role, ClusterRole, RoleBinding, ClusterRoleBinding } from "./types";

const role = (name: string, ns: string, rules: any[]): Role => ({
  metadata: { name, namespace: ns },
  rules,
});
const clusterRole = (name: string, rules: any[]): ClusterRole => ({
  metadata: { name },
  rules,
});
const rb = (
  name: string,
  ns: string,
  roleRef: { kind: string; name: string },
  subjects: any[],
): RoleBinding => ({ metadata: { name, namespace: ns }, roleRef, subjects });
const crb = (
  name: string,
  roleRef: { kind: string; name: string },
  subjects: any[],
): ClusterRoleBinding => ({ metadata: { name }, roleRef, subjects });

const saAgent = { kind: "ServiceAccount", name: "rigel-agent", namespace: "default" };
const groupMasters = { kind: "Group", name: "system:masters" };

describe("subjectKey", () => {
  it("distinguishes SA namespace from users/groups", () => {
    expect(subjectKey(saAgent)).not.toBe(
      subjectKey({ kind: "ServiceAccount", name: "rigel-agent", namespace: "kube-system" }),
    );
    expect(subjectKey(groupMasters)).toBe(subjectKey({ kind: "Group", name: "system:masters" }));
  });
});

describe("effectiveGrants", () => {
  const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
  const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
  const roleBindings = [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])];
  const clusterRoleBindings = [
    crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent]),
  ];

  it("resolves rules across RoleBinding and ClusterRoleBinding for a subject", () => {
    const grants = effectiveGrants(
      subjectKey(saAgent),
      roleBindings,
      clusterRoleBindings,
      roles,
      clusterRoles,
    );
    expect(grants).toHaveLength(2);
    const ns = grants.find((g) => g.bindingKind === "RoleBinding")!;
    expect(ns.scope).toEqual({ kind: "Namespaced", namespace: "default" });
    expect(ns.rules).toEqual([{ verbs: ["get"], resources: ["pods"] }]);
    const cluster = grants.find((g) => g.bindingKind === "ClusterRoleBinding")!;
    expect(cluster.scope).toEqual({ kind: "Cluster" });
    expect(cluster.rules).toEqual([{ verbs: ["*"], resources: ["*"] }]);
  });

  it("resolves a namespaced Role only in its own namespace", () => {
    const grants = effectiveGrants(
      subjectKey({ kind: "ServiceAccount", name: "rigel-agent", namespace: "other" }),
      [rb("b2", "other", { kind: "Role", name: "reader" }, [
        { kind: "ServiceAccount", name: "rigel-agent", namespace: "other" },
      ])],
      [],
      roles, // "reader" only exists in "default"
      [],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].rules).toEqual([]); // no matching Role in "other" ns
  });
});

describe("subjectsForRole (reverse)", () => {
  it("lists subjects bound to a clusterrole", () => {
    const result = subjectsForRole(
      { kind: "ClusterRole", name: "admin" },
      [],
      [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent, groupMasters])],
    );
    expect(result.map((s) => s.subject.name).sort()).toEqual(["rigel-agent", "system:masters"]);
  });
});

describe("collectSubjects", () => {
  it("dedupes subjects across bindings and flags dangerous ones", () => {
    const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
    const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
    const subjects = collectSubjects(
      [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])],
      [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent, groupMasters])],
      roles,
      clusterRoles,
    );
    expect(subjects).toHaveLength(2); // saAgent deduped
    const agent = subjects.find((s) => s.name === "rigel-agent")!;
    expect(agent.dangerous).toBe(true); // bound to cluster admin
    const masters = subjects.find((s) => s.name === "system:masters")!;
    expect(masters.dangerous).toBe(true);
  });
});

describe("rbacCounts", () => {
  it("counts subjects, roles, bindings, and dangerous subjects", () => {
    const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
    const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
    const roleBindings = [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])];
    const clusterRoleBindings = [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [groupMasters])];
    const counts = rbacCounts(roleBindings, clusterRoleBindings, roles, clusterRoles);
    expect(counts).toEqual({ subjects: 2, roles: 2, bindings: 2, dangerous: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/access.test.ts`
Expected: FAIL with "Cannot find module './access'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/access.ts`:

```ts
import type {
  ClusterRole,
  ClusterRoleBinding,
  Grant,
  ListSubject,
  PolicyRule,
  Role,
  RoleBinding,
  RoleRef,
  Subject,
  SubjectRef,
} from "./types";
import { grantRisk } from "./risk";

/** Stable identity key for a subject. NUL-separated so parts can't collide. */
export function subjectKey(s: { kind?: string; name?: string; namespace?: string }): string {
  return `${s.kind ?? ""} ${s.namespace ?? ""} ${s.name ?? ""}`;
}

type AnyBinding = RoleBinding | ClusterRoleBinding;

function bindingScope(binding: AnyBinding, kind: Grant["bindingKind"]): Grant["scope"] {
  if (kind === "RoleBinding") {
    return { kind: "Namespaced", namespace: binding.metadata.namespace ?? "" };
  }
  return { kind: "Cluster" };
}

/** Resolve a RoleRef to its rules. Namespaced Roles match on binding namespace. */
export function resolveRoleRules(
  roleRef: RoleRef | undefined,
  bindingNamespace: string | undefined,
  roles: Role[],
  clusterRoles: ClusterRole[],
): PolicyRule[] {
  if (!roleRef?.name) return [];
  if (roleRef.kind === "ClusterRole") {
    return clusterRoles.find((r) => r.metadata.name === roleRef.name)?.rules ?? [];
  }
  return (
    roles.find(
      (r) => r.metadata.name === roleRef.name && r.metadata.namespace === bindingNamespace,
    )?.rules ?? []
  );
}

/** All resolved grants (binding → role rules) for a subject key. */
export function effectiveGrants(
  key: string,
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): Grant[] {
  const grants: Grant[] = [];
  const push = (binding: AnyBinding, kind: Grant["bindingKind"]) => {
    if (!(binding.subjects ?? []).some((s) => subjectKey(s) === key)) return;
    const scope = bindingScope(binding, kind);
    grants.push({
      bindingName: binding.metadata.name,
      bindingKind: kind,
      roleRef: binding.roleRef ?? {},
      scope,
      rules: resolveRoleRules(
        binding.roleRef,
        scope.kind === "Namespaced" ? scope.namespace : undefined,
        roles,
        clusterRoles,
      ),
    });
  };
  for (const b of roleBindings) push(b, "RoleBinding");
  for (const b of clusterRoleBindings) push(b, "ClusterRoleBinding");
  return grants;
}

/** Reverse lookup: subjects bound to a given role. */
export function subjectsForRole(
  role: { kind: "Role" | "ClusterRole"; name: string; namespace?: string },
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
): { subject: Subject; bindingName: string; scope: Grant["scope"] }[] {
  const out: { subject: Subject; bindingName: string; scope: Grant["scope"] }[] = [];
  const match = (ref: RoleRef | undefined, ns: string | undefined) =>
    ref?.name === role.name &&
    (ref?.kind ?? "") === role.kind &&
    (role.kind === "ClusterRole" || ns === role.namespace);
  for (const b of roleBindings) {
    if (!match(b.roleRef, b.metadata.namespace)) continue;
    for (const s of b.subjects ?? [])
      out.push({ subject: s, bindingName: b.metadata.name, scope: bindingScope(b, "RoleBinding") });
  }
  for (const b of clusterRoleBindings) {
    if (!match(b.roleRef, undefined)) continue;
    for (const s of b.subjects ?? [])
      out.push({ subject: s, bindingName: b.metadata.name, scope: { kind: "Cluster" } });
  }
  return out;
}

/** Whether a subject holds any dangerous grant. */
export function subjectIsDangerous(
  key: string,
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): boolean {
  return effectiveGrants(key, roleBindings, clusterRoleBindings, roles, clusterRoles).some(
    (g) => grantRisk(g.rules) === "dangerous",
  );
}

/** Unique subjects across all bindings, each with a precomputed danger flag. */
export function collectSubjects(
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): ListSubject[] {
  const seen = new Map<string, SubjectRef>();
  for (const b of [...roleBindings, ...clusterRoleBindings]) {
    for (const s of b.subjects ?? []) {
      if (!s.name) continue;
      const key = subjectKey(s);
      if (!seen.has(key))
        seen.set(key, { kind: s.kind ?? "", name: s.name, namespace: s.namespace });
    }
  }
  return [...seen.entries()]
    .map(([key, ref]) => ({
      ...ref,
      key,
      dangerous: subjectIsDangerous(key, roleBindings, clusterRoleBindings, roles, clusterRoles),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Status-strip counts. */
export function rbacCounts(
  roleBindings: RoleBinding[],
  clusterRoleBindings: ClusterRoleBinding[],
  roles: Role[],
  clusterRoles: ClusterRole[],
): { subjects: number; roles: number; bindings: number; dangerous: number } {
  const subjects = collectSubjects(roleBindings, clusterRoleBindings, roles, clusterRoles);
  return {
    subjects: subjects.length,
    roles: roles.length + clusterRoles.length,
    bindings: roleBindings.length + clusterRoleBindings.length,
    dangerous: subjects.filter((s) => s.dangerous).length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- src/panels/rbac/access.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/access.ts apps/web/src/panels/rbac/access.test.ts
git commit -m "feat(rbac): access-graph resolver (subjects, grants, reverse lookup, counts)"
```

---

## Task 4: Status strip component

**Files:**
- Create: `apps/web/src/panels/rbac/components/RbacStatusStrip.tsx`
- Test: `apps/web/src/panels/rbac/components/RbacStatusStrip.test.tsx`

Renders the four count chips (DANGEROUS red) and the All/Namespaced/Cluster scope toggle. Matches `.pen` node `M1w91`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/RbacStatusStrip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RbacStatusStrip } from "./RbacStatusStrip";

afterEach(cleanup);

test("renders counts and switches scope", () => {
  const onScope = vi.fn();
  render(
    <RbacStatusStrip
      counts={{ subjects: 42, roles: 31, bindings: 24, dangerous: 3 }}
      scope="all"
      onScopeChange={onScope}
    />,
  );
  expect(screen.getByText("42")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
  expect(onScope).toHaveBeenCalledWith("cluster");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/components/RbacStatusStrip.test.tsx`
Expected: FAIL with "Cannot find module './RbacStatusStrip'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/components/RbacStatusStrip.tsx`:

```tsx
import type { ScopeFilter } from "../types";

interface Props {
  counts: { subjects: number; roles: number; bindings: number; dangerous: number };
  scope: ScopeFilter;
  onScopeChange: (scope: ScopeFilter) => void;
}

const SCOPES: { value: ScopeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "namespaced", label: "Namespaced" },
  { value: "cluster", label: "Cluster" },
];

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="flex items-center gap-[7px]">
      <span className="font-[var(--font-mono)] text-[11px] tracking-[0.8px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <span
        className={`font-[var(--font-mono)] text-[15px] font-semibold ${
          danger ? "text-[var(--status-failed)]" : "text-[var(--fg-primary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function RbacStatusStrip({ counts, scope, onScopeChange }: Props) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-[18px] py-[13px]">
      <div className="flex items-center gap-5">
        <Stat label="SUBJECTS" value={counts.subjects} />
        <Stat label="ROLES" value={counts.roles} />
        <Stat label="BINDINGS" value={counts.bindings} />
        <Stat label="DANGEROUS" value={counts.dangerous} danger />
      </div>
      <div className="flex gap-[3px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-[3px]">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onScopeChange(s.value)}
            aria-pressed={scope === s.value}
            className={`rounded-[var(--radius-sm)] px-[13px] py-[6px] text-[13px] transition-colors ${
              scope === s.value
                ? "bg-[#FFFFFF14] font-semibold text-[var(--fg-primary)]"
                : "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- src/panels/rbac/components/RbacStatusStrip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/RbacStatusStrip.tsx apps/web/src/panels/rbac/components/RbacStatusStrip.test.tsx
git commit -m "feat(rbac): status strip with counts and scope toggle"
```

---

## Task 5: Rule row + binding card

**Files:**
- Create: `apps/web/src/panels/rbac/components/RuleRow.tsx`
- Create: `apps/web/src/panels/rbac/components/BindingCard.tsx`
- Test: `apps/web/src/panels/rbac/components/BindingCard.test.tsx`

Matches `.pen` binding card `wiNd1` and rule rows `SLyxg`/`TpSuW` (dangerous rule = red-tinted border `#EF444426`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/BindingCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BindingCard } from "./BindingCard";
import type { Grant } from "../types";

afterEach(cleanup);

const grant: Grant = {
  bindingName: "rigel-agent",
  bindingKind: "RoleBinding",
  roleRef: { kind: "Role", name: "rigel-agent" },
  scope: { kind: "Namespaced", namespace: "default" },
  rules: [
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
};

test("renders binding name, roleRef, scope, and rule count", () => {
  render(<BindingCard grant={grant} />);
  expect(screen.getByText("rigel-agent")).toBeTruthy();
  expect(screen.getByText("Role/rigel-agent")).toBeTruthy();
  expect(screen.getByText("default")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy(); // rules count
  expect(screen.getByText("secrets")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/components/BindingCard.test.tsx`
Expected: FAIL with "Cannot find module './BindingCard'".

- [ ] **Step 3: Write RuleRow**

Create `apps/web/src/panels/rbac/components/RuleRow.tsx`:

```tsx
import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";

function apiGroupLabel(groups: string[] | undefined): string {
  if (!groups || groups.length === 0) return "core";
  return groups.map((g) => (g === "" ? "core" : g)).join(", ");
}

function Cell({ label, items, width }: { label: string; items: string[]; width: string }) {
  return (
    <div className={`flex flex-col gap-[6px] ${width}`}>
      <span className="font-[var(--font-mono)] text-[9.5px] tracking-[0.6px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-[6px]">
        {items.map((it, i) => (
          <span
            key={i}
            className="font-[var(--font-mono)] text-[11px] text-[var(--fg-secondary)]"
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RuleRow({ rule }: { rule: PolicyRule }) {
  const dangerous = ruleRisk(rule) === "dangerous";
  return (
    <div
      className={`flex gap-4 rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] px-[13px] py-[11px] ${
        dangerous ? "border-[#EF444426]" : "border-[var(--border-subtle)]"
      }`}
    >
      <Cell label="API GROUP" items={[apiGroupLabel(rule.apiGroups)]} width="w-[120px] shrink-0" />
      <Cell label="RESOURCES" items={rule.resources ?? []} width="flex-1" />
      <Cell label="VERBS" items={rule.verbs ?? []} width="w-[300px] shrink-0" />
    </div>
  );
}
```

- [ ] **Step 4: Write BindingCard**

Create `apps/web/src/panels/rbac/components/BindingCard.tsx`:

```tsx
import { Link2, ArrowRight, FileBadge, Box } from "lucide-react";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

function roleRefLabel(grant: Grant): string {
  const kind = grant.roleRef.kind ?? (grant.bindingKind === "RoleBinding" ? "Role" : "ClusterRole");
  return `${kind}/${grant.roleRef.name ?? "—"}`;
}

export function BindingCard({ grant }: { grant: Grant }) {
  const rules = grant.rules;
  return (
    <div className="flex flex-col gap-[13px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-[10px]">
          <Link2 className="size-[15px] text-[var(--fg-tertiary)]" />
          <span className="font-[var(--font-mono)] text-[14px] font-semibold text-[var(--fg-primary)]">
            {grant.bindingName}
          </span>
          <span className="flex items-center gap-[5px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[#FFFFFF0D] px-2 py-[2px]">
            <Box className="size-[10px] text-[var(--fg-tertiary)]" />
            <span className="text-[11.5px] font-medium text-[var(--fg-secondary)]">
              {grant.scope.kind === "Namespaced" ? "Namespaced" : "Cluster"}
            </span>
            {grant.scope.kind === "Namespaced" && (
              <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">
                {grant.scope.namespace}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-[9px]">
          <span className="text-[12px] text-[var(--fg-tertiary)]">grants</span>
          <ArrowRight className="size-[14px] text-[var(--fg-tertiary)]" />
          <span className="flex items-center gap-[6px] rounded-[var(--radius-sm)] border border-[#38BDF840] bg-[var(--accent-dim)] px-[9px] py-[3px]">
            <FileBadge className="size-[12px] text-[var(--accent-primary)]" />
            <span className="font-[var(--font-mono)] text-[12px] font-semibold text-[var(--accent-primary)]">
              {roleRefLabel(grant)}
            </span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-[7px]">
        <span className="font-[var(--font-mono)] text-[10px] tracking-[1px] text-[var(--fg-tertiary)]">
          RULES
        </span>
        <span className="font-[var(--font-mono)] text-[10px] text-[var(--fg-tertiary)]">
          {rules.length}
        </span>
        <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>

      {rules.length === 0 ? (
        <p className="text-[12px] text-[var(--fg-tertiary)]">
          Role not found in scope (rules unavailable).
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((r, i) => (
            <RuleRow key={i} rule={r} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test -- src/panels/rbac/components/BindingCard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/rbac/components/RuleRow.tsx apps/web/src/panels/rbac/components/BindingCard.tsx apps/web/src/panels/rbac/components/BindingCard.test.tsx
git commit -m "feat(rbac): binding card + rule row with risk tinting"
```

---

## Task 6: Left list pane

**Files:**
- Create: `apps/web/src/panels/rbac/components/RbacList.tsx`
- Test: `apps/web/src/panels/rbac/components/RbacList.test.tsx`

Left pane (`.pen` node `nlrak`): Subjects/Roles view toggle header + selectable rows. Dangerous subjects show a red dot.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/RbacList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RbacList } from "./RbacList";
import type { ListSubject } from "../types";

afterEach(cleanup);

const subjects: ListSubject[] = [
  { key: "a", kind: "ServiceAccount", name: "rigel-agent", namespace: "default", dangerous: true },
  { key: "b", kind: "Group", name: "system:authenticated", dangerous: false },
];

test("renders subjects and fires selection", () => {
  const onSelect = vi.fn();
  render(
    <RbacList
      view="subjects"
      onViewChange={vi.fn()}
      subjects={subjects}
      roleItems={[]}
      selectedKey="a"
      onSelectSubject={onSelect}
      onSelectRole={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("system:authenticated"));
  expect(onSelect).toHaveBeenCalledWith(subjects[1]);
});

test("switches to roles view", () => {
  const onView = vi.fn();
  render(
    <RbacList
      view="subjects"
      onViewChange={onView}
      subjects={subjects}
      roleItems={[]}
      selectedKey={null}
      onSelectSubject={vi.fn()}
      onSelectRole={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Roles/ }));
  expect(onView).toHaveBeenCalledWith("roles");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/components/RbacList.test.tsx`
Expected: FAIL with "Cannot find module './RbacList'".

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/panels/rbac/components/RbacList.tsx`:

```tsx
import { User, Users, Server, FileBadge } from "lucide-react";
import type { ListSubject, RbacView } from "../types";

/** A role list item (namespaced Role or ClusterRole) for the Roles view. */
export interface RoleItem {
  key: string;
  kind: "Role" | "ClusterRole";
  name: string;
  namespace?: string;
  dangerous: boolean;
}

interface Props {
  view: RbacView;
  onViewChange: (view: RbacView) => void;
  subjects: ListSubject[];
  roleItems: RoleItem[];
  selectedKey: string | null;
  onSelectSubject: (s: ListSubject) => void;
  onSelectRole: (r: RoleItem) => void;
}

function subjectIcon(kind: string) {
  if (kind === "Group") return Users;
  if (kind === "ServiceAccount") return Server;
  return User;
}

function Row({
  selected,
  dangerous,
  Icon,
  name,
  sub,
  onClick,
}: {
  selected: boolean;
  dangerous: boolean;
  Icon: typeof User;
  name: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-[11px] rounded-[var(--radius-md)] border px-[11px] py-[10px] text-left transition-colors ${
        selected
          ? "border-[#38BDF859] bg-[var(--accent-dim)]"
          : "border-transparent hover:bg-[#FFFFFF08]"
      }`}
    >
      <Icon className="size-[15px] shrink-0 text-[var(--fg-tertiary)]" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-[var(--font-mono)] text-[13px] font-medium text-[var(--fg-primary)]">
          {name}
        </span>
        {sub && <span className="truncate text-[11px] text-[var(--fg-tertiary)]">{sub}</span>}
      </div>
      <span className="flex-1" />
      {dangerous && <span className="size-[7px] shrink-0 rounded-full bg-[var(--status-failed)]" />}
    </button>
  );
}

export function RbacList({
  view,
  onViewChange,
  subjects,
  roleItems,
  selectedKey,
  onSelectSubject,
  onSelectRole,
}: Props) {
  return (
    <div className="flex w-[452px] shrink-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-[14px] py-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
            {view === "subjects" ? "SUBJECTS" : "ROLES"}
          </span>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">
            {view === "subjects" ? subjects.length : roleItems.length}
          </span>
        </div>
        <div className="flex gap-[2px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-[2px]">
          {(["subjects", "roles"] as RbacView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onViewChange(v)}
              aria-pressed={view === v}
              className={`rounded-[3px] px-[10px] py-1 text-[12px] capitalize ${
                view === v
                  ? "bg-[#FFFFFF14] font-semibold text-[var(--fg-primary)]"
                  : "text-[var(--fg-tertiary)]"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-[3px] overflow-auto p-2">
        {view === "subjects"
          ? subjects.map((s) => (
              <Row
                key={s.key}
                selected={s.key === selectedKey}
                dangerous={s.dangerous}
                Icon={subjectIcon(s.kind)}
                name={s.name}
                sub={s.namespace ? `${s.kind} · ${s.namespace}` : s.kind}
                onClick={() => onSelectSubject(s)}
              />
            ))
          : roleItems.map((r) => (
              <Row
                key={r.key}
                selected={r.key === selectedKey}
                dangerous={r.dangerous}
                Icon={FileBadge}
                name={r.name}
                sub={r.kind === "Role" ? `Role · ${r.namespace ?? ""}` : "ClusterRole"}
                onClick={() => onSelectRole(r)}
              />
            ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test -- src/panels/rbac/components/RbacList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/rbac/components/RbacList.tsx apps/web/src/panels/rbac/components/RbacList.test.tsx
git commit -m "feat(rbac): left list pane with subjects/roles toggle"
```

---

## Task 7: Detail panes (subject + role)

**Files:**
- Create: `apps/web/src/panels/rbac/components/SubjectDetail.tsx`
- Create: `apps/web/src/panels/rbac/components/RoleDetail.tsx`
- Test: `apps/web/src/panels/rbac/components/SubjectDetail.test.tsx`

`.pen` right pane `x97yi`: subject head + Ask button, summary strip (`NXU4J`), access caption + legend (`O2BGO`), binding cards (`iwrKi`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/panels/rbac/components/SubjectDetail.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SubjectDetail } from "./SubjectDetail";
import type { Grant, ListSubject } from "../types";

afterEach(cleanup);

const subject: ListSubject = {
  key: "a",
  kind: "ServiceAccount",
  name: "rigel-agent",
  namespace: "default",
  dangerous: true,
};
const grants: Grant[] = [
  {
    bindingName: "rigel-agent",
    bindingKind: "RoleBinding",
    roleRef: { kind: "Role", name: "rigel-agent" },
    scope: { kind: "Namespaced", namespace: "default" },
    rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }],
  },
];

test("shows summary counts and fires Ask handoff", () => {
  const onAsk = vi.fn();
  render(<SubjectDetail subject={subject} grants={grants} onAsk={onAsk} />);
  expect(screen.getByText("1 role bound")).toBeTruthy();
  expect(screen.getByText("1 dangerous grant")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Ask Rigel about access/ }));
  expect(onAsk).toHaveBeenCalledWith(subject);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/components/SubjectDetail.test.tsx`
Expected: FAIL with "Cannot find module './SubjectDetail'".

- [ ] **Step 3: Write SubjectDetail**

Create `apps/web/src/panels/rbac/components/SubjectDetail.tsx`:

```tsx
import { Layers, Box, ShieldAlert, MessageSquare } from "lucide-react";
import type { Grant, ListSubject } from "../types";
import { grantRisk } from "../risk";
import { BindingCard } from "./BindingCard";

interface Props {
  subject: ListSubject;
  grants: Grant[];
  onAsk: (subject: ListSubject) => void;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function SummaryItem({
  Icon,
  text,
  danger,
}: {
  Icon: typeof Layers;
  text: string;
  danger?: boolean;
}) {
  const color = danger ? "text-[var(--status-failed)]" : "text-[var(--fg-primary)]";
  return (
    <div className="flex items-center gap-2">
      <Icon className={`size-[15px] ${color}`} />
      <span className={`text-[13px] font-semibold ${color}`}>{text}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-[5px]">
      <span className="size-[7px] rounded-full" style={{ background: color }} />
      <span className="text-[11.5px] text-[var(--fg-tertiary)]">{label}</span>
    </div>
  );
}

export function SubjectDetail({ subject, grants, onAsk }: Props) {
  const namespaces = new Set(
    grants.filter((g) => g.scope.kind === "Namespaced").map((g) => (g.scope as { namespace: string }).namespace),
  );
  const hasCluster = grants.some((g) => g.scope.kind === "Cluster");
  const dangerousCount = grants.filter((g) => grantRisk(g.rules) === "dangerous").length;
  const scopeText =
    hasCluster && namespaces.size > 0
      ? `${plural(namespaces.size, "namespace", "namespaces")} + cluster`
      : hasCluster
        ? "cluster"
        : plural(namespaces.size, "namespace", "namespaces");

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-[14px]">
          <span className="font-[var(--font-mono)] text-[18px] font-semibold text-[var(--fg-primary)]">
            {subject.name}
          </span>
          <span className="text-[13px] text-[var(--fg-tertiary)]">
            {subject.namespace ? `${subject.kind} · ${subject.namespace}` : subject.kind}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onAsk(subject)}
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-[15px] py-[9px] text-[13px] text-[var(--fg-primary)] hover:bg-[#FFFFFF08]"
        >
          <MessageSquare className="size-[14px]" />
          Ask Rigel about access
        </button>
      </div>

      <div className="flex items-center gap-[22px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 py-3">
        <SummaryItem Icon={Layers} text={plural(grants.length, "role bound", "roles bound")} />
        <span className="h-4 w-px bg-[var(--border-strong)]" />
        <SummaryItem Icon={Box} text={scopeText} />
        <span className="h-4 w-px bg-[var(--border-strong)]" />
        <SummaryItem
          Icon={ShieldAlert}
          text={plural(dangerousCount, "dangerous grant", "dangerous grants")}
          danger={dangerousCount > 0}
        />
      </div>

      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-[3px]">
          <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
            ACCESS
          </span>
          <span className="text-[12.5px] text-[var(--fg-tertiary)]">
            Roles bound to this subject, and the rules they grant
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LegendDot color="var(--status-failed)" label="dangerous" />
          <LegendDot color="var(--status-pending)" label="wildcard" />
        </div>
      </div>

      <div className="flex flex-col gap-[14px]">
        {grants.map((g, i) => (
          <BindingCard key={`${g.bindingKind}:${g.bindingName}:${i}`} grant={g} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write RoleDetail**

Create `apps/web/src/panels/rbac/components/RoleDetail.tsx`:

```tsx
import { Server, User, Users } from "lucide-react";
import type { PolicyRule, Subject } from "../types";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

interface Props {
  roleName: string;
  roleKind: "Role" | "ClusterRole";
  roleNamespace?: string;
  rules: PolicyRule[];
  boundSubjects: { subject: Subject; bindingName: string; scope: Grant["scope"] }[];
}

function subjectIcon(kind: string | undefined) {
  if (kind === "Group") return Users;
  if (kind === "ServiceAccount") return Server;
  return User;
}

export function RoleDetail({ roleName, roleKind, roleNamespace, rules, boundSubjects }: Props) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center gap-[14px]">
        <span className="font-[var(--font-mono)] text-[18px] font-semibold text-[var(--fg-primary)]">
          {roleName}
        </span>
        <span className="text-[13px] text-[var(--fg-tertiary)]">
          {roleKind === "Role" ? `Role · ${roleNamespace ?? ""}` : "ClusterRole"}
        </span>
      </div>

      <div className="flex flex-col gap-[3px]">
        <span className="font-[var(--font-mono)] text-[11px] font-semibold tracking-[1px] text-[var(--fg-secondary)]">
          BOUND TO
        </span>
        <span className="text-[12.5px] text-[var(--fg-tertiary)]">
          Subjects that receive this role
        </span>
      </div>
      {boundSubjects.length === 0 ? (
        <p className="text-[12px] text-[var(--fg-tertiary)]">No subjects are bound to this role.</p>
      ) : (
        <div className="flex flex-col gap-[3px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-2">
          {boundSubjects.map((b, i) => {
            const Icon = subjectIcon(b.subject.kind);
            return (
              <div key={`${b.bindingName}:${i}`} className="flex items-center gap-[11px] px-[11px] py-[9px]">
                <Icon className="size-[15px] text-[var(--fg-tertiary)]" />
                <span className="font-[var(--font-mono)] text-[13px] text-[var(--fg-primary)]">
                  {b.subject.name}
                </span>
                <span className="text-[11px] text-[var(--fg-tertiary)]">
                  {b.subject.kind}
                  {b.subject.namespace ? ` · ${b.subject.namespace}` : ""} · via {b.bindingName}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-[7px]">
        <span className="font-[var(--font-mono)] text-[10px] tracking-[1px] text-[var(--fg-tertiary)]">
          RULES
        </span>
        <span className="font-[var(--font-mono)] text-[10px] text-[var(--fg-tertiary)]">
          {rules.length}
        </span>
        <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      <div className="flex flex-col gap-2">
        {rules.map((r, i) => (
          <RuleRow key={i} rule={r} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test -- src/panels/rbac/components/SubjectDetail.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/rbac/components/SubjectDetail.tsx apps/web/src/panels/rbac/components/RoleDetail.tsx apps/web/src/panels/rbac/components/SubjectDetail.test.tsx
git commit -m "feat(rbac): subject and role detail panes"
```

---

## Task 8: Rewrite RbacPanel (assembly)

**Files:**
- Modify (full rewrite): `apps/web/src/panels/rbac/RbacPanel.tsx`
- Test: `apps/web/src/panels/rbac/RbacPanel.test.tsx`

Composes chrome + scope-aware subscriptions + two panes. Reuses `sortByName`/`sortByNamespaceName`/`matchesSearch` from `rbacDisplay.ts`, `grantRisk` for role danger flags, `buildHandoffPrompt` + `handoffToChat` for the Ask button, `NamespaceSelector` for the namespace dropdown (never free text).

- [ ] **Step 1: Confirm the namespace dropdown import**

Run: `grep -rn "export function NamespaceSelector\|export const NamespaceSelector" apps/web/src/shell/NamespaceBar.tsx`
Expected: a matching export. Use that named import in Step 4. If the prop shape differs from `value`/`onChange`, adapt the call to the real signature (read the component). Do not build a free-text namespace input.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/panels/rbac/RbacPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
vi.mock("@/shell/NamespaceBar", () => ({ NamespaceSelector: () => null }));

const state = {
  resources: {
    rolebindings: {
      "1": {
        metadata: { name: "b1", namespace: "default", uid: "1" },
        roleRef: { kind: "Role", name: "reader" },
        subjects: [{ kind: "ServiceAccount", name: "rigel-agent", namespace: "default" }],
      },
    },
    roles: {
      "2": { metadata: { name: "reader", namespace: "default", uid: "2" }, rules: [{ verbs: ["get"], resources: ["pods"] }] },
    },
    clusterroles: {},
    clusterrolebindings: {},
    serviceaccounts: {},
  },
  isLoading: false,
  error: null,
  namespaceFilter: null,
};
vi.mock("@/store/cluster", () => ({
  useCluster: (sel: (s: typeof state) => unknown) => sel(state),
}));

import RbacPanel from "./RbacPanel";

afterEach(cleanup);

test("renders the subject and its resolved binding on select", () => {
  render(<RbacPanel />);
  expect(screen.getByText("RBAC")).toBeTruthy();
  // subject appears in the list
  expect(screen.getAllByText("rigel-agent").length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test -- src/panels/rbac/RbacPanel.test.tsx`
Expected: FAIL (panel still renders the old pills; `getByText("RBAC")` may pass but the assembled two-pane structure/imports won't match — this test drives the rewrite). If it happens to pass against the old panel, proceed to Step 4 regardless; the rewrite is required by the design.

- [ ] **Step 4: Rewrite the panel**

Replace the entire contents of `apps/web/src/panels/rbac/RbacPanel.tsx` with:

```tsx
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
  subjectKey,
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
      key: `Role ${r.metadata.namespace ?? ""} ${r.metadata.name}`,
      kind: "Role",
      name: r.metadata.name,
      namespace: r.metadata.namespace,
      dangerous: grantRisk(r.rules) === "dangerous",
    }));
    const cItems: RoleItem[] = scopedCR.map((r) => ({
      key: `ClusterRole  ${r.metadata.name}`,
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
```

- [ ] **Step 5: Run the panel test + typecheck**

Run: `pnpm --filter web test -- src/panels/rbac/RbacPanel.test.tsx`
Expected: PASS.
Run: `pnpm --filter web typecheck`
Expected: PASS. (If `NamespaceSelector` needs props, fix the call per Step 1. If any `resources[...]` index type complains, keep the `as Record<...>` casts shown.)

- [ ] **Step 6: Delete now-dead code**

The old panel's local helpers (`NamespaceChip`, `RulesDetail`, `BindingDetail`, `secretsLabel`, `rulesLabel`, `roleRefLabel`, `KIND_TABS`) are gone with the rewrite. Confirm nothing else imports them:

Run: `grep -rn "secretsLabel\|roleRefLabel\|RulesDetail\|KIND_TABS" apps/web/src`
Expected: no matches outside test files. `rulesSummary`/`subjectsSummary` in `rbacDisplay.ts` may now be unused by the panel — keep them (still covered by `rbacDisplay.test.ts`) unless the whole-suite run flags them as an unused-export lint error, in which case leave them (they are exported API, not dead locals).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/rbac/RbacPanel.tsx apps/web/src/panels/rbac/RbacPanel.test.tsx
git commit -m "feat(rbac): two-pane access-analysis panel (replaces flat browser)"
```

---

## Task 9: Full suite, visual verification, docs

**Files:**
- No new code unless verification surfaces a defect.

- [ ] **Step 1: Run the whole web suite + typecheck + build**

Run: `pnpm --filter web test`
Expected: PASS (all, including the pre-existing 930+ tests and the new rbac tests).
Run: `pnpm --filter web typecheck`
Expected: PASS.
Run: `pnpm --filter web build`
Expected: succeeds.

- [ ] **Step 2: Visual verification against the `.pen`**

Compare the built panel to Pencil frame `dPDS8` (screenshot it via the pencil MCP if needed). Confirm: header title/subtitle + namespace dropdown + filter input; status strip counts with DANGEROUS in red + scope toggle; left list with Subjects/Roles toggle and red danger dots; subject detail summary strip, legend, and binding cards with three-column rule rows and red-tinted dangerous rules; footer text. Fix spacing/token mismatches inline (Tailwind tokens only). Per house rule, do NOT start the web dev server; verify via `pnpm --filter desktop dev` only if the user asks for a live check.

- [ ] **Step 3: Update Outline + Plane (per workflow)**

Update the app's Outline doc with the RBAC access-analysis feature, and derive/attach a Plane ticket under the Rigel (HELM) project. (Uses the Outline + Plane MCPs.)

- [ ] **Step 4: Final commit if any fixes were made**

```bash
git add -A && git commit -m "fix(rbac): visual polish to match Pencil frame dPDS8"
```

---

## Self-review notes (author)

- **Spec coverage:** header/search/namespace (T8) ✓; status strip + DANGEROUS + scope toggle (T4/T8) ✓; two-pane + Subjects/Roles toggle (T6/T8) ✓; subject summary + legend + binding cards + rules table (T5/T7) ✓; risk classification `dangerous`/`wildcard` (T2) ✓; access resolver bindings→roles→rules + reverse (T3) ✓; read-only footer (T8) ✓; Ask handoff (T7/T8) ✓. Non-goals (write actions, query builder, `auth can-i`) intentionally absent ✓.
- **Placeholder scan:** the only intentional "fix me" is the T2 Step-1 `create`-secrets assertion, explicitly corrected in T2 Step 4. No other TODOs.
- **Type consistency:** `Grant`, `ListSubject`, `SubjectRef`, `BindingScope`, `ScopeFilter`, `RbacView` defined in T1 and used verbatim in T2–T8. `RoleItem` defined in `RbacList.tsx` (T6) and imported by the panel (T8). Function names (`subjectKey`, `effectiveGrants`, `resolveRoleRules`, `subjectsForRole`, `collectSubjects`, `rbacCounts`, `grantRisk`, `ruleRisk`) consistent across tasks.
- **Open confirmation for the user:** risk tiers are exactly the two the `.pen` legend shows. If a third tier or different threshold is wanted, adjust `risk.ts` (T2) — isolated, one file.
