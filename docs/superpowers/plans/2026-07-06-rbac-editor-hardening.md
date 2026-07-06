# RBAC Editor Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the HELM-53 RBAC-editor follow-ups: per-cluster policies with Apply / Save-to-all / Copy-to-clusters, a live-drift indicator, a de-duplicated read baseline (15 rules), and one-click clear on partial capability toggles.

**Architecture:** Policies stay per-cluster (`assistant-config` ConfigMap, already namespaced). One server action (`setRbac`) applies **and** persists a policy to an explicit list of contexts, so stored + live agree on every cluster it touches. Reads become a non-editable baseline floor via a structural cross-dedup in the manifest builder. Drift is a pure set-compare of the live ClusterRole against the rules the stored policy renders.

**Tech Stack:** TypeScript monorepo — `packages/k8s` (pure policy/manifest), `apps/server` (Node action handlers, vitest), `apps/web` (React 19 + TanStack Query + vitest/RTL). Commands: `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/server test`, `pnpm --filter web test`, `pnpm --filter web typecheck`.

**Spec:** `docs/superpowers/specs/2026-07-06-rbac-editor-hardening-design.md`

---

## File Structure

- `packages/k8s/src/rbacPolicy.ts` — add `isBaselineReadCell`, `subtractBaseline`; remove `read` from `DEFAULT_POLICY`; mark `read` capability `baseline`; guard `toggleCell`/`parsePolicy` against baseline read cells. (Task 1)
- `packages/k8s/src/assistant.ts` — replace the `BASELINE_READ_RULES` string with a structured `BASELINE_RULES: PolicyRule[]` + `rulesToYaml`; add `clusterRoleRules` and `liveMatchesPolicy`; make `rbac()` render from `clusterRoleRules`. (Tasks 1, 2)
- `packages/k8s/src/index.ts` — export the new symbols. (Task 1/2)
- `apps/server/src/assistant.ts` — `setRbac` takes an explicit `contexts` list, persists+applies per context; new `installedContexts` action; `AssistantRequest.contexts`, drop `rbacTarget`; dispatch case. (Task 3)
- `apps/web/src/lib/api.ts` — `AssistantRequest.contexts` (drop `rbacTarget`), `installedContexts` action, `useInstalledContexts`. (Task 4)
- `apps/web/src/panels/assistant/permissions/usePermissions.ts` — drop `target`; `apply(contexts)` / `reapply(contexts)`; `drift`. (Task 5)
- `apps/web/src/panels/assistant/permissions/SimpleView.tsx` — baseline "Always on" row; partial toggle clears. (Task 6)
- `apps/web/src/panels/assistant/permissions/AdvancedView.tsx` — baseline read cells checked+disabled. (Task 7)
- `apps/web/src/panels/assistant/permissions/CopyToClustersDialog.tsx` — new picker dialog. (Task 8)
- `apps/web/src/panels/assistant/tabs/PermissionsTab.tsx` — Apply / Save-to-all / Copy menu + drift banner. (Task 8)

Order: Tasks 1→2 (pure `@rigel/k8s`) unblock everything; Task 3 (server) depends on Task 2's `liveMatchesPolicy` only for exports; Tasks 4→8 (web) depend on 1–3.

---

## Task 1: Read baseline floor — de-dup to 15 rules (packages/k8s)

**Files:**
- Modify: `packages/k8s/src/rbacPolicy.ts`
- Modify: `packages/k8s/src/assistant.ts:431-471`
- Modify: `packages/k8s/src/index.ts`
- Test: `packages/k8s/src/rbacPolicy.test.ts`, `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1: Write failing tests for the pure baseline helpers**

Add to `packages/k8s/src/rbacPolicy.ts`'s test file `packages/k8s/src/rbacPolicy.test.ts`:

```ts
import { DEFAULT_POLICY, isBaselineReadCell, subtractBaseline, cell } from "./rbacPolicy";

describe("read baseline floor", () => {
  test("DEFAULT_POLICY no longer contains read cells", () => {
    // Reads ship as the non-editable baseline, not as policy cells.
    expect(DEFAULT_POLICY.cells.some((c) => isBaselineReadCell(c))).toBe(false);
  });

  test("isBaselineReadCell matches get/list/watch on baseline-covered resources only", () => {
    expect(isBaselineReadCell(cell("", "pods", "get"))).toBe(true);
    expect(isBaselineReadCell(cell("apps", "deployments", "watch"))).toBe(true);
    expect(isBaselineReadCell(cell("", "pods", "delete"))).toBe(false); // write verb
    expect(isBaselineReadCell(cell("", "secrets", "get"))).toBe(false); // secrets never baseline
    expect(isBaselineReadCell(cell("", "nodes", "patch"))).toBe(false); // cordon, editable
  });

  test("subtractBaseline drops baseline read cells, keeps the rest", () => {
    const p = { cells: [cell("", "pods", "get"), cell("", "pods", "delete")].sort() };
    expect(subtractBaseline(p).cells).toEqual([cell("", "pods", "delete")]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rigel/k8s test rbacPolicy`
Expected: FAIL — `isBaselineReadCell`/`subtractBaseline` are not exported.

- [ ] **Step 3: Implement the baseline helpers and drop read from DEFAULT_POLICY**

In `packages/k8s/src/rbacPolicy.ts`, change `DEFAULT_POLICY` (lines 136-138) to drop `"read"`:

```ts
export const DEFAULT_POLICY: RbacPolicy = {
  cells: [...new Set(["reversible", "deletePods", "cordon"].flatMap((id) => CAP_BY_ID.get(id)!.cells))].sort(),
};

/** The get/list/watch cells that ship as part of the non-editable baseline
 *  (BASELINE_RULES in assistant.ts). Equal to what the old "read" capability
 *  granted; the capability stays for display but is baseline-managed now. */
const BASELINE_READ_CELLS = new Set(CAP_BY_ID.get("read")!.cells);

export function isBaselineReadCell(c: string): boolean {
  return BASELINE_READ_CELLS.has(c);
}

/** Remove any baseline read cell so the rendered ClusterRole never duplicates a
 *  read the baseline already grants — regardless of what a stored policy holds. */
export function subtractBaseline(policy: RbacPolicy): RbacPolicy {
  return { cells: policy.cells.filter((c) => !BASELINE_READ_CELLS.has(c)) };
}
```

Mark the `read` capability as baseline. Change its interface + entry:

```ts
export interface Capability {
  id: string;
  label: string;
  description: string;
  risk: Risk;
  /** The exact cells this capability grants. */
  cells: string[];
  /** Baseline capabilities are always-on and non-editable (rendered informational). */
  baseline?: boolean;
}
```

```ts
  {
    id: "read", label: "Read everything", description: "Inspect any resource except Secrets", risk: "safe",
    baseline: true,
    cells: readResources.flatMap((r) => READ_VERBS.map((v) => cell(r.apiGroup, r.resource, v))),
  },
```

Guard `toggleCell` and `parsePolicy` so staged/stored policies never carry baseline read cells. `toggleCell` (line 50-51):

```ts
export function toggleCell(policy: RbacPolicy, c: string, on: boolean): RbacPolicy {
  if (on && (!REPRESENTABLE.has(c) || isBaselineReadCell(c))) return policy;
  const set = new Set(policy.cells);
  if (on) set.add(c);
  else set.delete(c);
  return { cells: [...set].sort() };
}
```

`parsePolicy` (line 67) — strip baseline read cells from legacy stored policies:

```ts
    return { cells: [...new Set(cells)].filter((c) => REPRESENTABLE.has(c) && !isBaselineReadCell(c)).sort() };
```

And `serializePolicy` (line 59) for symmetry:

```ts
  return JSON.stringify({ cells: [...new Set(policy.cells)].filter((c) => REPRESENTABLE.has(c) && !isBaselineReadCell(c)).sort() });
}
```

- [ ] **Step 4: Run the pure-helper tests**

Run: `pnpm --filter @rigel/k8s test rbacPolicy`
Expected: the three new tests PASS. The existing `DEFAULT_POLICY = read + reversible + …` test (rbacPolicy.test.ts:31-38) now FAILS on the `capabilityState(DEFAULT_POLICY, "read")` assertion — fix it in the next step.

- [ ] **Step 5: Update the existing DEFAULT_POLICY test**

Replace rbacPolicy.test.ts lines 31-38 body:

```ts
  test("DEFAULT_POLICY = reversible + pod-delete + node-patch; read is baseline; destructive off", () => {
    expect(capabilityState(DEFAULT_POLICY, "read")).toBe("off"); // reads are baseline now, not policy cells
    expect(capabilityState(DEFAULT_POLICY, "reversible")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "deletePods")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "cordon")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "deleteWorkloads")).toBe("off");
    expect(capabilityState(DEFAULT_POLICY, "drain")).toBe("off");
    expect(capabilityState(DEFAULT_POLICY, "secrets")).toBe("off");
  });
```

Run: `pnpm --filter @rigel/k8s test rbacPolicy` → PASS.

- [ ] **Step 6: Write the failing 15-rule manifest test**

Add to `packages/k8s/src/assistant.test.ts`:

```ts
import { rbac, DEFAULT_POLICY, setCapability } from "@rigel/k8s";

test("rbac(DEFAULT_POLICY) renders exactly 15 ClusterRole rules with no duplicate read", () => {
  const yaml = rbac("default");
  const clusterRoleDoc = yaml.split("\n---\n").find((d) => /\bkind: ClusterRole\b/.test(d) && !/ClusterRoleBinding/.test(d))!;
  const ruleLines = clusterRoleDoc.split("\n").filter((l) => l.trim().startsWith("- apiGroups:"));
  expect(ruleLines).toHaveLength(15);
});
```

Run: `pnpm --filter @rigel/k8s test assistant` → FAIL (currently 16, and `rbac` still concatenates the raw baseline string).

- [ ] **Step 7: Restructure the baseline and render from clusterRoleRules**

In `packages/k8s/src/assistant.ts`, replace the `BASELINE_READ_RULES` string (lines 431-461) with a structured constant, and add helpers. First extend the import from `./rbacPolicy` to include `PolicyRule` and `subtractBaseline` (add to the existing import list):

```ts
import { policyToClusterRoleRules, subtractBaseline, DEFAULT_POLICY, type PolicyRule, type RbacPolicy } from "./rbacPolicy";
```
(Keep whatever else that import already pulls in — add these names to it, do not create a second import.)

Replace lines 431-461:

```ts
/** Non-editable baseline reads: diagnosis/audits/alerts need these regardless of
 *  the policy, so they always ship ahead of the policy-rendered rules. Structured
 *  (not a YAML string) so both the manifest and the drift compare render from one
 *  source and no read is duplicated. */
const BASELINE_RULES: PolicyRule[] = [
  { apiGroups: [""], resources: ["pods", "pods/log", "pods/status", "nodes", "events", "namespaces", "services", "endpoints", "persistentvolumeclaims", "persistentvolumes", "replicationcontrollers", "configmaps", "serviceaccounts", "resourcequotas", "limitranges"], verbs: ["get", "list", "watch"] },
  { apiGroups: [""], resources: ["services/proxy"], verbs: ["get"] },
  { apiGroups: ["apps"], resources: ["deployments", "replicasets", "statefulsets", "daemonsets", "deployments/scale", "statefulsets/scale"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["policy"], resources: ["poddisruptionbudgets"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "networkpolicies"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["metrics.k8s.io"], resources: ["pods", "nodes"], verbs: ["get", "list"] },
];

/** Render an array of rules as ClusterRole YAML rule lines. */
function rulesToYaml(rules: PolicyRule[]): string {
  return rules
    .map((r) => `  - apiGroups: [${r.apiGroups.map((g) => `"${g}"`).join(", ")}]\n    resources: [${r.resources.join(", ")}]\n    verbs: [${r.verbs.join(", ")}]`)
    .join("\n");
}

/** The full ClusterRole rule set: the non-editable baseline plus the policy's
 *  own rules with any baseline-covered read removed (structural de-dup). */
export function clusterRoleRules(policy: RbacPolicy = DEFAULT_POLICY): PolicyRule[] {
  return [...BASELINE_RULES, ...policyToClusterRoleRules(subtractBaseline(policy))];
}
```

Change `rbac()` (lines 467-471) to render from `clusterRoleRules`:

```ts
export function rbac(ns: string, policy: RbacPolicy = DEFAULT_POLICY): string {
  const ruleYaml = rulesToYaml(clusterRoleRules(policy));
  return `apiVersion: v1
```
(Leave the rest of the template literal from `kind: ServiceAccount` onward exactly as-is; only the two lines computing `policyRuleYaml`/`ruleYaml` are replaced by the single `ruleYaml` line above.)

- [ ] **Step 8: Export the new symbols**

In `packages/k8s/src/index.ts`, ensure `isBaselineReadCell`, `subtractBaseline`, and `clusterRoleRules` are exported. If the index re-exports with `export * from "./rbacPolicy"` and `export * from "./assistant"`, no change is needed — verify with:

Run: `pnpm --filter @rigel/k8s build`
Expected: no missing-export errors.

- [ ] **Step 9: Run the k8s suite**

Run: `pnpm --filter @rigel/k8s test`
Expected: PASS, including the new 15-rule test. The `poddisruptionbudgets`/`horizontalpodautoscalers` `toContain` tests still pass (those tokens are unchanged).

- [ ] **Step 10: Commit**

```bash
git add packages/k8s/src/rbacPolicy.ts packages/k8s/src/assistant.ts packages/k8s/src/index.ts packages/k8s/src/rbacPolicy.test.ts packages/k8s/src/assistant.test.ts
git commit -m "fix(rbac): read baseline floor — de-dup rendered ClusterRole to 15 rules"
```

---

## Task 2: Drift compare — liveMatchesPolicy (packages/k8s)

**Files:**
- Modify: `packages/k8s/src/assistant.ts`
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1: Write the failing drift test**

Add to `packages/k8s/src/assistant.test.ts`:

```ts
import { liveMatchesPolicy, clusterRoleRules, DEFAULT_POLICY, setCapability } from "@rigel/k8s";

describe("liveMatchesPolicy", () => {
  test("true when live rules equal what the stored policy renders", () => {
    const live = clusterRoleRules(DEFAULT_POLICY); // PolicyRule[] shape matches a live ClusterRole's rules
    expect(liveMatchesPolicy(live, DEFAULT_POLICY)).toBe(true);
  });

  test("false when the live cluster grants something the policy does not", () => {
    const drifted = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
    const live = clusterRoleRules(drifted);
    expect(liveMatchesPolicy(live, DEFAULT_POLICY)).toBe(false);
  });

  test("order and grouping independent", () => {
    const live = [...clusterRoleRules(DEFAULT_POLICY)].reverse();
    expect(liveMatchesPolicy(live, DEFAULT_POLICY)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rigel/k8s test assistant`
Expected: FAIL — `liveMatchesPolicy` not exported.

- [ ] **Step 3: Implement liveMatchesPolicy**

In `packages/k8s/src/assistant.ts`, just below `clusterRoleRules`, add:

```ts
/** Expand rule objects into a set of `${apiGroup}|${resource}|${verb}` tuples,
 *  defensively (live rules come straight from `kubectl get clusterrole -o json`). */
function ruleTuples(rules: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const r of rules) {
    const rule = r as { apiGroups?: unknown; resources?: unknown; verbs?: unknown };
    const groups = Array.isArray(rule.apiGroups) ? rule.apiGroups : [];
    const resources = Array.isArray(rule.resources) ? rule.resources : [];
    const verbs = Array.isArray(rule.verbs) ? rule.verbs : [];
    for (const g of groups) for (const res of resources) for (const v of verbs) set.add(`${String(g)}|${String(res)}|${String(v)}`);
  }
  return set;
}

/** True when the live ClusterRole rules grant exactly what the stored policy
 *  renders (baseline + policy). Order/grouping independent. The caller only
 *  calls this with a non-null live rules array — a failed live read is never
 *  reported as drift. */
export function liveMatchesPolicy(appliedRules: unknown[], policy: RbacPolicy): boolean {
  const live = ruleTuples(appliedRules);
  const expected = ruleTuples(clusterRoleRules(policy));
  if (live.size !== expected.size) return false;
  for (const t of expected) if (!live.has(t)) return false;
  return true;
}
```

- [ ] **Step 4: Run the drift test**

Run: `pnpm --filter @rigel/k8s test assistant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(rbac): liveMatchesPolicy — pure drift compare for the editor"
```

---

## Task 3: Per-cluster persist + installedContexts action (apps/server)

**Files:**
- Modify: `apps/server/src/assistant.ts` (action union ~130-144, `AssistantRequest` ~199-204, `setRbac` 618-635, dispatch 1066-1069, new `installedContexts`)
- Test: `apps/server/src/assistant.test.ts:987-1096`

- [ ] **Step 1: Rewrite the setRbac server tests for the explicit-contexts model**

Replace the `describe("setRbac", …)` block (assistant.test.ts:987-1070). The key behavioral change: `setRbac` persists **and** applies per context in the passed `contexts` list (fixing the bug where secondary clusters never got their config written).

```ts
describe("setRbac", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test("persists + applies the ClusterRole to just the active context by default", async () => {
    const applied: { args: string[]; stdin: unknown }[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, args, stdin) => {
      applied.push({ args, stdin });
      return { code: 0, stdout: "", stderr: "" };
    });
    const policy = setCapability(DEFAULT_POLICY, "drain", true);
    const res = await setRbac("active-ctx", "default", {
      action: "setRbac", policy: serializePolicy(policy), contexts: ["active-ctx"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: unknown[] };
    expect(result.applied).toEqual(["active-ctx"]);
    expect(result.failures).toEqual([]);
    expect(applied[0]!.stdin).toContain("rbacPolicy"); // config write
    expect(applied[1]!.stdin).toMatch(/kind: ClusterRole\b/);
    expect(applied[1]!.stdin).not.toMatch(/kind: ClusterRoleBinding/);
    expect(applied[1]!.stdin).toMatch(/pods\/eviction/);
  });

  test("writes config AND applies the ClusterRole to EVERY passed context", async () => {
    const configWrites: string[] = [];
    const clusterRoleApplies: string[] = [];
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, _args, stdin) => {
      const s = String(stdin);
      if (s.includes("rbacPolicy")) configWrites.push(s);
      if (/kind: ClusterRole\b/.test(s) && !/ClusterRoleBinding/.test(s)) clusterRoleApplies.push(s);
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-b"],
    });
    const result = JSON.parse(res.stdout) as { applied: string[] };
    expect(result.applied.sort()).toEqual(["ctx-a", "ctx-b"]);
    // The fix: config persisted to BOTH clusters, not just the active one.
    expect(configWrites).toHaveLength(2);
    expect(clusterRoleApplies).toHaveLength(2);
  });

  test("one context failing does not abort the others; names the failure", async () => {
    vi.spyOn(runMod, "kubectl").mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" });
    vi.spyOn(runMod, "runProcessWithStdin").mockImplementation(async (_prog, fullArgs, stdin) => {
      // Fail the ClusterRole apply only for ctx-b.
      if (/kind: ClusterRole\b/.test(String(stdin)) && fullArgs.includes("ctx-b")) {
        return { code: 1, stdout: "", stderr: "Forbidden" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await setRbac("ctx-a", "default", {
      action: "setRbac", policy: serializePolicy(DEFAULT_POLICY), contexts: ["ctx-a", "ctx-b"],
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("ctx-b");
    expect(res.stderr).toContain("Forbidden");
    const result = JSON.parse(res.stdout) as { applied: string[]; failures: { context: string; error: string }[] };
    expect(result.applied).toEqual(["ctx-a"]);
    expect(result.failures).toEqual([{ context: "ctx-b", error: "Forbidden" }]);
  });
});
```

Note: the failure test assumes `runProcessWithStdin` is called with the target context in `fullArgs`. Verify `applyStdin` passes `--context <ctx>` in its args; if it threads context differently, adjust the `fullArgs.includes("ctx-b")` guard to match how the context reaches the stub (check `apps/server/src/*` for `applyStdin`).

Also update the two `handleAssistant routes getRbac/setRbac` calls (assistant.test.ts:1080-1082 and 1091-1093): replace `rbacTarget: "active"` with `contexts: ["default"]` in each `setRbac` request object.

- [ ] **Step 2: Add a failing installedContexts test**

Add to `apps/server/src/assistant.test.ts`:

```ts
test("installedContexts returns managed contexts with the active flag", async () => {
  const run = async (ctx: string | null, args: string[]) => {
    if (args[0] === "config") {
      return { code: 0, stdout: JSON.stringify({
        "current-context": "ctx-a",
        contexts: [{ name: "ctx-a", context: { cluster: "a" } }, { name: "ctx-b", context: { cluster: "b" } }],
        clusters: [{ name: "a", cluster: {} }, { name: "b", cluster: {} }],
      }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ metadata: { labels: { "app.kubernetes.io/managed-by": "rigel-assistant" } } }), stderr: "" };
  };
  const res = await handleAssistant("ctx-a", { action: "installedContexts", namespace: "default" }, run);
  const parsed = JSON.parse(res.stdout) as { contexts: { name: string; active: boolean }[] };
  expect(parsed.contexts).toEqual([
    { name: "ctx-a", active: true },
    { name: "ctx-b", active: false },
  ]);
});
```

Note: confirm `handleAssistant`'s signature — it is called elsewhere as `handleAssistant(context, req)`. If it does not accept an injectable `run`, drop the third arg here and instead `vi.spyOn(runMod, "kubectl")` with a mock mirroring the `run` above (same branching on `args[0]`). Match the existing test style in this file.

- [ ] **Step 3: Run to verify both fail**

Run: `pnpm --filter @rigel/server test assistant`
Expected: FAIL — `contexts` not accepted / `installedContexts` action unknown.

- [ ] **Step 4: Update the request type and action union**

In `apps/server/src/assistant.ts`, add `"installedContexts"` to the `AssistantAction` union (near line 143-144):

```ts
  | "getRbac"
  | "setRbac"
  | "installedContexts";
```

Replace the `rbacTarget` field (lines 202-203) with `contexts`:

```ts
  // getRbac/setRbac/installedContexts — the operator-editable RBAC policy.
  // `policy` is a serializePolicy() JSON string; `contexts` is the explicit set
  // of kubeconfig contexts to persist+apply to (active alone, all installed, or
  // a picked subset). Omitted → the active context.
  policy?: string;
  contexts?: string[];
```

- [ ] **Step 5: Rewrite setRbac and add installedContexts**

Replace `setRbac` (lines 611-635) with:

```ts
/**
 * Persist the operator's RBAC policy AND apply it as a ClusterRole to each
 * context in `req.contexts` (default: the active context). For every target we
 * read-modify-write `assistant-config` (so stored + live agree per cluster) and
 * apply the ClusterRole-only document. Never re-applies the namespaced
 * SA/Role/binding (install-time only). One failing context does not abort the rest.
 */
export async function setRbac(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const policy = parsePolicy(req.policy);
  const contexts = req.contexts && req.contexts.length > 0 ? req.contexts : [context ?? ""];
  const applied: string[] = [];
  const failures: { context: string; error: string }[] = [];
  for (const ctx of contexts) {
    try {
      await patchConfig(ctx, namespace, rbacConfigUpdate(policy));
      const r = await applyPolicy({ policy, contexts: [ctx] }, { apply: (c, yaml) => applyStdin(c, yaml) });
      if (r.failures.length > 0) failures.push({ context: ctx, error: r.failures[0]!.error });
      else applied.push(ctx);
    } catch (e) {
      failures.push({ context: ctx, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const result = { applied, failures };
  if (failures.length > 0) {
    const stderr = failures.map((f) => `Failed to apply RBAC to ${f.context}: ${f.error}`).join("; ");
    return { code: 1, stdout: JSON.stringify(result), stderr };
  }
  return { code: 0, stdout: JSON.stringify(result), stderr: "" };
}

/** List the contexts with the assistant installed (for the editor's "all
 *  clusters" / copy picker), flagging which is the active kubeconfig context. */
export async function installedContexts(context: string | null, namespace: string): Promise<RunResult> {
  const names = await discoverInstalledContexts(namespace);
  const active = context ?? "";
  const contexts = names.map((name) => ({ name, active: name === active }));
  return { code: 0, stdout: JSON.stringify({ contexts }), stderr: "" };
}
```

- [ ] **Step 6: Wire the dispatch**

In the action switch (lines 1066-1069), add the case:

```ts
    case "getRbac":
      return getRbac(context, namespace);
    case "setRbac":
      return setRbac(context, namespace, req);
    case "installedContexts":
      return installedContexts(context, namespace);
```

- [ ] **Step 7: Run the server suite**

Run: `pnpm --filter @rigel/server test assistant`
Expected: PASS. If the `installedContexts` test used an injectable `run` the handler doesn't support, fall back to the `vi.spyOn` form (Step 2 note).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "fix(rbac): setRbac persists+applies per explicit context; add installedContexts"
```

---

## Task 4: Client API — contexts field + useInstalledContexts (apps/web)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`AssistantAction` union, `AssistantRequest` ~436-498, add hook)
- Test: none (thin wrapper; covered via usePermissions test in Task 5)

- [ ] **Step 1: Update the client request type**

In `apps/web/src/lib/api.ts`, add `"installedContexts"` to the `AssistantAction` union. Replace the `rbacTarget?: "active" | "all";` line (≈497) with:

```ts
  policy?: string;
  contexts?: string[];
```
(Remove the now-dead `rbacTarget` line; if `policy?` is already declared above it, don't duplicate — just replace `rbacTarget` with `contexts`.)

- [ ] **Step 2: Add the useInstalledContexts hook**

Near `useContexts` (≈1150) add:

```ts
export interface InstalledContext {
  name: string;
  active: boolean;
}

async function fetchInstalledContexts(namespace: string): Promise<InstalledContext[]> {
  const res = await postAssistant({ action: "installedContexts", namespace });
  const parsed = JSON.parse(res.stdout || "{}") as { contexts?: InstalledContext[] };
  return parsed.contexts ?? [];
}

/** Contexts with the assistant installed — for the Permissions editor's
 *  "Save to all clusters" / "Copy to clusters" scopes. */
export function useInstalledContexts(namespace: string) {
  return useQuery({
    queryKey: ["assistant-installed-contexts", namespace] as const,
    queryFn: () => fetchInstalledContexts(namespace),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: errors ONLY in `usePermissions.ts` / `PermissionsTab.tsx` referencing the removed `rbacTarget` — fixed in Tasks 5 and 8. No errors in `api.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(rbac): client contexts field + useInstalledContexts"
```

---

## Task 5: usePermissions — apply(contexts) / reapply / drift (apps/web)

**Files:**
- Modify: `apps/web/src/panels/assistant/permissions/usePermissions.ts`
- Test: `apps/web/src/panels/assistant/permissions/usePermissions.test.ts`

- [ ] **Step 1: Write failing tests for the new surface**

Add to `usePermissions.test.ts` (follow the file's existing render/mock style — it already mocks `postAssistant`/`useAssistantAction`). Add cases asserting: `apply(contexts)` sends `contexts` (not `rbacTarget`), and `drift` is derived from `appliedRules`.

```ts
test("apply sends the explicit contexts list and the staged policy", async () => {
  // ... render usePermissions with a mocked action.mutate captured as `mutate`
  // Act: result.current.apply(["ctx-a", "ctx-b"]);
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({ action: "setRbac", contexts: ["ctx-a", "ctx-b"] }),
    expect.anything(),
  );
  expect(mutate.mock.calls[0][0]).not.toHaveProperty("rbacTarget");
});

test("drift is true when live appliedRules diverge from the stored policy", async () => {
  // fetchRbac mocked to return { policy: DEFAULT_POLICY-serialized, appliedRules: <drifted live rules> }
  // e.g. appliedRules = clusterRoleRules(setCapability(DEFAULT_POLICY, "deleteWorkloads", true))
  // Assert: result.current.drift === true
});

test("drift is false when appliedRules is null (live read failed)", async () => {
  // fetchRbac mocked with appliedRules: null → drift === false
});
```

(Fill in the render/mock scaffolding by mirroring the existing tests in this file — same `renderHook`, `QueryClientProvider`, and `postAssistant` mock they already use.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test usePermissions`
Expected: FAIL — `apply` still sends `rbacTarget`; `drift` undefined.

- [ ] **Step 3: Rewrite usePermissions**

Replace `apps/web/src/panels/assistant/permissions/usePermissions.ts` body from the import block through the return. Key changes: drop `RbacTarget`/`target`/`setTarget`; add `liveMatchesPolicy` import; `apply(contexts)`/`reapply(contexts)`; `drift`.

```ts
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_POLICY,
  diffPolicies,
  liveMatchesPolicy,
  parsePolicy,
  serializePolicy,
  setCapability,
  toggleCell as toggleCellInPolicy,
  type RbacPolicy,
} from "@rigel/k8s";
import { postAssistant, useAssistantAction } from "@/lib/api";

export function stagedDiff(applied: RbacPolicy, staged: RbacPolicy) {
  const diff = diffPolicies(applied, staged);
  return { ...diff, count: diff.added.length + diff.removed.length };
}

interface RbacQueryData {
  policy: RbacPolicy;
  appliedRules: unknown;
}

async function fetchRbac(namespace: string): Promise<RbacQueryData> {
  const res = await postAssistant({ action: "getRbac", namespace });
  const parsed = JSON.parse(res.stdout || "{}") as { policy?: string; appliedRules?: unknown };
  return { policy: parsePolicy(parsed.policy), appliedRules: parsed.appliedRules ?? null };
}

export function usePermissions(namespace: string) {
  const queryKey = ["assistant-rbac", namespace] as const;
  const query = useQuery({ queryKey, queryFn: () => fetchRbac(namespace) });
  const qc = useQueryClient();
  const action = useAssistantAction();

  const applied = query.data?.policy ?? DEFAULT_POLICY;
  const appliedRules = query.data?.appliedRules ?? null;
  const [staged, setStaged] = useState<RbacPolicy>(applied);

  const seeded = useRef(false);
  useEffect(() => {
    if (query.data && !seeded.current) {
      setStaged(query.data.policy);
      seeded.current = true;
    }
  }, [query.data]);

  // The live ClusterRole differs from what the stored policy renders. Null live
  // rules (best-effort read failed) is never reported as drift.
  const drift = Array.isArray(appliedRules) && !liveMatchesPolicy(appliedRules, applied);

  function toggleCapability(id: string, on: boolean) {
    setStaged((p) => setCapability(p, id, on));
  }
  function toggleCell(cell: string, on: boolean) {
    setStaged((p) => toggleCellInPolicy(p, cell, on));
  }

  function push(policy: RbacPolicy, contexts: string[], onDone?: () => void) {
    action.mutate(
      { action: "setRbac", namespace, policy: serializePolicy(policy), contexts },
      { onSuccess: () => { void qc.invalidateQueries({ queryKey }); onDone?.(); } },
    );
  }
  function apply(contexts: string[], onDone?: () => void) {
    push(staged, contexts, onDone);
  }
  function reapply(contexts: string[], onDone?: () => void) {
    push(applied, contexts, onDone);
  }

  return {
    applied,
    staged,
    diff: stagedDiff(applied, staged),
    drift,
    toggleCapability,
    toggleCell,
    apply,
    reapply,
    applying: action.isPending,
    applyError: action.error,
    loading: query.isLoading,
    loadError: query.error,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter web test usePermissions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/permissions/usePermissions.ts apps/web/src/panels/assistant/permissions/usePermissions.test.ts
git commit -m "feat(rbac): usePermissions apply(contexts)/reapply + drift"
```

---

## Task 6: SimpleView — baseline always-on row + one-click clear (apps/web)

**Files:**
- Modify: `apps/web/src/panels/assistant/permissions/SimpleView.tsx`
- Test: `apps/web/src/panels/assistant/permissions/SimpleView.test.tsx`

- [ ] **Step 1: Write failing tests**

Add to `SimpleView.test.tsx`:

```ts
test("clicking a partial capability clears it (one-click off)", async () => {
  const onToggle = vi.fn();
  const reversible = CAPABILITIES.find((c) => c.id === "reversible")!;
  const partial: RbacPolicy = { cells: [reversible.cells[0]] }; // some-but-not-all → partial
  render(<SimpleView staged={partial} onToggleCapability={onToggle} />);
  await userEvent.click(screen.getByRole("switch", { name: reversible.label }));
  expect(onToggle).toHaveBeenCalledWith("reversible", false);
});

test("the baseline read capability renders always-on, not a toggle", () => {
  render(<SimpleView staged={{ cells: [] }} onToggleCapability={() => {}} />);
  expect(screen.getByText("Always on")).toBeInTheDocument();
  // No interactive switch is rendered for the baseline row.
  expect(screen.queryByRole("switch", { name: "Read everything" })).not.toBeInTheDocument();
});
```

(Match the existing imports/render helpers in the file — `CAPABILITIES`, `RbacPolicy`, `render`, `screen`, `userEvent`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test SimpleView`
Expected: FAIL — partial click calls `(…, true)`; no "Always on" text.

- [ ] **Step 3: Render baseline caps as informational and flip the partial click**

In `SimpleView.tsx`, in the `CAPABILITIES.map` body (lines 18-35), branch on `cap.baseline`:

```tsx
      {CAPABILITIES.map((cap) => {
        const state = capabilityState(staged, cap.id);
        return (
          <div key={cap.id} className="flex items-center justify-between gap-4 px-[22px] py-3.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--fg-primary)]">{cap.label}</span>
                <RiskChip risk={cap.risk} />
              </div>
              <p className="text-[12.5px] text-[var(--fg-tertiary)]">{cap.description}</p>
            </div>
            {cap.baseline ? (
              <span className="shrink-0 rounded-full bg-[var(--accent-dim)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-primary)]">
                Always on
              </span>
            ) : (
              <CapabilityToggle
                state={state}
                disabled={disabled}
                label={cap.label}
                onChange={(on) => onToggleCapability(cap.id, on)}
              />
            )}
          </div>
        );
      })}
```

Flip the partial handler in `CapabilityToggle` (line 80):

```tsx
        onClick={() => onChange(false)}
```

Update the comment above `CapabilityToggle` (lines 58-60) to read "…clicking it clears the capability."

- [ ] **Step 4: Run the test**

Run: `pnpm --filter web test SimpleView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/permissions/SimpleView.tsx apps/web/src/panels/assistant/permissions/SimpleView.test.tsx
git commit -m "feat(rbac): SimpleView baseline always-on row + one-click clear on partial"
```

---

## Task 7: AdvancedView — baseline read cells checked+disabled (apps/web)

**Files:**
- Modify: `apps/web/src/panels/assistant/permissions/AdvancedView.tsx`
- Test: `apps/web/src/panels/assistant/permissions/AdvancedView.test.tsx`

- [ ] **Step 1: Write a failing test**

Add to `AdvancedView.test.tsx`:

```ts
test("baseline read cells render checked and disabled even when absent from the policy", () => {
  render(<AdvancedView staged={{ cells: [] }} onToggleCell={() => {}} />);
  const podsGet = screen.getByRole("checkbox", { name: "pods get" });
  expect(podsGet).toBeChecked();
  expect(podsGet).toBeDisabled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter web test AdvancedView`
Expected: FAIL — `pods get` is unchecked/enabled with an empty policy.

- [ ] **Step 3: Wire isBaselineReadCell into the matrix**

In `AdvancedView.tsx`: import `isBaselineReadCell` (line 5):

```ts
import { cell, hasCell, isBaselineReadCell, MATRIX_RESOURCES, VERBS, type RbacPolicy } from "@rigel/k8s";
```

In the verb cell render (lines 77-90):

```tsx
                      {VERBS.map((v) => {
                        const allowed = (allowedVerbs as readonly string[]).includes(v);
                        const c = cell(r.apiGroup, r.resource, v);
                        const baseline = isBaselineReadCell(c);
                        return (
                          <td key={v} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${r.resource} ${v}`}
                              checked={baseline || hasCell(staged, c)}
                              disabled={disabled || !allowed || baseline}
                              onChange={(e) => onToggleCell(c, e.target.checked)}
                              className="size-[15px] accent-[var(--accent-primary)] disabled:opacity-20"
                            />
                          </td>
                        );
                      })}
```

Update the footer note (lines 104-107) to mention reads are always-on baseline, e.g. append: "Reads are always on (a non-editable baseline)."

- [ ] **Step 4: Run the test**

Run: `pnpm --filter web test AdvancedView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/permissions/AdvancedView.tsx apps/web/src/panels/assistant/permissions/AdvancedView.test.tsx
git commit -m "feat(rbac): AdvancedView renders baseline read cells checked+disabled"
```

---

## Task 8: PermissionsTab — Apply / Save-to-all / Copy + drift banner (apps/web)

**Files:**
- Create: `apps/web/src/panels/assistant/permissions/CopyToClustersDialog.tsx`
- Modify: `apps/web/src/panels/assistant/tabs/PermissionsTab.tsx`
- Test: `apps/web/src/panels/assistant/tabs/PermissionsTab.test.tsx`, new `CopyToClustersDialog.test.tsx`

- [ ] **Step 1: Build the CopyToClustersDialog (test first)**

Create `apps/web/src/panels/assistant/permissions/CopyToClustersDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyToClustersDialog } from "./CopyToClustersDialog";

test("confirms with the checked subset of other clusters", async () => {
  const onConfirm = vi.fn();
  render(
    <CopyToClustersDialog
      open
      onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }, { name: "dev", active: false }]}
      confirming={false}
      onConfirm={onConfirm}
    />,
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "prod" }));
  await userEvent.click(screen.getByRole("button", { name: /copy/i }));
  expect(onConfirm).toHaveBeenCalledWith(["prod"]);
});

test("confirm is disabled until at least one cluster is checked", () => {
  render(
    <CopyToClustersDialog open onOpenChange={() => {}}
      clusters={[{ name: "prod", active: false }]} confirming={false} onConfirm={() => {}} />,
  );
  expect(screen.getByRole("button", { name: /copy/i })).toBeDisabled();
});
```

Create `apps/web/src/panels/assistant/permissions/CopyToClustersDialog.tsx`:

```tsx
// CopyToClustersDialog — pick which other installed clusters to copy the current
// policy onto. Selection is a checkbox list (never free text). Guarded: the
// parent runs the mutation through the same setRbac path.
import { useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { InstalledContext } from "@/lib/api";

export function CopyToClustersDialog({
  open,
  onOpenChange,
  clusters,
  confirming,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusters: InstalledContext[];
  confirming: boolean;
  error?: string | null;
  onConfirm: (contexts: string[]) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const others = clusters.filter((c) => !c.active);
  const selected = others.filter((c) => checked[c.name]).map((c) => c.name);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy permissions to clusters</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            Apply this cluster&apos;s current permissions to the clusters you select.
          </DialogDescription>
          {others.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No other installed clusters.</p>
          ) : (
            <ul className="mt-3 space-y-1">
              {others.map((c) => (
                <li key={c.name}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={c.name}
                      checked={!!checked[c.name]}
                      onChange={(e) => setChecked((m) => ({ ...m, [c.name]: e.target.checked }))}
                      className="size-[15px] accent-[var(--accent-primary)]"
                    />
                    <span className="font-mono text-[12.5px]">{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-3 font-mono text-[11px] text-[var(--status-failed)]">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={confirming} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={confirming || selected.length === 0} onClick={() => onConfirm(selected)}>
            {confirming ? "Copying…" : `Copy to ${selected.length || ""} cluster${selected.length === 1 ? "" : "s"}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Run: `pnpm --filter web test CopyToClustersDialog` → PASS.

- [ ] **Step 2: Update PermissionsTab tests**

Rewrite the parts of `PermissionsTab.test.tsx` that reference the "Apply to" dropdown / `rbacTarget`. Add/adjust cases:

```tsx
test("Apply applies to the active context only", async () => {
  // render with useContexts → [{ name: "active", active: true }], usePermissions.apply spy
  // click Review changes → Apply (or the primary Apply); assert apply called with ["active"]
});

test("Save to all clusters applies to every installed context", async () => {
  // useInstalledContexts → [{name:"active",active:true},{name:"prod",active:false}]
  // open the Apply menu → "Save to all clusters"; assert apply called with ["active","prod"]
});

test("shows a drift banner with Re-apply when perms.drift is true", async () => {
  // usePermissions mock returns drift: true; assert banner text + Re-apply button
});
```

(Mirror the existing mocking approach in this test file — it already mocks `usePermissions`, `useContexts`. Add a `useInstalledContexts` mock.)

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter web test PermissionsTab`
Expected: FAIL — dropdown/`target` gone; drift banner absent.

- [ ] **Step 4: Rewrite PermissionsTab**

Replace `apps/web/src/panels/assistant/tabs/PermissionsTab.tsx`:

```tsx
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
```

- [ ] **Step 5: Run the tab tests**

Run: `pnpm --filter web test PermissionsTab`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/assistant/permissions/CopyToClustersDialog.tsx apps/web/src/panels/assistant/permissions/CopyToClustersDialog.test.tsx apps/web/src/panels/assistant/tabs/PermissionsTab.tsx apps/web/src/panels/assistant/tabs/PermissionsTab.test.tsx
git commit -m "feat(rbac): PermissionsTab Apply/Save-to-all/Copy scopes + drift banner"
```

---

## Task 9: Full verification sweep

- [ ] **Step 1: Typecheck + test everything touched**

Run:
```bash
pnpm --filter @rigel/k8s test
pnpm --filter @rigel/server test
pnpm --filter web typecheck
pnpm --filter web test
```
Expected: all green. Investigate any residual `rbacTarget` reference the typecheck flags.

- [ ] **Step 2: Grep for stragglers**

Run: `git grep -n "rbacTarget" -- apps packages`
Expected: no matches (fully removed).

- [ ] **Step 3: Final commit if the sweep changed anything**

```bash
git add -A && git commit -m "chore(rbac): verification sweep for HELM-53 hardening"
```

---

## Notes for the implementer

- **UI parity caveat:** the original Permissions tab was built from Pencil frames (jCXlB / riSgI). This plan adds an Apply split-button menu + drift banner + copy dialog by reusing in-file primitives (`DropdownMenu`, `ui/dialog.tsx`) rather than authoring a new Pencil frame. If a design pass is wanted, mock these three affordances in Pencil before finalizing styling.
- **No fallbacks added:** every new path is explicit. `contexts` defaults to the active context server-side only as the documented "omitted → active" contract, not as a silent guess.
- **Guarded mutations preserved:** Apply/Save-to-all go through ReviewDialog; Copy goes through CopyToClustersDialog. Both name the cluster set before mutating.
